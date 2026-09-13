// subset-embed.spec.ts — regression net for the CJK subsetting decision.
//
// The export path used to embed the *entire* Source Han OTF (8–12 MB) because a
// code comment claimed `subset: true` drops CJK glyphs for CID/CFF fonts.
// `scripts/experiment-subset.mjs` disproved that: 200 Chinese characters
// produced exactly 201 glyph outlines in the subset, with byte-identical text
// extraction. Full-font embedding is ~106x larger for no benefit.
//
// This test fails loudly if anyone reintroduces `subset: false`: a full-font
// embed of the text below weighs ~7.3 MB, a subset tens of KB.
import { describe, it, expect, beforeAll } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setCjkFontBytes } from '../../src/core/writer/cjkFont';
import { flattenOverlays } from '../../src/core/writer/flatten';
import type { PageMeta, TextItem } from '../../src/core/types';

const FONT = join(process.cwd(), 'public', 'fonts', 'SourceHanSansCN-Regular.otf');

const PAGES: PageMeta[] = [
  { id: 'p1', index: 0, rotation: 0, width: 595, height: 842 },
];

function cjkOverlay(text: string): TextItem {
  return {
    id: 'o1',
    pageId: 'p1',
    type: 'text',
    position: { x: 40, y: 40 },
    size: { w: 400, h: 40 },
    rotation: 0,
    text,
    font: 'SimSun',
    fontSize: 14,
    color: '#000000',
    bold: false,
    italic: false,
    underline: false,
    fontClass: 'cjk-sans',
  };
}

describe('CJK export embeds a subset, not the whole font', () => {
  beforeAll(() => {
    // Inject the real OTF so the loader skips its fetch/CDN path in tests.
    setCjkFontBytes(
      new Uint8Array(readFileSync(FONT)),
      'cjk-sans',
      'regular'
    );
  });

  it('keeps a CJK export in the KB range', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);

    const text =
      '这是一段用于验证子集嵌入的中文测试文本,包含多个不同汉字以确认字形齐全。';
    await flattenOverlays(doc, [cjkOverlay(text)], PAGES);
    const bytes = await doc.save();

    // Full-font embedding produced ~7.3 MB here; a subset is well under 500 KB.
    expect(bytes.byteLength).toBeLessThan(500 * 1024);
    // Sanity: something was actually written.
    expect(bytes.byteLength).toBeGreaterThan(1024);
  });

  it('grows sub-linearly with the number of distinct characters', async () => {
    const few = '中文测试';
    const many = '一二三四五六七八九十百千万亿兆京垓秭穰沟涧正载中文测试更多汉字';

    const sizeFor = async (text: string) => {
      const doc = await PDFDocument.create();
      doc.addPage([595, 842]);
      await flattenOverlays(doc, [cjkOverlay(text)], PAGES);
      return (await doc.save()).byteLength;
    };

    const small = await sizeFor(few);
    const large = await sizeFor(many);

    // A full-font embed would make these two nearly identical (~7.3 MB each).
    // A subset must grow with the character count — and stay small.
    expect(small).toBeLessThan(100 * 1024);
    expect(large).toBeLessThan(500 * 1024);
    expect(large).toBeGreaterThan(small);
  });
});
