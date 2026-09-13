// experiment-redact.mjs — decide what MuPDF's `applyRedactions` parameters
// actually do, before we expose redaction as a user-facing tool.
//
// Why this matters: the project already calls
//   page.applyRedactions(false, 0, 0, 0)
// for its internal text-edit path, and the comment says "只删文字" (text only).
// If we reuse that call for a user-facing 「涂黑 / 密文」 tool, we ship FAKE
// redaction: the black box appears, the text underneath is byte-removed, but
// any image or vector art under the box survives intact. That is precisely the
// anti-pattern the competitive analysis warns about ("AI 标记 ≠ 脱敏").
//
// The mupdf.d.ts constants are:
//   REDACT_IMAGE_NONE = 0  REMOVE = 1  PIXELS = 2  UNLESS_INVISIBLE = 3
//   REDACT_LINE_ART_NONE = 0  REMOVE_IF_COVERED = 1  REMOVE_IF_TOUCHED = 2
//   REDACT_TEXT_REMOVE = 0  NONE = 1
//
// Two independent checks, so a single flaky signal cannot mislead us:
//
//   A. TEXT  — extract text with pdfjs (NOT MuPDF) and assert the covered
//              string is gone while an uncovered one survives.
//   B. PIXELS — render the page and sample actual pixel colours, to prove the
//              image's covered half is blanked while its uncovered half is
//              untouched, and that vector art is removed.
//
// A CONTROL run with the legacy text-only parameters (false, 0, 0, 0) is
// included: image and vector art MUST survive there. Without the control, a
// passing aggressive run would not prove the parameters were responsible.
//
// The pixel checks also validate the COORDINATE CONVENTION used by
// core/writer/redact.ts: rects are passed in y-down-from-top page space and
// handed to setQuadPoints without conversion. If that assumption were wrong,
// the redaction would land in the wrong place and the "secret" text would
// survive — the most dangerous possible failure mode.
//
// Run: `node scripts/experiment-redact.mjs`
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { deflateSync } from 'node:zlib';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  '../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
  import.meta.url
).href;

const PAGE_W = 595;
const PAGE_H = 842;

// ---------------------------------------------------------------------------
// Minimal PNG encoder (same approach as gen-fixtures.mjs — no image deps).
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
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
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

function encodePng(width, height, rgbBuf) {
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    rgbBuf.copy(raw, y * stride + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Left half pure red, right half pure blue — so we can tell which half was hit. */
function makeSplitPng(width, height) {
  const buf = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      const left = x < width / 2;
      buf[i] = left ? 220 : 0;
      buf[i + 1] = 0;
      buf[i + 2] = left ? 0 : 220;
    }
  }
  return encodePng(width, height, buf);
}

// ---------------------------------------------------------------------------
// Layout — everything expressed in y-DOWN-from-top page space, which is the
// space core/writer/redact.ts feeds to setQuadPoints.
// ---------------------------------------------------------------------------

const LAYOUT = {
  // "SECRETTOKEN" text, top-left.
  secret: { x: 60, y: 95, w: 140, h: 22 },
  // "KEEPME" text further down — must never be touched.
  keep: { x: 60, y: 195, w: 140, h: 22 },
  // Embedded image: 200x100 pt, left half red / right half blue.
  image: { x: 60, y: 300, w: 200, h: 100 },
  // Vector art (magenta stroked box).
  vector: { x: 60, y: 500, w: 200, h: 60 },
};

/** Redaction boxes: cover the secret text, the image's LEFT half, the vector. */
const REDACT_BOXES = [
  LAYOUT.secret,
  { x: LAYOUT.image.x - 5, y: LAYOUT.image.y - 5, w: 110, h: LAYOUT.image.h + 10 },
  { x: LAYOUT.vector.x - 5, y: LAYOUT.vector.y - 5, w: LAYOUT.vector.w + 10, h: LAYOUT.vector.h + 10 },
];

/** y-down top-left rect -> pdf-lib (y-up) baseline/box. */
const flipY = (topY, h) => PAGE_H - topY - h;

