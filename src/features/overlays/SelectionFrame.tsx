// SelectionFrame: Canva 风格的选中框。实线主题色(--accent)边框、无底色,
// 手柄为白色圆形(四角)+ 白色胶囊(四边,hover 时才出现),尺寸全部按
// 1/zoom 换算,保证任意缩放下屏幕像素恒定。它处理鼠标事件并把
// 位置/尺寸/旋转更新委托给 document store。
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { ImageItem, OverlayItem } from '../../core/types';
import { useDocumentStore } from '../../store/documentStore';
import { useEditorStore } from '../../store/editorStore';
import { pushDownSubsequentBlocks } from '../text-edit/reflow';
import { computeSnap, getOverlayBBox, type Guide, type SnapBox } from './alignment';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate';

// 所有手柄几何量都在 SVG 用户单位(PDF pt)里除以 zoom,屏幕像素恒定。
const CORNER_RADIUS = 5; // 白色圆点手柄半径(屏幕 10px)
const CORNER_STROKE = 1.25; // 圆点描边宽度(屏幕 ~1.5px)
const PILL_W = 3; // 侧边胶囊手柄:宽 6px
const PILL_H = 9; // 高 18px —— 参照 Canva
const HANDLE_HIT = 12; // 手柄透明命中区(屏幕 24px),便于抓取
const HANDLE_FILL = '#ffffff';
const HANDLE_STROKE = '#0f1015'; // Canva 手柄描边色(近黑)

// 移动命中区在块 bbox 基础上外扩 MOVE_PAD_PX 屏幕像素,便于抓取小块
// (小块 bbox 太小,直接点常常点不到)。
const MOVE_PAD_PX = 7;
// 对齐参考线样式 + 吸附阈值(屏幕像素,内部除以 zoom 转成 pt)。
const GUIDE_COLOR = '#ff3b30';
const GUIDE_THRESHOLD_PX = 6;

const CORNERS: Handle[] = ['nw', 'ne', 'sw', 'se'];
const SIDES: Handle[] = ['n', 's', 'e', 'w'];

function applyResize(
  item: OverlayItem,
  handle: Handle,
  startBox: { x: number; y: number; w: number; h: number },
  dx: number,
  dy: number
): Partial<OverlayItem> {
  let { x, y, w, h } = startBox;
  if (handle === 'nw' || handle === 'n' || handle === 'ne') {
    const newY = y + dy;
    h = Math.max(4, h + (y - newY));
    y = newY;
  }
  if (handle === 'sw' || handle === 's' || handle === 'se') {
    h = Math.max(4, h + dy);
  }
  if (handle === 'nw' || handle === 'w' || handle === 'sw') {
    const newX = x + dx;
    w = Math.max(4, w + (x - newX));
    x = newX;
  }
  if (handle === 'ne' || handle === 'e' || handle === 'se') {
    w = Math.max(4, w + dx);
  }

  switch (item.type) {
    case 'highlight':
      return { rect: { x, y, w, h } } as Partial<OverlayItem>;
    case 'text-block':
      return { bbox: { x, y, w, h } } as Partial<OverlayItem>;
    case 'text':
    case 'image':
      return {
        position: { x, y },
        size: { w, h },
      } as Partial<OverlayItem>;
    default:
      return {};
  }
}

// 按 overlay 类型,把吸附后的位置写成对应的字段补丁。w/h 在对齐吸附中
// 不变,只有 x/y 被调整。
function buildMovePatch(item: OverlayItem, box: SnapBox): Partial<OverlayItem> {
  switch (item.type) {
    case 'highlight':
    case 'redact':
      return { rect: { x: box.x, y: box.y, w: box.w, h: box.h } };
    case 'text-block':
      return { bbox: { x: box.x, y: box.y, w: box.w, h: box.h } };
    case 'text':
    case 'image':
      return { position: { x: box.x, y: box.y }, size: { w: box.w, h: box.h } };
    default:
      return {};
  }
}

export interface SelectionFrameProps {
  overlay: OverlayItem;
  zoom: number;
}

