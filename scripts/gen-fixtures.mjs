// gen-fixtures.mjs — generate the validation sample PDFs (S1–S6) described in
// `docs/validation-plan.md` §2.
//
// Run: `node scripts/gen-fixtures.mjs`
// Output: `fixtures/*.pdf` (gitignored — regenerable, and S6 is intentionally
// multi-megabyte).
//
// Why a script instead of committed binaries: the CJK fixtures need the
// Source Han OTFs (8–12 MB each) and S6 must exceed 5 MB by design, so
// committing them would bloat the repo. Everything here is deterministic.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'fixtures');
const FONTS = join(ROOT, 'public', 'fonts');

// ---------------------------------------------------------------------------
// Minimal PNG encoder (no image dependency). Used to synthesise a "scanned
// page" for S5 and an embedded photo for S3.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode a raw RGB buffer (w*h*3, row-major) as a PNG. */
function encodePng(width, height, rgbBuf) {
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0; // filter type: none
    rgbBuf.copy(raw, y * stride + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Synthesise a page that *looks* like a scan: white paper, grey speckle noise,
 * and dark bars standing in for lines of text. Crucially there is no text
 * layer at all — that is the whole point of S5.
 */
function makeScanPng(width, height, seed) {
  const buf = Buffer.alloc(width * height * 3, 0xf7);
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const put = (x, y, v) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 3;
    buf[i] = v;
    buf[i + 1] = v;
    buf[i + 2] = v;
  };

  // Paper speckle.
  for (let i = 0; i < width * height * 0.02; i += 1) {
    put((rnd() * width) | 0, (rnd() * height) | 0, 200 + ((rnd() * 45) | 0));
  }

  // Heading bar (taller + wider) then body lines of varying length.
  const left = 60;
  let y = 70;
  for (let bar = 0; bar < 4; bar += 1) put(left + bar, y, 40); // thick heading
  for (let x = left; x < left + 260; x += 1) {
    for (let h = 0; h < 9; h += 1) put(x, y + h, 45);
  }
  y += 46;

  while (y < height - 70) {
    const len = 180 + ((rnd() * (width - left * 2 - 180)) | 0);
    for (let x = left; x < left + len; x += 1) {
      for (let h = 0; h < 5; h += 1) put(x, y + h, 60 + ((rnd() * 30) | 0));
    }
    y += 26 + ((rnd() * 8) | 0);
  }
  return encodePng(width, height, buf);
}

// ---------------------------------------------------------------------------
// Font helpers
// ---------------------------------------------------------------------------

function loadFontBytes(file) {
  return readFileSync(join(FONTS, file));
}

async function embedCjk(doc, file, subset) {
  doc.registerFontkit(fontkit);
  return doc.embedFont(loadFontBytes(file), { subset });
}

// ---------------------------------------------------------------------------
// S1 — pure Chinese, multiple font classes + bold
// ---------------------------------------------------------------------------

async function s1Chinese() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const sans = await embedCjk(doc, 'SourceHanSansCN-Regular.otf', true);
  const sansBold = await embedCjk(doc, 'SourceHanSansCN-Bold.otf', true);
  const serif = await embedCjk(doc, 'SourceHanSerifCN-Regular.otf', true);
  const serifBold = await embedCjk(doc, 'SourceHanSerifCN-Bold.otf', true);

  let y = 780;
  const line = (font, text, size = 16, color = rgb(0, 0, 0)) => {
    page.drawText(text, { x: 56, y, size, font, color });
    y -= size * 2.1;
  };

  line(sansBold, '中文验证样例 · 黑体标题', 22);
  line(sans, '这是思源黑体常规体的一段正文,用于验证字体映射。');
  line(sansBold, '这是思源黑体粗体的一段正文,用于验证粗体字重文件。');
  y -= 12;
  line(serifBold, '宋体标题 · 衬线测试', 20);
  line(serif, '这是思源宋体常规体的一段正文,应映射为 cjk-serif。');
  line(serifBold, '这是思源宋体粗体的一段正文,应使用真 Bold 字重。');
  y -= 12;
  line(sans, '标点测试:,。、;:!?「」『』()《》—— ……');
  line(sans, '数字混排:0123456789 金额 ¥1,234.56 占比 87%');

  writeFileSync(join(OUT, 's1-chinese.pdf'), await doc.save());
}

// ---------------------------------------------------------------------------
// S2 — mixed CJK + Latin, red and black in the SAME paragraph (ADR 0002)
// ---------------------------------------------------------------------------