async function buildPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  page.drawText('SECRETTOKEN', {
    x: LAYOUT.secret.x,
    y: flipY(LAYOUT.secret.y, 14) + 4,
    size: 14,
    font,
    color: rgb(0, 0, 0),
  });
  page.drawText('KEEPME', {
    x: LAYOUT.keep.x,
    y: flipY(LAYOUT.keep.y, 14) + 4,
    size: 14,
    font,
    color: rgb(0, 0, 0),
  });

  const png = await doc.embedPng(makeSplitPng(200, 100));
  page.drawImage(png, {
    x: LAYOUT.image.x,
    y: flipY(LAYOUT.image.y, LAYOUT.image.h),
    width: LAYOUT.image.w,
    height: LAYOUT.image.h,
  });

  // Vector art: a stroked rectangle (a "chart axis" stand-in).
  page.drawRectangle({
    x: LAYOUT.vector.x,
    y: flipY(LAYOUT.vector.y, LAYOUT.vector.h),
    width: LAYOUT.vector.w,
    height: LAYOUT.vector.h,
    borderColor: rgb(1, 0, 1),
    borderWidth: 6,
  });

  return doc.save();
}

// ---------------------------------------------------------------------------
// MuPDF redaction
// ---------------------------------------------------------------------------

const IMAGE = { NONE: 0, REMOVE: 1, PIXELS: 2, UNLESS_INVISIBLE: 3 };
const LINE_ART = { NONE: 0, REMOVE_IF_COVERED: 1, REMOVE_IF_TOUCHED: 2 };
const TEXT = { REMOVE: 0, NONE: 1 };

async function redact(bytes, boxes, params) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
  const pdfDoc = doc.asPDF();
  const page = pdfDoc.loadPage(0);

  const quads = boxes.map((b) => [
    b.x, b.y,
    b.x + b.w, b.y,
    b.x, b.y + b.h,
    b.x + b.w, b.y + b.h,
  ]);
  const annot = page.createAnnotation('Redact');
  annot.setQuadPoints(quads);
  page.applyRedactions(
    params.blackBoxes,
    params.imageMethod,
    params.lineArtMethod,
    params.textMethod
  );
  annot.destroy();
  page.destroy();

  const out = pdfDoc.saveToBuffer().asUint8Array();
  doc.destroy();
  return out;
}

/**
 * Apply SEVERAL redaction annotations to one page, each with its own parameter
 * set. A single page legitimately carries both kinds: text-only boxes from the
 * text-editing path, and aggressive boxes from the user-facing redact tool.
 * If MuPDF cannot honour per-annotation parameters in one pass, the export
 * pipeline must run two sequential passes instead.
 */
async function redactGroups(bytes, groups) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
  const pdfDoc = doc.asPDF();
  const page = pdfDoc.loadPage(0);

  for (const g of groups) {
    const quads = g.boxes.map((b) => [
      b.x, b.y,
      b.x + b.w, b.y,
      b.x, b.y + b.h,
      b.x + b.w, b.y + b.h,
    ]);
    const annot = page.createAnnotation('Redact');
    annot.setQuadPoints(quads);
    page.applyRedactions(
      g.params.blackBoxes,
      g.params.imageMethod,
      g.params.lineArtMethod,
      g.params.textMethod
    );
    annot.destroy();
  }
  page.destroy();

  const out = pdfDoc.saveToBuffer().asUint8Array();
  doc.destroy();
  return out;
}

const AGGRESSIVE = {
  label: 'aggressive (blackBoxes=false, image=PIXELS, lineArt=REMOVE_IF_TOUCHED, text=REMOVE)',
  blackBoxes: false,
  imageMethod: IMAGE.PIXELS,
  lineArtMethod: LINE_ART.REMOVE_IF_TOUCHED,
  textMethod: TEXT.REMOVE,
};

const LEGACY_TEXT_ONLY = {
  label: 'legacy text-only (false, 0, 0, 0)',
  blackBoxes: false,
  imageMethod: IMAGE.NONE,
  lineArtMethod: LINE_ART.NONE,
  textMethod: TEXT.REMOVE,
};

// ---------------------------------------------------------------------------
// Verification helpers
// ---------------------------------------------------------------------------

