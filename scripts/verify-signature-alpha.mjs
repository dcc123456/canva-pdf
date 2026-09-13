// Verify that a signature saved as a transparent PNG really is transparent
// once it is embedded in the exported PDF — i.e. it does NOT paint an opaque
// white box over whatever is underneath.
//
// This reproduces the exact export path (core/writer/flatten.ts → drawImageItem:
// `doc.embedPng(bytes)` + `page.drawImage(...)`) and then renders the result
// with MuPDF to read actual pixels.
//
// A control group is included, because "the region looks dark" cannot by itself
// distinguish "the PNG is transparent" from "the PNG is opaque white and I
// sampled the wrong spot". The control embeds an identical PNG whose background
// is opaque WHITE — the old buggy behaviour — and the checks require the two to
// render differently.
//
// Usage: node scripts/verify-signature-alpha.mjs
import zlib from 'node:zlib';

const mupdf = await import('mupdf');
const { PDFDocument } = await import('pdf-lib');

// ---------------------------------------------------------------------------
// Minimal PNG encoder (RGBA, 8-bit). pdf-lib's embedPng needs a real PNG, and
// the browser canvas is not available in Node, so we build one by hand.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** pixel(x, y) -> [r, g, b, a]; y = 0 is the TOP row. */
function makePng(w, h, pixel) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  let o = 0;
  for (let y = 0; y < h; y += 1) {
    raw[o++] = 0; // filter type: none
    for (let x = 0; x < w; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', zlib.deflateSync(raw)),
      pngChunk('IEND', Buffer.alloc(0)),
    ])
  );
}

const SIZE = 64;
const BLOCK = 16; // the "ink" is a 16x16 blue square in the top-left corner
const INK = [0, 0, 255];

/** @param opaqueBackground paint an opaque white background (the old bug). */
function signaturePng(opaqueBackground) {
  return makePng(SIZE, SIZE, (x, y) => {
    if (x < BLOCK && y < BLOCK) return [...INK, 255];
    return opaqueBackground ? [255, 255, 255, 255] : [0, 0, 0, 0];
  });
}

// ---------------------------------------------------------------------------
// Build a PDF: solid black page content, then the signature PNG on top.
// ---------------------------------------------------------------------------

const PAGE = 200;
// Where the PNG is placed, in pdf-lib (y-up) coordinates.
// NB: pdf-lib's drawImage takes `width` / `height`, not `w` / `h` — passing the
// wrong keys silently falls back to the image's natural size and the checks
// below then sample empty space.
const IMG = { x: 50, y: 50, width: 100, height: 100 };

async function buildPdf(pngBytes) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE, PAGE]);
  // Solid black block covering everything the image will overlap.
  page.drawRectangle({
    x: 20,
    y: 20,
    width: 160,
    height: 160,
    color: (await import('pdf-lib')).rgb(0, 0, 0),
  });
  // Exact same call as flatten.ts drawImageItem.
  const embedded = await doc.embedPng(pngBytes);
  page.drawImage(embedded, IMG);
  return doc.save();
}

// ---------------------------------------------------------------------------
// Render with MuPDF and sample pixels.
// ---------------------------------------------------------------------------

async function render(bytes) {
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
  const page = doc.loadPage(0);
  const scale = 2;
  const pix = page.toPixmap(
    mupdf.Matrix.scale(scale, scale),
    mupdf.ColorSpace.DeviceRGB,
    false,
    true
  );
  const w = pix.getWidth();
  const h = pix.getHeight();
  const n = pix.getNumberOfComponents();
  // Copy before destroy: getPixels() is a view onto document-owned memory.
  const px = Uint8Array.from(pix.getPixels());
  page.destroy();
  doc.destroy();

  /** Sample a point given in page space (y-UP, matching pdf-lib). */
  function atPage(px_, py) {
    const x = Math.round(px_ * scale);
    const y = Math.round((PAGE - py) * scale);
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    const i = (y * w + x) * n;
    return [px[i], px[i + 1], px[i + 2]];
  }
  return { atPage, w, h };
}

const isBlack = (c) => c[0] < 60 && c[1] < 60 && c[2] < 60;
const isWhite = (c) => c[0] > 200 && c[1] > 200 && c[2] > 200;
const isBlue = (c) => c[2] > 180 && c[0] < 90 && c[1] < 90;

// PNG top-left quarter (the blue ink) lands here in page space:
//   x: 50 .. 50 + 100 * (16/64) = 75      y: 100 .. 150
const INK_POINT = { x: 62, y: 130 };
// The opposite corner of the image — transparent in variant A.
const CLEAR_POINT = { x: 135, y: 65 };

const transparent = await render(await buildPdf(signaturePng(false)));
const opaque = await render(await buildPdf(signaturePng(true)));

const tInk = transparent.atPage(INK_POINT.x, INK_POINT.y);
const tClear = transparent.atPage(CLEAR_POINT.x, CLEAR_POINT.y);
const oInk = opaque.atPage(INK_POINT.x, INK_POINT.y);
const oClear = opaque.atPage(CLEAR_POINT.x, CLEAR_POINT.y);

const fmt = (c) => (c ? `rgb(${c.join(',')})` : 'out of bounds');

console.log('Sample points (page space, y-up):');
console.log(`  ink   ${INK_POINT.x},${INK_POINT.y}   clear ${CLEAR_POINT.x},${CLEAR_POINT.y}\n`);
console.log('Transparent signature PNG (the fix):');
console.log(`  under ink   : ${fmt(tInk)}`);
console.log(`  under clear : ${fmt(tClear)}`);
console.log('\nOpaque-white signature PNG (control = the old bug):');
console.log(`  under ink   : ${fmt(oInk)}`);
console.log(`  under clear : ${fmt(oClear)}`);

const checks = [
  ['signature ink is actually drawn (blue block visible)', isBlue(tInk), fmt(tInk)],
  [
    'transparent area lets the page content through (still black)',
    isBlack(tClear),
    fmt(tClear),
  ],
  [
    'control reproduces the old bug: opaque background covers the page (white)',
    isWhite(oClear),
    fmt(oClear),
  ],
  [
    'control draws its ink the same way (proves the two differ only by alpha)',
    isBlue(oInk),
    fmt(oInk),
  ],
];

let fail = 0;
console.log('');
for (const [label, ok, detail] of checks) {
  if (!ok) fail += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} — ${detail}`);
}

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : `${fail} CHECK(S) FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
