// BottomBar: page navigation (left) and zoom controls (right).
// Extracted from the original Toolbar.tsx (page nav) and Viewer.tsx (zoom).
//
// Height: h-9 (36px). Reads everything from stores -- no props needed.
import { useState } from 'react';
import clsx from 'clsx';
import { useEditorStore, ZOOM_LEVELS } from '../store/editorStore';
import { useDocumentStore } from '../store/documentStore';

export function BottomBar() {
  const currentPageIndex = useEditorStore((s) => s.currentPageIndex);
  const totalPages = useEditorStore((s) => s.totalPages);
  const setCurrentPage = useEditorStore((s) => s.setCurrentPage);
  const nextPage = useEditorStore((s) => s.nextPage);
  const prevPage = useEditorStore((s) => s.prevPage);
  const sidebarCollapsed = useEditorStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useEditorStore((s) => s.setSidebarCollapsed);

  const zoom = useEditorStore((s) => s.zoom);
  const setZoom = useEditorStore((s) => s.setZoom);
  const zoomIn = useEditorStore((s) => s.zoomIn);
  const zoomOut = useEditorStore((s) => s.zoomOut);

  const addPage = useDocumentStore((s) => s.addPage);
  const totalDocumentPages = useDocumentStore((s) => s.pages.length);

  // Page jump input state.
  const [editingPage, setEditingPage] = useState(false);
  const [pageDraft, setPageDraft] = useState(String(currentPageIndex + 1));

  return (
    <footer className="flex h-9 shrink-0 items-center justify-between border-t border-gray-200 bg-white px-3 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
      {/* Left: page navigation */}
      <div className="flex items-center gap-1">
        {/* 页面缩略图开关(对齐 Canva Pages) */}
        <button
          type="button"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          title={sidebarCollapsed ? '显示页面缩略图' : '隐藏页面缩略图'}
          className={clsx(
            'flex h-6 items-center gap-1 rounded border px-1.5 text-xs',
            sidebarCollapsed
              ? 'border-gray-200 hover:bg-gray-100 dark:border-gray-600 dark:hover:bg-gray-700'
              : 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
          )}
        >
          ⊞ 页面
        </button>

        <button
          type="button"
          onClick={prevPage}
          disabled={currentPageIndex === 0}
          title="上一页 (←)"
          className="flex h-6 w-6 items-center justify-center rounded enabled:hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-gray-700"
        >
          ←
        </button>

        {editingPage ? (
          <input
            type="number"
            min={1}
            max={Math.max(1, totalPages)}
            autoFocus
            value={pageDraft}
            onChange={(e) => setPageDraft(e.target.value)}
            onBlur={() => {
              const v = Number(pageDraft);
              if (Number.isFinite(v)) setCurrentPage(v - 1);
              setEditingPage(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                (e.target as HTMLInputElement).blur();
              } else if (e.key === 'Escape') {
                setEditingPage(false);
              }
            }}
            className="w-12 rounded border border-gray-200 px-1 py-0.5 text-center dark:border-gray-600 dark:bg-gray-700"
          />
        ) : (
          <button
            type="button"
            onDoubleClick={() => {
              setPageDraft(String(currentPageIndex + 1));
              setEditingPage(true);
            }}
            title="双击输入页码跳转"
            className="rounded border border-gray-200 px-2 py-0.5 hover:bg-gray-100 dark:border-gray-600 dark:hover:bg-gray-700"
          >
            {currentPageIndex + 1} / {Math.max(1, totalPages)}
          </button>
        )}

        <button
          type="button"
          onClick={nextPage}
          disabled={currentPageIndex >= totalPages - 1}
          title="下一页 (→)"
          className="flex h-6 w-6 items-center justify-center rounded enabled:hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-gray-700"
        >
          →
        </button>

        <button
          type="button"
          onClick={() => addPage()}
          title="新增一张 A4 空白页"
          className="flex h-6 w-6 items-center justify-center rounded border border-gray-200 hover:bg-gray-100 dark:border-gray-600 dark:hover:bg-gray-700"
        >
          +
        </button>

        <span className="ml-1 text-gray-500 dark:text-gray-400">
          共 {totalDocumentPages} 页
        </span>
      </div>

      {/* Right: zoom controls */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={zoomOut}
          title="缩小 (-)"
          className="flex h-6 w-6 items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          −
        </button>

        <select
          value={ZOOM_LEVELS.reduce((prev, curr) =>
            Math.abs(curr - zoom) < Math.abs(prev - zoom) ? curr : prev
          )}
          onChange={(e) => setZoom(Number(e.target.value))}
          title="缩放"
          className="h-6 rounded border border-gray-200 bg-white px-1 text-xs dark:border-gray-600 dark:bg-gray-700"
        >
          {ZOOM_LEVELS.map((z) => (
            <option key={z} value={z}>
              {Math.round(z * 100)}%
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={zoomIn}
          title="放大 (+)"
          className="flex h-6 w-6 items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          +
        </button>

        <span className="ml-1 tabular-nums text-gray-500 dark:text-gray-400">
          {Math.round(zoom * 100)}%
        </span>
      </div>
    </footer>
  );
}
