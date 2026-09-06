// Viewer: Canva-style continuous vertical multi-page canvas.
// - 全部页垂直排列,IntersectionObserver 懒渲染(进入视口才画,离开取消)
// - 滚动自动同步"当前页";页码/键盘跳页平滑滚动到目标页
// - 每页挂完整编辑层(OverlayLayer/FormFieldOverlay/TextBlockEditLayer/
//   CanvasInteractionLayer),点击哪页编辑哪页
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import clsx from 'clsx';
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
  const pages = useDocumentStore((s) => s.pages);
  const setZoom = useEditorStore((s) => s.setZoom);
  const currentPageIndex = useEditorStore((s) => s.currentPageIndex);
  const setCurrentPage = useEditorStore((s) => s.setCurrentPage);
  const nextPage = useEditorStore((s) => s.nextPage);
  const prevPage = useEditorStore((s) => s.prevPage);
  const zoomIn = useEditorStore((s) => s.zoomIn);
  const zoomOut = useEditorStore((s) => s.zoomOut);
  const setSelectedOverlayId = useEditorStore((s) => s.setSelectedOverlayId);
  const setTotalPages = useEditorStore((s) => s.setTotalPages);
  const addPage = useDocumentStore((s) => s.addPage);
  const removePage = useDocumentStore((s) => s.removePage);
  const setPages = useDocumentStore((s) => s.setPages);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pageElsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  // 标记"本次 currentPageIndex 变化来自滚动同步",跳过程序化滚动,防回环。
  const syncingFromScrollRef = useRef(false);
  const scrollRafRef = useRef(0);

  // Keyboard shortcuts (global while Viewer is mounted).
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

  // 总页数(原 Sidebar 内的逻辑,侧栏收起后由 Viewer 维护)。
  useEffect(() => {
    setTotalPages(doc?.numPages ?? pages.length);
  }, [doc, pages.length, setTotalPages]);

  // 滚动同步当前页:取视口中心所在的页。
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    function sync() {
      const el = scrollRef.current;
      if (!el) return;
      const center = el.scrollTop + el.clientHeight / 2;
      let best = -1;
      let bestDist = Infinity;
      for (const [idx, node] of pageElsRef.current) {
        const mid = node.offsetTop + node.offsetHeight / 2;
        const dist = Math.abs(mid - center);
        if (dist < bestDist) {
          bestDist = dist;
          best = idx;
        }
      }
      if (best >= 0 && best !== useEditorStore.getState().currentPageIndex) {
        syncingFromScrollRef.current = true;
        useEditorStore.getState().setCurrentPage(best);
      }
    }
    function onScroll() {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = requestAnimationFrame(sync);
    }
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  // 程序化跳页(页码输入/键盘):平滑滚动到目标页。
  // 来自滚动同步的变化(syncingFromScrollRef)不触发滚动。
  useEffect(() => {
    if (syncingFromScrollRef.current) {
      syncingFromScrollRef.current = false;
      return;
    }
    const node = pageElsRef.current.get(currentPageIndex);
    const container = scrollRef.current;
    if (node && container) {
      container.scrollTo({ top: Math.max(0, node.offsetTop - 16), behavior: 'smooth' });
    }
  }, [currentPageIndex]);

  const registerPageEl = useCallback((index: number, el: HTMLDivElement | null) => {
    if (el) {
      pageElsRef.current.set(index, el);
    } else {
      pageElsRef.current.delete(index);
    }
  }, []);

  function rotatePage(page: PageMeta) {
    const nextRot = ((page.rotation + 90) % 360) as 0 | 90 | 180 | 270;
    setPages(pages.map((p) => (p.id === page.id ? { ...p, rotation: nextRot } : p)));
  }

  function deletePage(page: PageMeta) {
    if (pages.length <= 1) return; // 最后一页不可删除
    removePage(page.id);
    if (currentPageIndex >= pages.length - 1) {
      setCurrentPage(Math.max(0, pages.length - 2));
    }
  }

  return (
    <div className="flex h-full w-full flex-col">
      {/* 连续滚动画布:全部页垂直排列。顶部留白 ≥ 页眉徽标高度,
          避免第一页的"第 N 页"徽标被上方工具栏遮挡。 */}
      <div ref={scrollRef} className="flex-1 overflow-auto bg-gray-100 dark:bg-gray-900">
        <div className="relative mx-auto flex w-fit flex-col items-center gap-8 px-4 pb-8 pt-12">
          {pages.map((page, index) => (
            <PageView
              key={page.id}
              doc={doc}
              page={page}
              pageNumber={index + 1}
              isActive={index === currentPageIndex}
              onSelectPage={() => setCurrentPage(index)}
              onRotate={() => rotatePage(page)}
              onDelete={() => deletePage(page)}
              canDelete={pages.length > 1}
              registerEl={registerPageEl}
            />
          ))}
          <button
            type="button"
            onClick={() => addPage()}
            title="新增一张 A4 空白页"
            className="w-40 rounded border border-dashed border-gray-400 bg-white/70 py-2 text-xs text-gray-600 hover:bg-blue-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
          >
            + 新建页
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- PageView:单页渲染 + 编辑层 + 页操作 ----------------------------

interface PageViewProps {
  doc: PDFDocumentProxy | null;
  page: PageMeta;
  pageNumber: number;
  isActive: boolean;
  onSelectPage: () => void;
  onRotate: () => void;
  onDelete: () => void;
  canDelete: boolean;
  registerEl: (index: number, el: HTMLDivElement | null) => void;
}

function PageView({
  doc,
  page,
  pageNumber,
  isActive,
  onSelectPage,
  onRotate,
  onDelete,
  canDelete,
  registerEl,
}: PageViewProps) {
  const zoom = useEditorStore((s) => s.zoom);
  const setSelectedOverlayId = useEditorStore((s) => s.setSelectedOverlayId);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // 渲染串行锁:防止同一 canvas 并发 render() 报错。
  const renderLockRef = useRef<Promise<void>>(Promise.resolve());
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // 懒渲染:进入视口(±400px)才渲染,离开不主动销毁(pdfjs 缓存页面对象)。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
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
      { rootMargin: '400px 0px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 渲染当前页 + 采样该页 text-block 的局部背景色。
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let release: (() => void) | undefined;
    const prev = renderLockRef.current;
    renderLockRef.current = new Promise<void>((resolve) => {
      release = resolve;
    });

    async function draw() {
      await prev;
      if (cancelled) return;
      if (!doc || !canvasRef.current) return;
      if (pageNumber < 1 || pageNumber > doc.numPages) return;
      const pdfPage: PDFPageProxy = await doc.getPage(pageNumber);
      if (cancelled) {
        pdfPage.cleanup();
        return;
      }
      try {
        await renderPage(pdfPage, canvasRef.current, {
          scale: zoom,
          rotation: page.rotation,
        });
        if (cancelled) return;
        // 采样块背景色:取块左上外侧 2px 的像素(与导出 whiteout 同色)。
        const ctx = canvasRef.current.getContext('2d');
        if (ctx) {
          const dpr = window.devicePixelRatio || 1;
          const store = useDocumentStore.getState();
          const blockOverlays = store.overlays.filter(
            (o) => o.type === 'text-block' && o.pageId === page.id
          );
          for (const o of blockOverlays) {
            if (o.type !== 'text-block') continue;
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
      } catch (err) {
        if (err instanceof Error && /cancelled/i.test(err.message)) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        pdfPage.cleanup();
        release?.();
      }
    }
    draw();
    return () => {
      cancelled = true;
      release?.();
    };
  }, [doc, visible, zoom, page.rotation, page.id, pageNumber]);

  const { width: renderW, height: renderH } = rotatedSize(page);
  const isPdfPage = !!doc && pageNumber <= doc.numPages;

  return (
    <div
      ref={(el) => {
        containerRef.current = el;
        registerEl(page.index, el);
      }}
      data-page={page.index}
      onPointerDownCapture={() => {
        // 点击任意页(含页内的块)即切换当前编辑页(Canva 行为)。
        if (!isActive) onSelectPage();
      }}
      onPointerDown={() => {
        // 点击页面空白处取消选中(块/元素的处理器会 stopPropagation)。
        setSelectedOverlayId(null);
      }}
      className={clsx(
        'group relative rounded',
        isActive && 'ring-2 ring-blue-500'
      )}
      style={{ width: renderW * zoom, height: renderH * zoom }}
    >
      {/* 页眉:页码徽标 + hover 操作菜单 */}
      <div className="absolute -top-7 left-0 z-10 flex items-center gap-1">
        <span
          className={clsx(
            'rounded px-1.5 py-0.5 text-[10px] font-medium',
            isActive
              ? 'bg-blue-600 text-white'
              : 'bg-gray-700/80 text-white opacity-70 group-hover:opacity-100'
          )}
        >
          第 {pageNumber} 页
        </span>
        <div className="relative opacity-0 transition group-hover:opacity-100">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            title="页面操作"
            className="flex h-5 w-5 items-center justify-center rounded bg-white/90 text-xs text-gray-700 shadow hover:bg-white dark:bg-gray-700 dark:text-gray-200"
          >
            ⋯
          </button>
          {menuOpen && (
            <div
              className="absolute left-0 top-6 z-20 w-28 rounded border bg-white py-1 text-left shadow dark:border-gray-600 dark:bg-gray-700"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => {
                  onRotate();
                  setMenuOpen(false);
                }}
                className="block w-full px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-600"
              >
                旋转 90°
              </button>
              <button
                type="button"
                onClick={() => {
                  if (canDelete) onDelete();
                  setMenuOpen(false);
                }}
                disabled={!canDelete}
                className={clsx(
                  'block w-full px-2 py-1 text-xs',
                  canDelete
                    ? 'text-red-600 hover:bg-red-50 dark:hover:bg-gray-600'
                    : 'cursor-not-allowed text-gray-300'
                )}
              >
                删除
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 页面主体 */}
      {isPdfPage ? (
        <canvas
          ref={canvasRef}
          className="bg-white shadow"
          style={{
            transform: page.rotation !== 0 ? `rotate(${page.rotation}deg)` : undefined,
            transformOrigin: 'center center',
          }}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center border border-dashed border-gray-300 bg-white text-sm text-gray-400 shadow dark:border-gray-600 dark:bg-gray-800 dark:text-gray-500">
          空白页 (A4 595x842)
        </div>
      )}
      {error && (
        <div className="absolute bottom-0 left-0 right-0 bg-red-50 px-2 py-1 text-xs text-red-600">
          {error}
        </div>
      )}

      {/* 编辑层:与旧单页 Viewer 相同的嵌套结构,跟随旋转 */}
      <div
        className="absolute left-0 top-0"
        style={{
          width: renderW * zoom,
          height: renderH * zoom,
          transform: page.rotation !== 0 ? `rotate(${page.rotation}deg)` : undefined,
          transformOrigin: 'center center',
        }}
      >
        <div
          style={{
            width: page.width * zoom,
            height: page.height * zoom,
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
          }}
        >
          <OverlayLayer page={page} />
          <FormFieldOverlay page={page} />
          <TextBlockEditLayer page={page} />
          <CanvasInteractionLayer page={page} registerFileInput={() => {}} />
        </div>
      </div>
    </div>
  );
}
