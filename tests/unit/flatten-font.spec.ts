// flatten-font.spec.ts — regression net for the export font-variant bug.
//
// flatten.ts used to hold a single `cjkFont` variable and always call
// `loadCjkFontBytes()` — i.e. hardcoded ('cjk-sans', 'regular'). A 「文字」
// overlay set to 中文衬线 + 粗体 therefore rendered correctly on canvas but
// exported as Source Han Sans Regular. These tests assert the loader is asked
// for the *correct* (fontClass, weight) variant.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { PageMeta, TextItem } from '../../src/core/types';

const { loadVariant } = vi.hoisted(() => ({ loadVariant: vi.fn() }));

vi.mock('../../src/core/writer/cjkFont', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/core/writer/cjkFont')
  >('../../src/core/writer/cjkFont');
  return { ...actual, loadCjkFontBytesForVariant: loadVariant };
});

const { flattenOverlays } = await import('../../src/core/writer/flatten');

const PAGES: PageMeta[] = [
  { id: 'p1', index: 0, rotation: 0, width: 595, height: 842 },
];

function textOverlay(overrides: Partial<TextItem> = {}): TextItem {
  return {
    id: 'o1',
    pageId: 'p1',
    type: 'text',
    position: { x: 40, y: 40 },
    size: { w: 300, h: 40 },
    rotation: 0,
    text: '中文衬线加粗',
    font: 'SimSun',
    fontSize: 14,
    color: '#000000',
    bold: false,
    italic: false,
    underline: false,
    ...overrides,
  };
}

async function flattenOne(item: TextItem): Promise<void> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  await flattenOverlays(doc, [item], PAGES);
}

describe('flattenOverlays font variant selection', () => {
  beforeEach(() => {
    loadVariant.mockReset();
    // Return null so the code takes its StandardFonts fallback — the test
    // asserts on *which variant was requested*, not on real font bytes.
    loadVariant.mockResolvedValue(null);
  });

  it('requests cjk-serif + bold for a serif bold text overlay', async () => {
    await flattenOne(textOverlay({ fontClass: 'cjk-serif', bold: true }));

    expect(loadVariant).toHaveBeenCalledWith('cjk-serif', 'bold');
    // The old bug: always ('cjk-sans', 'regular').
    expect(loadVariant).not.toHaveBeenCalledWith('cjk-sans', 'regular');
  });

  it('requests cjk-serif + regular when not bold', async () => {
    await flattenOne(textOverlay({ fontClass: 'cjk-serif', bold: false }));

    expect(loadVariant).toHaveBeenCalledWith('cjk-serif', 'regular');
    expect(loadVariant).not.toHaveBeenCalledWith('cjk-sans', 'regular');
  });

  it('requests cjk-sans + bold for a sans bold text overlay', async () => {
    await flattenOne(textOverlay({ fontClass: 'cjk-sans', bold: true }));

    expect(loadVariant).toHaveBeenCalledWith('cjk-sans', 'bold');
  });

  it('honours a segment-level fontClass override', async () => {
    await flattenOne(
      textOverlay({
        fontClass: 'cjk-sans',
        segments: [{ text: '中文衬线加粗', fontClass: 'cjk-serif', bold: true }],
      })
    );

    expect(loadVariant).toHaveBeenCalledWith('cjk-serif', 'bold');
  });

  it('falls back to cjk-sans regular when fontClass is absent (legacy projects)', async () => {
    const item = textOverlay();
    delete item.fontClass;

    await flattenOne(item);

    expect(loadVariant).toHaveBeenCalledWith('cjk-sans', 'regular');
  });

  it('never loads a CJK font for pure-ASCII text', async () => {
    await flattenOne(
      textOverlay({ text: 'Hello world', font: 'Helvetica', fontClass: 'sans' })
    );

    expect(loadVariant).not.toHaveBeenCalled();
  });

  it('caches per (fontClass, weight) instead of re-loading per overlay', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    await flattenOverlays(
      doc,
      [
        textOverlay({ id: 'a', fontClass: 'cjk-serif', bold: true }),
        textOverlay({ id: 'b', fontClass: 'cjk-serif', bold: true }),
      ],
      PAGES
    );

    expect(loadVariant).toHaveBeenCalledTimes(1);
  });
});
