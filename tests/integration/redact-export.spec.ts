// redact-export.spec.ts — regression net for the 「涂黑 / 密文」 export path.
//
// Three things are locked here, each of which was a real defect or a real
// safety hazard while building the feature:
//
//   1. Redaction must run even when there are ZERO edited text blocks.
//      exportPdf used to call applyMupdfRedactions only inside
//      `if (editedTextBlocks.length > 0)`. A document where the user only
//      drew redaction boxes therefore skipped redaction entirely — the black
//      box would be drawn over content that was still in the file.
//
//   2. Redact overlays must be submitted in 'full' mode, and text-block edits
//      in 'text-only' mode. If a redact overlay were submitted as 'text-only',
//      `scripts/experiment-redact.mjs` shows the image pixels and vector art
//      underneath would survive (1400->1400 px, 381->381 px) — fake redaction.
//
//   3. If redaction fails, exportPdf MUST throw rather than export. A
//      silently-degraded export looks redacted but is not. The graceful
//      whiteout fallback stays available for the text-editing path, which is
//      covered by test C below so the hard failure isn't over-applied.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PageMeta, RedactItem, TextBlockItem } from '../../src/core/types';

// NOTE: do NOT set pdfjs.GlobalWorkerOptions.workerSrc here — tests/setup.ts
// already points it at a file:// URL. Overriding it with `new URL(...).href`
// yields an http: URL that the ESM loader rejects.

const h = vi.hoisted(() => ({
  real: null as null | ((bytes: Uint8Array, edits: unknown[]) => Promise<unknown>),
  applyMupdfRedactions: vi.fn(),
  downloadBlob: vi.fn(),
}));

vi.mock('../../src/core/writer/redact', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/writer/redact')>();
  h.real = actual.applyMupdfRedactions as typeof h.real;
  return { ...actual, applyMupdfRedactions: h.applyMupdfRedactions };
});

vi.mock('../../src/utils/download', () => ({
  downloadBlob: h.downloadBlob,
}));

// Imported after the mocks so the module graph picks them up.
const { exportPdf } = await import('../../src/features/export/exportPdf');
const { useDocumentStore } = await import('../../src/store/documentStore');

const PAGE_W = 595;
const PAGE_H = 842;

const PAGES: PageMeta[] = [
  { id: 'p1', index: 0, rotation: 0, width: PAGE_W, height: PAGE_H },
];

/** Redaction box over the "SECRETTOKEN" text at y-down 95..109. */
const SECRET_RECT = { x: 55, y: 90, w: 150, h: 25 };

async function buildSourcePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('SECRETTOKEN', {
    x: 60,
    y: PAGE_H - 95 - 14 + 4,
    size: 14,
    font,
    color: rgb(0, 0, 0),
  });
  page.drawText('KEEPME', {
    x: 60,
    y: PAGE_H - 195 - 14 + 4,
    size: 14,
    font,
    color: rgb(0, 0, 0),
  });
  return doc.save();
}

function redactOverlay(rect = SECRET_RECT): RedactItem {
  return {
    id: 'r1',
    pageId: 'p1',
    type: 'redact',
    rect,
    color: '#000000',
  };
}

function editedTextBlock(): TextBlockItem {
  return {
    id: 't1',
    pageId: 'p1',
    type: 'text-block',
    bbox: { x: 60, y: 195, w: 120, h: 18 },
    originalBbox: { x: 60, y: 195, w: 120, h: 18 },
    originalText: 'KEEPME',
    text: 'CHANGED',
    font: 'Helvetica',
    fontSize: 14,
    color: '#000000',
    lineHeight: 1.2,
    bold: false,
    italic: false,
    fontClass: 'sans',
  };
}

async function extractText(bytes: Uint8Array): Promise<string> {
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

/** Last bytes handed to downloadBlob. */
function lastExport(): Uint8Array {
  const calls = h.downloadBlob.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const bytes = calls[calls.length - 1][0];
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

let source: Uint8Array;

beforeEach(async () => {
  source = await buildSourcePdf();
  h.applyMupdfRedactions.mockReset();
  h.applyMupdfRedactions.mockImplementation(h.real!);
  h.downloadBlob.mockReset();
  useDocumentStore.setState({
    pages: PAGES,
    overlays: [],
    pdfBytes: source,
    pdfName: 'test',
    pageBgColors: {},
    panelRects: {},
  });
});

describe('redact export', () => {
  it('A: runs redaction even with zero edited text blocks', async () => {
    useDocumentStore.setState({ overlays: [redactOverlay()] });

    await exportPdf();

    // The old code guarded this call behind `editedTextBlocks.length > 0`,
    // so it was never invoked for a redact-only document.
    expect(h.applyMupdfRedactions).toHaveBeenCalledTimes(1);
    const edits = h.applyMupdfRedactions.mock.calls[0][1] as Array<{
      mode?: string;
      pageIndex: number;
    }>;
    expect(edits).toHaveLength(1);
    expect(edits[0].pageIndex).toBe(0);
    expect(edits[0].mode).toBe('full');
  });

  it('A2: actually removes the covered text from the output file', async () => {
    useDocumentStore.setState({ overlays: [redactOverlay()] });

    await exportPdf();
    const text = await extractText(lastExport());

    expect(text).not.toContain('SECRETTOKEN');
    expect(text).toContain('KEEPME');
  });

  it('B: marks text-block edits as text-only and redact boxes as full', async () => {
    useDocumentStore.setState({
      overlays: [redactOverlay(), editedTextBlock()],
    });

    await exportPdf();

    const edits = h.applyMupdfRedactions.mock.calls[0][1] as Array<{
      mode?: string;
    }>;
    expect(edits).toHaveLength(2);
    const modes = edits.map((e) => e.mode).sort();
    expect(modes).toEqual(['full', 'text-only']);
  });

  it('C: throws instead of exporting a fake redaction when redaction fails', async () => {
    useDocumentStore.setState({ overlays: [redactOverlay()] });
    // Simulate MuPDF being unavailable / throwing: redact.ts reports failure
    // by returning the ORIGINAL bytes with redacted: false.
    h.applyMupdfRedactions.mockResolvedValue({ bytes: source, redacted: false });

    await expect(exportPdf()).rejects.toThrow(/涂黑|脱敏/);
    // The crucial part: nothing was downloaded.
    expect(h.downloadBlob).not.toHaveBeenCalled();
  });

  it('C2: keeps the graceful whiteout fallback for text edits only', async () => {
    // No redact overlay -> a failed redaction must NOT be fatal, otherwise
    // plain text editing would break on any engine hiccup.
    useDocumentStore.setState({ overlays: [editedTextBlock()] });
    h.applyMupdfRedactions.mockResolvedValue({ bytes: source, redacted: false });

    await expect(exportPdf()).resolves.toBeTruthy();
    expect(h.downloadBlob).toHaveBeenCalledTimes(1);
  });

  it('D: skips redaction entirely when there is nothing to redact', async () => {
    useDocumentStore.setState({ overlays: [] });

    await exportPdf();

    expect(h.applyMupdfRedactions).not.toHaveBeenCalled();
    expect(h.downloadBlob).toHaveBeenCalledTimes(1);
  });
});
