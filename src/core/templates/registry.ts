// registry.ts: in-process built-in PDF templates.
//
// All five templates are produced at runtime with `pdf-lib` rather than
// shipped as binary assets under /public/. The metadata table
// (`BUILTIN_TEMPLATES`) is exported as a synchronous array so callers can
// iterate it without an `await`; the PDF bytes are generated on demand
// by `generateBuiltinPdf` / `applyBuiltinTemplate`.
//
// Each generator returns raw `Uint8Array` PDF bytes; `applyBuiltinTemplate`
// wraps that into the editor's normal `setPdfBytes` flow (clears overlays,
// resets history, etc.).
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import { v4 as uuidv4 } from 'uuid';
import type { Template } from '../types';
import { useDocumentStore } from '../../store/documentStore';
import { useEditorStore } from '../../store/editorStore';
import { useHistoryStore } from '../../store/historyStore';
import { loadDocument } from '../pdf/loader';

// ---------------------------------------------------------------------------
// Metadata table. `pdf` is intentionally empty — the bytes are generated on
// demand so this module doesn't have to be async.
// ---------------------------------------------------------------------------

export const BUILTIN_TEMPLATES: Template[] = [
  {
    id: 'blank-a4',
    name: 'A4 空白',
    source: 'builtin',
    pdf: '',
    createdAt: '',
  },
  {
    id: 'blank-letter',
    name: 'Letter 空白',
    source: 'builtin',
    pdf: '',
    createdAt: '',
  },
  {
    id: 'resume-modern',
    name: 'Modern Resume',
    source: 'builtin',
    pdf: '',
    createdAt: '',
  },
  {
    id: 'invoice',
    name: 'Invoice',
    source: 'builtin',
    pdf: '',
    createdAt: '',
  },
  {
    id: 'meeting-notes',
    name: 'Meeting Notes',
    source: 'builtin',
    pdf: '',
    createdAt: '',
  },
];

export function getBuiltinTemplate(id: string): Template | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.id === id);
}

// ---------------------------------------------------------------------------
// PDF generators. Each takes no arguments and returns Uint8Array bytes.
// ---------------------------------------------------------------------------

async function generateBlankPdf(width: number, height: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([width, height]);
  return doc.save();
}

async function generateResumePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg = await doc.embedFont(StandardFonts.Helvetica);

  const accent = rgb(0.12, 0.18, 0.4);
  const muted = rgb(0.35, 0.35, 0.4);

  page.drawRectangle({
    x: 40,
    y: 780,
    width: 200,
    height: 6,
    color: accent,
  });
  page.drawText('Modern Resume', {
    x: 40,
    y: 740,
    size: 28,
    font: bold,
    color: accent,
  });
  page.drawText('Your Name', {
    x: 40,
    y: 705,
    size: 14,
    font: reg,
    color: rgb(0.1, 0.1, 0.1),
  });
  page.drawText(
    'email@example.com  ·  +1 555-0100  ·  city, country',
    { x: 40, y: 690, size: 9, font: reg, color: muted }
  );

  drawSectionTitle(page, bold, accent, 'SUMMARY', 655);
  page.drawText(
    'A short professional summary describing your experience, strengths, and goals.',
    { x: 40, y: 635, size: 10, font: reg, color: rgb(0.15, 0.15, 0.15) }
  );

  drawSectionTitle(page, bold, accent, 'EXPERIENCE', 595);
  page.drawText('Senior Engineer — Example Corp', {
    x: 40, y: 575, size: 12, font: bold, color: rgb(0.1, 0.1, 0.1),
  });
  page.drawText('2022 — Present', {
    x: 40, y: 561, size: 9, font: reg, color: muted,
  });
  page.drawText('• Built and shipped features used by thousands of customers.', {
    x: 40, y: 545, size: 10, font: reg,
  });
  page.drawText('• Mentored junior engineers and ran architecture reviews.', {
    x: 40, y: 530, size: 10, font: reg,
  });

  drawSectionTitle(page, bold, accent, 'EDUCATION', 490);
  page.drawText('B.Sc. Computer Science — University', {
    x: 40, y: 470, size: 11, font: reg,
  });

  drawSectionTitle(page, bold, accent, 'SKILLS', 440);
  page.drawText('TypeScript, React, Node.js, Postgres, Docker', {
    x: 40, y: 420, size: 10, font: reg,
  });

  return doc.save();
}

function drawSectionTitle(
  page: PDFPage,
  font: PDFFont,
  color: ReturnType<typeof rgb>,
  text: string,
  y: number
): void {
  page.drawText(text, { x: 40, y, size: 12, font, color });
  page.drawRectangle({
    x: 40,
    y: y - 6,
    width: 80,
    height: 1,
    color: rgb(0.7, 0.7, 0.75),
  });
}

