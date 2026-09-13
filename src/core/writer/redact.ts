// core/writer/redact.ts
//
// MuPDF 字节级删字管线。替代旧的 pdf-lib 白底覆盖策略。
//
// 流程:
//   1. 用 MuPDF 打开干净的原 PDF 字节
//   2. 按 (页, 模式) 分组,每组创建一个 Redact 注释,setQuadPoints,
//      applyRedactions(...) -- 按模式决定是否同时抹除图片/矢量
//   3. saveToBuffer -> 返回 redacted 字节
//
// 关键:walker 的 quad 与 setQuadPoints 同属 MuPDF 内部坐标系,直接透传,
// 无需任何坐标转换(旧白底路径要 pageHeight - q.y - q.h 是因为跨到 pdf-lib)。
// 该坐标约定已由 scripts/experiment-redact.mjs 实证:被覆盖的文本消失、
// 未被覆盖的文本保留 —— 若 y 轴方向反了,结果会恰好相反。
//
// 两种模式(参数语义经 experiment-redact.mjs 逐项验证,勿凭字面猜测):
//
//   * 'text-only'(默认,文本编辑内部路径)
//       只删文字,图片与矢量原样保留。
//       实验对照组:图片 1400->1400 px、矢量 381->381 px,均存活。
//
//   * 'full'(用户可见的「涂黑 / 密文」工具)
//       删文字 + 抹除覆盖区域的图片像素 + 移除被触及的矢量图元。
//       实验:被覆盖的图片半边 1400->0 px,未被覆盖的半边 1400->1400 px
//       完好无损,矢量 381->0。这才是"真脱敏"。
//
// 为什么必须区分:把 'text-only' 直接用于涂黑工具会产出**假脱敏** ——
// 黑框画上了、文字也删了,但框下的图片像素与矢量仍然留在文件里,几秒即可
// 提取。竞品评测反复强调"AI 标记 ≠ 脱敏"正是这个陷阱。
//
// 失败兜底:若 MuPDF redaction 抛错,返回原始 cleanBytes + redacted:false。
// 文本编辑路径据此走旧白底路径;涂黑路径**不允许**静默降级(见
// features/export/exportPdf.ts 的硬失败检查),否则用户会拿到一份看起来
// 已脱敏、实际没有脱敏的文件。
import { loadMupdf, type MupdfNs } from '../mupdf/loader';
import type { Rect } from '../types';

/**
 * 'text-only' = 仅删字(文本编辑内部使用);
 * 'full'      = 真脱敏:同时抹除覆盖区域的图片像素与被触及的矢量图元。
 */
export type RedactMode = 'text-only' | 'full';

export interface RedactEdit {
  /** 原始 PDF 中的页索引(0-based,不含 blank 页)。 */
  pageIndex: number;
  /** 检测时的原始位置(redaction 区域)。 */
  originalBbox: Rect;
  /** 缺省 'text-only'。 */
  mode?: RedactMode;
}

export interface RedactResult {
  bytes: Uint8Array;
  /** true = redaction 执行成功;false = 失败,调用方决定兜底策略。 */
  redacted: boolean;
}

/**
 * applyRedactions 的四个参数。取值来自 mupdf 的 PDFPage 常量
 * (见 node_modules/mupdf/dist/mupdf.d.ts):
 *   REDACT_IMAGE_NONE=0 / REMOVE=1 / PIXELS=2 / UNLESS_INVISIBLE=3
 *   REDACT_LINE_ART_NONE=0 / REMOVE_IF_COVERED=1 / REMOVE_IF_TOUCHED=2
 *   REDACT_TEXT_REMOVE=0 / NONE=1
 *
 * 用 PIXELS(2) 而非 REMOVE(1):REMOVE 会把整张图片整体删掉(哪怕只有
 * 一小角被覆盖,留下一个洞);PIXELS 只把被覆盖的像素抹掉,图片其余部分
 * 保留 —— 扫描件正是靠这个行为才能只遮住局部。
 *
 * 用 REMOVE_IF_TOUCHED(2) 而非 REMOVE_IF_COVERED(1):脱敏要的是"宁可多删",
 * 一条穿过涂黑区又伸到区外的矢量线(如签名笔画、图表折线)仍可能泄漏信息。
 */