export function SelectionFrame({ overlay, zoom }: SelectionFrameProps) {
  const updateOverlay = useDocumentStore((s) => s.updateOverlay);
  const setSelectedOverlayId = useEditorStore((s) => s.setSelectedOverlayId);
  const tool = useEditorStore((s) => s.tool);
  // 对齐参考线状态;仅在「移动」拖拽过程中存在,松手即清空。
  const [guides, setGuides] = useState<Guide[]>([]);

  // 取当前页尺寸 + 同页其它块的 bbox,供对齐吸附计算。
  const pages = useDocumentStore((s) => s.pages);
  const overlays = useDocumentStore((s) => s.overlays);
  const page = pages.find((p) => p.id === overlay.pageId);

  // Canva 行为:仅 hover / 拖拽中才显示侧边胶囊手柄,平时只显示四角圆点。
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const showSideHandles = hovered || dragging;

  const startRef = useRef<{
    box: { x: number; y: number; w: number; h: number };
    pointerX: number;
    pointerY: number;
    mode: 'move' | Handle;
    rotation: number;
    centerX: number;
    centerY: number;
    startAngle: number;
  } | null>(null);

  const box = getOverlayBBox(overlay);
  const isImage = overlay.type === 'image';
  const rotation = isImage ? (overlay as ImageItem).rotation : 0;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;

  function beginDrag(e: ReactPointerEvent<SVGElement>, mode: 'move' | Handle) {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDragging(true);
    setGuides([]);
    startRef.current = {
      box: { ...box },
      pointerX: e.clientX,
      pointerY: e.clientY,
      mode,
      rotation,
      centerX: cx,
      centerY: cy,
      startAngle: Math.atan2(e.clientY / zoom - cy, e.clientX / zoom - cx),
    };
  }

  function onMove(e: ReactPointerEvent<SVGElement>) {
    const s = startRef.current;
    if (!s) return;
    const dx = (e.clientX - s.pointerX) / zoom;
    const dy = (e.clientY - s.pointerY) / zoom;

    if (s.mode === 'move') {
      // 先按指针位移算出"临时块",再与同页其它块/页面边缘做对齐吸附。
      const tentative: SnapBox = {
        x: s.box.x + dx,
        y: s.box.y + dy,
        w: s.box.w,
        h: s.box.h,
      };
      let snapped = tentative;
      if (page) {
        const others: SnapBox[] = overlays
          .filter((o) => o.pageId === overlay.pageId && o.id !== overlay.id)
          .map((o) => getOverlayBBox(o));
        const res = computeSnap(
          tentative,
          others,
          { width: page.width, height: page.height },
          GUIDE_THRESHOLD_PX / zoom
        );
        snapped = res.box;
        setGuides(res.guides);
      }
      const patch: Partial<OverlayItem> = buildMovePatch(overlay, snapped);
      if (Object.keys(patch).length > 0) {
        updateOverlay(overlay.id, patch);
      }
      return;
    }

    if (s.mode === 'rotate') {
      const angle = Math.atan2(
        e.clientY / zoom - s.centerY,
        e.clientX / zoom - s.centerX
      );
      const delta = ((angle - s.startAngle) * 180) / Math.PI;
      const next = s.rotation + delta;
      if (overlay.type === 'image') {
        updateOverlay(overlay.id, { rotation: next } as Partial<OverlayItem>);
      }
      return;
    }

    // Resize
    const patch = applyResize(overlay, s.mode, s.box, dx, dy);
    if (Object.keys(patch).length > 0) {
      updateOverlay(overlay.id, patch);
    }
  }

  function endDrag(e: ReactPointerEvent<SVGElement>) {
    const s = startRef.current;
    startRef.current = null;
    setDragging(false);
    setGuides([]);
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    // Phase D: trigger inter-block reflow when a text-block is resized.
    if (s && overlay.type === 'text-block') {
      const current = useDocumentStore
        .getState()
        .overlays.find((o) => o.id === overlay.id);
      if (current && current.type === 'text-block') {
        const deltaH = current.bbox.h - s.box.h;
        if (Math.abs(deltaH) > 0.5) {
          pushDownSubsequentBlocks(overlay.pageId, overlay.id, deltaH);
        }
      }
    }
  }

  // For images, wrap the chrome in a rotation group so the frame matches
  // the rotated element. Other items are not rotated.
  const transform = rotation ? `rotate(${rotation} ${cx} ${cy})` : undefined;

  // 手柄位置共用计算:corner/side 的中心坐标。
  function handlePos(h: Handle): { hx: number; hy: number } {
    const hx =
      h === 'nw' || h === 'w' || h === 'sw'
        ? box.x
        : h === 'n' || h === 's'
        ? box.x + box.w / 2
        : box.x + box.w;
    const hy =
      h === 'nw' || h === 'n' || h === 'ne'
        ? box.y
        : h === 'w' || h === 'e'
        ? box.y + box.h / 2
        : box.y + box.h;
    return { hx, hy };
  }

  const accent = 'var(--accent, #2563eb)';

  // text-block 的选中边框由 TextBlockEditLayer 的 .text-block-outline(HTML)
  // 负责(随编辑内容伸展、双击进编辑),这里不再画 SVG 边框,否则选中/
  // 编辑态会叠成两个框。SVG 层只保留手柄 + 拖拽命中区 + 对齐参考线。
  const hideFrameBorder = overlay.type === 'text-block';

  return (
    <g
      transform={transform}
      pointerEvents="all"
      onPointerDown={(e) => {
        e.stopPropagation();
        setSelectedOverlayId(overlay.id);
      }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      {/* 可见选中框:实线主题色,无底色填充 —— Canva 风格。
          本身不接收指针事件,抓取由下方放大的透明命中区负责,
          保证小块也能轻松拖动。 */}
      <rect
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        fill="none"
        stroke={hideFrameBorder ? 'none' : accent}
        strokeWidth={2 / zoom}
        rx={2 / zoom}
        pointerEvents="none"
      />
      {/* 移动命中区:在 bbox 基础上外扩 MOVE_PAD_PX 屏幕像素,便于抓取小块。 */}
      <rect
        x={box.x - MOVE_PAD_PX / zoom}
        y={box.y - MOVE_PAD_PX / zoom}
        width={box.w + (MOVE_PAD_PX * 2) / zoom}
        height={box.h + (MOVE_PAD_PX * 2) / zoom}
        fill="transparent"
        style={{ cursor: tool === 'select' ? 'move' : 'default' }}
        onPointerDown={(e) => beginDrag(e, 'move')}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
      {/* 四角白色圆点手柄(常显) */}
      {CORNERS.map((h) => {
        const { hx, hy } = handlePos(h);
        const cursor =
          h === 'nw' || h === 'se' ? 'nwse-resize' : 'nesw-resize';
        return (
          <g key={h}>
            <rect
              x={hx - HANDLE_HIT / zoom}
              y={hy - HANDLE_HIT / zoom}
              width={(HANDLE_HIT * 2) / zoom}
              height={(HANDLE_HIT * 2) / zoom}
              fill="transparent"
              style={{ cursor }}
              onPointerDown={(e) => beginDrag(e, h)}
              onPointerMove={onMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            />
            <circle
              cx={hx}
              cy={hy}
              r={CORNER_RADIUS / zoom}
              fill={HANDLE_FILL}
              stroke={HANDLE_STROKE}
              strokeWidth={CORNER_STROKE / zoom}
              pointerEvents="none"
            />
          </g>
        );
      })}
      {/* 四边白色胶囊手柄(hover / 拖拽时显示) */}
      {showSideHandles &&
        SIDES.map((h) => {
          const { hx, hy } = handlePos(h);
          const horizontal = h === 'e' || h === 'w';
          const cursor = horizontal ? 'ew-resize' : 'ns-resize';
          const w = (horizontal ? PILL_H : PILL_W) / zoom;
          const hgt = (horizontal ? PILL_W : PILL_H) / zoom;
          return (
            <g key={h}>
              <rect
                x={hx - HANDLE_HIT / zoom}
                y={hy - HANDLE_HIT / zoom}
                width={(HANDLE_HIT * 2) / zoom}
                height={(HANDLE_HIT * 2) / zoom}
                fill="transparent"
                style={{ cursor }}
                onPointerDown={(e) => beginDrag(e, h)}
                onPointerMove={onMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              />
              <rect
                x={hx - w / 2}
                y={hy - hgt / 2}
                width={w}
                height={hgt}
                rx={Math.min(w, hgt) / 2}
                fill={HANDLE_FILL}
                stroke="none"
                pointerEvents="none"
              />
            </g>
          );
        })}
      {/* 对齐参考线(移动拖拽中):贯穿全页的红线,与页面边缘/中心及其它
          块的对应边对齐时显示,帮助用户对齐。pointerEvents=none 不挡操作。 */}
      {guides.map((g, i) =>
        g.axis === 'v' ? (
          <line
            key={`gv-${i}`}
            x1={g.pos}
            y1={0}
            x2={g.pos}
            y2={page ? page.height : box.y + box.h}
            stroke={GUIDE_COLOR}
            strokeWidth={1 / zoom}
            pointerEvents="none"
          />
        ) : (
          <line
            key={`gh-${i}`}
            x1={0}
            y1={g.pos}
            x2={page ? page.width : box.x + box.w}
            y2={g.pos}
            stroke={GUIDE_COLOR}
            strokeWidth={1 / zoom}
            pointerEvents="none"
          />
        )
      )}
      {isImage && (
        <g style={{ cursor: 'grab' }}>
          <line
            x1={cx}
            y1={box.y}
            x2={cx}
            y2={box.y - 20}
            stroke={accent}
            strokeWidth={1.5 / zoom}
          />
          <circle
            cx={cx}
            cy={box.y - 22}
            r={5 / zoom}
            fill={HANDLE_FILL}
            stroke={HANDLE_STROKE}
            strokeWidth={CORNER_STROKE / zoom}
            onPointerDown={(e) => beginDrag(e, 'rotate')}
            onPointerMove={onMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
        </g>
      )}
    </g>
  );
}
