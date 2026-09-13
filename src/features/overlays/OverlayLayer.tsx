// OverlayLayer: SVG container that mirrors the current page's size and zoom
// and renders every overlay (and a selection frame for the selected one).
import { useDocumentStore } from '../../store/documentStore';
import { useEditorStore } from '../../store/editorStore';
import type { PageMeta } from '../../core/types';
import { ElementRenderer } from './ElementRenderer';
import { SelectionFrame } from './SelectionFrame';

export interface OverlayLayerProps {
  page: PageMeta;
}

export function OverlayLayer({ page }: OverlayLayerProps) {
  const zoom = useEditorStore((s) => s.zoom);
  const tool = useEditorStore((s) => s.tool);
  const selectedOverlayId = useEditorStore((s) => s.selectedOverlayId);
  const setSelectedOverlayId = useEditorStore((s) => s.setSelectedOverlayId);
  const overlays = useDocumentStore((s) => s.overlays);

  const pageOverlays = overlays.filter((o) => o.pageId === page.id);
  const selected = pageOverlays.find((o) => o.id === selectedOverlayId);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${page.width} ${page.height}`}
      width={page.width * zoom}
      height={page.height * zoom}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        pointerEvents: tool === 'select' ? 'auto' : 'none',
        cursor: tool === 'select' ? 'default' : 'crosshair',
      }}
      onPointerDown={() => {
        if (tool === 'select') setSelectedOverlayId(null);
      }}
    >
      {pageOverlays.map((o) => (
        <g
          key={o.id}
          onPointerDown={(e) => {
            // Selecting the element happens in SelectionFrame to keep the
            // element visible underneath; here we just stop bubbling so the
            // background-click handler above doesn't immediately deselect.
            // In `select` mode we also promote the clicked overlay to the
            // selected one — without this, clicking an unselected overlay
            // would only swallow the event and the SelectionFrame would
            // never appear.
            e.stopPropagation();
            if (tool === 'select') setSelectedOverlayId(o.id);
          }}
          style={{ pointerEvents: tool === 'select' ? 'auto' : 'none' }}
        >
          <ElementRenderer overlay={o} selected={o.id === selectedOverlayId} />
          {/* For types that are pointer-inert, we add a transparent hit area. */}
          {(o.type === 'image' || o.type === 'highlight' || o.type === 'redact' || o.type === 'text-block') && (
            <OverlayHitArea overlay={o} />
          )}
        </g>
      ))}
      {/* SelectionFrame 渲染在 svg 的"overlay 通道",独立 pointerEvents
          控制,这样即便 user 在非 select 工具(比如编辑文字)选中
          了一个块,Inspector 改字体颜色后我们也能拖它调整位置 ——
          否则 svg 在非 select 工具下整体 pointerEvents=none 就完
          全拖不动了。 */}
      {selected && (
        <g
          style={{
            pointerEvents:
              tool === 'select' || selected.type === 'text-block'
                ? 'all'
                : 'none',
          }}
        >
          <SelectionFrame overlay={selected} zoom={zoom} />
        </g>
      )}
    </svg>
  );
}

function OverlayHitArea({ overlay }: { overlay: import('../../core/types').OverlayItem }) {
  switch (overlay.type) {
    case 'image':
      return (
        <rect
          x={overlay.position.x}
          y={overlay.position.y}
          width={overlay.size.w}
          height={overlay.size.h}
          fill="transparent"
          transform={`rotate(${overlay.rotation} ${overlay.position.x} ${overlay.position.y})`}
        />
      );
    case 'highlight':
    case 'redact':
      return (
        <rect
          x={overlay.rect.x}
          y={overlay.rect.y}
          width={overlay.rect.w}
          height={overlay.rect.h}
          fill="transparent"
        />
      );
    case 'text-block':
      return (
        <rect
          x={overlay.bbox.x}
          y={overlay.bbox.y}
          width={overlay.bbox.w}
          height={overlay.bbox.h}
          fill="transparent"
        />
      );
    default:
      return null;
  }
}
