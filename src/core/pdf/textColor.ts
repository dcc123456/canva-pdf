// core/pdf/textColor.ts
//
// 从 PDF 内容流抽取文字真实颜色。MuPDF 的 StructuredText 不暴露颜色,
// 所以用 pdfjs 的 getOperatorList() 遍历算子表:
//   - 追踪 setFillRGBColor / setFillGray / setFillCMYKColor 的填色状态
//   - 遇到 showText 时用当前填色 + 文本矩阵位置记录 (text, color, x, y, w, h)
//   - 然后按位置匹配到 MuPDF 检测的 atom,赋真实颜色(ADR 0002)
//
// 坐标系:pdfjs 的文本矩阵 (e, f) 是 PDF 坐标(y-up, 原点在左下)。
// MuPDF block 的 bbox.y 是 y-down(原点在左上),与 textQuad.ts 的 quad 一致。
// 匹配时转换:block y-down -> y-up: yUp = pageHeight - yDown。
import type { PDFPageProxy } from 'pdfjs-dist';
import { pdfjsLib } from './loader';
import type { Rect } from '../types';

export interface ColoredText {
  text: string;
  color: string; // hex "#rrggbb"
  x: number; // PDF x (y-up, 左下原点)
  y: number; // PDF y baseline (y-up)
  /** Approximate width of the showText run. Used for atom bbox matching. */
  w: number;
  /** Approximate height (font size at this run). */
  h: number;
}

/**
 * 遍历 pdfjs operator list,记录每段文字的颜色和位置。
 * 每条 entry 的 (x, y, w, h) 是该 showText 调用覆盖的矩形。
 */
export async function extractTextColors(
  page: PDFPageProxy
): Promise<ColoredText[]> {
  const ops = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;
  const results: ColoredText[] = [];

  let color = { r: 0, g: 0, b: 0 }; // 默认黑色
  let textX = 0;
  let textY = 0;
  // 当前字体尺寸估算:getTextMatrix 的 d (transform[3]) 通常是字号(可能带 skew)
  let fontSizeEst = 12;

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];

    switch (fn) {
      case OPS.setFillRGBColor:
        color = { r: args[0], g: args[1], b: args[2] };
        break;
      case OPS.setFillGray: {
        const g = args[0];
        color = { r: g, g, b: g };
        break;
      }
      case OPS.setFillCMYKColor: {
        const [c, m, y, k] = args;
        // 简化 CMYK -> RGB 转换
        color = {
          r: (1 - c) * (1 - k),
          g: (1 - m) * (1 - k),
          b: (1 - y) * (1 - k),
        };
        break;
      }
      case OPS.setFont:
        // args = [fontName, size]
        if (typeof args[1] === 'number' && args[1] > 0) {
          fontSizeEst = args[1];
        }
        break;
      case OPS.setTextMatrix:
        // args = [a, b, c, d, e, f]; e=x, f=y (y-up)
        textX = args[4];
        textY = args[5];
        if (Math.abs(args[3]) > 0) fontSizeEst = Math.abs(args[3]);
        break;
      case OPS.moveText:
        // Td: 相对移动
        textX += args[0];
        textY += args[1];
        break;
      case OPS.showText:
      case OPS.showSpacedText: {
        const items = args[0] as Array<string | number>;
        let textStr = '';
        // 估算宽度:用 fontSizeEst * 0.5 作为平均字符宽度(粗略但够用)
        let widthEst = 0;
        for (const item of items) {
          if (typeof item === 'string') {
            textStr += item;
            widthEst += item.length * fontSizeEst * 0.5;
          } else if (typeof item === 'number') {
            // -num = 字距调整(千分之一 em);num = 间距(num/1000 em)
            widthEst += (item / 1000) * fontSizeEst;
          }
        }
        if (textStr.trim()) {
          results.push({
            text: textStr,
            color: rgbToHex(color.r, color.g, color.b),
            x: textX,
            y: textY,
            w: Math.max(widthEst, fontSizeEst * 0.5),
            h: fontSizeEst,
          });
        }
        // 累加 x 位置以便下一次 showText 调用从正确位置开始
        textX += widthEst;
        break;
      }
      default:
        break;
    }
  }

  return results;
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * 按位置将彩色文字条目匹配到 MuPDF atom,返回 atomId -> color 映射。
 *
 * @param coloredTexts extractTextColors 的输出(y-up 坐标)
 * @param atoms MuPDF 检测的 atom(bbox.y 是 y-down)
 * @param pageHeight 页面高度(用于 y-up <-> y-down 转换)
 */