async function extractText(bytes) {
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    isEvalSupported: false,
  });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    return content.items.map((it) => it.str).join('');
  } finally {
    await task.destroy();
  }
}

async function renderSampler(bytes) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
  const page = doc.loadPage(0);
  const pix = page.toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceRGB, false, true);
  const w = pix.getWidth();
  const h = pix.getHeight();
  const n = pix.getNumberOfComponents();
  const px = pix.getPixels();
  const sampler = (x, y) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return null;
    const i = (yi * w + xi) * n;
    return [px[i], px[i + 1], px[i + 2]];
  };
  page.destroy();
  doc.destroy();
  return { sampler, w, h };
}

/** Count pixels in a y-down rect matching a predicate, sampling on a grid. */
function countIn(sampler, rect, predicate, step = 2) {
  let hit = 0;
  let total = 0;
  for (let y = rect.y; y < rect.y + rect.h; y += step) {
    for (let x = rect.x; x < rect.x + rect.w; x += step) {
      const c = sampler(x, y);
      if (!c) continue;
      total += 1;
      if (predicate(c)) hit += 1;
    }
  }
  return { hit, total };
}

const isRed = ([r, g, b]) => r > 170 && g < 90 && b < 90;
const isBlue = ([r, g, b]) => b > 170 && r < 90 && g < 90;
const isMagenta = ([r, g, b]) => r > 150 && b > 150 && g < 100;

// Left half of the image, inset so we sample interior pixels only.
const IMG_LEFT = { x: LAYOUT.image.x + 10, y: LAYOUT.image.y + 10, w: 70, h: LAYOUT.image.h - 20 };
const IMG_RIGHT = { x: LAYOUT.image.x + 120, y: LAYOUT.image.y + 10, w: 70, h: LAYOUT.image.h - 20 };

// ---------------------------------------------------------------------------

