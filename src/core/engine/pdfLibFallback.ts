// engine/pdfLibFallback.ts
//
// Implements `EngineInterface` using only the packages already in
// `package.json`:
//
//   * `pdfjs-dist` provides `getTextContent` (yields per-glyph TextItems
//     with a transform matrix in PDF user-space units).
//
// 重构后只保留 detect 只读能力。文本编辑不再走引擎 --
// 编辑只改 overlay,导出时用 pdf-lib 统一应用。
import { loadDocument, pdfjsLib } from '../pdf/loader';
import type {
  DetectTextBlocksOptions,
  EngineInterface,
  TextBlock,
} from './types';
import type { FontClass, Rect } from '../types';
import { classifyFontWithFallback } from './fontClassify';

interface PdfJsTextItem {
  str: string;
  dir: string;
  transform: Array<number>;
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
}

const Y_TOLERANCE = 2; // pt; small enough to keep separate lines apart

function isTextItem(it: unknown): it is PdfJsTextItem {
  return (
    !!it &&
    typeof it === 'object' &&
    'str' in (it as object) &&
    'transform' in (it as object)
  );
}

function clusterIntoLines(
  items: PdfJsTextItem[]
): Array<{ y: number; items: PdfJsTextItem[] }> {
  // Sort by baseline y (transform[5]) desc - pdfjs y is bottom-up.
  const sorted = [...items].sort((a, b) => b.transform[5] - a.transform[5]);
  const lines: Array<{ y: number; items: PdfJsTextItem[] }> = [];
  for (const it of sorted) {
    const y = it.transform[5];
    const line = lines.find((l) => Math.abs(l.y - y) <= Y_TOLERANCE);
    if (line) {
      line.items.push(it);
    } else {
      lines.push({ y, items: [it] });
    }
  }
  return lines;
}

function rectOfLine(
  pageHeight: number,
  lineItems: PdfJsTextItem[]
): { rect: Rect; fontSize: number; fontName: string } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let fontSize = 0;
  let fontName = 'g_d0_f1';
  for (const it of lineItems) {
    const x = it.transform[4];
    const y = it.transform[5];
    const h = Math.max(it.height || 0, 0.1);
    if (x < minX) minX = x;
    if (x + it.width > maxX) maxX = x + it.width;
    if (y < minY) minY = y;
    if (y + h > maxY) maxY = y + h;
    const scaleY = Math.hypot(it.transform[2], it.transform[3]) || h;
    if (scaleY > fontSize) fontSize = scaleY;
    if (it.fontName) fontName = it.fontName;
  }
  // pdfjs is y-up from the bottom; our store is y-down from the top.
  const top = pageHeight - maxY;
  const height = Math.max(maxY - minY, fontSize || 1);
  return {
    rect: { x: minX, y: top, w: Math.max(maxX - minX, 1), h: height },
    fontSize: fontSize || height,
    fontName,
  };
}

/**
 * 把同一行内的 pdfjs TextItem 按几何位置拼成文字,保留 PDF 中真实的
 * 空格宽度。和 "join(' ') + replace(/\s+/g,' ') + trim()" 的区别:
 *   - 不把多个连续空格塌成单个空格
 *   - 不去掉行首/行尾的空格
 *   - 片段之间的间距按 x 坐标差换算成对应数量的空格
 * 这样编辑模式下看到的文字和 pdfjs 渲染的页面保持一致 (WYSIWYG)。
 */
function joinItemsPreservingSpaces(items: PdfJsTextItem[]): string {
  if (items.length === 0) return '';
  const sorted = [...items].sort((a, b) => a.transform[4] - b.transform[4]);
  // 用本行最大字号估算一个空格字符的宽度 (常规字体空格约 0.25em)。
  let maxFontScale = 0;
  for (const it of sorted) {
    const fs = Math.hypot(it.transform[2], it.transform[3]);
    if (fs > maxFontScale) maxFontScale = fs;
  }
  const spaceUnit = Math.max(maxFontScale * 0.25, 1);

  let text = '';
  let prevEndX: number | null = null;
  for (const it of sorted) {
    const xStart = it.transform[4];
    if (prevEndX !== null) {
      const gap = xStart - prevEndX;
      // 两侧任一侧已经自带空白时不补,避免叠成双空格。
      const alreadySpaced = /\s$/.test(text) || /^\s/.test(it.str);
      // 只在确实有正向间距 (大于 ~0.3 个空格宽度) 时才补空格。
      if (gap > spaceUnit * 0.3 && !alreadySpaced) {
        const numSpaces = Math.max(1, Math.round(gap / spaceUnit));
        text += ' '.repeat(numSpaces);
      }
    }
    text += it.str;
    prevEndX = xStart + (it.width || 0);
  }
  return text;
}

