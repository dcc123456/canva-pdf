// features/text-edit/TextBlockEditLayer.tsx
//
// Floating TipTap editor for `text-block` overlays. Shown above the
// canvas when the user clicks a text-block while the `选择` (select) tool is
// active. On commit (blur or Ctrl+Enter) it updates the overlay's text and
// segments in place -- no engine round-trip, no pdfBytes rewrite.
//
// 重构后(Phase C):contentEditable + execCommand 替换为 TipTap 富文本编辑器。
// RichTextSegment[] 边界不变,store/export 管线零改动。
//
// Selection / Move 行为(选择 工具):
//   * 单击 block:仅选中 (selectedOverlayId = block.id)
//   * 选中状态下再次单击同一 block:进入内嵌编辑
//   * 双击 block:进入内嵌编辑
//   * 在 block 上按下并拖动:移动该 block(小块整块即命中区,见下方
//     pointer-events 设置),拖动时显示红色智能对齐参考线(与页面边缘/中心
//     及其它 block 对齐吸附)。对齐计算与 SelectionFrame 共用 computeSnap。
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useDocumentStore } from '../../store/documentStore';
import { useEditorStore } from '../../store/editorStore';
import { useCommitTextBlock } from './useCommitTextBlock';
import { pushDownSubsequentBlocks } from './reflow';
import { RichTextEditor } from './RichTextEditor';
import {
  computeSnap,
  computeEdgeSnap,
  getOverlayBBox,
  type ActiveEdge,
  type Guide,
  type SnapBox,
} from '../overlays/alignment';
import type { TextBlockItem, RichTextSegment, PageMeta } from '../../core/types';

// ---------- Constants --------------------------------------------------------

// 对齐参考线样式 + 吸附阈值(屏幕像素,内部除以 zoom 转成 pt)。
const GUIDE_COLOR = '#ff3b30'; // 对齐参考线红色(Canva/Figma 风格)
const GUIDE_THRESHOLD_PX = 6; // 距离小于该像素值即吸附
// 区分"点击"与"拖动"的阈值:指针位移小于该值视为点击(进入选中/编辑),
// 超过则进入拖动(移动 block)。
const DRAG_THRESHOLD_PX = 4;

// 缩放手柄几何(屏幕 px,与 SelectionFrame 视觉一致)。
type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLE_HIT_PX = 12; // 透明命中区半边(即 24px 命中,便于抓取)
const CORNER_R_PX = 5; // 角手柄白圆点半径(直径 10px)
const PILL_W_PX = 3; // 边手柄药丸短边(=6px)
const PILL_H_PX = 9; // 边手柄药丸长边(=18px)
const CORNERS: Handle[] = ['nw', 'ne', 'sw', 'se'];
const SIDES: Handle[] = ['n', 's', 'e', 'w'];
// corner 手柄同时吸附两条边(如 'se' → 底边 + 右边)。
const EDGE_OF: Record<Handle, ActiveEdge[]> = {
  nw: ['n', 'w'],
  ne: ['n', 'e'],
  sw: ['s', 'w'],
  se: ['s', 'e'],
  n: ['n'],
  s: ['s'],
  e: ['e'],
  w: ['w'],
};

function handleCursor(h: Handle): string {
  if (h === 'nw' || h === 'se') return 'nwse-resize';
  if (h === 'ne' || h === 'sw') return 'nesw-resize';
  if (h === 'n' || h === 's') return 'ns-resize';
  return 'ew-resize';
}

// 手柄在块 div 内的定位(屏幕 px)。块 div 原点在 bbox 左上角,
// 手柄命中区以边中点/角为中心向外各延展 HANDLE_HIT_PX。
function handlePosPx(h: Handle, w: number, ht: number): { left: number; top: number } {
  const cx =
    h === 'nw' || h === 'w' || h === 'sw' ? 0 : h === 'n' || h === 's' ? w / 2 : w;
  const cy =
    h === 'nw' || h === 'n' || h === 'ne' ? 0 : h === 'w' || h === 'e' ? ht / 2 : ht;
  return { left: cx - HANDLE_HIT_PX, top: cy - HANDLE_HIT_PX };
}

