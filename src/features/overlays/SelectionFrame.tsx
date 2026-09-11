// SelectionFrame: Canva 风格的选中框。实线主题色(--accent)边框、无底色,
// 手柄为白色圆形(四角)+ 白色胶囊(四边,hover 时才出现),尺寸全部按
// 1/zoom 换算,保证任意缩放下屏幕像素恒定。它处理鼠标事件并把
// 位置/尺寸/旋转更新委托给 document store。
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { ImageItem, OverlayItem } from '../../core/types';
import { useDocumentStore } from '../../store/documentStore';
import { useEditorStore } from '../../store/editorStore';
import { pushDownSubsequentBlocks } from '../text-edit/reflow';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate';

// 所有手柄几何量都在 SVG 用户单位(PDF pt)里除以 zoom,屏幕像素恒定。
const CORNER_RADIUS = 5; // 白色圆点手柄半径(屏幕 10px)
const CORNER_STROKE = 1.25; // 圆点描边宽度(屏幕 ~1.5px)
const PILL_W = 3; // 侧边胶囊手柄:宽 6px
const PILL_H = 9; // 高 18px —— 参照 Canva
const HANDLE_HIT = 12; // 手柄透明命中区(屏幕 24px),便于抓取
const HANDLE_FILL = '#ffffff';
const HANDLE_STROKE = '#0f1015'; // Canva 手柄描边色(近黑)

const CORNERS: Handle[] = ['nw', 'ne', 'sw', 'se'];
const SIDES: Handle[] = ['n', 's', 'e', 'w'];

function getOverlayBBox(item: OverlayItem): { x: number; y: number; w: number; h: number } {
  switch (item.type) {
    case 'highlight':
      return item.rect;
    case 'text-block':
    case 'form-field':
      return item.bbox;
    case 'note':
    case 'text':
    case 'image':
      return {
        x: item.position.x,
        y: item.position.y,
        w: item.size.w,
        h: item.size.h,
      };
    case 'drawing':
      // Drawings don't have a natural bbox in the model; we still draw
      // a frame around a 1x1 default. The path itself is the source of truth.
      return { x: 0, y: 0, w: 0, h: 0 };
    default: {
      const _exhaustive: never = item;
      return _exhaustive;
    }
  }
}

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
    case 'form-field':
      return { bbox: { x, y, w, h } } as Partial<OverlayItem>;
    case 'note':
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

export interface SelectionFrameProps {
  overlay: OverlayItem;
  zoom: number;
}

export function SelectionFrame({ overlay, zoom }: SelectionFrameProps) {
  const updateOverlay = useDocumentStore((s) => s.updateOverlay);
  const setSelectedOverlayId = useEditorStore((s) => s.setSelectedOverlayId);
  const tool = useEditorStore((s) => s.tool);

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
      let patch: Partial<OverlayItem>;
      switch (overlay.type) {
        case 'highlight':
          patch = { rect: { x: s.box.x + dx, y: s.box.y + dy, w: s.box.w, h: s.box.h } };
          break;
        case 'text-block':
        case 'form-field':
          patch = { bbox: { x: s.box.x + dx, y: s.box.y + dy, w: s.box.w, h: s.box.h } };
          break;
        case 'note':
        case 'text':
        case 'image':
          patch = {
            position: { x: s.box.x + dx, y: s.box.y + dy },
            size: { w: s.box.w, h: s.box.h },
          };
          break;
        default:
          return;
      }
      updateOverlay(overlay.id, patch);
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

  // edit-text 工具下 text-block 的边框由 TextBlockEditLayer 的
  // .text-block-outline(HTML,随编辑内容伸展)负责;这里只保留拖拽
  // 命中区 + 手柄,否则两套边框在选中/编辑态叠成两个框。
  const hideFrameBorder = overlay.type === 'text-block' && tool !== 'select';

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
      {/* 选中框:实线主题色,无底色填充 —— Canva 风格 */}
      <rect
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        fill="none"
        stroke={hideFrameBorder ? 'none' : accent}
        strokeWidth={2 / zoom}
        rx={2 / zoom}
        pointerEvents="all"
        onPointerDown={(e) => beginDrag(e, 'move')}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{ cursor: tool === 'select' ? 'move' : 'default' }}
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
