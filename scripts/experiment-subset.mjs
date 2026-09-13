// experiment-subset.mjs — decide whether `embedFont(..., { subset: true })` is
// safe for the Source Han CJK fonts.
//
// Why this matters: `textBlockEdits.ts` / `flatten.ts` use `{ subset: false }`
// with a comment claiming subsetting "may produce an incomplete subset for
// CID/CFF fonts, causing missing CJK glyphs". That decision costs 8–12 MB per
// export. If the claim is wrong we can switch to subsetting and cut exported
// PDFs from megabytes to tens of kilobytes.
//
// Method (two independent checks, so a single flaky signal can't mislead us):
//
//   1. CONTROL — parse the original OTF with fontkit and keep only characters
//      it actually has glyphs for. Without this step, a missing glyph could
//      just mean the source font never had it, which would be a false alarm.
//
//   2. EXTRACTION — embed those characters with subset on/off, save, reload
//      with pdfjs, and compare the extracted string against the source. A
//      broken subset shows up as dropped or garbled characters, and as
//      zero-advance-width glyphs.
//
// Run: `node scripts/experiment-subset.mjs`
import { PDFDocument, PDFName } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FONTS = join(ROOT, 'public', 'fonts');
const OTF = join(FONTS, 'SourceHanSansCN-Regular.otf');

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  '../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
  import.meta.url
).href;

const TARGET = 200;

/** Characters the *source* font really has glyphs for — the control set. */
function pickCharacters() {
  const orig = fontkit.create(readFileSync(OTF));
  const chars = [];
  for (let cp = 0x4e00; cp <= 0x9fff && chars.length < TARGET; cp += 1) {
    if (orig.hasGlyphForCodePoint(cp)) chars.push(String.fromCodePoint(cp));
  }
  return { chars, origGlyphs: orig.numGlyphs };
}

async function buildPdf(chars, subset) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(readFileSync(OTF), { subset });
  const page = doc.addPage([595, 842]);
  // Lay the characters out in rows that fit the page. A single 200-char line
  // overflows the 595pt MediaBox and pdfjs silently drops what is off-page,
  // which would look like "missing glyphs" but is really just clipping.
  const perRow = 24;
  const size = 12;
  for (let i = 0; i < chars.length; i += perRow) {
    const row = chars.slice(i, i + perRow).join('');
    page.drawText(row, { x: 24, y: 800 - (i / perRow) * 22, size, font });
  }
  return doc.save();
}

/** Extract text + per-item advance widths via pdfjs. */
async function extract(bytes) {
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  const items = content.items.filter((it) => 'str' in it);
  const text = items.map((it) => it.str).join('');
  const zeroWidth = items.filter((it) => it.width === 0).length;
  await task.destroy();
  return { text, zeroWidth, itemCount: items.length };
}

// ---------------------------------------------------------------------------
// Raw CFF glyph counting.
//
// pdf-lib subsets a CFF/OpenType font into a bare `CIDFontType0C` stream, which
// fontkit cannot open (it wants a container). Text extraction alone is not
// proof of a healthy subset: ToUnicode can map characters correctly while the
// glyph *outlines* are absent, which would render as blank boxes. Counting the
// CharStrings entries tells us whether real outlines shipped.
// ---------------------------------------------------------------------------

function readIndex(buf, pos) {
  const count = buf.readUInt16BE(pos);
  if (count === 0) return { count: 0, end: pos + 2, items: [] };
  const offSize = buf[pos + 2];
  const offsets = [];
  let p = pos + 3;
  for (let i = 0; i <= count; i += 1) {
    let v = 0;
    for (let b = 0; b < offSize; b += 1) v = (v << 8) | buf[p + b];
    offsets.push(v);
    p += offSize;
  }
  const dataStart = p - 1; // CFF offsets are 1-based
  const items = [];
  for (let i = 0; i < count; i += 1) {
    items.push(buf.subarray(dataStart + offsets[i], dataStart + offsets[i + 1]));
  }
  return { count, end: dataStart + offsets[count], items };
}

/** Walk a CFF Top DICT and return the CharStrings INDEX entry count. */
function countCffGlyphs(buf) {
  try {
    const hdrSize = buf[2];
    let pos = hdrSize;
    pos = readIndex(buf, pos).end; // Name INDEX
    const topDict = readIndex(buf, pos);
    pos = topDict.end;
    pos = readIndex(buf, pos).end; // String INDEX
    pos = readIndex(buf, pos).end; // Global Subr INDEX
    void pos;

    const dict = topDict.items[0];
    let i = 0;
    let lastNum = 0;
    let charStringsOffset = null;
    while (i < dict.length) {
      const b0 = dict[i];
      if (b0 <= 21) {
        if (b0 === 12) { i += 2; continue; }
        if (b0 === 17) charStringsOffset = lastNum;
        i += 1;
        continue;
      }
      if (b0 >= 32 && b0 <= 246) { lastNum = b0 - 139; i += 1; }
      else if (b0 >= 247 && b0 <= 250) { lastNum = (b0 - 247) * 256 + dict[i + 1] + 108; i += 2; }
      else if (b0 >= 251 && b0 <= 254) { lastNum = -(b0 - 251) * 256 - dict[i + 1] - 108; i += 2; }
      else if (b0 === 28) {
        lastNum = (dict[i + 1] << 8) | dict[i + 2];
        if (lastNum > 0x7fff) lastNum -= 0x10000;
        i += 3;
      } else if (b0 === 29) { lastNum = dict.readInt32BE(i + 1); i += 5; }
      else if (b0 === 30) {
        i += 1;
        while (i < dict.length) {
          const nb = dict[i];
          i += 1;
          if ((nb & 0x0f) === 0x0f || nb >> 4 === 0x0f) break;
        }
      } else i += 1;
    }
    if (charStringsOffset == null) return null;
    return readIndex(buf, charStringsOffset).count;
  } catch {
    return null;
  }
}

