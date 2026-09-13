// core/mupdf/mupdfEngine.ts
//
// 基于 Artifex 官方 MuPDF.js (WebAssembly) 的检测引擎。
//
// 重构后只保留 detectTextBlocks(toStructuredText 抽取结构化文本)。
// 文本编辑不再在编辑时调引擎 -- 编辑只改 overlay,导出时用
// core/writer/textBlockEdits.ts 统一应用(字符级白底 + 重画)。
//
// CJK 字体加载已移至 core/writer/cjkFont.ts;
// 字符 quad 收集已移至 core/writer/textQuad.ts。
import type {
  DetectTextBlocksOptions,
  EngineInterface,
  TextBlock,
} from '../engine/types';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { FontClass, RichTextSegment } from '../types';
import { loadMupdf, type MupdfNs } from './loader';
import { classifyFontWithFallback, isSymbolFontName } from '../engine/fontClassify';
import { extractTextColors, matchColorsToAtoms } from '../pdf/textColor';
import { loadDocument } from '../pdf/loader';

// MuPDF 的 StructuredText JSON schema(`mupdf.d.ts` 里 `asJSON()` 返回
// string)。
interface MupdfStextJson {
  blocks: Array<{
    type: 'text' | 'image' | string;
    bbox: { x: number; y: number; w: number; h: number };
    lines?: Array<{
      wmode: number;
      bbox: { x: number; y: number; w: number; h: number };
      font: {
        name: string;
        family: string;
        weight: string;
        style: string;
        size: number;
      };
      x: number;
      y: number;
      text: string;
    }>;
  }>;
}

// ---------- PUA / symbol-font character mapping ------------------------------

// Windows 符号字体(Wingdings/Webdings/Symbol 等)把 bullet/符号编码在
// Unicode 私用区(U+E000-U+F8FF)。MuPDF 会原样吐出 PUA 码点,这些字符
// 在编辑器和导出重画时都会渲染成乱码(方块)。这里把常见 bullet 映射回
// 真实 Unicode;符号字体里无法识别的 PUA 字符直接丢弃(保留只会显示方块)。
const PUA_CHAR_MAP: Record<string, string> = {
  '': ' ', // Wingdings space
  '': '●', // Wingdings l  实心圆 bullet (●)
  '': '❍', // Wingdings m  阴影圆 (❍)
  '': '■', // Wingdings n  实心方块 (■)
  '': '□', // Wingdings p  空心方块 (□)
  '': '◆', // Wingdings u  实心菱形 (◆)
  '': '❖', // Wingdings v  菱形 (❖)
  '': '▪', // Wingdings §  小方块 bullet (▪)
  '': '➢', // Wingdings Ø  箭头 bullet (➢)
  '': '•', // Symbol ·     圆点 bullet (•)
  '': '✓', // Wingdings ü  对勾 (✓)
};

function sanitizeSymbolChars(text: string, fontName: string): string {
  if (!text) return text;
  let out = '';
  let hasPua = false;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0xe000 && code <= 0xf8ff) {
      hasPua = true;
      const mapped = PUA_CHAR_MAP[ch];
      if (mapped !== undefined) {
        out += mapped;
      } else if (!isSymbolFontName(fontName)) {
        // 非符号字体的 PUA 字符可能是自定义编码,原样保留。
        out += ch;
      }
      // 符号字体中未映射的 PUA 字符丢弃,避免乱码。
    } else {
      out += ch;
    }
  }
  return hasPua ? out : text;
}

// ---------- detectTextBlocks ------------------------------------------------