export function matchColorsToAtoms(
  coloredTexts: ColoredText[],
  atoms: Array<{ id: string; bbox: Rect }>,
  pageHeight: number
): Map<string, string> {
  const result = new Map<string, string>();

  for (const atom of atoms) {
    // atom bbox 是 y-down;转 y-up
    const xMin = atom.bbox.x;
    const xMax = atom.bbox.x + atom.bbox.w;
    const yUpTop = pageHeight - atom.bbox.y;
    const yUpBottom = pageHeight - (atom.bbox.y + atom.bbox.h);

    const colorCounts = new Map<string, number>();
    for (const ct of coloredTexts) {
      // 检查 coloredText 的 bbox 与 atom bbox 是否相交
      const ctXMin = ct.x;
      const ctXMax = ct.x + ct.w;
      const ctYMin = ct.y;
      const ctYMax = ct.y + ct.h;
      const xOverlap = ctXMin < xMax && ctXMax > xMin;
      const yOverlap = ctYMin < yUpTop && ctYMax > yUpBottom;
      if (xOverlap && yOverlap) {
        colorCounts.set(ct.color, (colorCounts.get(ct.color) || 0) + 1);
      }
    }

    // 取出现次数最多的颜色
    let bestColor = '';
    let bestCount = 0;
    for (const [c, count] of colorCounts) {
      if (count > bestCount) {
        bestColor = c;
        bestCount = count;
      }
    }
    if (bestCount > 0) {
      result.set(atom.id, bestColor);
      continue;
    }
    // 最近邻回退:extractTextColors 的宽度是估算值(coloredText 的 bbox
    // 可能偏窄/偏移),相交判据会漏。退化为"垂直重叠 + x 中心最近"。
    const atomCx = (xMin + xMax) / 2;
    let nearest = null;
    let nearestDist = Infinity;
    for (const ct of coloredTexts) {
      const ctYMin = ct.y;
      const ctYMax = ct.y + ct.h;
      if (ctYMin > yUpTop || ctYMax < yUpBottom) continue;
      const dist = Math.abs(ct.x + ct.w / 2 - atomCx);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = ct;
      }
    }
    if (nearest) {
      result.set(atom.id, nearest.color);
    }
  }

  return result;
}

/**
 * 旧 API(已 deprecated,见 ADR 0002):按位置匹配到 MuPDF block,返回 blockId -> color。
 * 保留是为了向后兼容,新代码应使用 matchColorsToAtoms。
 */
export function matchColorsToBlocks(
  coloredTexts: ColoredText[],
  blocks: Array<{ id: string; bbox: Rect }>,
  pageHeight: number
): Map<string, string> {
  const result = new Map<string, string>();

  for (const block of blocks) {
    const xMin = block.bbox.x;
    const xMax = block.bbox.x + block.bbox.w;
    const yUpTop = pageHeight - block.bbox.y;
    const yUpBottom = pageHeight - (block.bbox.y + block.bbox.h);

    const colorCounts = new Map<string, number>();
    for (const ct of coloredTexts) {
      if (
        ct.x >= xMin &&
        ct.x <= xMax &&
        ct.y >= yUpBottom &&
        ct.y <= yUpTop
      ) {
        colorCounts.set(ct.color, (colorCounts.get(ct.color) || 0) + 1);
      }
    }

    let bestColor = '';
    let bestCount = 0;
    for (const [c, count] of colorCounts) {
      if (count > bestCount) {
        bestColor = c;
        bestCount = count;
      }
    }
    if (bestCount > 0) {
      result.set(block.id, bestColor);
    }
  }

  return result;
}