async function generateInvoicePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg = await doc.embedFont(StandardFonts.Helvetica);

  const accent = rgb(0.1, 0.2, 0.4);
  const muted = rgb(0.4, 0.4, 0.4);

  page.drawText('INVOICE', { x: 40, y: 780, size: 28, font: bold, color: accent });
  page.drawText('INV-2026-0001', { x: 40, y: 755, size: 11, font: reg, color: muted });

  page.drawText('Bill To:', { x: 40, y: 720, size: 10, font: bold });
  page.drawText('Customer Name', { x: 40, y: 705, size: 10, font: reg });
  page.drawText('Customer Address Line', { x: 40, y: 690, size: 10, font: reg });

  page.drawText('Issue date:', { x: 360, y: 720, size: 9, font: bold });
  page.drawText('2026-06-29', { x: 430, y: 720, size: 9, font: reg });
  page.drawText('Due date:', { x: 360, y: 705, size: 9, font: bold });
  page.drawText('2026-07-29', { x: 430, y: 705, size: 9, font: reg });

  // Table header
  const tableTop = 650;
  const colItem = 40;
  const colQty = 340;
  const colPrice = 410;
  const colTotal = 490;
  page.drawRectangle({
    x: 40,
    y: tableTop - 18,
    width: 515,
    height: 22,
    color: rgb(0.95, 0.95, 0.97),
  });
  page.drawText('ITEM', { x: colItem, y: tableTop - 12, size: 9, font: bold });
  page.drawText('QTY', { x: colQty, y: tableTop - 12, size: 9, font: bold });
  page.drawText('PRICE', { x: colPrice, y: tableTop - 12, size: 9, font: bold });
  page.drawText('TOTAL', { x: colTotal, y: tableTop - 12, size: 9, font: bold });

  // Rows (placeholders)
  const rows = [
    ['Service A — description', '1', '$0.00', '$0.00'],
    ['Service B — description', '2', '$0.00', '$0.00'],
    ['Service C — description', '1', '$0.00', '$0.00'],
  ];
  let y = tableTop - 38;
  for (const r of rows) {
    page.drawText(r[0], { x: colItem, y, size: 10, font: reg });
    page.drawText(r[1], { x: colQty, y, size: 10, font: reg });
    page.drawText(r[2], { x: colPrice, y, size: 10, font: reg });
    page.drawText(r[3], { x: colTotal, y, size: 10, font: reg });
    y -= 20;
  }

  // Total
  page.drawLine({
    start: { x: 380, y: y - 4 },
    end: { x: 555, y: y - 4 },
    thickness: 0.5,
    color: muted,
  });
  page.drawText('Total', { x: colPrice, y: y - 20, size: 11, font: bold });
  page.drawText('$0.00', { x: colTotal, y: y - 20, size: 11, font: bold });

  page.drawText('Thank you for your business.', {
    x: 40,
    y: 80,
    size: 10,
    font: reg,
    color: muted,
  });

  return doc.save();
}

async function generateMeetingNotesPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg = await doc.embedFont(StandardFonts.Helvetica);

  const accent = rgb(0.15, 0.25, 0.55);

  page.drawText('Meeting Notes', { x: 40, y: 780, size: 24, font: bold, color: accent });
  page.drawText('Date: 2026-06-29', {
    x: 40,
    y: 750,
    size: 10,
    font: reg,
    color: rgb(0.4, 0.4, 0.4),
  });

  // Horizontal lines acting as writing space.
  const lineColor = rgb(0.85, 0.85, 0.88);
  let y = 700;
  while (y > 80) {
    page.drawLine({
      start: { x: 40, y },
      end: { x: 555, y },
      thickness: 0.5,
      color: lineColor,
    });
    y -= 30;
  }

  return doc.save();
}

/**
 * Return the bytes of any built-in template. Throws if `id` is unknown.
 */
export async function generateBuiltinPdf(id: string): Promise<Uint8Array> {
  switch (id) {
    case 'blank-a4':
      return generateBlankPdf(595, 842);
    case 'blank-letter':
      return generateBlankPdf(612, 792);
    case 'resume-modern':
      return generateResumePdf();
    case 'invoice':
      return generateInvoicePdf();
    case 'meeting-notes':
      return generateMeetingNotesPdf();
    default:
      throw new Error(`Unknown built-in template: ${id}`);
  }
}

// ---------------------------------------------------------------------------
// Application: write the template's PDF into the document store and reset
// all editor state. Notifies listeners so the Viewer can rebind its pdfjs
// document via the `canva:document-replaced` window event.
// ---------------------------------------------------------------------------

export interface ApplyTemplateResult {
  templateId: string;
  numPages: number;
  bytes: number;
}

export async function applyBuiltinTemplate(
  id: string
): Promise<ApplyTemplateResult> {
  const tpl = getBuiltinTemplate(id);
  if (!tpl) {
    throw new Error(`Unknown built-in template: ${id}`);
  }
  const bytes = await generateBuiltinPdf(id);

  // Probe numPages through pdfjs so we set totalPages correctly.
  // `loadDocument` hands pdfjs a *copy* of `bytes`, so the original is still
  // valid for `setPdfBytes` below — before that fix this line detached the
  // buffer and every later read of the stored bytes threw
  // "Cannot perform Construct on a detached or out-of-bounds ArrayBuffer".
  const doc = await loadDocument(bytes);
  const numPages = doc.numPages;

  const newPages = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const p = await doc.getPage(i);
    const vp = p.getViewport({ scale: 1 });
    newPages.push({
      id: uuidv4(),
      index: i - 1,
      rotation: 0 as const,
      width: vp.width,
      height: vp.height,
    });
    p.cleanup();
  }

  const setPdfBytes = useDocumentStore.getState().setPdfBytes;
  const setPdfName = useDocumentStore.getState().setPdfName;
  const setPages = useDocumentStore.getState().setPages;
  const setOverlays = useDocumentStore.getState().setOverlays;
  const setTotalPages = useEditorStore.getState().setTotalPages;
  const setCurrentPage = useEditorStore.getState().setCurrentPage;
  const clearHistory = useHistoryStore.getState().clear;

  setPdfBytes(bytes);
  setPdfName(tpl.name);
  setPages(newPages);
  setOverlays([]);
  setTotalPages(numPages);
  setCurrentPage(0);
  clearHistory();

  // Tell the App component to rebind the pdfjs doc in the Viewer.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('canva:document-replaced'));
  }

  return { templateId: id, numPages, bytes: bytes.byteLength };
}