// redact-modes.spec.ts — locks the MuPDF parameter mapping in
// core/writer/redact.ts.
//
// This is the crux of the 「涂黑 / 密文」 feature. `applyRedactions` takes four
// positional parameters, and getting them wrong fails SILENTLY: the call still
// succeeds, the black box still appears, and the content underneath simply
// stays in the file. `scripts/experiment-redact.mjs` measured the difference:
//
//   (false, 0, 0, 0)  ->  covered text removed, but image 1400->1400 px and
//                         vector art 381->381 px SURVIVE  (fake redaction)
//   (false, 2, 2, 0)  ->  image 1400->0 px, vector 381->0  (real redaction)
//
// so the numbers below are the whole difference between a security feature and
// a security theatre feature. They are asserted explicitly rather than via the
// named constants, precisely so that changing a constant fails this test.
//
// The MuPDF loader is mocked: we are testing the call we make, not MuPDF.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Rect } from '../../src/core/types';

interface RedactCall {
  blackBoxes: boolean;
  imageMethod: number;
  lineArtMethod: number;
  textMethod: number;
}

interface AnnotRecord {
  type: string;
  quads: number[][];
  destroyed: boolean;
}

const h = vi.hoisted(() => {
  const applyCalls: RedactCall[] = [];
  const annots: AnnotRecord[] = [];
  const pagesLoaded: number[] = [];
  let saveShouldThrow = false;
  let openShouldThrow = false;
  let asPdfReturnsNull = false;

  function makePage(index: number) {
    return {
      createAnnotation(type: string) {
        const rec: AnnotRecord = { type, quads: [], destroyed: false };
        annots.push(rec);
        return {
          setQuadPoints(quads: number[][]) {
            rec.quads = quads;
          },
          destroy() {
            rec.destroyed = true;
          },
        };
      },
      applyRedactions(
        blackBoxes: boolean,
        imageMethod: number,
        lineArtMethod: number,
        textMethod: number
      ) {
        applyCalls.push({ blackBoxes, imageMethod, lineArtMethod, textMethod });
      },
      toStructuredText() {
        return {
          // No characters found -> redact.ts falls back to using the bbox
          // corners, which is what we want to assert on.
          walk() {
            /* no-op */
          },
          destroy() {
            /* no-op */
          },
        };
      },
      destroy() {
        /* no-op */
      },
      _index: index,
    };
  }

  const fakeMupdf = {
    Document: {
      openDocument() {
        if (openShouldThrow) throw new Error('openDocument failed');
        return {
          asPDF() {
            if (asPdfReturnsNull) return null;
            return {
              loadPage(index: number) {
                pagesLoaded.push(index);
                return makePage(index);
              },
              saveToBuffer() {
                if (saveShouldThrow) throw new Error('saveToBuffer failed');
                return { asUint8Array: () => new Uint8Array([0x25, 0x50, 0x44, 0x46]) };
              },
            };
          },
          destroy() {
            /* no-op */
          },
        };
      },
    },
  };

  return {
    applyCalls,
    annots,
    pagesLoaded,
    fakeMupdf,
    setSaveShouldThrow: (v: boolean) => {
      saveShouldThrow = v;
    },
    setOpenShouldThrow: (v: boolean) => {
      openShouldThrow = v;
    },
    setAsPdfReturnsNull: (v: boolean) => {
      asPdfReturnsNull = v;
    },
    reset() {
      applyCalls.length = 0;
      annots.length = 0;
      pagesLoaded.length = 0;
      saveShouldThrow = false;
      openShouldThrow = false;
      asPdfReturnsNull = false;
    },
  };
});

vi.mock('../../src/core/mupdf/loader', () => ({
  loadMupdf: async () => h.fakeMupdf,
}));

const { applyMupdfRedactions } = await import('../../src/core/writer/redact');

const ORIGINAL = new Uint8Array([1, 2, 3]);
const BOX: Rect = { x: 10, y: 20, w: 100, h: 30 };

beforeEach(() => {
  h.reset();
});

