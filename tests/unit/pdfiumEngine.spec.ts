import { describe, it, expect } from 'vitest';
import { asPdfium } from '../../src/core/pdfium/helpers';
import { pdfiumEngine } from '../../src/core/pdfium/pdfiumEngine';
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';

function fakePdfium() {
  // Happy-DOM has no wasm support, so the real `loadPdfium` will reject.
  // We mock the helper module to avoid that path: assert that the
  // engine and helpers compose cleanly with a stand-in module.
  const heap = new ArrayBuffer(64);
  const fake = {
    pdfium: {
      HEAPU8: new Uint8Array(heap),
      HEAPU32: new Uint32Array(heap),
      HEAPF32: new Float32Array(heap),
      UTF8ToString: () => '',
      stringToUTF8: () => 0,
      wasmExports: {
        malloc: () => 0,
        free: () => undefined,
      },
    },
  } as unknown as WrappedPdfiumModule;
  return fake;
}

describe('pdfium helpers', () => {
  it('asPdfium attaches the heap views used by EngineInterface', () => {
    const mod = fakePdfium();
    const lifted = asPdfium(mod);
    expect(lifted.pdfium.HEAPU8).toBeInstanceOf(Uint8Array);
    expect(lifted.pdfium.HEAPU32).toBeInstanceOf(Uint32Array);
  });
});

describe('pdfiumEngine', () => {
  it('kind is "pdfium" — slots into the source union', () => {
    expect(pdfiumEngine.kind).toBe('pdfium');
  });

  it('exposes the EngineInterface detect method', () => {
    expect(typeof pdfiumEngine.detectTextBlocks).toBe('function');
  });

  it('no longer exposes parseFormFields (form feature removed)', () => {
    expect('parseFormFields' in pdfiumEngine).toBe(false);
  });

  it('detectTextBlocks rejects gracefully when wasm is unreachable in this env', async () => {
    await expect(
      pdfiumEngine.detectTextBlocks({
        pdfBytes: new Uint8Array(),
        pageIndex: 0,
      })
    ).rejects.toBeDefined();
  });
});