let failures = 0;
function check(label, condition, detail) {
  const ok = !!condition;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

async function main() {
  const original = await buildPdf();
  console.log(`built test PDF: ${original.byteLength} bytes, ${REDACT_BOXES.length} redaction boxes\n`);

  // ---- Baseline render (before any redaction) -----------------------------
  const before = await renderSampler(original);
  const beforeText = await extractText(original);
  const beforeRed = countIn(before.sampler, IMG_LEFT, isRed);
  const beforeBlue = countIn(before.sampler, IMG_RIGHT, isBlue);
  const beforeMagenta = countIn(before.sampler, LAYOUT.vector, isMagenta);

  console.log('BASELINE (no redaction)');
  console.log(`  text extracted      : ${JSON.stringify(beforeText)}`);
  console.log(`  image left  (red)   : ${beforeRed.hit}/${beforeRed.total} sampled px`);
  console.log(`  image right (blue)  : ${beforeBlue.hit}/${beforeBlue.total} sampled px`);
  console.log(`  vector   (magenta)  : ${beforeMagenta.hit}/${beforeMagenta.total} sampled px`);
  check('baseline contains SECRETTOKEN', beforeText.includes('SECRETTOKEN'));
  check('baseline image left half is red', beforeRed.hit > beforeRed.total * 0.8);
  check('baseline image right half is blue', beforeBlue.hit > beforeBlue.total * 0.8);
  // The vector art is a *stroked* rectangle, so only its outline is magenta —
  // roughly 13% of the sampled area, not the >30% a filled shape would give.
  check(
    'baseline vector art is magenta',
    beforeMagenta.hit > beforeMagenta.total * 0.05,
    `${beforeMagenta.hit}/${beforeMagenta.total} px`
  );

  // ---- Run both parameter sets -------------------------------------------
  const runs = [
    { params: LEGACY_TEXT_ONLY, expectImagesRemoved: false },
    { params: AGGRESSIVE, expectImagesRemoved: true },
  ];

  for (const run of runs) {
    console.log(`\n=== ${run.params.label} ===`);
    const out = await redact(original, REDACT_BOXES, run.params);
    const text = await extractText(out);
    const after = await renderSampler(out);
    const red = countIn(after.sampler, IMG_LEFT, isRed);
    const blue = countIn(after.sampler, IMG_RIGHT, isBlue);
    const magenta = countIn(after.sampler, LAYOUT.vector, isMagenta);

    console.log(`  text extracted      : ${JSON.stringify(text)}`);
    console.log(`  image left  (red)   : ${red.hit}/${red.total} sampled px`);
    console.log(`  image right (blue)  : ${blue.hit}/${blue.total} sampled px`);
    console.log(`  vector   (magenta)  : ${magenta.hit}/${magenta.total} sampled px`);

    // A — text. Independent of MuPDF (pdfjs does the extraction).
    check('covered text SECRETTOKEN removed', !text.includes('SECRETTOKEN'));
    check('uncovered text KEEPME survives', text.includes('KEEPME'));

    // B — pixels.
    if (run.expectImagesRemoved) {
      check(
        'covered image half blanked',
        red.hit < beforeRed.hit * 0.1,
        `${beforeRed.hit} -> ${red.hit}`
      );
      check(
        'uncovered image half untouched',
        blue.hit > beforeBlue.hit * 0.8,
        `${beforeBlue.hit} -> ${blue.hit}`
      );
      check(
        'vector art touching box removed',
        magenta.hit < beforeMagenta.hit * 0.1,
        `${beforeMagenta.hit} -> ${magenta.hit}`
      );
    } else {
      // Control: proves the parameters — not something incidental — are what
      // removes image/vector content.
      check(
        'CONTROL: image survives text-only params',
        red.hit > beforeRed.hit * 0.8,
        `${beforeRed.hit} -> ${red.hit}`
      );
      check(
        'CONTROL: vector art survives text-only params',
        magenta.hit > beforeMagenta.hit * 0.8,
        `${beforeMagenta.hit} -> ${magenta.hit}`
      );
    }
  }

  // ---- Mixed per-annotation parameters on ONE page ------------------------
  // This is the real export scenario: a page can carry text-only boxes (text
  // editing) and aggressive boxes (redact tool) simultaneously. If MuPDF
  // honoured only the last parameter set, the vector art would vanish here.
  console.log('\n=== mixed: text-only box + aggressive box on the same page ===');
  const mixed = await redactGroups(original, [
    { boxes: [LAYOUT.secret], params: LEGACY_TEXT_ONLY },
    {
      boxes: [{ x: LAYOUT.image.x - 5, y: LAYOUT.image.y - 5, w: 110, h: LAYOUT.image.h + 10 }],
      params: AGGRESSIVE,
    },
  ]);
  const mixedText = await extractText(mixed);
  const mixedSampler = await renderSampler(mixed);
  const mixedRed = countIn(mixedSampler.sampler, IMG_LEFT, isRed);
  const mixedBlue = countIn(mixedSampler.sampler, IMG_RIGHT, isBlue);
  const mixedMagenta = countIn(mixedSampler.sampler, LAYOUT.vector, isMagenta);

  console.log(`  text extracted      : ${JSON.stringify(mixedText)}`);
  console.log(`  image left  (red)   : ${mixedRed.hit}/${mixedRed.total} sampled px`);
  console.log(`  image right (blue)  : ${mixedBlue.hit}/${mixedBlue.total} sampled px`);
  console.log(`  vector   (magenta)  : ${mixedMagenta.hit}/${mixedMagenta.total} sampled px`);

  check('mixed: text-only box still removed its text', !mixedText.includes('SECRETTOKEN'));
  check('mixed: untouched text survives', mixedText.includes('KEEPME'));
  check(
    'mixed: aggressive box blanked image pixels',
    mixedRed.hit < beforeRed.hit * 0.1,
    `${beforeRed.hit} -> ${mixedRed.hit}`
  );
  check(
    'mixed: uncovered image half untouched',
    mixedBlue.hit > beforeBlue.hit * 0.8,
    `${beforeBlue.hit} -> ${mixedBlue.hit}`
  );
  check(
    'mixed: vector art NOT touched (no box over it)',
    mixedMagenta.hit > beforeMagenta.hit * 0.8,
    `${beforeMagenta.hit} -> ${mixedMagenta.hit}`
  );

  console.log(
    `\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('experiment failed:', err);
  process.exit(1);
});