// 按 handle 做缩放几何(镜像 SelectionFrame.applyResize)。dx/dy 为 pt 单位。
function applyResizeGeom(
  start: { x: number; y: number; w: number; h: number },
  mode: Handle,
  dx: number,
  dy: number
): { x: number; y: number; w: number; h: number } {
  let { x, y, w, h } = start;
  if (mode === 'nw' || mode === 'n' || mode === 'ne') {
    const ny = y + dy;
    h = Math.max(4, h + (y - ny));
    y = ny;
  }
  if (mode === 'sw' || mode === 's' || mode === 'se') {
    h = Math.max(4, h + dy);
  }
  if (mode === 'nw' || mode === 'w' || mode === 'sw') {
    const nx = x + dx;
    w = Math.max(4, w + (x - nx));
    x = nx;
  }
  if (mode === 'ne' || mode === 'e' || mode === 'se') {
    w = Math.max(4, w + dx);
  }
  return { x, y, w, h };
}

// ---------- Component --------------------------------------------------------

export interface TextBlockEditLayerProps {
  page: PageMeta;
}

export function TextBlockEditLayer({ page }: TextBlockEditLayerProps) {
  const tool = useEditorStore((s) => s.tool);
  const zoom = useEditorStore((s) => s.zoom);
  const selectedOverlayId = useEditorStore((s) => s.selectedOverlayId);
  const setSelectedOverlayId = useEditorStore((s) => s.setSelectedOverlayId);
  const overlays = useDocumentStore((s) => s.overlays);
  const pages = useDocumentStore((s) => s.pages);
  const updateOverlay = useDocumentStore((s) => s.updateOverlay);
  // 采样到的块局部页面背景色:编辑态用它替代白色,彩色页面底色不跳变。
  const pageBgColors = useDocumentStore((s) => s.pageBgColors);

  const editingIdRef = useRef<string | null>(null);
  // commitFnRef: RichTextEditor 注册的提交函数,父组件可手动调用
  // (切换 block / 切换工具时,blur 可能不触发)。
  const commitFnRef = useRef<(() => void) | null>(null);
  // Stable callback so RichTextEditor's useEffect doesn't re-run each render.
  const registerCommit = useCallback((fn: (() => void) | null) => {
    commitFnRef.current = fn;
  }, []);

  // 共享的"写回 overlay"逻辑(同样被 Inspector 用)。
  const { commit: commitToOverlay } = useCommitTextBlock();

  // Force-update tick: editingId is stored in a ref (not state) so we need
  // a manual re-render trigger when it changes.
  const [, setTick] = useState(0);
  const forceUpdate = () => setTick((t) => t + 1);

  // 拖动对齐参考线(仅拖动过程中存在,松手即清空)。
  const [guides, setGuides] = useState<Guide[]>([]);
  // 拖动过程状态(不进 state,避免每帧重渲染;用 ref 保存手势起点)。
  const dragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    pointerX: number;
    pointerY: number;
    moved: boolean;
    wasSelected: boolean;
  } | null>(null);
  // 缩放过程状态。与 dragRef 互斥(手柄 pointerdown 会 stopPropagation,
  // 不会触发块的 dragRef)。
  const resizeRef = useRef<{
    id: string;
    mode: Handle;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    pointerX: number;
    pointerY: number;
  } | null>(null);

  useEffect(() => {
    if (tool !== 'select') {
      // 切换工具时,如果正在编辑,先提交编辑内容到 store。
      if (editingIdRef.current && commitFnRef.current) {
        commitFnRef.current();
      }
      editingIdRef.current = null;
      commitFnRef.current = null;
    }
  }, [tool]);

  if (tool !== 'select') return null;
  const blocks = overlays.filter(
    (o): o is TextBlockItem => o.type === 'text-block' && o.pageId === page.id
  );

  function selectOnly(block: TextBlockItem) {
    setSelectedOverlayId(block.id);
  }

  // Commit the in-progress edit (if any) without relying on onBlur, which
  // may not fire because pointerdown on another block calls preventDefault
  // and keeps the editor focused.
  function commitCurrentEdit() {
    if (commitFnRef.current) {
      commitFnRef.current();
    }
  }

  function startEdit(block: TextBlockItem) {
    editingIdRef.current = block.id;
    setSelectedOverlayId(block.id);
    forceUpdate();
  }

  function commitEdit(
    block: TextBlockItem | undefined,
    newText: string,
    segments?: RichTextSegment[]
  ) {
    // 失焦提交后不再保留选中态:用户点空白处提交时,前一个块应取消选中。
    // 若本次失焦由点击另一块触发,该块的 onPointerDown 会立即重新选中它。
    setSelectedOverlayId(null);
    if (!block) {
      editingIdRef.current = null;
      commitFnRef.current = null;
      forceUpdate();
      return;
    }
    commitToOverlay({
      block,
      pageIndex: page.index,
      newText,
      segments,
    });
    editingIdRef.current = null;
    commitFnRef.current = null;
    forceUpdate();
  }

  // 拖动中:根据指针位移算出临时位置,与同页其它 block / 页面边缘做对齐吸附,
  // 写回 bbox,并保存参考线供渲染。
  function moveDrag(b: TextBlockItem, e: ReactPointerEvent) {
    const d = dragRef.current;
    if (!d || d.id !== b.id) return;
    const dxPx = e.clientX - d.pointerX;
    const dyPx = e.clientY - d.pointerY;
    if (!d.moved && Math.hypot(dxPx, dyPx) < DRAG_THRESHOLD_PX) {
      // 位移尚小,视为点击候选,不进入拖动。
      return;
    }
    d.moved = true;
    const dx = dxPx / zoom;
    const dy = dyPx / zoom;
    const tentative: SnapBox = {
      x: d.startX + dx,
      y: d.startY + dy,
      w: b.bbox.w,
      h: b.bbox.h,
    };
    const pg = pages.find((p) => p.id === b.pageId);
    let snapped = tentative;
    if (pg) {
      const others: SnapBox[] = overlays
        .filter((o) => o.pageId === b.pageId && o.id !== b.id)
        .map((o) => getOverlayBBox(o));
      const res = computeSnap(
        tentative,
        others,
        { width: pg.width, height: pg.height },
        GUIDE_THRESHOLD_PX / zoom
      );
      snapped = res.box;
      setGuides(res.guides);
    }
    updateOverlay(b.id, {
      bbox: { x: snapped.x, y: snapped.y, w: snapped.w, h: snapped.h },
    });
  }

  // 拖动结束:松手即清空参考线;若实际移动过则保持选中(不进编辑),
  // 否则按"点击"语义处理(已选中 -> 进编辑,未选中 -> 仅选中)。
  function endDrag(b: TextBlockItem, e: ReactPointerEvent) {
    const d = dragRef.current;
    dragRef.current = null;
    setGuides([]);
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (!d) return;
    if (d.moved) {
      setSelectedOverlayId(b.id);
      return;
    }
    if (d.wasSelected) {
      startEdit(b);
    } else {
      selectOnly(b);
    }
  }

  // 缩放开始:手柄 pointerdown 触发(stopPropagation 防止触发块的 move)。
  // 手柄仅在不编辑的选中态渲染,故这里无需再判 isEditing。
  function startResize(b: TextBlockItem, e: ReactPointerEvent, mode: Handle) {
    e.preventDefault();
    e.stopPropagation();
    setSelectedOverlayId(b.id);
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    resizeRef.current = {
      id: b.id,
      mode,
      startX: b.bbox.x,
      startY: b.bbox.y,
      startW: b.bbox.w,
      startH: b.bbox.h,
      pointerX: e.clientX,
      pointerY: e.clientY,
    };
  }

  // 缩放中:几何变化 + 边缘吸附(computeEdgeSnap 只吸附被拖动的边)+ 参考线。
  function moveResize(b: TextBlockItem, e: ReactPointerEvent) {
    const d = resizeRef.current;
    if (!d || d.id !== b.id) return;
    const dx = (e.clientX - d.pointerX) / zoom;
    const dy = (e.clientY - d.pointerY) / zoom;
    let nb = applyResizeGeom(
      { x: d.startX, y: d.startY, w: d.startW, h: d.startH },
      d.mode,
      dx,
      dy
    );
    const pg = pages.find((p) => p.id === b.pageId);
    if (pg) {
      const others: SnapBox[] = overlays
        .filter((o) => o.pageId === b.pageId && o.id !== b.id)
        .map((o) => getOverlayBBox(o));
      const res = computeEdgeSnap(
        nb,
        others,
        { width: pg.width, height: pg.height },
        GUIDE_THRESHOLD_PX / zoom,
        EDGE_OF[d.mode]
      );
      nb = res.box;
      setGuides(res.guides);
    }
    updateOverlay(b.id, {
      bbox: { x: nb.x, y: nb.y, w: nb.w, h: nb.h },
    });
  }

  // 缩放结束:清参考线;text-block 高度变化 → 回流下推后续块(与 SelectionFrame 一致)。
  function endResize(b: TextBlockItem, e: ReactPointerEvent) {
    const d = resizeRef.current;
    resizeRef.current = null;
    setGuides([]);
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (!d) return;
    const cur = useDocumentStore.getState().overlays.find((o) => o.id === b.id);
    if (cur && cur.type === 'text-block') {
      const deltaH = cur.bbox.h - d.startH;
      if (Math.abs(deltaH) > 0.5) {
        pushDownSubsequentBlocks(b.pageId, b.id, deltaH);
      }
    }
  }

  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={{ width: page.width * zoom, height: page.height * zoom }}
    >
      {blocks.map((b) => {
        const isSelected = selectedOverlayId === b.id;
        const isEditing = editingIdRef.current === b.id;
        return (
          <div
            key={b.id}
            // Canva 风格轮廓:未选中时隐藏,hover 淡入;选中/编辑为
            // 实线主题色。具体样式见 index.css 的 .text-block-outline。
            className={
              'absolute text-block-outline' +
              (isSelected || isEditing ? ' is-selected' : '')
            }
            style={{
              left: b.bbox.x * zoom,
              top: b.bbox.y * zoom,
              // 编辑态:宽度用 max-content(按文本不换行的实际宽度伸展,
              // 不低于原 bbox)—— PDF 原字与编辑字体有 1-2px 度量差,固定
              // bbox 宽度会让"本来一行的标题"编辑时被挤断行。上限为页面
              // 剩余宽度,超长文本仍正常换行。
              ...(isEditing
                ? {
                    width: 'max-content',
                    minWidth: b.bbox.w * zoom,
                    maxWidth: (page.width - b.bbox.x) * zoom,
                    minHeight: b.bbox.h * zoom,
                    zIndex: 30,
                  }
                : isSelected
                ? {
                    width: b.bbox.w * zoom,
                    height: b.bbox.h * zoom,
                    // 选中态抬高 z-index,使缩放手柄不被相邻块覆盖(相邻块无
                    // 显式 z-index,默认堆叠在选中块之下)。
                    zIndex: 20,
                  }
                : { width: b.bbox.w * zoom, height: b.bbox.h * zoom }),
              pointerEvents: 'auto',
              // 选中 工具下整块可拖移:用 move 光标提示可拖动(双击仍进编辑)。
              cursor: isEditing ? 'text' : 'move',
              // 编辑态底色 = 渲染时采样到的该块局部页面背景(导出 whiteout
              // 也用同一颜色),保证进入编辑时视觉不跳变。
              background: isEditing ? (pageBgColors[b.id] ?? '#ffffff') : undefined,
            }}
            onPointerDown={(e) => {
              if (isEditing) return;
              e.preventDefault();
              e.stopPropagation();
              // Commit any in-progress edit on another block before switching.
              if (editingIdRef.current && editingIdRef.current !== b.id) {
                commitCurrentEdit();
              }
              // 立即选中,使拖动时显示选中框 + 手柄。
              setSelectedOverlayId(b.id);
              try {
                (e.currentTarget as Element).setPointerCapture(e.pointerId);
              } catch {
                /* ignore */
              }
              dragRef.current = {
                id: b.id,
                startX: b.bbox.x,
                startY: b.bbox.y,
                pointerX: e.clientX,
                pointerY: e.clientY,
                moved: false,
                wasSelected: isSelected,
              };
            }}
            onPointerMove={(e) => moveDrag(b, e)}
            onPointerUp={(e) => endDrag(b, e)}
            onPointerCancel={(e) => endDrag(b, e)}
            onDoubleClick={(e) => {
              // 缩放手柄上的双击不应进入编辑(手柄已 stopPropagation,
              // 但 dblclick 会冒泡到块,这里用 data 属性拦截)。
              if ((e.target as HTMLElement).closest('[data-resize-handle]')) return;
              if (isEditing) return;
              e.preventDefault();
              e.stopPropagation();
              if (editingIdRef.current && editingIdRef.current !== b.id) {
                commitCurrentEdit();
              }
              startEdit(b);
            }}
          >
            {isEditing ? (
              <RichTextEditor
                key={b.id}
                block={b}
                zoom={zoom}
                onCommit={(text, segments) => commitEdit(b, text, segments)}
                onCancel={() => {
                  editingIdRef.current = null;
                  commitFnRef.current = null;
                  setSelectedOverlayId(null);
                  forceUpdate();
                }}
                registerCommit={registerCommit}
              />
            ) : null}
            {/* 缩放手柄:仅选中(未编辑)态显示。手柄挂在块 div 内、z-index 高于
                相邻块,拖动时调用 computeEdgeSnap 做边缘对齐 + 参考线。 */}
            {isSelected && !isEditing
              ? [...CORNERS, ...SIDES].map((h) => {
                  const pos = handlePosPx(
                    h,
                    b.bbox.w * zoom,
                    b.bbox.h * zoom
                  );
                  const isCorner =
                    h === 'nw' || h === 'ne' || h === 'sw' || h === 'se';
                  const visW = isCorner ? CORNER_R_PX * 2 : PILL_H_PX;
                  const visH = isCorner ? CORNER_R_PX * 2 : PILL_W_PX;
                  return (
                    <div
                      key={h}
                      data-resize-handle
                      onPointerDown={(e) => startResize(b, e, h)}
                      onPointerMove={(e) => moveResize(b, e)}
                      onPointerUp={(e) => endResize(b, e)}
                      onPointerCancel={(e) => endResize(b, e)}
                      style={{
                        position: 'absolute',
                        left: pos.left,
                        top: pos.top,
                        width: HANDLE_HIT_PX * 2,
                        height: HANDLE_HIT_PX * 2,
                        cursor: handleCursor(h),
                        pointerEvents: 'auto',
                        zIndex: 25,
                      }}
                    >
                      <div
                        style={{
                          position: 'absolute',
                          left: (HANDLE_HIT_PX * 2 - visW) / 2,
                          top: (HANDLE_HIT_PX * 2 - visH) / 2,
                          width: visW,
                          height: visH,
                          borderRadius: isCorner ? '50%' : Math.min(visW, visH) / 2,
                          background: '#fff',
                          border: isCorner ? '1px solid #0f1015' : 'none',
                          boxShadow: '0 0 0 1px rgba(0,0,0,0.18)',
                          pointerEvents: 'none',
                        }}
                      />
                    </div>
                  );
                })
              : null}
          </div>
        );
      })}
      {/* 对齐参考线(拖动中):贯穿全页的红线,与页面边缘/中心及其它 block
          的对应边对齐时显示。pointer-events=none 不挡操作。坐标按 zoom 缩放。 */}
      <svg
        className="pointer-events-none absolute left-0 top-0"
        width={page.width * zoom}
        height={page.height * zoom}
        style={{ overflow: 'visible' }}
      >
        {guides.map((g, i) =>
          g.axis === 'v' ? (
            <line
              key={`gv-${i}`}
              x1={g.pos * zoom}
              y1={0}
              x2={g.pos * zoom}
              y2={page.height * zoom}
              stroke={GUIDE_COLOR}
              strokeWidth={1}
            />
          ) : (
            <line
              key={`gh-${i}`}
              x1={0}
              y1={g.pos * zoom}
              x2={page.width * zoom}
              y2={g.pos * zoom}
              stroke={GUIDE_COLOR}
              strokeWidth={1}
            />
          )
        )}
      </svg>
    </div>
  );
}
