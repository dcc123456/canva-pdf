// Sidebar: per-page thumbnails + page management (delete, rotate, drag&drop, new page).
import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import clsx from 'clsx';
import { useEditorStore } from '../../store/editorStore';
import { useDocumentStore } from '../../store/documentStore';
import type { PageMeta } from '../../core/types';

const THUMB_W = 130;
const THUMB_H = 150;

function PdfThumbnail({
  doc,
  pageNumber,
  page,
  isActive,
  onClick,
  onDelete,
  onRotate,
  canDelete,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  page: PageMeta;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
  onRotate: () => void;
  canDelete: boolean;
  draggable: boolean;
  onDragStart: (e: ReactDragEvent<HTMLDivElement>) => void;
  onDragOver: (e: ReactDragEvent<HTMLDivElement>) => void;
  onDrop: (e: ReactDragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: '200px 0px' }
    );
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let pdfPage: PDFPageProxy | null = null;
    let renderTask: ReturnType<PDFPageProxy['render']> | null = null;
    async function draw() {
      if (!visible || !canvasRef.current) return;
      if (pageNumber < 1 || pageNumber > doc.numPages) return;
      pdfPage = await doc.getPage(pageNumber);
      if (cancelled) {
        pdfPage.cleanup();
        return;
      }
      const vp1 = pdfPage.getViewport({ scale: 1, rotation: page.rotation });
      // Fit the thumbnail inside the THUMB_W x THUMB_H box, preserving aspect
      // ratio so tall pages no longer overflow vertically.
      const scale = Math.min(THUMB_W / vp1.width, THUMB_H / vp1.height);
      const viewport = pdfPage.getViewport({ scale, rotation: page.rotation });
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        pdfPage.cleanup();
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      try {
        renderTask = pdfPage.render({ canvas, canvasContext: ctx, viewport });
        await renderTask.promise;
        if (!cancelled) setRendered(true);
      } catch (err) {
        if (err instanceof Error && /cancelled/i.test(err.message)) return;
        console.error(err);
      }
      pdfPage.cleanup();
      pdfPage = null;
    }
    draw();
    return () => {
      cancelled = true;
      if (renderTask) {
        try {
          renderTask.cancel();
        } catch {
          /* ignore */
        }
      }
      if (pdfPage) {
        try {
          pdfPage.cleanup();
        } catch {
          /* ignore */
        }
      }
    };
  }, [doc, pageNumber, visible, page.rotation]);

  return (
    <div
      ref={containerRef}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={clsx(
        'group relative flex w-full flex-col items-center gap-1 rounded p-1 text-xs hover:bg-blue-50',
        isActive && 'bg-blue-100 ring-2 ring-blue-500'
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex w-full flex-col items-center"
      >
        <div
          className="flex items-center justify-center bg-white shadow"
          style={{ width: THUMB_W, height: THUMB_H }}
        >
          {!rendered && <span className="text-gray-300">…</span>}
          <canvas ref={canvasRef} />
        </div>
        <span className="mt-1 text-gray-700">
          {pageNumber} · {page.width.toFixed(0)}×{page.height.toFixed(0)} · {page.rotation}°
        </span>
      </button>
      <div className="absolute right-1 top-1">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className="flex h-5 w-5 items-center justify-center rounded bg-white/90 text-xs text-gray-700 shadow hover:bg-white"
          title="更多"
        >
          ⋯
        </button>
        {menuOpen && (
          <div
            className="absolute right-0 top-6 z-10 w-32 rounded border bg-white py-1 text-left shadow"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                onRotate();
                setMenuOpen(false);
              }}
              className="block w-full px-2 py-1 text-xs hover:bg-gray-100"
            >
              旋转 90°
            </button>
            <button
              type="button"
              onClick={() => {
                if (canDelete) {
                  onDelete();
                }
                setMenuOpen(false);
              }}
              disabled={!canDelete}
              className={clsx(
                'block w-full px-2 py-1 text-xs',
                canDelete ? 'text-red-600 hover:bg-red-50' : 'cursor-not-allowed text-gray-300'
              )}
            >
              删除
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function BlankThumbnail({
  page,
  index,
  isActive,
  onClick,
  onDelete,
  onRotate,
  canDelete,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  page: PageMeta;
  index: number;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
  onRotate: () => void;
  canDelete: boolean;
  draggable: boolean;
  onDragStart: (e: ReactDragEvent<HTMLDivElement>) => void;
  onDragOver: (e: ReactDragEvent<HTMLDivElement>) => void;
  onDrop: (e: ReactDragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={clsx(
        'group relative flex w-full flex-col items-center gap-1 rounded p-1 text-xs hover:bg-blue-50',
        isActive && 'bg-blue-100 ring-2 ring-blue-500'
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex w-full flex-col items-center"
      >
        <div
          className="flex items-center justify-center border border-dashed border-gray-300 bg-white text-gray-300 shadow"
          style={{ width: THUMB_W, height: THUMB_H }}
        >
          空白页
        </div>
        <span className="mt-1 text-gray-700">
          {index + 1} · 595×842 · {page.rotation}°
        </span>
      </button>
      <div className="absolute right-1 top-1">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className="flex h-5 w-5 items-center justify-center rounded bg-white/90 text-xs text-gray-700 shadow hover:bg-white"
        >
          ⋯
        </button>
        {menuOpen && (
          <div
            className="absolute right-0 top-6 z-10 w-32 rounded border bg-white py-1 text-left shadow"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                onRotate();
                setMenuOpen(false);
              }}
              className="block w-full px-2 py-1 text-xs hover:bg-gray-100"
            >
              旋转 90°
            </button>
            <button
              type="button"
              onClick={() => {
                if (canDelete) {
                  onDelete();
                }
                setMenuOpen(false);
              }}
              disabled={!canDelete}
              className={clsx(
                'block w-full px-2 py-1 text-xs',
                canDelete ? 'text-red-600 hover:bg-red-50' : 'cursor-not-allowed text-gray-300'
              )}
            >
              删除
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export interface SidebarProps {
  doc: PDFDocumentProxy | null;
}

export function Sidebar({ doc }: SidebarProps) {
  const currentPageIndex = useEditorStore((s) => s.currentPageIndex);
  const setCurrentPage = useEditorStore((s) => s.setCurrentPage);
  const setSidebarCollapsed = useEditorStore((s) => s.setSidebarCollapsed);
  const pages = useDocumentStore((s) => s.pages);
  const addPage = useDocumentStore((s) => s.addPage);
  const removePage = useDocumentStore((s) => s.removePage);
  const setPages = useDocumentStore((s) => s.setPages);

  const dragIndexRef = useRef<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);

  function startDrag(index: number) {
    return (e: ReactDragEvent<HTMLDivElement>) => {
      dragIndexRef.current = index;
      e.dataTransfer.effectAllowed = 'move';
      // Some browsers require setData to fire the drop.
      e.dataTransfer.setData('text/plain', String(index));
    };
  }
  function overDrag(index: number) {
    return (e: ReactDragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropTargetIndex(index);
    };
  }
  function endDrag() {
    dragIndexRef.current = null;
    setDropTargetIndex(null);
  }
  function doDrop(targetIndex: number) {
    return (e: ReactDragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const from = dragIndexRef.current;
      dragIndexRef.current = null;
      setDropTargetIndex(null);
      if (from === null || from === targetIndex) return;
      const next = pages.slice();
      const [moved] = next.splice(from, 1);
      next.splice(targetIndex, 0, moved);
      // Reindex
      const renumbered = next.map((p, i) => ({ ...p, index: i }));
      setPages(renumbered);
    };
  }

  function rotatePage(page: PageMeta) {
    // Update PageMeta.rotation (90° clockwise steps).
    const nextRot = ((page.rotation + 90) % 360) as 0 | 90 | 180 | 270;
    const nextPages = pages.map((p) =>
      p.id === page.id ? { ...p, rotation: nextRot } : p
    );
    setPages(nextPages);
  }

  function deletePage(page: PageMeta) {
    if (pages.length <= 1) return; // last page cannot be deleted
    removePage(page.id);
    if (currentPageIndex >= pages.length - 1) {
      setCurrentPage(Math.max(0, pages.length - 2));
    }
  }

  if (!doc && pages.length === 0) {
    return (
      <aside className="flex h-full w-[160px] flex-col items-center justify-center border-r bg-gray-50 p-2 text-xs text-gray-400">
        <button
          type="button"
          onClick={() => setSidebarCollapsed(true)}
          title="收起页面缩略图"
          className="mb-2 rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-200"
        >
          ⟨
        </button>
        缩略图
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-[160px] flex-col gap-1 overflow-y-auto border-r bg-gray-50 p-1">
      <button
        type="button"
        onClick={() => setSidebarCollapsed(true)}
        title="收起页面缩略图"
        className="mx-auto rounded px-2 py-0.5 text-xs text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-700"
      >
        ⟨ 收起
      </button>
      {pages.map((page, index) => {
        const pageNumber = index + 1;
        const isActive = index === currentPageIndex;
        const canDelete = pages.length > 1;
        const isPdfPage = doc && pageNumber <= doc.numPages;
        const dragHandlers = {
          draggable: true,
          onDragStart: startDrag(index),
          onDragOver: overDrag(index),
          onDrop: doDrop(index),
          onDragEnd: endDrag,
        };
        const ringHighlight =
          dropTargetIndex === index ? 'ring-2 ring-blue-400' : '';
        return (
          <div key={page.id} className={clsx('relative', ringHighlight)}>
            {isPdfPage ? (
              <PdfThumbnail
                doc={doc}
                pageNumber={pageNumber}
                page={page}
                isActive={isActive}
                onClick={() => setCurrentPage(index)}
                onDelete={() => deletePage(page)}
                onRotate={() => rotatePage(page)}
                canDelete={canDelete}
                {...dragHandlers}
              />
            ) : (
              <BlankThumbnail
                page={page}
                index={index}
                isActive={isActive}
                onClick={() => setCurrentPage(index)}
                onDelete={() => deletePage(page)}
                onRotate={() => rotatePage(page)}
                canDelete={canDelete}
                {...dragHandlers}
              />
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => addPage()}
        className="mt-2 rounded border border-dashed border-gray-400 bg-white py-2 text-xs text-gray-600 hover:bg-blue-50"
        title="新增一张 A4 空白页"
      >
        + 新建页
      </button>
    </aside>
  );
}