/**
 * Pull the embedded font program out of a saved PDF.
 *
 * Two traps here: the stream carries no `/Subtype` when the full font is
 * embedded, and `PDFRawStream.getContents()` returns the *still-encoded* bytes.
 * So we sniff the `/Filter` and inflate FlateDecode ourselves before looking at
 * the font signature.
 */
function findFontProgram(pdf) {
  let best = null;
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!obj?.dict || typeof obj.getContents !== 'function') continue;
    let bytes = obj.getContents();
    const filter = obj.dict.get(PDFName.of('Filter'));
    if (filter && filter.toString() === '/FlateDecode') {
      try {
        bytes = inflateSync(Buffer.from(bytes));
      } catch {
        continue;
      }
    }
    // 'OTTO' = full OpenType container; 0x01 0x00 = bare CFF.
    const isOtto =
      bytes[0] === 0x4f && bytes[1] === 0x54 && bytes[2] === 0x54 && bytes[3] === 0x4f;
    const isCff = bytes[0] === 0x01 && bytes[1] === 0x00;
    if (!isOtto && !isCff) continue;
    if (!best || bytes.length > best.bytes.length) best = { bytes, isOtto, isCff };
  }
  return best;
}

async function runCase(label, chars, subset) {
  const bytes = await buildPdf(chars, subset);
  const source = chars.join('');
  const { text, zeroWidth, itemCount } = await extract(bytes);

  // Compare as multisets of code points: pdfjs may re-order or re-split runs,
  // but it must not lose or corrupt any character.
  const srcSet = [...source].sort().join('');
  const gotSet = [...text].sort().join('');
  const exact = text === source;
  const sameSet = srcSet === gotSet;
  const missing = [...source].filter((c) => !text.includes(c));

  // Independent check: how many glyph outlines actually shipped?
  const reloaded = await PDFDocument.load(bytes);
  const program = findFontProgram(reloaded);
  let glyphs = null;
  let programKind = 'none';
  if (program) {
    programKind = program.isOtto ? 'OTTO 容器' : '裸 CFF';
    glyphs = program.isOtto
      ? fontkit.create(Buffer.from(program.bytes)).numGlyphs
      : countCffGlyphs(Buffer.from(program.bytes));
  }

  return {
    label,
    kb: bytes.byteLength / 1024,
    itemCount,
    zeroWidth,
    exact,
    sameSet,
    missingCount: missing.length,
    missingSample: missing.slice(0, 15).join(''),
    extractedLen: text.length,
    sourceLen: source.length,
    programKind,
    glyphs,
  };
}

const { chars, origGlyphs } = pickCharacters();
console.log(`源字体字形数: ${origGlyphs}`);
console.log(`控制字符集  : ${chars.length} 个(均确认源字体有字形)`);
console.log(`示例        : ${chars.slice(0, 20).join('')}`);

const sub = await runCase('subset: true', chars, true);
const full = await runCase('subset: false (当前实现)', chars, false);

for (const r of [sub, full]) {
  console.log(`\n=== ${r.label} ===`);
  console.log(`  导出体积      : ${r.kb.toFixed(1)} KB`);
  console.log(`  提取字符数    : ${r.extractedLen} / ${r.sourceLen}`);
  console.log(`  text item 数  : ${r.itemCount}`);
  console.log(`  零宽度字形    : ${r.zeroWidth}`);
  console.log(`  逐字符全等    : ${r.exact ? '是' : '否'}`);
  console.log(`  字符集一致    : ${r.sameSet ? '是' : '否'}`);
  if (r.missingCount) console.log(`  丢失字符      : ${r.missingCount} 个 -> ${r.missingSample}`);
  console.log(`  字体程序      : ${r.programKind}`);
  console.log(`  字形轮廓数    : ${r.glyphs ?? '解析失败'}(期望 >= ${chars.length + 1})`);
}

console.log('\n--- 结论 ---');
const outlinesOk = sub.glyphs !== null && sub.glyphs >= chars.length + 1;
const subsetSafe =
  sub.sameSet && sub.zeroWidth === 0 && sub.missingCount === 0 && outlinesOk;
const control = full.sameSet && full.zeroWidth === 0;
if (!control) {
  console.log('对照组(subset:false)本身就没通过,说明是测试方法有问题,结论不可信。');
} else if (subsetSafe) {
  console.log(`子集化安全:${chars.length} 个汉字全部保留,无零宽字形,字形轮廓 ${sub.glyphs} 个。`);
  console.log(`体积:${sub.kb.toFixed(1)} KB vs ${full.kb.toFixed(1)} KB —— 相差 ${(full.kb / sub.kb).toFixed(0)}x。`);
  console.log('=> subset 可改为 true,直接消解 B2 + C1。');
} else if (!outlinesOk) {
  console.log('子集缺少字形轮廓 —— 文字可提取但可能渲染为空白/豆腐块。');
  console.log('=> 保留 subset:false,改为修订 README 中"子集化"的表述。');
} else {
  console.log('子集化确有损失,当前 subset:false 的选择成立。');
  console.log('=> 保留 subset:false,改为修订 README 中"子集化"的表述。');
}
