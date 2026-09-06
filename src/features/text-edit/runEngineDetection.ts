// features/text-edit/runEngineDetection.ts
//
// Orchestrates engine-driven detection (text blocks for `edit-text`, form
// fields for `form`) and writes results into documentStore / engineStore.
// Extracted from ToolSidebar so the same logic can be triggered automatically
// when a PDF is opened with the `edit-text` tool active.
import { detectTextBlocksForPage } from './detectTextBlocks';
import { detectFormFields } from '../forms/detectFormFields';
import { useDocumentStore } from '../../store/documentStore';
import { useEditorStore } from '../../store/editorStore';
import { useEngineStore } from '../../store/engineStore';
import { toast } from '../../utils/toast';

export type DetectionKind = 'edit-text' | 'form';

/**
 * Run engine detection for the given kind. For `edit-text`, detects text
 * blocks for the current page. For `form`, detects form fields across all
 * pages.
 *
 * 对 `edit-text`:如果当前页已有 text-block overlay(包括用户已编辑过的),
 * 直接跳过 —— 重新检测会先 wipe 该页所有 text-block,把用户的编辑一并
 * 清掉。此时返回 true(视为已就绪),想重新检测可先删除该页的块。
 *
 * Updates the engineStore detection UI state (progress / label / status) so
 * the TopBar LoadingOverlay reflects progress.
 *
 * @returns whether detection succeeded (or was skipped as already done).
 * Callers use false to allow a later retry (e.g. the auto-detect hook
 * un-marks the page so detection runs again on the next visit).
 */
export async function runEngineDetection(t: DetectionKind): Promise<boolean> {
  const { pdfBytes, pages, addOverlay } = useDocumentStore.getState();
  const eng = useEngineStore.getState();

  if (!pdfBytes || pages.length === 0) {
    eng.setEngineStatusMessage('请先打开 PDF');
    window.setTimeout(() => eng.setEngineStatusMessage(null), 3000);
    return false;
  }

  eng.setDetectionVisible(true);
  eng.setDetectionProgress(0);
  eng.setDetectionLabel('初始化引擎');
  eng.setDetectionTitle('正在检测文本块');
  eng.setEngineStatusMessage(null);

  try {
    // Defensive copy: the underlying ArrayBuffer may have been transferred
    // to a pdfjs worker and detached. Cloning here guarantees a fresh buffer.
    const safeBytes = new Uint8Array(pdfBytes);
    if (t === 'edit-text') {
      const pageIndex = useEditorStore.getState().currentPageIndex;
      const currentPage = pages[pageIndex];
      // 该页已有 text-block(检测过或含编辑)时不再重测,保护用户编辑。
      const hasExistingBlocks =
        currentPage &&
        useDocumentStore
          .getState()
          .overlays.some(
            (o) => o.type === 'text-block' && o.pageId === currentPage.id
          );
      if (hasExistingBlocks) {
        return true;
      }
      const { blocks } = await detectTextBlocksForPage({
        pageIndex,
        pdfBytes: safeBytes,
        onProgress: (p, label) => {
          eng.setDetectionProgress(p);
          if (label) eng.setDetectionLabel(label);
        },
      });

      // ADR 0002: 颜色抽取现在在 mupdfEngine 内部按 atom 级完成,
      // 这里不再做块级颜色覆盖。

      if (currentPage) {
        for (const b of blocks) {
          addOverlay({
            id: b.id,
            pageId: currentPage.id,
            type: 'text-block',
            bbox: b.bbox,
            originalBbox: b.bbox,
            originalText: b.text,
            text: b.text,
            font: b.font,
            fontSize: b.fontSize,
            color: b.color,
            lineHeight: b.lineHeight,
            bold: b.bold,
            italic: b.italic,
            align: b.align,
            segments: b.segments,
            originalSegments: b.segments,
            fontClass: b.fontClass,
          });
        }
      }
      eng.setEngineStatusMessage(`检测到 ${blocks.length} 个文本块`);
      return true;
    } else {
      // form detection
      const fields = await detectFormFields({
        pdfBytes: safeBytes,
        onProgress: (p, label) => {
          eng.setDetectionProgress(p);
          if (label) eng.setDetectionLabel(label);
        },
      });
      for (const f of fields) {
        const page = pages[f.pageIndex];
        if (!page) continue;
        addOverlay({
          id: f.id,
          pageId: page.id,
          type: 'form-field',
          fieldName: f.fieldName,
          kind: f.kind,
          bbox: f.bbox,
          options: f.options,
          value: f.value,
        });
      }
      eng.setEngineStatusMessage(`检测到 ${fields.length} 个表单字段`);
      return true;
    }
  } catch (err) {
    console.error(err);
    const msg = err instanceof Error ? err.message : String(err);
    eng.setEngineStatusMessage(`引擎调用失败: ${msg}`);
    toast.error(`引擎调用失败: ${msg}`);
    return false;
  } finally {
    eng.setDetectionProgress(1);
    eng.setDetectionLabel('完成');
    eng.setDetectionTitle(null);
    window.setTimeout(() => eng.setDetectionVisible(false), 400);
    window.setTimeout(() => eng.setEngineStatusMessage(null), 3000);
  }
}