const REDACT_IMAGE_PIXELS = 2;
const REDACT_LINE_ART_REMOVE_IF_TOUCHED = 2;
const REDACT_TEXT_REMOVE = 0;

interface RedactParams {
  blackBoxes: boolean;
  imageMethod: number;
  lineArtMethod: number;
  textMethod: number;
}

/**
 * blackBoxes 恒为 false:黑框由 flatten 阶段用用户画的那个矩形绘制,
 * 这样"看到的框"与"被删的范围"严格一致,也才能支持自定义颜色/白色遮盖。
 */
const PARAMS: Record<RedactMode, RedactParams> = {
  'text-only': {
    blackBoxes: false,
    imageMethod: 0,
    lineArtMethod: 0,
    textMethod: REDACT_TEXT_REMOVE,
  },
  full: {
    blackBoxes: false,
    imageMethod: REDACT_IMAGE_PIXELS,
    lineArtMethod: REDACT_LINE_ART_REMOVE_IF_TOUCHED,
    textMethod: REDACT_TEXT_REMOVE,
  },
};

/**
 * 对 cleanBytes 应用所有编辑块的 redaction,返回 redacted 字节。
 * 若 MuPDF 不可用或 redaction 失败,返回原始字节 + redacted:false。
 */
export async function applyMupdfRedactions(
  cleanBytes: Uint8Array,
  edits: RedactEdit[]
): Promise<RedactResult> {
  if (edits.length === 0) {
    return { bytes: cleanBytes, redacted: true };
  }
  try {
    const mupdf = await loadMupdf();
    return applyRedactionsImpl(mupdf, new Uint8Array(cleanBytes), edits);
  } catch (err) {
    console.warn('[redact] MuPDF 不可用,跳过 redaction:', err);
    return { bytes: cleanBytes, redacted: false };
  }
}

type MupdfQuad = [number, number, number, number, number, number, number, number];

function applyRedactionsImpl(
  mupdf: MupdfNs,
  bytes: Uint8Array,
  edits: RedactEdit[]
): RedactResult {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  try {
    const pdfDoc = doc.asPDF();
    if (!pdfDoc) {
      console.warn('[redact] doc.asPDF() 返回 null,跳过');
      return { bytes, redacted: false };
    }

    // 按页分组,页内再按模式分组 —— 同一页可能同时存在"文本编辑的只删字"
    // 与"涂黑工具的全量脱敏"。每组单独建注释并单独调用 applyRedactions,
    // 每组用各自的参数。experiment-redact.mjs 的 mixed 用例已验证 MuPDF
    // 会逐注释遵守各自参数(矢量 381->381 未被误删)。
    const byPage = new Map<number, Map<RedactMode, Rect[]>>();
    for (const edit of edits) {
      const mode = edit.mode ?? 'text-only';
      let modes = byPage.get(edit.pageIndex);
      if (!modes) {
        modes = new Map();
        byPage.set(edit.pageIndex, modes);
      }
      let list = modes.get(mode);
      if (!list) {
        list = [];
        modes.set(mode, list);
      }
      list.push(edit.originalBbox);
    }

    let totalQuadsApplied = 0;

    for (const [pageIndex, modes] of byPage) {
      const page = pdfDoc.loadPage(pageIndex) as import('mupdf').PDFPage;
      try {
        for (const [mode, bboxes] of modes) {
          const pageQuads =
            mode === 'full'
              ? bboxes.map(bboxToQuad)
              : collectQuadsForBboxes(page, bboxes);
          if (pageQuads.length === 0) continue;

          const annot = page.createAnnotation('Redact');
          annot.setQuadPoints(pageQuads as import('mupdf').Quad[]);
          const p = PARAMS[mode];
          page.applyRedactions(
            p.blackBoxes,
            p.imageMethod,
            p.lineArtMethod,
            p.textMethod
          );
          totalQuadsApplied += pageQuads.length;
          try {
            annot.destroy();
          } catch {
            /* ignore */
          }
        }
      } finally {
        page.destroy();
      }
    }

    if (totalQuadsApplied === 0) {
      // 没收集到任何 quad -- 不需要 save,返回原始字节。
      return { bytes, redacted: false };
    }

    const buffer = pdfDoc.saveToBuffer();
    return { bytes: buffer.asUint8Array(), redacted: true };
  } catch (err) {
    console.warn('[redact] redaction 执行失败,返回原始字节:', err);
    return { bytes, redacted: false };
  } finally {
    doc.destroy();
  }
}

