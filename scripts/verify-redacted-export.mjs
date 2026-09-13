// Verify a redacted PDF exported by the app: the region the user covered must
// have its content erased, and everything outside must be untouched.
//
// Usage:
//   node scripts/verify-redacted-export.mjs [exported.pdf] [original.pdf]
// Defaults target a manual browser check of fixture S5 (the scanned, image-only
// page): load it in the app, drag a 「涂黑」 box over the top of the scan,
// export, then point this script at the downloaded file.
//
// The rect must match what you dragged, in y-down page space — read it off the
// Inspector's X / Y / W / H fields.
import { readFileSync } from 'node:fs';

const OUT = process.argv[2] ?? '/private/tmp/redacted-s5.pdf';
const ORIG =
  process.argv[3] ??
  new URL('../fixtures/s5-scanned.pdf', import.meta.url).pathname;

// Rect the user dragged, in y-down page space (from the Inspector readout).
const REDACT = { x: 8, y: 20, w: 292, h: 130 };

const mupdf = await import('mupdf');

async function sampler(path) {
  return samplerBytes(new Uint8Array(readFileSync(path)));
}

/**
 * Apply the SAME redaction parameters core/writer/redact.ts uses for 'full'
 * mode, but draw no black box — so any change in the region can only come from
 * the content itself being erased.
 */
async function redactNoBox(path, rect) {
  const doc = mupdf.Document.openDocument(
    new Uint8Array(readFileSync(path)),
    'application/pdf'
  );
  const page = doc.asPDF().loadPage(0);
  const annot = page.createAnnotation('Redact');
  annot.setQuadPoints([
    [
      rect.x, rect.y,
      rect.x + rect.w, rect.y,
      rect.x, rect.y + rect.h,
      rect.x + rect.w, rect.y + rect.h,
    ],
  ]);
  // Mirrors PARAMS.full in src/core/writer/redact.ts.
  page.applyRedactions(false, 2, 2, 0);
  annot.destroy();
  page.destroy();
  const out = doc.asPDF().saveToBuffer().asUint8Array();
  doc.destroy();
  return out;
}

async function samplerBytes(bytes) {
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
  const page = doc.loadPage(0);
  const pix = page.toPixmap(
    mupdf.Matrix.scale(1, 1),
    mupdf.ColorSpace.DeviceRGB,
    false,
    true
  );
  const w = pix.getWidth();
  const h = pix.getHeight();
  const n = pix.getNumberOfComponents();
  // COPY the pixels before destroying the document: `getPixels()` returns a
  // view onto memory owned by the document, so it becomes garbage the moment
  // we destroy it (which showed up as NaN luminances, not as an error).
  const px = Uint8Array.from(pix.getPixels());
  page.destroy();
  doc.destroy();
  const at = (x, y) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return null;
    const i = (yi * w + xi) * n;
    if (i + 2 >= px.length) return null;
    return [px[i], px[i + 1], px[i + 2]];
  };
  return { at, w, h };
}

/** Count "ink" pixels (dark) in a y-down rect. */
function countInk(s, rect, step = 1) {
  let ink = 0;
  let total = 0;
  for (let y = rect.y; y < rect.y + rect.h; y += step) {
    for (let x = rect.x; x < rect.x + rect.w; x += step) {
      const c = s.at(x, y);
      if (!c) continue;
      total += 1;
      if (c[0] < 150 && c[1] < 150 && c[2] < 150) ink += 1;
    }
  }
  return { ink, total };
}

const a = await sampler(ORIG);
const b = await sampler(OUT);
console.log(`page size: ${a.w} x ${a.h} (original), ${b.w} x ${b.h} (exported)\n`);

// Inside the redacted rect: after export the box is filled with the redact
// colour (black), so "ink" stays high — what matters is that it is now a FLAT
// fill, not the original texture. Sample the variance instead.
function stats(s, rect, step = 1) {
  let n = 0;
  let sum = 0;
  const vals = [];
  for (let y = rect.y; y < rect.y + rect.h; y += step) {
    for (let x = rect.x; x < rect.x + rect.w; x += step) {
      const c = s.at(x, y);
      if (!c) continue;
      n += 1;
      const lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
      sum += lum;
      vals.push(lum);
    }
  }
  const mean = sum / n;
  const variance = vals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
  return { n, mean, std: Math.sqrt(variance) };
}

// A region well below the redaction — must be byte-identical in spirit.
const UNTOUCHED = { x: 8, y: 400, w: 292, h: 120 };

const origIn = stats(a, REDACT);
const outIn = stats(b, REDACT);
const origOut = stats(a, UNTOUCHED);
const outOut = stats(b, UNTOUCHED);

console.log('INSIDE the redacted rect (y 20..150):');
console.log(`  original : mean lum ${origIn.mean.toFixed(1)}, std ${origIn.std.toFixed(1)}`);
console.log(`  exported : mean lum ${outIn.mean.toFixed(1)}, std ${outIn.std.toFixed(1)}`);
console.log('\nOUTSIDE / below the redaction (y 400..520):');
console.log(`  original : mean lum ${origOut.mean.toFixed(1)}, std ${origOut.std.toFixed(1)}`);
console.log(`  exported : mean lum ${outOut.mean.toFixed(1)}, std ${outOut.std.toFixed(1)}`);

const inkOrig = countInk(a, REDACT);
const inkOut = countInk(b, REDACT);
console.log(
  `\nink pixels inside rect: original ${inkOrig.ink}/${inkOrig.total}, exported ${inkOut.ink}/${inkOut.total}`
);

const checks = [
  [
    'redacted region is now a FLAT fill (std collapses)',
    outIn.std < origIn.std * 0.25,
    `${origIn.std.toFixed(1)} -> ${outIn.std.toFixed(1)}`,
  ],
  [
    'redacted region is dark (the black box)',
    outIn.mean < 90,
    `mean ${outIn.mean.toFixed(1)}`,
  ],
  [
    'region below the redaction still has texture (not over-deleted)',
    outOut.std > origOut.std * 0.5,
    `${origOut.std.toFixed(1)} -> ${outOut.std.toFixed(1)}`,
  ],
];

let fail = 0;
console.log('');
for (const [label, ok, detail] of checks) {
  if (!ok) fail += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// The pixel test above CANNOT distinguish "image data removed" from "opaque
// black rectangle painted on top of intact image data" — both render as flat
// black. That is the fake-redaction trap, so we need a check where nothing can
// hide the underlying pixels.
//
// Run the same redaction on the same real fixture WITHOUT drawing any box.
// blackBoxes=false and no flatten step means the only thing that can change the
// region is the image content itself being erased.
// ---------------------------------------------------------------------------
console.log('\n--- isolation check: real fixture, redaction with NO box drawn ---');

const stripped = await redactNoBox(ORIG, REDACT);
const c = await samplerBytes(stripped);
const inStats = stats(c, REDACT);
console.log(
  `  region after redaction-only: mean lum ${inStats.mean.toFixed(1)}, std ${inStats.std.toFixed(1)}`
);
const isoOk = inStats.std < origIn.std * 0.25 && inStats.mean > 150;
if (!isoOk) fail += 1;
console.log(
  `  ${isoOk ? 'PASS' : 'FAIL'}  underlying scan data erased (region turned blank paper, no box involved) — std ${origIn.std.toFixed(1)} -> ${inStats.std.toFixed(1)}, mean -> ${inStats.mean.toFixed(1)}`
);

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : `${fail} CHECK(S) FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