describe('applyMupdfRedactions parameter mapping', () => {
  it('defaults to text-only: images and vector art are preserved', async () => {
    const r = await applyMupdfRedactions(ORIGINAL, [
      { pageIndex: 0, originalBbox: BOX },
    ]);

    expect(r.redacted).toBe(true);
    expect(h.applyCalls).toEqual([
      { blackBoxes: false, imageMethod: 0, lineArtMethod: 0, textMethod: 0 },
    ]);
  });

  it("'full' mode removes image pixels and touching vector art", async () => {
    await applyMupdfRedactions(ORIGINAL, [
      { pageIndex: 0, originalBbox: BOX, mode: 'full' },
    ]);

    expect(h.applyCalls).toEqual([
      { blackBoxes: false, imageMethod: 2, lineArtMethod: 2, textMethod: 0 },
    ]);
  });

  it("explicit 'text-only' matches the default", async () => {
    await applyMupdfRedactions(ORIGINAL, [
      { pageIndex: 0, originalBbox: BOX, mode: 'text-only' },
    ]);

    expect(h.applyCalls).toEqual([
      { blackBoxes: false, imageMethod: 0, lineArtMethod: 0, textMethod: 0 },
    ]);
  });

  it('never asks MuPDF to draw black boxes (flatten draws them instead)', async () => {
    await applyMupdfRedactions(ORIGINAL, [
      { pageIndex: 0, originalBbox: BOX, mode: 'full' },
    ]);
    await applyMupdfRedactions(ORIGINAL, [
      { pageIndex: 0, originalBbox: BOX, mode: 'text-only' },
    ]);

    expect(h.applyCalls.every((c) => c.blackBoxes === false)).toBe(true);
  });

  it('passes the drawn rect through unchanged in full mode', async () => {
    // Locks the coordinate convention that scripts/experiment-redact.mjs
    // verified end-to-end: y-down page space, handed to setQuadPoints as-is.
    await applyMupdfRedactions(ORIGINAL, [
      { pageIndex: 0, originalBbox: BOX, mode: 'full' },
    ]);

    expect(h.annots).toHaveLength(1);
    expect(h.annots[0].type).toBe('Redact');
    expect(h.annots[0].quads).toEqual([
      [10, 20, 110, 20, 10, 50, 110, 50],
    ]);
  });
});

describe('applyMupdfRedactions grouping', () => {
  it('applies both modes on one page as two separate annotations', async () => {
    await applyMupdfRedactions(ORIGINAL, [
      { pageIndex: 0, originalBbox: BOX, mode: 'text-only' },
      { pageIndex: 0, originalBbox: { x: 5, y: 5, w: 10, h: 10 }, mode: 'full' },
    ]);

    // One page load, two annotations, two calls with different parameters.
    expect(h.pagesLoaded).toEqual([0]);
    expect(h.annots).toHaveLength(2);
    expect(h.applyCalls).toEqual([
      { blackBoxes: false, imageMethod: 0, lineArtMethod: 0, textMethod: 0 },
      { blackBoxes: false, imageMethod: 2, lineArtMethod: 2, textMethod: 0 },
    ]);
    expect(h.annots.every((a) => a.destroyed)).toBe(true);
  });

  it('loads each page once and keeps pages independent', async () => {
    await applyMupdfRedactions(ORIGINAL, [
      { pageIndex: 0, originalBbox: BOX, mode: 'full' },
      { pageIndex: 2, originalBbox: BOX, mode: 'full' },
      { pageIndex: 0, originalBbox: { x: 1, y: 1, w: 2, h: 2 }, mode: 'full' },
    ]);

    expect(h.pagesLoaded).toEqual([0, 2]);
    // Page 0's two boxes are batched into a single annotation.
    expect(h.annots).toHaveLength(2);
    expect(h.annots[0].quads).toHaveLength(2);
  });

  it('is a no-op with no edits (no engine load at all)', async () => {
    const r = await applyMupdfRedactions(ORIGINAL, []);

    expect(r.redacted).toBe(true);
    expect(r.bytes).toBe(ORIGINAL);
    expect(h.applyCalls).toHaveLength(0);
  });
});

describe('applyMupdfRedactions failure reporting', () => {
  it('reports redacted:false and returns the ORIGINAL bytes when saving throws', async () => {
    h.setSaveShouldThrow(true);

    const r = await applyMupdfRedactions(ORIGINAL, [
      { pageIndex: 0, originalBbox: BOX, mode: 'full' },
    ]);

    // Returning the untouched original bytes is exactly why exportPdf must
    // not treat redacted:false as a soft failure for redaction overlays.
    // (Note: on failure the engine hands back a defensive copy of the input,
    // so we compare content, not reference identity.)
    expect(r.redacted).toBe(false);
    expect(Array.from(r.bytes)).toEqual(Array.from(ORIGINAL));
  });

  it('reports redacted:false when the document cannot be opened', async () => {
    h.setOpenShouldThrow(true);

    const r = await applyMupdfRedactions(ORIGINAL, [
      { pageIndex: 0, originalBbox: BOX, mode: 'full' },
    ]);

    expect(r.redacted).toBe(false);
    expect(Array.from(r.bytes)).toEqual(Array.from(ORIGINAL));
  });

  it('reports redacted:false when asPDF() returns null', async () => {
    h.setAsPdfReturnsNull(true);

    const r = await applyMupdfRedactions(ORIGINAL, [
      { pageIndex: 0, originalBbox: BOX, mode: 'full' },
    ]);

    expect(r.redacted).toBe(false);
    expect(Array.from(r.bytes)).toEqual(Array.from(ORIGINAL));
  });
});
