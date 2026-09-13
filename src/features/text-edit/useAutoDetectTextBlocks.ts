// features/text-edit/useAutoDetectTextBlocks.ts
//
// Auto-runs text-block detection when the `select` tool is active and the
// current page has no text-block overlays yet. Text editing is entered by
// double-clicking a block under `select`, so the blocks must exist before the
// user can edit them.
//
// Skips pages that already have text-block overlays (e.g. loaded from a saved
// project) so existing edits are never wiped.
import { useEffect, useRef } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { useDocumentStore } from '../../store/documentStore';
import { useEngineStore } from '../../store/engineStore';
import { runEngineDetection } from './runEngineDetection';

/**
 * Track which pageIds have already been auto-detected in this session, so we
 * don't re-run detection when switching back to a page we already processed.
 * Reset whenever the PDF bytes change (new document opened).
 */
export function useAutoDetectTextBlocks(): void {
  const tool = useEditorStore((s) => s.tool);
  const currentPageIndex = useEditorStore((s) => s.currentPageIndex);
  const pdfBytes = useDocumentStore((s) => s.pdfBytes);
  const pages = useDocumentStore((s) => s.pages);
  const overlays = useDocumentStore((s) => s.overlays);
  const detectionVisible = useEngineStore((s) => s.detectionVisible);

  const detectedPagesRef = useRef<Set<string>>(new Set());
  const lastPdfRef = useRef<Uint8Array | null>(null);

  useEffect(() => {
    // Reset the detected-pages set when a new document is loaded.
    if (pdfBytes !== lastPdfRef.current) {
      lastPdfRef.current = pdfBytes;
      detectedPagesRef.current = new Set();
    }
  }, [pdfBytes]);

  const currentPageId = pages[currentPageIndex]?.id;

  useEffect(() => {
    if (tool !== 'select') return;
    if (!pdfBytes || !currentPageId) return;
    // Don't re-detect a page we already processed in this session.
    if (detectedPagesRef.current.has(currentPageId)) return;
    // Don't auto-detect if the page already has text-block overlays
    // (e.g. loaded from a saved project with edits).
    const hasExistingBlocks = overlays.some(
      (o) => o.type === 'text-block' && o.pageId === currentPageId
    );
    if (hasExistingBlocks) {
      detectedPagesRef.current.add(currentPageId);
      return;
    }
    // Avoid concurrent detection runs (e.g. user is mid-detection via button).
    if (detectionVisible) return;

    detectedPagesRef.current.add(currentPageId);
    // 检测失败时取消标记,下次回到该页自动重试(比如引擎首次加载失败)。
    void runEngineDetection().then((ok) => {
      if (!ok) detectedPagesRef.current.delete(currentPageId);
    });
  }, [tool, pdfBytes, currentPageId, overlays, detectionVisible]);
}
