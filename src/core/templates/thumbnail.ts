// core/templates/thumbnail.ts
//
// Render page 1 of a PDF to a small raster data URL, used as cover art in the
// template gallery and by the "save current as template" flow.
//
// 历史:`thumbnail.ts` 原本导出 `generateThumbnail`(JPEG),而
// `user.ts` 里另有一份私有 `generateThumbnailDataUrl`(PNG),两者几乎逐行
// 重复。这里合并为单一实现 `renderPdfThumbnail`,`generateThumbnail` 保留为
// 兼容别名(旧导出无调用方,但删除一个已跟踪模块的公开符号风险更大)。
import { loadDocument } from '../pdf/loader';

export interface ThumbnailOptions {
  /** 封面必须放进的矩形;页面保持原始宽高比缩放。 */
  maxWidth?: number;
  maxHeight?: number;
}

const DEFAULT_MAX_W = 200;
const DEFAULT_MAX_H = 280;

/**
 * Render page 1 of `pdfBytes` into a PNG data URL.
 *
 * PNG (not JPEG) because covers may contain sharp text and flat colour, which
 * JPEG smears; the images are tiny either way.
 *
 * Returns an empty string on any failure — callers should still render the
 * card (with a letter placeholder) rather than dropping the template.
 */
export async function renderPdfThumbnail(
  pdfBytes: Uint8Array,
  options: ThumbnailOptions = {}
): Promise<string> {
  // Guard for non-DOM environments (node scripts, SSR).
  if (typeof document === 'undefined') return '';
  const maxW = options.maxWidth ?? DEFAULT_MAX_W;
  const maxH = options.maxHeight ?? DEFAULT_MAX_H;
  try {
    // loadDocument gives pdfjs a private copy of the buffer, so `pdfBytes`
    // stays usable by the caller afterwards (it still has to be stored /
    // base64-encoded). Handing pdfjs the original is what used to throw
    // "Cannot perform Construct on a detached or out-of-bounds ArrayBuffer".
    const doc = await loadDocument(pdfBytes);
    if (doc.numPages < 1) return '';
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const scale = Math.min(maxW / viewport.width, maxH / viewport.height);
    const scaled = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(scaled.width));
    canvas.height = Math.max(1, Math.floor(scaled.height));
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    // 先铺白底:PDF 页面自身没有底色,透明 PNG 在浅灰卡片上会看不清边界。
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport: scaled }).promise;
    page.cleanup();
    return canvas.toDataURL('image/png');
  } catch (err) {
    console.warn('[templates] thumbnail render failed:', err);
    return '';
  }
}

/** @deprecated Use {@link renderPdfThumbnail}. Kept for API compatibility. */
export interface GenerateThumbnailOptions {
  width?: number;
  height?: number;
  /** Ignored — output is PNG so there is no quality knob. */
  quality?: number;
}

/**
 * @deprecated Use {@link renderPdfThumbnail}, which returns `''` instead of
 * `null` on failure. Retained so the original export does not vanish.
 */
export async function generateThumbnail(
  pdfBytes: Uint8Array,
  options: GenerateThumbnailOptions = {}
): Promise<string | null> {
  const url = await renderPdfThumbnail(pdfBytes, {
    maxWidth: options.width,
    maxHeight: options.height,
  });
  return url || null;
}
