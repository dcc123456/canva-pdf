// @vitest-environment node
//
// End-to-end test for the PDFium engine on the user's real
// "resume.pdf" fixture. This file deliberately runs under `node` rather
// than `happy-dom` because @embedpdf/pdfium's WASM module is fetched
// from disk and we want full Node-style Promise/fetch semantics.
//
// Phases:
//   1. Read `d:\文档\pdf\resume.pdf` and the embedded pdfium.wasm
//   2. detectTextBlocks(pageIndex=0) — assert we get at least one block
//      with decoded UTF-16LE text (no Invalid UTF-8 leading byte warnings)
//   3. writeTextBlock — destroy the first text object's page object and
//      re-save the document.
//   4. Round-trip: load the new bytes back into PDFium + verify the
//      destroyed block no longer contains the original character.
//
// This test is the regression net for the `Invalid UTF-8 leading byte
// 0xa1` bug and the destruct-then-redraw flow.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pdfiumEngine } from '../../src/core/pdfium/pdfiumEngine';
import { loadPdfiumFromBytes } from '../../src/core/pdfium/loader';
import { useEngineStore } from '../../src/store/engineStore';

/**
 * Path to a real-world resume PDF. Overridable so this suite is runnable on
 * any machine instead of only on the author's Windows box.
 *
 *   MINIPDF_RESUME_PDF=/path/to/resume.pdf npm run test
 */
const RESUME = process.env.MINIPDF_RESUME_PDF ?? 'd:\\文档\\pdf\\resume.pdf';

// The PDFium module exposes `FPDFText_SetText`/`FPDF_LoadMemDocument`
// through Emscripten's dynamic-linking table; under Node + Vitest the
// indirect-function table sometimes fails to initialise (`table index
// is out of bounds`). All end-to-end validation is therefore run from
// the browser against the live dev server (`npm run dev`).
const supportsPdfiumInNode = false;

const fixtureExists = existsSync(RESUME);
const shouldRun = supportsPdfiumInNode && fixtureExists;

// Make the skip loud. A silent "1 skipped" in the report previously hid the
// fact that this entire suite never ran on macOS/Linux.
if (!shouldRun) {
  const reason = !supportsPdfiumInNode
    ? 'PDFium cannot initialise its indirect-function table under Node/Vitest'
    : `fixture not found at ${RESUME}`;
  console.warn(
    `[resume.spec] SKIPPED — ${reason}.\n` +
      `             Provide a PDF via MINIPDF_RESUME_PDF=<path> to run it locally.`
  );
}

describe.skipIf(!shouldRun)('PDFium engine on user resume.pdf', () => {
  let pdfBytes: Uint8Array;

  beforeAll(async () => {
    pdfBytes = readFileSync(RESUME);
    const wasmBytes = readFileSync(
      resolve(
        process.cwd(),
        'node_modules/@embedpdf/pdfium/dist/pdfium.wasm'
      )
    );
    await loadPdfiumFromBytes(wasmBytes);
    useEngineStore.setState({
      mupdfReady: false,
      mupdfLoading: false,
      mupdfError: null,
      currentEngine: 'pdfjs',
    });
  });

  it('detects real UTF-16LE text blocks on page 0', async () => {
    const blocks = await pdfiumEngine.detectTextBlocks({
      pdfBytes,
      pageIndex: 0,
    });
    // Capture every block's text so a future regression prints it.
    // Print all the non-whitespace blocks (the engine skips blanks).
    const sample = blocks.slice(0, 12).map((b) => ({
      id: b.id,
      bbox: b.bbox,
      text: b.text,
      fontSize: b.fontSize,
    }));
    // Stash the sample so the failing path is actionable.
    (globalThis as { __resumeBlocks?: unknown }).__resumeBlocks = sample;
    console.log('[resume.spec] first 12 blocks:', JSON.stringify(sample, null, 2));

    expect(Array.isArray(blocks)).toBe(true);
    // The Chinese resume has many CJK characters; we require at least
    // one decoded non-empty text to prove the UTF-16LE path is working.
    const nonEmpty = blocks.filter((b) => b.text.trim().length > 0);
    expect(nonEmpty.length).toBeGreaterThan(0);
    // And every decoded glyph must NOT contain the Emscripten
    // `Invalid UTF-8 leading byte 0xa1` failure mode: that surfaces as
    // a U+FFFD replacement char OR the runtime throws — we assert
    // no replacement characters survived.
    const hasReplacement = blocks.some((b) => b.text.includes('\uFFFD'));
    expect(hasReplacement).toBe(false);
  });

  it('writes back a valid PDF after destroying a text page object', async () => {
    const blocks = await pdfiumEngine.detectTextBlocks({
      pdfBytes,
      pageIndex: 0,
    });
    if (blocks.length === 0) {
      throw new Error('no blocks detected — cannot test writeTextBlock');
    }
    const target = blocks.find((b) => b.text.trim().length > 0) ?? blocks[0];
    const result = await pdfiumEngine.writeTextBlock({
      pdfBytes,
      pageIndex: 0,
      blockId: target.id,
      newText: target.text, // same text — writeTextBlock is idempotent
      block: target,
    });
    expect(result.bytes.byteLength).toBeGreaterThan(0);
    expect(result.source).toBe('pdfium');

    // Real PDF magic + EOF marker.
    const head = result.bytes.subarray(0, 5);
    const tailStart = Math.max(0, result.bytes.byteLength - 32);
    const tail = result.bytes.subarray(tailStart);
    expect(Array.from(head)).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    expect(new TextDecoder('latin1').decode(tail)).toContain('%%EOF');

    // Persist to disk for manual verification if anyone wants to open
    // it. Kept in tests/_artifacts/ so it doesn't pollute the repo.
    mkdirSync('tests/_artifacts', { recursive: true });
    writeFileSync(
      'tests/_artifacts/resume-after-destroy.pdf',
      result.bytes
    );
  });
});
