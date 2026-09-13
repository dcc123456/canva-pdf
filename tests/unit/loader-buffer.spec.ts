// loader-buffer.spec.ts — regression net for the detached-ArrayBuffer bug.
//
// pdfjs *transfers* (detaches) the ArrayBuffer handed to it. The built-in and
// user template flows call `loadDocument(bytes)` to probe page sizes and then
// keep using `bytes` — they store it in the document store, and base64-encode
// it as a template. When the loader passed the caller's buffer straight
// through, that second use blew up with:
//
//   Cannot perform Construct on a detached or out-of-bounds ArrayBuffer
//
// The fix is that `loadDocument` now always gives pdfjs a private copy. These
// tests pin that contract down so a future "optimisation" that drops the copy
// fails here instead of in the template gallery.
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { loadDocument } from '../../src/core/pdf/loader';

async function makePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  return doc.save();
}

describe("loadDocument leaves the caller's buffer alone", () => {
  it('keeps the input Uint8Array usable after loading', async () => {
    const bytes = await makePdf();
    const before = Array.from(bytes);

    const doc = await loadDocument(bytes);
    expect(doc.numPages).toBe(1);

    // Still alive, still byte-identical.
    expect(bytes.byteLength).toBe(before.length);
    expect(Array.from(bytes)).toEqual(before);

    // ...and still consumable by a second reader. This is exactly what the
    // template flow does: probe with pdfjs, then keep the bytes.
    const roundTrip = await PDFDocument.load(bytes);
    expect(roundTrip.getPageCount()).toBe(1);
  });

  it('leaves a plain ArrayBuffer input intact too', async () => {
    const bytes = await makePdf();
    // Slice out a standalone ArrayBuffer (pdf-lib's output may be a view into
    // a larger allocation).
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    const expectedLength = buffer.byteLength;

    const doc = await loadDocument(buffer);
    expect(doc.numPages).toBe(1);

    expect(buffer.byteLength).toBe(expectedLength);
    const roundTrip = await PDFDocument.load(new Uint8Array(buffer));
    expect(roundTrip.getPageCount()).toBe(1);
  });
});