async function detectTextBlocksImpl(
  mupdf: MupdfNs,
  bytes: Uint8Array,
  pageIndex: number
): Promise<TextBlock[]> {
  const buf = new Uint8Array(bytes);
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');
  try {
    const page = doc.loadPage(pageIndex);
    let stext: ReturnType<typeof page.toStructuredText> | null = null;
    // pdfjs 文档/页:颜色抽取与 bbox 校正共用,cleanup 统一放在 finally。
    let pdfjsDoc: PDFDocumentProxy | null = null;
    let pdfjsPage: PDFPageProxy | null = null;
    let pageHeight = 0;
    try {
      // 用 "preserve-spans" 保证 mupdf 不会把多个视觉行合并到一行;
      // 我们自行按 baseline-y 聚类,把同行 span 拼成"一行一个 block"。
      stext = page.toStructuredText('preserve-spans');
      const json = JSON.parse(stext.asJSON()) as MupdfStextJson;
      interface AtomLine {
        id: string;
        bbox: { x: number; y: number; w: number; h: number };
        text: string;
        baseline: number;
        font: string;
        size: number;
        bold: boolean;
        italic: boolean;
        fontClass: FontClass;
        color?: string;
        /** 符号字体映射字符的绘制字号(=原字符推进宽度),size 仅用于聚类。 */
        drawSize?: number;
      }
      const atoms: AtomLine[] = [];
      let atomCounter = 0;
      for (const block of json.blocks) {
        if (block.type !== 'text' || !block.lines) continue;
        for (const line of block.lines) {
          const fi = line.font;
          const fName = (fi?.name ?? fi?.family ?? 'embedded');
          // WYSIWYG: 保留普通空格和制表符(\t),只去掉换行/控制符。
          // \t 在 PDF 中是合法的行内空白,必须保留。
          // 同时把符号字体(Wingdings 等)的 PUA bullet 映射回真实 Unicode,
          // 否则编辑/重画时会显示乱码。
          const rawText = (line.text ?? '').replace(/[\r\n\v\f]+/g, '');
          const text = sanitizeSymbolChars(rawText, fName);
          if (text.length === 0) continue;
          const baseline = (line.y ?? line.bbox.y + line.bbox.h) | 0;
          const fLower = fName.toLowerCase();
          const wLower = (fi?.weight ?? '').toLowerCase();
          const sLower = (fi?.style ?? '').toLowerCase();
          const fc = classifyFontWithFallback(fName, text);
          // 符号字体字符被映射后(如 Wingdings ●),原字符的推进宽度
          // (bbox.w,7pt)与映射字符在 CJK 字体里的全角宽度(=1em,10pt)
          // 不一致,按原字号重画圆点会变大。用原推进宽度作为该 segment
          // 的字号,映射字符在 CJK 字体中恰好 1em,绘制宽度即可还原。
          const drawSize =
            text !== rawText && isSymbolFontName(fName) && line.bbox.w > 0
              ? line.bbox.w
              : undefined;
          atoms.push({
            id: `atom-${pageIndex}-${atomCounter++}`,
            bbox: { ...line.bbox },
            text,
            baseline,
            font: fName,
            size: fi?.size || line.bbox.h || 12,
            bold: fLower.includes('bold') || wLower.includes('bold') || wLower === '700',
            italic: fLower.includes('italic') || fLower.includes('oblique') || sLower.includes('italic') || sLower.includes('oblique'),
            fontClass: fc,
            drawSize,
          });
        }
      }

      // ADR 0002: 提取每段 showText 的真实颜色,按位置匹配到每个 atom。
      // 在 atoms 聚合成 lines/blocks 之前先做,确保 atom.id 还在。
      try {
        pdfjsDoc = await loadDocument(new Uint8Array(bytes));
        pdfjsPage = await pdfjsDoc.getPage(pageIndex + 1);
        const viewport = pdfjsPage.getViewport({ scale: 1 });
        pageHeight = viewport.height;
        const coloredTexts = await extractTextColors(pdfjsPage);
        if (coloredTexts.length > 0) {
          const colorMap = matchColorsToAtoms(
            coloredTexts,
            atoms.map((a) => ({ id: a.id, bbox: a.bbox })),
            viewport.height
          );
          for (const atom of atoms) {
            const c = colorMap.get(atom.id);
            if (c) atom.color = c;
          }
        }
      } catch (err) {
        // 颜色抽取失败不阻断检测,atom.color 留空,后续 segment.color 也会空,
        // 渲染端会 fallback 到 block.color 或 '#000000'。
        console.warn('[mupdfEngine] 颜色抽取失败,使用默认黑色:', err);
      }
      // 按 baseline 聚类:同行 span (baseline 差 < 字号/2) 拼到一起。
      // 同行两个 atom 之间水平间距 > 平均字符宽度的 3 倍时拆分,
      // 阈值基于实际字符宽度而非写死的字号倍数。
      atoms.sort((a, b) => a.baseline - b.baseline || a.bbox.x - b.bbox.x);
      interface Line {
        baseline: number;
        atoms: AtomLine[];
        text: string;
        x: number;
        w: number;
        y: number;
        h: number;
        size: number;
        font: string;
        bold: boolean;
        italic: boolean;
        align?: 'left' | 'center' | 'right';
        isHeading?: boolean;
        fontClass: FontClass;
      }
      // 计算平均字符宽度:用所有 atom 的 text 长度 / bbox 宽度。
      function avgCharWidth(at: AtomLine): number {
        const charCount = [...(at.text || ' ')].length;
        return charCount > 0 ? at.bbox.w / charCount : at.size * 0.5;
      }

      const lines: Line[] = [];
      for (const atom of atoms) {
        const tol = Math.max(2, atom.size * 0.5);
        const last = lines[lines.length - 1];
        if (last && Math.abs(last.baseline - atom.baseline) <= tol) {
          const lastAtom = last.atoms[last.atoms.length - 1];
          const gap = atom.bbox.x - (lastAtom.bbox.x + lastAtom.bbox.w);
          // 阈值 = 两个 atom 中较大的平均字符宽度 * 3
          const avgW = Math.max(avgCharWidth(lastAtom), avgCharWidth(atom));
          if (gap > avgW * 3) {
            // 间距超过 3 个字符宽度 -- 拆分为独立块。
            lines.push({
              baseline: atom.baseline,
              atoms: [atom],
              text: '',
              x: atom.bbox.x,
              w: atom.bbox.w,
              y: atom.bbox.y,
              h: atom.bbox.h,
              size: atom.size,
              font: atom.font,
              bold: atom.bold,
              italic: atom.italic,
              fontClass: atom.fontClass,
            });
          } else {
            last.atoms.push(atom);
          }
        } else {
          lines.push({
            baseline: atom.baseline,
            atoms: [atom],
            text: '',
            x: atom.bbox.x,
            w: atom.bbox.w,
            y: atom.bbox.y,
            h: atom.bbox.h,
            size: atom.size,
            font: atom.font,
            bold: atom.bold,
            italic: atom.italic,
            fontClass: atom.fontClass,
          });
        }
      }
      for (const line of lines) {
        line.atoms.sort((a, b) => a.bbox.x - b.bbox.x);
        // WYSIWYG: atoms 已包含 MuPDF span 自带的空格,直接拼接即可,
        // 不再 trim -- 保留行首/行尾真实空格。
        //
        // 但 atom 之间的"可见间隙"(如 Wingdings 圆点与正文之间常有
        // 1-2 个字宽的空白,而两侧文本里没有空格字符)不在任何 atom 的
        // 文本里 -- 编辑/重画只按拼接后的字符串排版,不还原每个 atom
        // 的原始坐标,间隙会直接消失。这里按间隙宽度插入等量空格近似
        // 还原(思源字体空格实测 0.224-0.256em,按 0.25em 估算;
        // 向下取整避免总宽超出 bbox 触发重排换行)。
        let joined = '';
        line.atoms.forEach((a, i) => {
          if (i > 0) {
            const prev = line.atoms[i - 1];
            const gap = a.bbox.x - (prev.bbox.x + prev.bbox.w);
            const gapThreshold = a.size * 0.25;
            if (
              gap > gapThreshold &&
              !/\s$/.test(prev.text) &&
              !/^\s/.test(a.text)
            ) {
              const spaceW = Math.max(0.5, a.size * 0.25);
              const nSpaces = Math.min(8, Math.max(1, Math.floor(gap / spaceW)));
              // 空格写进下一个 atom 的文本(跟随其样式 segment),而不是
              // 只加在 line.text 上 -- 编辑器/重画都按 segments 排版,
              // 只加在 line.text 的话一进编辑器空格就会丢。
              a.text = ' '.repeat(nSpaces) + a.text;
            }
          }
          joined += a.text;
        });
        line.text = joined;
        line.x = Math.min(...line.atoms.map((a) => a.bbox.x));
        const maxR = Math.max(...line.atoms.map((a) => a.bbox.x + a.bbox.w));
        line.w = maxR - line.x;
        line.y = Math.min(...line.atoms.map((a) => a.bbox.y));
        const maxB = Math.max(...line.atoms.map((a) => a.bbox.y + a.bbox.h));
        line.h = maxB - line.y;
        line.size = line.atoms[0].size;
        line.font = line.atoms[0].font;
        line.bold = line.atoms[0].bold;
        line.italic = line.atoms[0].italic;
        line.fontClass = line.atoms[0].fontClass;
      }
      // Compute page content area and median font size for alignment/heading detection.
      const allLefts = lines.map((l) => l.x);
      const allRights = lines.map((l) => l.x + l.w);
      const leftEdge = allLefts.length > 0 ? Math.min(...allLefts) : 0;
      const rightEdge = allRights.length > 0 ? Math.max(...allRights) : 0;
      const contentCenter = (leftEdge + rightEdge) / 2;
      const contentWidth = Math.max(1, rightEdge - leftEdge);
      const alignTol = contentWidth * 0.05;
      const sortedSizes = lines.map((l) => l.size).sort((a, b) => a - b);
      const medianSize = sortedSizes.length > 0
        ? sortedSizes[Math.floor(sortedSizes.length / 2)]
        : 12;

      // Detect alignment and heading status for each line.
      for (const line of lines) {
        const lineLeft = line.x;
        const lineRight = line.x + line.w;
        const lineCenter = line.x + line.w / 2;
        const isLeft = Math.abs(lineLeft - leftEdge) <= alignTol;
        const isRight = Math.abs(lineRight - rightEdge) <= alignTol;
        const isCenter = Math.abs(lineCenter - contentCenter) <= alignTol;
        if (isCenter && !isLeft && !isRight) {
          line.align = 'center';
        } else if (isRight && !isLeft) {
          line.align = 'right';
        } else {
          line.align = 'left';
        }
        // Heading: font size significantly larger than median.
        line.isHeading = line.size > medianSize * 1.5;
      }

      // 按段落聚类:多行字号/粗细/斜体一致 -> 同一段落。
      // 任何一个样式属性不同 -> 拆分为独立块。
      // 行间距阈值基于实际字符宽度(自适应)。
      interface Paragraph { lines: Line[] }
      const paragraphs: Paragraph[] = [];
      for (const line of lines) {
        if (!line.text) continue;
        const last = paragraphs[paragraphs.length - 1];
        if (last) {
          const prev = last.lines[last.lines.length - 1];
          const baselineDiff = line.baseline - prev.baseline;
          const minSize = Math.min(prev.size, line.size);
          const maxSize = Math.max(prev.size, line.size);
          const xOverlap = line.x < prev.x + prev.w && line.x + line.w > prev.x;
          // 行间距:0.8x ~ 2.0x 字号(正常行距 1.2-1.5x)。
          const spacingOk = baselineDiff >= minSize * 0.8 && baselineDiff <= maxSize * 2.0;
          // 字号一致(1.1x 以内视为相同)。
          const sizeOk = maxSize / minSize <= 1.1;
          // 粗细和斜体必须一致才合并。
          const styleOk = line.bold === prev.bold && line.italic === prev.italic;
          // 对齐方式必须一致。
          const alignOk = (line.align || 'left') === (prev.align || 'left');
          // 标题边界不跨越。
          const headingOk = !!line.isHeading === !!prev.isHeading;
          if (xOverlap && spacingOk && sizeOk && styleOk && alignOk && headingOk) {
            last.lines.push(line);
            continue;
          }
        }
        paragraphs.push({ lines: [line] });
      }
      const blocks: TextBlock[] = [];
      paragraphs.forEach((para, idx) => {
        // WYSIWYG: 保留段落首尾真实空格,不再 trim。
        // 每行已在上面用 `if (!text.trim()) continue` 过滤掉纯空白行,
        // 所以段落里至少有一行非空白文字。
        const text = para.lines.map((l) => l.text).join('\n');
        if (!text) return;
        const minX = Math.min(...para.lines.map((l) => l.x));
        const minY = Math.min(...para.lines.map((l) => l.y));
        const maxRight = Math.max(...para.lines.map((l) => l.x + l.w));
        const maxBottom = Math.max(...para.lines.map((l) => l.y + l.h));
        const head = para.lines[0];
        let lineHeight = 1.2;
        if (para.lines.length > 1) {
          const diffs: number[] = [];
          for (let i = 1; i < para.lines.length; i++) {
            diffs.push(para.lines[i].baseline - para.lines[i - 1].baseline);
          }
          const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
          lineHeight = avgDiff / head.size;
        }
        // Build per-atom segments to preserve style changes at the font-run
        // level. MuPDF's preserve-spans splits different fonts into separate
        // lines (atoms), so each atom has a single consistent font/bold/italic/size.
        // \n is only added between different baselines (actual line breaks),
        // not between atoms on the same visual line.
        const rawSegs: RichTextSegment[] = [];
        para.lines.forEach((line, li) => {
          if (li > 0) rawSegs.push({ text: '\n' });
          for (const atom of line.atoms) {
            const seg: RichTextSegment = { text: atom.text };
            // 检测元数据:atom 位置,供渲染后按区域反推文字颜色。
            seg.bbox = atom.bbox;
            if (atom.bold) seg.bold = true;
            if (atom.italic) seg.italic = true;
            if (atom.font) seg.fontFamily = atom.font;
            // 符号字体映射字符(如 ●)用推进宽度换算的绘制字号,
            // 其余用原字号。
            if (atom.size) {
              seg.fontSize = Math.round(
                (atom.drawSize ?? atom.size) * 100
              ) / 100;
            }
            if (atom.fontClass) seg.fontClass = atom.fontClass;
            if (atom.color) seg.color = atom.color;
            rawSegs.push(seg);
          }
        });
        // Merge adjacent segments with identical style to reduce fragmentation.
        // 颜色检测失败的文档(atom 无色)不合并相邻同 style 段 —— 灰/蓝
        // 等真实颜色差异在 styleKey 中不可见,合并会让渲染后按 segment
        // 区域反推的颜色无法区分(一行内灰色正文 + 蓝色链接会被并成一段)。
        const segs: RichTextSegment[] = [];
        for (const seg of rawSegs) {
          const last = segs[segs.length - 1];
          const colorless = !last?.color && !seg.color;
          if (
            last &&
            !colorless &&
            !!last.bold === !!seg.bold &&
            !!last.italic === !!seg.italic &&
            (last.fontFamily || '') === (seg.fontFamily || '') &&
            (last.fontSize ?? 0) === (seg.fontSize ?? 0) &&
            (last.fontClass ?? '') === (seg.fontClass ?? '') &&
            (last.color ?? '') === (seg.color ?? '')
          ) {
            last.text += seg.text;
            if (seg.bbox && last.bbox) {
              last.bbox = {
                x: Math.min(last.bbox.x, seg.bbox.x),
                y: Math.min(last.bbox.y, seg.bbox.y),
                w:
                  Math.max(
                    last.bbox.x + last.bbox.w,
                    seg.bbox.x + seg.bbox.w
                  ) - Math.min(last.bbox.x, seg.bbox.x),
                h:
                  Math.max(
                    last.bbox.y + last.bbox.h,
                    seg.bbox.y + seg.bbox.h
                  ) - Math.min(last.bbox.y, seg.bbox.y),
              };
            }
          } else {
            segs.push({ ...seg });
          }
        }

        // Use the first line's alignment for the whole block.
        const blockAlign = head.align || 'left';

        // Block-level color: first atom's color (fallback to '#000000').
        const blockColor = head.atoms[0]?.color || '#000000';

        blocks.push({
          id: `tb-${pageIndex}-${idx}`,
          bbox: {
            x: minX,
            y: minY,
            w: Math.max(1, maxRight - minX),
            h: Math.max(1, maxBottom - minY),
          },
          text,
          font: head.font,
          fontSize: head.size,
          color: blockColor,
          lineHeight: Math.max(0.5, Math.round(lineHeight * 100) / 100),
          bold: head.bold,
          italic: head.italic,
          segments: segs,
          align: blockAlign,
          fontClass: head.fontClass,
        });
      });

      // ---------- 用 pdfjs getTextContent 校正 block bbox ------------------------
      // MuPDF stext 的行/块 bbox 与 pdfjs 的实际渲染位置可能有系统性偏差
      // (Pages/WPS 等导出的 PDF 常见,实测偏差可达 15px),而画布渲染(pdfjs)、
      // 白底、重画全部以 pdfjs 坐标为基准 —— 检测 bbox 偏了会导致白底盖不住
      // 原字(残影)、编辑框错位、重画与原字叠影。
      // 这里把与 block bbox 相交的 pdfjs item(渲染级精确位置)并入 bbox。
      if (pdfjsPage) {
        try {
          const tc = await pdfjsPage.getTextContent();
          type ItemRect = { x0: number; x1: number; y0: number; y1: number };
          const itemRects: ItemRect[] = [];
          for (const it of tc.items) {
            if (!('str' in it) || !it.str || !it.str.trim()) continue;
            const t = it.transform;
            const h = Math.abs(t[3]) || Math.abs(t[0]) || 10;
            const w = it.width > 0 ? it.width : h * 0.5;
            const x0 = t[4];
            // pdfjs transform[5] 是基线 y(y-up);换算为 y-down 的文字矩形,
            // 垂直方向放宽(ascent/降部)以容纳字形溢出。
            const yBaselineDown = pageHeight - t[5];
            itemRects.push({
              x0,
              x1: x0 + w,
              y0: yBaselineDown - h * 1.15,
              y1: yBaselineDown + h * 0.25,
            });
          }
          for (const block of blocks) {
            const b = block.bbox;
            // item 中心点落在 block bbox 内即归属该块;多个块命中时取
            // 垂直中心距最近者(上下紧邻块容错)。
            let best: ItemRect[] | null = null;
            let bestDist = Infinity;
            for (const r of itemRects) {
              const cx = (r.x0 + r.x1) / 2;
              const cy = (r.y0 + r.y1) / 2;
              if (cx < b.x || cx > b.x + b.w) continue;
              if (cy < b.y || cy > b.y + b.h) continue;
              const dist = Math.abs(cy - (b.y + b.h / 2));
              if (!best || dist < bestDist) {
                bestDist = dist;
                best = [r];
              } else if (dist === bestDist) {
                best.push(r);
              }
            }
            if (!best || best.length === 0) continue;
            const nx0 = Math.min(b.x, ...best.map((r) => r.x0));
            const ny0 = Math.min(b.y, ...best.map((r) => r.y0));
            const nx1 = Math.max(b.x + b.w, ...best.map((r) => r.x1));
            const ny1 = Math.max(b.y + b.h, ...best.map((r) => r.y1));
            block.bbox = {
              x: nx0,
              y: ny0,
              w: Math.max(1, nx1 - nx0),
              h: Math.max(1, ny1 - ny0),
            };
          }
        } catch (err) {
          console.warn('[mupdfEngine] bbox 校正失败,使用 MuPDF 原始 bbox:', err);
        }
      }
      return blocks;
    } finally {
      stext?.destroy();
      page.destroy();
      if (pdfjsPage) {
        try {
          pdfjsPage.cleanup();
        } catch {
          /* ignore */
        }
      }
      if (pdfjsDoc) {
        try {
          await pdfjsDoc.cleanup();
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    doc.destroy();
  }
}

// ---------- EngineInterface glue --------------------------------------------

export const mupdfEngine: EngineInterface = {
  kind: 'mupdf',

  async detectTextBlocks({
    pdfBytes,
    pageIndex,
  }: DetectTextBlocksOptions): Promise<TextBlock[]> {
    const mupdf = await loadMupdf();
    return detectTextBlocksImpl(mupdf, new Uint8Array(pdfBytes), pageIndex);
  },
};

export { loadMupdf };