async function s2MixedColor() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const sans = await embedCjk(doc, 'SourceHanSansCN-Regular.otf', true);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const red = rgb(0.85, 0.1, 0.1);
  const black = rgb(0, 0, 0);

  page.drawText('S2 · Span-level colour extraction', {
    x: 56, y: 790, size: 18, font: helv, color: black,
  });
  page.drawText('red text and black text share one paragraph', {
    x: 56, y: 766, size: 11, font: helv, color: rgb(0.4, 0.4, 0.4),
  });

  // One visual paragraph, two colours — drawn as adjacent runs on one baseline
  // so the detector must split it at span level, not block level.
  let x = 56;
  const y = 720;
  const runs = [
    { t: '本段前半部分为黑色文字,', f: sans, c: black },
    { t: '后半部分为红色文字,', f: sans, c: red },
    { t: '结尾又回到黑色。', f: sans, c: black },
  ];
  for (const r of runs) {
    page.drawText(r.t, { x, y, size: 15, font: r.f, color: r.c });
    x += r.f.widthOfTextAtSize(r.t, 15);
  }

  // A second paragraph mixing Latin + CJK, again with a red run in the middle.
  let x2 = 56;
  const y2 = 660;
  const runs2 = [
    { t: 'Mixed run: ', f: helv, c: black },
    { t: 'ERROR', f: helv, c: red },
    { t: ' — 中文继续,', f: sans, c: black },
    { t: 'WARN', f: helv, c: rgb(0.9, 0.55, 0.05) },
    { t: ' 结束。', f: sans, c: black },
  ];
  for (const r of runs2) {
    page.drawText(r.t, { x: x2, y: y2, size: 15, font: r.f, color: r.c });
    x2 += r.f.widthOfTextAtSize(r.t, 15);
  }

  writeFileSync(join(OUT, 's2-mixed-color.pdf'), await doc.save());
}

// ---------------------------------------------------------------------------
// S3 — 12 pages with images + table rules (vector preservation)
// ---------------------------------------------------------------------------

async function s3Multipage() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const photo = await doc.embedPng(makeScanPng(320, 200, 7));

  for (let i = 0; i < 12; i += 1) {
    const page = doc.addPage([595, 842]);
    page.drawText(`S3 · Page ${i + 1} / 12`, {
      x: 56, y: 790, size: 18, font: helv, color: rgb(0, 0, 0),
    });
    page.drawText('Multi-page fixture: vector rules + raster image per page.', {
      x: 56, y: 768, size: 10, font: helv, color: rgb(0.4, 0.4, 0.4),
    });

    // A 4x4 table drawn as vector rules — these MUST survive export.
    const x0 = 56, y0 = 640, cw = 120, rh = 26;
    for (let r = 0; r <= 4; r += 1) {
      page.drawLine({
        start: { x: x0, y: y0 - r * rh },
        end: { x: x0 + cw * 4, y: y0 - r * rh },
        thickness: 0.8, color: rgb(0.2, 0.2, 0.2),
      });
    }
    for (let c = 0; c <= 4; c += 1) {
      page.drawLine({
        start: { x: x0 + c * cw, y: y0 },
        end: { x: x0 + c * cw, y: y0 - rh * 4 },
        thickness: 0.8, color: rgb(0.2, 0.2, 0.2),
      });
    }
    for (let r = 0; r < 4; r += 1) {
      for (let c = 0; c < 4; c += 1) {
        page.drawText(`R${r + 1}C${c + 1}`, {
          x: x0 + c * cw + 8, y: y0 - r * rh - 17,
          size: 9, font: helv, color: rgb(0.15, 0.15, 0.15),
        });
      }
    }

    page.drawImage(photo, { x: 56, y: 300, width: 320, height: 200 });

    // Body text lines so text detection has something to chew on.
    for (let l = 0; l < 10; l += 1) {
      page.drawText(
        `Body line ${l + 1} on page ${i + 1}. The quick brown fox jumps over the lazy dog.`,
        { x: 56, y: 250 - l * 18, size: 11, font: helv, color: rgb(0, 0, 0) }
      );
    }
  }
  writeFileSync(join(OUT, 's3-multipage.pdf'), await doc.save());
}

// ---------------------------------------------------------------------------
// S4 — AcroForm: text / checkbox / radio / dropdown
// ---------------------------------------------------------------------------