/**
 * 'full' 模式直接把用户画的矩形转成 quad。
 *
 * 不做 text-only 那套"按字符 quad 收集 + 膨胀"的精细处理,原因有二:
 *   1. 用户画的是一个矩形,意图就是"这块区域全部抹掉"。按 bbox 精确匹配
 *      才能让"看到的黑框"与"被删的范围"严格一致。
 *   2. 图片/矢量区域本来就没有字符 quad 可收集(扫描件整页无文字层),
 *      只有用 bbox 本身才能覆盖到它们。
 *
 * 刻意不加 padding:text-only 路径的 0.05/0.25 膨胀是为了让文本编辑不漏掉
 * 字形边缘;但涂黑场景下,膨胀会把黑框之外的可见内容一并删掉,与用户预期
 * 不符。
 */
function bboxToQuad(b: Rect): MupdfQuad {
  return [b.x, b.y, b.x + b.w, b.y, b.x, b.y + b.h, b.x + b.w, b.y + b.h];
}

/**
 * 遍历 StructuredText,收集落在任一 bbox 区域内的字符原始 quad。
 * quad 透传不做坐标转换 -- MuPDF walker 与 setQuadPoints 同坐标系。
 *
 * 仅 'text-only' 模式使用:文本编辑需要按字形精确删除,避免误伤相邻文字。
 */
function collectQuadsForBboxes(
  page: import('mupdf').PDFPage,
  bboxes: Rect[]
): MupdfQuad[] {
  const hits: MupdfQuad[] = [];
  const stext = page.toStructuredText('preserve-spans');
  try {
    // 预计算每个 bbox 的扩展边界(与 textQuad.ts 一致的 padding)。
    const expanded = bboxes.map((b) => {
      const expandX = 0.05;
      const expandY = 0.25;
      return {
        xMin: b.x - b.w * expandX,
        xMax: b.x + b.w + b.w * expandX,
        yMin: b.y - b.h * expandY,
        yMax: b.y + b.h + b.h * expandY,
      };
    });

    const walker: Record<string, unknown> = {
      beginLine() { /* no-op */ },
      endLine() { /* no-op */ },
      beginTextBlock() { /* no-op */ },
      endTextBlock() { /* no-op */ },
      beginStruct() { /* no-op */ },
      endStruct() { /* no-op */ },
      onChar(
        _utf: string,
        _origin: number[],
        _font: unknown,
        _size: number,
        quad: number[]
      ) {
        if (quad.length < 8) return;
        // 计算 AABB 用于相交判定。
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity;
        for (let i = 0; i < 8; i += 2) {
          const xv = quad[i];
          const yv = quad[i + 1];
          if (xv < minX) minX = xv;
          if (xv > maxX) maxX = xv;
          if (yv < minY) minY = yv;
          if (yv > maxY) maxY = yv;
        }
        const cw = maxX - minX;
        const ch = maxY - minY;
        for (const e of expanded) {
          if (
            minX + cw >= e.xMin &&
            minX <= e.xMax &&
            minY + ch >= e.yMin &&
            minY <= e.yMax
          ) {
            hits.push([
              quad[0], quad[1],
              quad[2], quad[3],
              quad[4], quad[5],
              quad[6], quad[7],
            ]);
            return;
          }
        }
      },
      onImageBlock() { /* no-op */ },
      onVector() { /* no-op */ },
    };
    (stext as unknown as { walk: (w: unknown) => void }).walk(walker);
  } finally {
    stext.destroy();
  }

  // 兜底:walker 一个字都没拿到时,用 bbox 自身作为 quad(4 角点),
  // 确保至少有覆盖。这与 textQuad.ts 的 bbox 兜底语义一致。
  if (hits.length === 0) {
    return bboxes.map(bboxToQuad);
  }
  return hits;
}
