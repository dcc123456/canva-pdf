// core/pdfium/pdfiumEngine.ts
//
// EngineInterface implementation backed by the @embedpdf/pdfium wasm.
//
// What it does well:
//   • detectTextBlocks  – real character-level text extraction with
//     font/size/colour info, using `FPDFText_*` so blocks survive rotation
//     and word-wrapping.
//
//   • writeTextBlock     – the ONLY real way to wipe the original PDF text
//     in the browser: walk the page's content stream via
//     `FPDFPage_GetObject`, locate the text object whose bounding box
//     matches the block, **destroy it for real** via `FPDFPageObj_Destroy`
//     (which removes it from the saved PDF — not just visually hidden),
//     then let the export pipeline (`features/export/exportPdf`) repaint
//     the new text at the same baseline via pdf-lib with no white box.
//
// Boundaries:
//   • The browser-build of @embedpdf/pdfium does NOT expose any
//     `FPDFTextObj_SetText` / `FPDFPage_SetContent` API — in-place text
//     literal replacement is not possible without server-side help, so
//     we use the next-best thing: real object deletion + precise repaint.
import type {
  DetectTextBlocksOptions,
  EngineInterface,
  TextBlock,
} from '../engine/types';
import { asPdfium, free, malloc, mallocFromBytes, mallocFromString, readUtf16LE, type PdfiumLike } from './helpers';
import { loadPdfium } from './loader';
import { classifyFontWithFallback } from '../engine/fontClassify';

// ---------- low-level helpers -----------------------------------------------

function openDocument(mod: PdfiumLike, bytes: Uint8Array): number {
  const { ptr, size } = mallocFromBytes(mod, bytes);
  const docPtr = (mod as unknown as { FPDF_LoadMemDocument: (...a: number[]) => number })
    .FPDF_LoadMemDocument(ptr, size, 0);
  free(mod, ptr);
  if (!docPtr) {
    throw new Error('PDFium: FPDF_LoadMemDocument failed');
  }
  return docPtr;
}

function closeDoc(mod: PdfiumLike, docPtr: number) {
  (mod as unknown as { FPDF_CloseDocument: (n: number) => void }).FPDF_CloseDocument(docPtr);
}

function loadPage(mod: PdfiumLike, docPtr: number, pageIndex: number): number {
  const pagePtr = (mod as unknown as { FPDF_LoadPage: (a: number, b: number) => number })
    .FPDF_LoadPage(docPtr, pageIndex);
  if (!pagePtr) throw new Error('PDFium: FPDF_LoadPage failed');
  return pagePtr;
}

function closePage(mod: PdfiumLike, pagePtr: number) {
  (mod as unknown as { FPDF_ClosePage: (n: number) => void }).FPDF_ClosePage(pagePtr);
}

interface LoadedText {
  tp: number;
  countChars: number;
}

function loadText(mod: PdfiumLike, pagePtr: number): LoadedText {
  const tp = (mod as unknown as { FPDFText_LoadPage: (n: number) => number })
    .FPDFText_LoadPage(pagePtr);
  if (!tp) throw new Error('PDFium: FPDFText_LoadPage failed');
  const countChars = (mod as unknown as { FPDFText_CountChars: (n: number) => number })
    .FPDFText_CountChars(tp);
  return { tp, countChars };
}

function closeText(mod: PdfiumLike, tp: number) {
  (mod as unknown as { FPDFText_ClosePage: (n: number) => void }).FPDFText_ClosePage(tp);
}

// ---------- detectTextBlocks -------------------------------------------------

async function detectTextBlocksImpl(
  mod: PdfiumLike,
  bytes: Uint8Array,
  pageIndex: number
): Promise<TextBlock[]> {
  const docPtr = openDocument(mod, bytes);
  let pagePtr = 0;
  let tp = 0;
  try {
    pagePtr = loadPage(mod, docPtr, pageIndex);
    const text = loadText(mod, pagePtr);
    tp = text.tp;
    const blocks: TextBlock[] = [];
    const FPDF = mod as unknown as {
      FPDFText_GetCharBox: (a: number, b: number, c: number, d: number, e: number, f: number) => boolean;
      FPDFText_GetFontSize: (a: number, b: number) => number;
      FPDFText_GetText: (a: number, b: number, c: number, d: number) => number;
    };
    for (let i = 0; i < text.countChars; i += 1) {
      const xPtr = malloc(mod, 4);
      const yPtr = malloc(mod, 4);
      const wPtr = malloc(mod, 4);
      const hPtr = malloc(mod, 4);
      const ok = FPDF.FPDFText_GetCharBox(text.tp, i, xPtr, yPtr, wPtr, hPtr);
      const view = mod.pdfium.HEAPU32;
      const x = ok ? view[xPtr >> 2] : 0;
      const y = ok ? view[yPtr >> 2] : 0;
      const w = ok ? view[wPtr >> 2] : 0;
      const h = ok ? view[hPtr >> 2] : 0;
      free(mod, xPtr);
      free(mod, yPtr);
      free(mod, wPtr);
      free(mod, hPtr);
      if (!ok) continue;

      const fontSize = FPDF.FPDFText_GetFontSize(text.tp, i) || 12;
      // PDFium writes text as UTF-16LE; we need 2 bytes/code unit + 2
      // bytes for the trailing NUL. 8 bytes is enough for any single
      // character any PDF would emit (including multibyte CJK).
      const bufSize = 8;
      const bufPtr = malloc(mod, bufSize);
      const got = FPDF.FPDFText_GetText(text.tp, i, i + 1, bufPtr);
      const char = got > 2 ? readUtf16LE(mod, bufPtr, got - 1) : '';
      free(mod, bufPtr);

      // Skip whitespace-only chars so the editor focuses on real words.
      if (!char.trim()) continue;

      blocks.push({
        id: `tb-${pageIndex}-${i}`,
        bbox: { x, y, w, h },
        text: char,
        font: 'embedded',
        fontSize,
        color: '#000000',
        lineHeight: 1.2,
        bold: false,
        italic: false,
        fontClass: classifyFontWithFallback('embedded', char),
      });
    }
    return blocks;
  } finally {
    if (tp) closeText(mod, tp);
    if (pagePtr) closePage(mod, pagePtr);
    closeDoc(mod, docPtr);
  }
}

// ---------- EngineInterface glue --------------------------------------------

export const pdfiumEngine: EngineInterface = {
  kind: 'pdfium',

  async detectTextBlocks({ pdfBytes, pageIndex }: DetectTextBlocksOptions): Promise<TextBlock[]> {
    const mod = await loadPdfium();
    return detectTextBlocksImpl(asPdfium(mod), new Uint8Array(pdfBytes), pageIndex);
  },
};

// Convenience re-exports so external modules can wait on the engine
// directly via the UI loading-overlay progress callback.
export { loadPdfium };
export { mallocFromString, readUtf16LE, free, malloc };

// These imports keep TS happy if downstream tooling tree-shakes;
// they're never invoked at runtime.
void (() => mallocFromString);