async function s4AcroForm() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();

  page.drawText('S4 · AcroForm fixture', {
    x: 56, y: 790, size: 18, font: helv, color: rgb(0, 0, 0),
  });
  page.drawText('Expected: the app reads these fields and can write values back.', {
    x: 56, y: 768, size: 10, font: helv, color: rgb(0.4, 0.4, 0.4),
  });

  const label = (t, y) =>
    page.drawText(t, { x: 56, y, size: 11, font: helv, color: rgb(0, 0, 0) });

  label('Full name (text field)', 720);
  const name = form.createTextField('full_name');
  name.setText('Jane Doe');
  name.addToPage(page, { x: 56, y: 692, width: 260, height: 20 });

  label('Subscribe to newsletter (checkbox)', 650);
  const cb = form.createCheckBox('subscribe');
  cb.addToPage(page, { x: 56, y: 622, width: 16, height: 16 });

  label('Plan (radio group)', 590);
  const radio = form.createRadioGroup('plan');
  radio.addOptionToPage('free', page, { x: 56, y: 562, width: 16, height: 16 });
  radio.addOptionToPage('pro', page, { x: 156, y: 562, width: 16, height: 16 });
  radio.addOptionToPage('team', page, { x: 256, y: 562, width: 16, height: 16 });

  label('City (dropdown)', 530);
  const dd = form.createDropdown('city');
  dd.setOptions(['Beijing', 'Shanghai', 'Shenzhen']);
  dd.addToPage(page, { x: 56, y: 502, width: 160, height: 20 });

  writeFileSync(join(OUT, 's4-acroform.pdf'), await doc.save());
}

// ---------------------------------------------------------------------------
// S5 — scan-like: image only, NO text layer
// ---------------------------------------------------------------------------

async function s5Scanned() {
  const doc = await PDFDocument.create();
  const scan = await doc.embedPng(makeScanPng(1000, 1400, 42));
  for (let i = 0; i < 2; i += 1) {
    const page = doc.addPage([595, 842]);
    page.drawImage(scan, { x: 0, y: 0, width: 595, height: 842 });
  }
  writeFileSync(join(OUT, 's5-scanned.pdf'), await doc.save());
}

// ---------------------------------------------------------------------------
// S6 — 25 pages, > 5 MB (full font embed, matching the app's subset:false)
// ---------------------------------------------------------------------------

async function s6Large() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  // subset:false on an 8 MB OTF — this is exactly what the app does on export
  // (see finding B2), and it is what pushes this fixture past 5 MB.
  const sans = await embedCjk(doc, 'SourceHanSansCN-Regular.otf', false);

  for (let i = 0; i < 25; i += 1) {
    const page = doc.addPage([595, 842]);
    page.drawText(`S6 · Page ${i + 1} / 25`, {
      x: 56, y: 790, size: 18, font: helv, color: rgb(0, 0, 0),
    });
    page.drawText(`第 ${i + 1} 页 · 大文档导出耗时与内存测试`, {
      x: 56, y: 762, size: 13, font: sans, color: rgb(0, 0, 0),
    });
    for (let l = 0; l < 26; l += 1) {
      page.drawText(
        `第 ${l + 1} 行:这是用于验证导出性能的中文正文内容,包含足够多的文本块以触发逐块检测与重画。`,
        { x: 56, y: 726 - l * 24, size: 11, font: sans, color: rgb(0, 0, 0) }
      );
    }
  }
  writeFileSync(join(OUT, 's6-large.pdf'), await doc.save());
}

// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(OUT, { recursive: true });
  const jobs = [
    ['S1 纯中文(黑体/宋体/粗体)', 's1-chinese.pdf', s1Chinese],
    ['S2 中英混排 + 段内红黑混色', 's2-mixed-color.pdf', s2MixedColor],
    ['S3 多页 + 图片 + 表格线', 's3-multipage.pdf', s3Multipage],
    ['S4 AcroForm 四类字段', 's4-acroform.pdf', s4AcroForm],
    ['S5 扫描件(无文字层)', 's5-scanned.pdf', s5Scanned],
    ['S6 25 页大文档(>5MB)', 's6-large.pdf', s6Large],
  ];
  for (const [label, file, fn] of jobs) {
    await fn();
    const { size } = statSync(join(OUT, file));
    console.log(
      `${label.padEnd(28)} -> fixtures/${file.padEnd(22)} ${(size / 1024).toFixed(0)} KB`
    );
  }
  console.log('\nDone. Fixtures written to fixtures/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
