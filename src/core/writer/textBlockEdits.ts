// core/writer/textBlockEdits.ts
//
// 导出时把"被编辑过的 text-block"(text !== originalText)统一应用到
// PDFDocument。重构后支持两种路径:
//   - redacted=true (优先): MuPDF 已字节级删字 (redact.ts),本函数只画新字
//   - redacted=false (兜底): MuPDF redaction 失败时,走旧白底覆盖 + 重画
//
// 旧路径(白底):
//   1. 用 MuPDF 从干净原 pdfBytes 收集原字字符级 quad
//   2. 用 pdf-lib 按字符 quad 画白底(精确覆盖原字)
//   3. 用 pdf-lib 在原 baseline 画新字(CJK 用 fontkit + Source Han Sans)
//
// 新路径(redaction):步骤 1-2 由 redact.ts 在导出前完成,本函数只做步骤 3。
//
// ADR 0001 后:字体策略改为 FontClass -> 具体字体映射,不再抽取原嵌入字体。
//   - 'sans'/'serif'/'mono' -> pdf-lib StandardFonts (Helvetica/Times/Courier)
//   - 'cjk-sans'/'cjk-serif' -> @pdf-lib/fontkit 嵌入 SourceHanSansCN-Regular.otf
//     (cjk-serif 暂时复用 SourceHanSans,等下载 Source Han Serif 后独立)
import { PDFDocument, PDFPage, PDFOperator, StandardFonts, rgb } from 'pdf-lib';
import type { PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { FontClass, PageMeta, TextBlockItem } from '../types';
import { hexToRgb, wrapText, alignedX } from './helpers';
import { loadCjkFontBytesForVariant, containsNonAscii, type FontWeight } from './cjkFont';
import { collectWhiteoutQuads, type Quad } from './textQuad';
import {
  FONT_CLASS_TO_PDF_STRATEGY,
  pickStandardFontVariant,
} from '../engine/fontClassify';

/**
 * 绘制单个 segment 到 page。
 * - 西文:用 StandardFonts 的 Bold/Italic 真变体(getFont 已选好),直接画。
 * - CJK Bold:getFont 加载真 Bold 字重文件(SourceHanSansCN-Bold.otf),直接画。
 * - CJK Italic:Source Han Sans 没有 italic 变体(CJK 字体惯例),
 *   用 pushOperators 设置 CTM 为斜切矩阵模拟。
 *
 * italic 模拟原理:CTM 矩阵 `1 0 italicSkew 1 -italicSkew*y 0 cm`
 * 让基线 y 处位置不变(通过 -italicSkew*y 平移补偿),
 * glyph 顶部向右偏 italicSkew*size,产生斜体效果。
 */
function drawSegmentText(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  size: number,
  font: PDFFont,
  fillColor: ReturnType<typeof rgb>,
  opts: { italic: boolean; isCjk: boolean }
): void {
  const { italic, isCjk } = opts;

  // 西文:字体已包含 italic 变体,直接画。
  // CJK 非 italic:直接画(Bold 已在 getFont 阶段选好字重文件)。
  if (!italic || !isCjk) {
    page.drawText(text, { x, y, size, font, color: fillColor });
    return;
  }

  // CJK italic 模拟:CTM 斜切。
  const italicSkew = 0.21; // ~12° = tan(12°)
  const translateX = -italicSkew * y;
  // q/Q/cm 是合法 PDF 操作符,但 pdf-lib 的 TS 类型白名单不含它们。
  // 用 as never 绕过类型检查;运行时 PDFOperator.of 接受任意字符串。
  page.pushOperators(PDFOperator.of('q' as never));
  page.pushOperators(
    PDFOperator.of(`1 0 ${italicSkew} 1 ${translateX} 0 cm` as never)
  );
  page.drawText(text, { x, y, size, font, color: fillColor });
  page.pushOperators(PDFOperator.of('Q' as never));
}
// pickStandardFontVariant returns one of these strings; we map to the enum
// value to call doc.embedFont.
const STANDARD_FONT_BY_NAME: Record<string, StandardFonts> = {
  Helvetica: StandardFonts.Helvetica,
  'Helvetica-Bold': StandardFonts.HelveticaBold,
  'Helvetica-Oblique': StandardFonts.HelveticaOblique,
  'Helvetica-BoldOblique': StandardFonts.HelveticaBoldOblique,
  'Times-Roman': StandardFonts.TimesRoman,
  'Times-Bold': StandardFonts.TimesRomanBold,
  'Times-Italic': StandardFonts.TimesRomanItalic,
  'Times-BoldItalic': StandardFonts.TimesRomanBoldItalic,
  Courier: StandardFonts.Courier,
  'Courier-Bold': StandardFonts.CourierBold,
  'Courier-Oblique': StandardFonts.CourierOblique,
  'Courier-BoldOblique': StandardFonts.CourierBoldOblique,
};

export interface ApplyTextBlockRedrawsOptions {
  /** 已通过 applyPages 处理好页面顺序/旋转的 PDFDocument。 */
  doc: PDFDocument;
  /** 原 PDF 字节。redacted=true 时为已删字字节;redacted=false 时为干净原字节(用于白底 quad)。 */
  originalBytes: Uint8Array;
  pages: PageMeta[];
  /** 仅 text !== originalText 的 text-block。 */
  textBlocks: TextBlockItem[];
  /** true = MuPDF 已 redact(跳过白底);false = 走白底兜底。 */
  redacted: boolean;
  /** 块局部背景色(画布采样):白底兜底时使用,彩色底板不变白。 */
  pageBgColors?: Record<string, string>;
}

/**
 * 对每个被编辑的 text-block:
 *   - redacted=true: 直接画新字(MuPDF 已删原字)
 *   - redacted=false: 收集字符 quad -> 画白底 -> 画新字
 */
export async function applyTextBlockRedraws(
  options: ApplyTextBlockRedrawsOptions
): Promise<void> {
  const { doc, originalBytes, pages, textBlocks, redacted } = options;
  if (textBlocks.length === 0) return;

  // 字体缓存:同一字体只 embed 一次。
  // key 形如 "standard:Helvetica-Bold" 或 "cjk:cjk-sans:bold"
  const fontCache = new Map<string, PDFFont>();
  const cjkFontAttempted = new Set<string>();

  async function getFont(
    text: string,
    bold: boolean,
    italic: boolean,
    fontClass: FontClass = 'sans'
  ): Promise<{ font: PDFFont; safe: string }> {
    // 防御:如果调用方传入 'sans' 但文本含 CJK,说明 fontClass 未被检测端
    // 设置(可能是老 .minipdf.json 项目),fallback 到 cjk-sans。
    // 否则会走 StandardFonts 路径把中文转成 '?'。
    if (fontClass === 'sans' && containsNonAscii(text)) {
      fontClass = 'cjk-sans';
    }
    const strategy = FONT_CLASS_TO_PDF_STRATEGY[fontClass];

    if (strategy.kind === 'standard') {
      const variantName = pickStandardFontVariant(strategy.name, bold, italic);
      const cacheKey = `standard:${variantName}`;
      // pdf-lib StandardFonts 的变体名(如 Helvetica-Bold)需要单独 embed
      const standardEnum = STANDARD_FONT_BY_NAME[variantName];
      let f = fontCache.get(cacheKey);
      if (!f) {
        f = await doc.embedFont(standardEnum);
        fontCache.set(cacheKey, f);
      }
      // StandardFonts 仅 WinAnsi,非 ASCII 字符降级为 ?
      let safe = '';
      for (const ch of text) {
        safe += (ch.codePointAt(0) ?? 0) > 0x7e ? '?' : ch;
      }
      return { font: f, safe };
    }

    // strategy.kind === 'cjk-file' -- 加载对应 fontClass + weight 变体。
    // Bold 用真 Bold 字重文件(SourceHanSansCN-Bold.otf 等),不靠偏移模拟。
    // Italic 用 CTM 斜切模拟(Source Han Sans 没有 italic 变体,这是 CJK 字体惯例)。
    const weight: FontWeight = bold ? 'bold' : 'regular';
    const cacheKey = `cjk:${fontClass}:${weight}`;
    if (!cjkFontAttempted.has(cacheKey)) {
      cjkFontAttempted.add(cacheKey);
      doc.registerFontkit(fontkit);
      const bytes = await loadCjkFontBytesForVariant(fontClass, weight);
      if (bytes) {
        try {
          // 用 subset: false 嵌入整字体。subset: true 对 CID/CFF 字体
          // (Source Han Sans)可能产生不完整子集,导致中文字形缺失。
          // 整字体嵌入虽然 PDF 略大(~8MB),但保证所有字形可用。
          const font = await doc.embedFont(bytes, { subset: false });
          fontCache.set(cacheKey, font);
        } catch (err) {
          console.warn('[textBlockEdits] embedFont %s 失败:', cacheKey, err);
        }
      }
    }
    const cjkFont = fontCache.get(cacheKey);
    if (cjkFont) {
      return { font: cjkFont, safe: text };
    }
    // CJK 字体加载失败 -> 退回 Helvetica,非 ASCII 变 ?
    const fbKey = 'standard:Helvetica';
    let f = fontCache.get(fbKey);
    if (!f) {
      f = await doc.embedFont(StandardFonts.Helvetica);
      fontCache.set(fbKey, f);
    }
    let safe = '';
    for (const ch of text) {
      safe += (ch.codePointAt(0) ?? 0) > 0x7e ? '?' : ch;
    }
    return { font: f, safe };
  }

  for (const block of textBlocks) {
    const editorPageIndex = pages.findIndex((p) => p.id === block.pageId);
    if (editorPageIndex < 0) continue;
    const meta = pages[editorPageIndex];
    const originalPageIndex = meta.isBlank ? -1 : meta.index;
    if (originalPageIndex < 0) {
      continue;
    }

    const page: PDFPage = doc.getPage(editorPageIndex);
    const pageHeight = page.getHeight();
    const { r, g, b } = hexToRgb(block.color || '#000000');
    // 白底颜色:优先用画布采样到的块局部背景色(彩色底板上的文字,
    // 纯白白底会破坏底色),采样缺失时退回纯白。
    const bgHex = options.pageBgColors?.[block.id] || '#ffffff';
    const bg = hexToRgb(bgHex);
    const white = rgb(bg.r, bg.g, bg.b);
    const fontSize = Math.max(block.fontSize, 6);
    const lineHeight = block.lineHeight || 1.2;
    const align = block.align || 'left';
    const lineStep = fontSize * lineHeight;

    // 白底覆盖:仅在未 redact 时执行(redact 路径已字节级删字,无需覆盖)。
    if (!redacted) {
      // (1) 收集原字字符 quad(从干净原 PDF,在 originalBbox 位置)。
      const quads: Quad[] = await collectWhiteoutQuads(
        new Uint8Array(originalBytes),
        originalPageIndex,
        block.originalBbox
      );

      // (2) 按字符 quad 画白底。
      for (const q of quads) {
        const padY = Math.max(1, q.h * 0.1);
        const padX = 0.5;
        const yPdf = pageHeight - q.y - q.h - padY;
        page.drawRectangle({
          x: q.x - padX,
          y: yPdf,
          width: q.w + 2 * padX,
          height: q.h + 2 * padY,
          color: white,
          borderWidth: 0,
          opacity: 1,
        });
      }
    }

    // (3) 画新字。
    if (!block.text) continue;

    if (block.segments && block.segments.length > 0) {
      // Draw segments sequentially with per-line alignment.
      // Each segment can have its own bold/italic/underline/strike/color/fontSize/fontFamily.
      type SegInfo = {
        text: string;
        font: PDFFont;
        width: number;
        color: string;
        size: number;
        underline: boolean;
        strike: boolean;
        bold: boolean;
        italic: boolean;
        /** true 表示该 SegInfo 用的是 CJK 字体(没有 Bold 变体,需要靠偏移模拟粗体) */
        isCjk: boolean;
      };
      const lines: SegInfo[][] = [[]];

      for (const seg of block.segments) {
        const segBold = !!seg.bold;
        const segItalic = !!seg.italic;
        const segColor = seg.color || block.color;
        const segSize = seg.fontSize || block.fontSize;
        const segFontClass: FontClass = seg.fontClass || block.fontClass || 'sans';
        const parts = seg.text.split('\n');
        for (let pi = 0; pi < parts.length; pi++) {
          if (pi > 0) lines.push([]);
          const partText = parts[pi].replace(/\t/g, '    ');
          if (partText) {
            try {
              const { font, safe } = await getFont(
                partText,
                segBold,
                segItalic,
                segFontClass
              );
              const width = font.widthOfTextAtSize(safe, segSize);
              const strategy = FONT_CLASS_TO_PDF_STRATEGY[segFontClass];
              const isCjk = strategy.kind === 'cjk-file';
              lines[lines.length - 1].push({
                text: safe,
                font,
                width,
                color: segColor,
                size: segSize,
                underline: !!seg.underline,
                strike: !!seg.strike,
                bold: segBold,
                italic: segItalic,
                isCjk,
              });
            } catch (err) {
              console.warn(
                '[textBlockEdits] segment getFont 失败,跳过 segment:',
                err
              );
            }
          }
        }
      }

      try {
        for (let li = 0; li < lines.length; li++) {
          const segs = lines[li];
          if (segs.length === 0) continue;
          const totalW = segs.reduce((sum, s) => sum + s.width, 0);
          let x = alignedX(align, block.bbox.x, block.bbox.w, totalW);
          const y =
            pageHeight - block.bbox.y - fontSize - li * lineStep;
          for (const s of segs) {
            const { r: sr, g: sg, b: sb } = hexToRgb(s.color);
            const fillColor = rgb(sr, sg, sb);
            // 用统一入口绘制:CJK 模拟 italic,西文用真变体。
            // Bold 不再需要模拟 -- getFont 已加载真 Bold 字重文件。
            drawSegmentText(page, s.text, x, y, s.size, s.font, fillColor, {
              italic: s.italic,
              isCjk: s.isCjk,
            });
            // Draw underline / strikethrough as thin lines.
            if (s.underline || s.strike) {
              const underY = y - 1;
              const strikeY = y + s.size * 0.3;
              const lineColor = rgb(sr, sg, sb);
              if (s.underline) {
                page.drawLine({
                  start: { x, y: underY },
                  end: { x: x + s.width, y: underY },
                  thickness: Math.max(0.5, s.size / 18),
                  color: lineColor,
                });
              }
              if (s.strike) {
                page.drawLine({
                  start: { x, y: strikeY },
                  end: { x: x + s.width, y: strikeY },
                  thickness: Math.max(0.5, s.size / 18),
                  color: lineColor,
                });
              }
            }
            x += s.width;
          }
        }
      } catch (err) {
        console.warn(
          '[textBlockEdits] segments drawText 失败,用 ? 兜底重试 block %s:',
          block.id,
          err
        );
        await fallbackDrawText(
          doc,
          fontCache,
          page,
          pageHeight,
          block,
          fontSize,
          lineStep,
          align,
          rgb(r, g, b)
        );
      }
    } else {
      // No segments: wrap + align + multi-line.
      const blockFontClass: FontClass = block.fontClass || 'sans';
      const { font, safe } = await getFont(
        block.text.replace(/\t/g, '    '),
        block.bold,
        block.italic,
        blockFontClass
      );
      const blockStrategy = FONT_CLASS_TO_PDF_STRATEGY[blockFontClass];
      const blockIsCjk = blockStrategy.kind === 'cjk-file';

      const drawAllLines = (f: PDFFont, text: string) => {
        const wrappedLines = wrapText(f, text, block.bbox.w, fontSize);
        for (let li = 0; li < wrappedLines.length; li++) {
          const lineW = f.widthOfTextAtSize(wrappedLines[li], fontSize);
          const x = alignedX(align, block.bbox.x, block.bbox.w, lineW);
          const y =
            pageHeight - block.bbox.y - fontSize - li * lineStep;
          drawSegmentText(page, wrappedLines[li], x, y, fontSize, f, rgb(r, g, b), {
            italic: block.italic,
            isCjk: blockIsCjk,
          });
        }
      };

      try {
        drawAllLines(font, safe);
      } catch (err) {
        console.warn(
          '[textBlockEdits] drawText 失败,用 ? 兜底重试 block %s:',
          block.id,
          err
        );
        await fallbackDrawText(
          doc,
          fontCache,
          page,
          pageHeight,
          block,
          fontSize,
          lineStep,
          align,
          rgb(r, g, b)
        );
      }
    }
  }
}

/** Fallback: draw with Helvetica and '?' for non-ASCII characters. */
async function fallbackDrawText(
  doc: PDFDocument,
  fontCache: Map<string, PDFFont>,
  page: PDFPage,
  pageHeight: number,
  block: TextBlockItem,
  fontSize: number,
  lineStep: number,
  align: 'left' | 'center' | 'right',
  color: ReturnType<typeof rgb>
): Promise<void> {
  try {
    const cacheKey = 'standard:Helvetica';
    let fb = fontCache.get(cacheKey);
    if (!fb) {
      fb = await doc.embedFont(StandardFonts.Helvetica);
      fontCache.set(cacheKey, fb);
    }
    let safeAscii = '';
    for (const ch of block.text.replace(/\t/g, '    ')) {
      safeAscii += (ch.codePointAt(0) ?? 0) > 0x7e ? '?' : ch;
    }
    const wrappedLines = wrapText(fb, safeAscii, block.bbox.w, fontSize);
    for (let li = 0; li < wrappedLines.length; li++) {
      const lineW = fb.widthOfTextAtSize(wrappedLines[li], fontSize);
      const x = alignedX(align, block.bbox.x, block.bbox.w, lineW);
      const y = pageHeight - block.bbox.y - fontSize - li * lineStep;
      page.drawText(wrappedLines[li], {
        x,
        y,
        size: fontSize,
        font: fb,
        color,
      });
    }
  } catch (err2) {
    console.error(
      '[textBlockEdits] 兜底 drawText 也失败,跳过 block %s:',
      block.id,
      err2
    );
  }
}
