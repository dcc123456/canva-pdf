// Viewer: renders the current page from a PDF.js document and hosts the
// overlay layer + tool interaction layer. Simplified to a pure canvas area;
// page navigation and zoom controls now live in BottomBar.
import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { renderPage } from '../../core/pdf/renderer';
import { useEditorStore } from '../../store/editorStore';
import { useDocumentStore } from '../../store/documentStore';
import type { PageMeta } from '../../core/types';
import { OverlayLayer } from '../overlays/OverlayLayer';
import { CanvasInteractionLayer } from './CanvasInteractionLayer';
import { FormFieldOverlay } from '../forms/FormFieldOverlay';
import { TextBlockEditLayer } from '../text-edit/TextBlockEditLayer';

export interface ViewerProps {
  doc: PDFDocumentProxy | null;
}

function rotatedSize(page: PageMeta): { width: number; height: number } {
  if (page.rotation === 90 || page.rotation === 270) {
    return { width: page.height, height: page.width };
  }
  return { width: page.width, height: page.height };
}

export function Viewer({ doc }: ViewerProps) {
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);

  const currentPageIndex = useEditorStore((s) => s.currentPageIndex);
  const zoom = useEditorStore((s) => s.zoom);
  const setZoom = useEditorStore((s) => s.setZoom);
  const nextPage = useEditorStore((s) => s.nextPage);
  const prevPage = useEditorStore((s) => s.prevPage);
  const zoomIn = useEditorStore((s) => s.zoomIn);
  const zoomOut = useEditorStore((s) => s.zoomOut);
  const setSelectedOverlayId = useEditorStore((s) => s.setSelectedOverlayId);

  const pages = useDocumentStore((s) => s.pages);

  // Keyboard shortcuts for page navigation and zoom (global while Viewer is mounted).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        nextPage();
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        prevPage();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomIn();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomOut();
      } else if (e.key === '0' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setZoom(1);
      } else if (e.key === 'Escape') {
        setSelectedOverlayId(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nextPage, prevPage, zoomIn, zoomOut, setZoom, setSelectedOverlayId]);

  // Determine which page to render overlays for.
  const overlayPage: PageMeta | undefined =
    pages[Math.min(currentPageIndex, Math.max(0, pages.length - 1))];

  // Render current page at current zoom + page rotation.
  useEffect(() => {
    let cancelled = false;
    async function draw() {
      if (!doc || !canvasRef.current || !overlayPage) return;
      const pageNumber = currentPageIndex + 1;
      if (pageNumber < 1 || pageNumber > doc.numPages) return;
      const page: PDFPageProxy = await doc.getPage(pageNumber);
      if (cancelled) {
        page.cleanup();
        return;
      }
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch {
          /* ignore */
        }
        renderTaskRef.current = null;
      }
      try {
        await renderPage(page, canvasRef.current, {
          scale: zoom,
          rotation: overlayPage.rotation,
        });
        // Sample background color per text-block from the rendered canvas.
        // Samples just OUTSIDE each block's top-left corner to get the local
        // background (may differ from page background for colored boxes).
        if (overlayPage) {
          const ctx = canvasRef.current.getContext('2d');
          if (ctx) {
            const dpr = window.devicePixelRatio || 1;
            const store = useDocumentStore.getState();
            const blockOverlays = store.overlays.filter(
              (o) => o.type === 'text-block' && o.pageId === overlayPage.id
            );
            for (const o of blockOverlays) {
              if (o.type !== 'text-block') continue;
              // Sample 2px above-left of the block's originalBbox (local bg).
              const cssX = (o.originalBbox.x - 2) * zoom;
              const cssY = (o.originalBbox.y - 2) * zoom;
              const deviceX = Math.max(0, Math.round(cssX * dpr));
              const deviceY = Math.max(0, Math.round(cssY * dpr));
              try {
                const px = ctx.getImageData(deviceX, deviceY, 1, 1).data;
                const hex =
                  '#' +
                  [px[0], px[1], px[2]]
                    .map((v) => v.toString(16).padStart(2, '0'))
                    .join('');
                store.setPageBgColor(o.id, hex);
              } catch {
                /* tainted canvas or out of bounds; skip */
              }
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && /cancelled/i.test(err.message)) return;
        throw err;
      }
      page.cleanup();
    }
    draw().catch((err) => {
      if (err instanceof Error && /cancelled/i.test(err.message)) return;
      setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
    };
  }, [doc, currentPageIndex, zoom, overlayPage?.rotation]);

  // Hand the file input ref to the interaction layer.
  function registerFileInput(_el: HTMLInputElement | null) {
    // The interaction layer owns its own file input and opens it via a
    // global event; this hook is kept for API symmetry / future use.
  }

  const isPdfPage =
    !!doc && !!overlayPage && currentPageIndex + 1 <= doc.numPages;
  const { width: renderW, height: renderH } = overlayPage
    ? rotatedSize(overlayPage)
    : { width: 0, height: 0 };

  return (
    <div className="flex h-full w-full flex-col">
      {/* Error banner for canvas rendering issues */}
      {error && (
        <div className="shrink-0 bg-red-50 px-3 py-1 text-xs text-red-600 dark:bg-red-900/30 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Canvas area: centered scrollable container */}
      <div className="flex-1 overflow-auto bg-gray-100 dark:bg-gray-900">
        <div className="flex min-h-full min-w-full items-center justify-center p-4">
          {overlayPage && (
            <div
              className="relative inline-block"
              style={{
                width: renderW * zoom,
                height: renderH * zoom,
              }}
            >
              {isPdfPage ? (
                <canvas
                  ref={canvasRef}
                  className="bg-white shadow"
                  style={{
                    transform: `rotate(${overlayPage.rotation}deg)`,
                    transformOrigin: 'center center',
                  }}
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center border border-dashed border-gray-300 bg-white text-sm text-gray-400 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-500">
                  空白页 (A4 595x842)
                </div>
              )}
              {/* Overlay layer container: follows page rotation */}
              <div
                className="absolute inset-0"
                style={{
                  width: renderW * zoom,
                  height: renderH * zoom,
                  transform:
                    overlayPage.rotation === 0
                      ? undefined
                      : `rotate(${overlayPage.rotation}deg)`,
                  transformOrigin: 'center center',
                }}
              >
                <div
                  style={{
                    width: overlayPage.width * zoom,
                    height: overlayPage.height * zoom,
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    transform: 'translate(-50%, -50%)',
                  }}
                  onPointerDown={() => {
                    // 点击页面空白处(未被任何块/元素 stopPropagation)时
                    // 取消选中。编辑文字模式下尤其重要:失焦提交后前一个
                    // 块不应保持选中。
                    setSelectedOverlayId(null);
                  }}
                >
                  <OverlayLayer page={overlayPage} />
                  <FormFieldOverlay page={overlayPage} />
                  <TextBlockEditLayer page={overlayPage} />
                  <CanvasInteractionLayer
                    page={overlayPage}
                    registerFileInput={registerFileInput}
                  />
                </div>
              </div>
            </div>
          )}
          {!overlayPage && (
            <div className="p-8 text-center text-sm text-gray-500 dark:text-gray-400">
              打开 PDF 文件后即可开始编辑。
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