async function detectTextBlocksImpl(
  opts: DetectTextBlocksOptions
): Promise<TextBlock[]> {
  const doc = await loadDocument(opts.pdfBytes);
  const page = await doc.getPage(opts.pageIndex + 1);
  const viewport = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const items = (tc.items as unknown[]).filter(isTextItem);
  const lines = clusterIntoLines(items);
  // 每行的完整信息(baseline + bbox + fontSize + text)
  interface LineInfo {
    baseline: number;
    rect: Rect;
    fontSize: number;
    fontName: string;
    text: string;
    fontClass: FontClass;
  }
  const lineInfos: LineInfo[] = [];
  for (const line of lines) {
    const { rect, fontSize, fontName } = rectOfLine(viewport.height, line.items);
    // WYSIWYG: 按几何位置拼字,保留 PDF 中真实的多空格和行首/行尾空格,
    // 不再 collapse / trim -- 这样编辑模式看到的文字和 pdfjs 渲染一致。
    const text = joinItemsPreservingSpaces(line.items);
    if (text.length === 0) continue;
    lineInfos.push({
      baseline: line.y,
      rect,
      fontSize,
      fontName,
      text,
      fontClass: classifyFontWithFallback(fontName, text),
    });
  }
  // 按段落聚类:相邻行(x 范围重叠 + 行间距合理 + 字号相近)合并
  interface Paragraph { lines: LineInfo[] }
  const paragraphs: Paragraph[] = [];
  for (const li of lineInfos) {
    const last = paragraphs[paragraphs.length - 1];
    if (last) {
      const prev = last.lines[last.lines.length - 1];
      const baselineDiff = li.baseline - prev.baseline;
      const minSize = Math.min(prev.fontSize, li.fontSize);
      const maxSize = Math.max(prev.fontSize, li.fontSize);
      const xOverlap = li.rect.x < prev.rect.x + prev.rect.w && li.rect.x + li.rect.w > prev.rect.x;
      const spacingOk = baselineDiff >= minSize * 0.8 && baselineDiff <= maxSize * 3.0;
      const sizeOk = maxSize / minSize <= 1.3;
      if (xOverlap && spacingOk && sizeOk) {
        last.lines.push(li);
        continue;
      }
    }
    paragraphs.push({ lines: [li] });
  }
  const blocks: TextBlock[] = paragraphs.map((para, i) => {
    // WYSIWYG: 保留段落首尾真实空格,不再 trim。
    // 注意:每行已在上面用 `if (!text.trim()) continue` 过滤掉纯空白行,
    // 所以段落里至少有一行非空白文字,不会出现段落整体为空白的情况。
    const text = para.lines.map((l) => l.text).join('\n');
    const minX = Math.min(...para.lines.map((l) => l.rect.x));
    const minY = Math.min(...para.lines.map((l) => l.rect.y));
    const maxRight = Math.max(...para.lines.map((l) => l.rect.x + l.rect.w));
    const maxBottom = Math.max(...para.lines.map((l) => l.rect.y + l.rect.h));
    const head = para.lines[0];
    let lineHeight = 1.2;
    if (para.lines.length > 1) {
      const diffs: number[] = [];
      for (let j = 1; j < para.lines.length; j++) {
        diffs.push(para.lines[j].baseline - para.lines[j - 1].baseline);
      }
      const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      lineHeight = avgDiff / head.fontSize;
    }
    return {
      id: `tb-${opts.pageIndex}-${i}`,
      bbox: {
        x: minX,
        y: minY,
        w: Math.max(1, maxRight - minX),
        h: Math.max(1, maxBottom - minY),
      },
      text,
      font: head.fontName,
      fontSize: head.fontSize,
      color: '#000000',
      lineHeight: Math.max(0.5, Math.round(lineHeight * 100) / 100),
      bold: /bold/i.test(head.fontName),
      italic: /italic|oblique/i.test(head.fontName),
      fontClass: head.fontClass,
    } satisfies TextBlock;
  });
  page.cleanup();
  return blocks;
}

export const pdfLibFallbackEngine: EngineInterface = {
  kind: 'pdflib-overlay',
  detectTextBlocks: detectTextBlocksImpl,
};

void pdfjsLib;
