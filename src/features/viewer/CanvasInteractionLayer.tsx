// CanvasInteractionLayer: an invisible div that covers the rendered page and
// handles pointer interactions for all "creation" tools (highlight, redact,
// text, image, draw, signature). It translates screen pixels into PDF
// coordinates and dispatches to the document store.
//
// Layout assumptions: this div must be positioned absolutely over the page
// canvas. The OverlayLayer SVG is rendered above it; in `select` mode this
// layer is fully transparent and pointer-inert, so overlay selection works.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useEditorStore } from '../../store/editorStore';
import { useDocumentStore } from '../../store/documentStore';
import { usePenStore } from '../../store/penStore';
import type { PageMeta } from '../../core/types';

export interface CanvasInteractionLayerProps {
  page: PageMeta;
  /** Optional callback invoked after an image is picked from a hidden input. */
  registerFileInput: (input: HTMLInputElement | null) => void;
}

export function CanvasInteractionLayer({
  page,
  registerFileInput,
}: CanvasInteractionLayerProps) {
  const tool = useEditorStore((s) => s.tool);
  const zoom = useEditorStore((s) => s.zoom);
  const addOverlay = useDocumentStore((s) => s.addOverlay);
  const setSelectedOverlayId = useEditorStore((s) => s.setSelectedOverlayId);
  const setTool = useEditorStore((s) => s.setTool);
  const penColor = usePenStore((s) => s.color);
  const penWidth = usePenStore((s) => s.width);

  // Per-tool drag/click state.
  const [dragRect, setDragRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  // Live drawing state for the pen tool.
  const drawPathRef = useRef<string>('');
  const drawPointsRef = useRef<Array<{ x: number; y: number }>>([]);
  const [liveDrawPath, setLiveDrawPath] = useState<string>('');

  // File input ref for the image tool.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const setFileInput = useCallback(
    (el: HTMLInputElement | null) => {
      fileInputRef.current = el;
      registerFileInput(el);
    },
    [registerFileInput]
  );

  // Listen for the global "open image picker" event from the Toolbar.
  useEffect(() => {
    function onOpen() {
      fileInputRef.current?.click();
    }
    window.addEventListener('canva:open-image-picker', onOpen);
    return () => window.removeEventListener('canva:open-image-picker', onOpen);
  }, []);

  function eventToPdf(e: ReactPointerEvent<HTMLDivElement>): {
    x: number;
    y: number;
  } {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / zoom,
      y: (e.clientY - rect.top) / zoom,
    };
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (tool === 'select') return;
    if (tool === 'image') {
      // Image is handled by the file picker — this layer should ignore clicks.
      return;
    }
    if (tool === 'signature') {
      // Signature is handled by the modal.
      return;
    }
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const p = eventToPdf(e);
    dragStartRef.current = p;

    if (tool === 'draw') {
      drawPointsRef.current = [p];
      drawPathRef.current = `M ${p.x} ${p.y}`;
      setLiveDrawPath(drawPathRef.current);
      return;
    }

    // highlight / redact / text: start a drag rectangle preview
    setDragRect({ x: p.x, y: p.y, w: 0, h: 0 });
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (tool === 'select') return;
    const p = eventToPdf(e);
    if (tool === 'draw') {
      if (drawPointsRef.current.length === 0) return;
      const last = drawPointsRef.current[drawPointsRef.current.length - 1];
      // Only push points that are at least ~0.5pt from the previous one.
      if (Math.hypot(p.x - last.x, p.y - last.y) < 0.5) return;
      drawPointsRef.current.push(p);
      drawPathRef.current += ` L ${p.x} ${p.y}`;
      setLiveDrawPath(drawPathRef.current);
      return;
    }
    if (!dragStartRef.current) return;
    const start = dragStartRef.current;
    const x = Math.min(start.x, p.x);
    const y = Math.min(start.y, p.y);
    const w = Math.abs(p.x - start.x);
    const h = Math.abs(p.y - start.y);
    setDragRect({ x, y, w, h });
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (tool === 'select') return;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    if (tool === 'draw') {
      const path = drawPathRef.current;
      drawPointsRef.current = [];
      drawPathRef.current = '';
      setLiveDrawPath('');
      if (path.length > 4) {
        const id = uuidv4();
        addOverlay({
          id,
          type: 'drawing',
          pageId: page.id,
          path,
          color: penColor,
          width: penWidth,
        });
        setSelectedOverlayId(id);
      }
      setTool('select');
      return;
    }

    if (!dragRect || !dragStartRef.current) {
      dragStartRef.current = null;
      return;
    }
    const start = dragStartRef.current;
    dragStartRef.current = null;
    const p = eventToPdf(e);
    const x = Math.min(start.x, p.x);
    const y = Math.min(start.y, p.y);
    const w = Math.abs(p.x - start.x);
    const h = Math.abs(p.y - start.y);
    setDragRect(null);

    if (w < 4 || h < 4) {
      // Too small — treat as no-op.
      return;
    }

    if (tool === 'highlight') {
      const id = uuidv4();
      addOverlay({
        id,
        type: 'highlight',
        pageId: page.id,
        rect: { x, y, w, h },
        color: '#FFEB3B',
        opacity: 0.4,
      });
      setSelectedOverlayId(id);
    } else if (tool === 'redact') {
      // 涂黑 / 密文:默认纯黑。真正的删除发生在导出时(见 core/writer/
      // redact.ts 的 'full' 模式),此处只落一个 overlay。
      const id = uuidv4();
      addOverlay({
        id,
        type: 'redact',
        pageId: page.id,
        rect: { x, y, w, h },
        color: '#000000',
      });
      setSelectedOverlayId(id);
    } else if (tool === 'text') {
      const id = uuidv4();
      addOverlay({
        id,
        type: 'text',
        pageId: page.id,
        position: { x, y },
        size: { w, h },
        rotation: 0,
        text: '',
        font: 'Helvetica',
        fontSize: 12,
        color: '#000000',
        bold: false,
        italic: false,
        underline: false,
      });
      setSelectedOverlayId(id);
    }

    setTool('select');
  }

  // This layer only needs to intercept drags for the *creation* tools.
  // For `select`, `image`, and `signature` it must stay fully
  // pointer-transparent so clicks reach the underlying
  // OverlayLayer / TextBlockEditLayer / file input.
  const interactive =
    tool === 'highlight' ||
    tool === 'redact' ||
    tool === 'text' ||
    tool === 'draw';

  return (
    <>
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={(e) => {
          try {
            (e.currentTarget as Element).releasePointerCapture(e.pointerId);
          } catch {
            /* ignore */
          }
          setDragRect(null);
          drawPathRef.current = '';
          drawPointsRef.current = [];
          setLiveDrawPath('');
          dragStartRef.current = null;
        }}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: page.width * zoom,
          height: page.height * zoom,
          cursor: interactive ? 'crosshair' : 'default',
          pointerEvents: interactive ? 'auto' : 'none',
          // Don't block the SVG above for tool modes handled there
          // (currently nothing else — all creation tools are handled here).
          zIndex: 5,
        }}
      />
      {/* Live drag preview rectangle for highlight/text */}
      {dragRect && (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox={`0 0 ${page.width} ${page.height}`}
          width={page.width * zoom}
          height={page.height * zoom}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            pointerEvents: 'none',
            zIndex: 6,
          }}
        >
          <rect
            x={dragRect.x}
            y={dragRect.y}
            width={dragRect.w}
            height={dragRect.h}
            fill={tool === 'highlight' ? '#FFEB3B' : 'rgba(59,130,246,0.08)'}
            fillOpacity={tool === 'highlight' ? 0.4 : 1}
            stroke={tool === 'highlight' ? '#ca8a04' : '#2563eb'}
            strokeDasharray={tool === 'highlight' ? undefined : '3 2'}
            strokeWidth={1 / zoom}
          />
        </svg>
      )}
      {/* Live drawing path preview */}
      {liveDrawPath && (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox={`0 0 ${page.width} ${page.height}`}
          width={page.width * zoom}
          height={page.height * zoom}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            pointerEvents: 'none',
            zIndex: 6,
          }}
        >
          <path
            d={liveDrawPath}
            stroke={penColor}
            strokeWidth={penWidth}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {/* Hidden file input used by the image tool */}
      <input
        ref={setFileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          const bytes = await f.arrayBuffer();
          const base64 = btoa(
            new Uint8Array(bytes).reduce(
              (acc, b) => acc + String.fromCharCode(b),
              ''
            )
          );
          // Read image dimensions to keep aspect ratio.
          const url = `data:${f.type};base64,${base64}`;
          const img = new Image();
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error('failed to load image'));
            img.src = url;
          });
          const maxSide = 200;
          const ratio = img.width / img.height;
          let w = img.width;
          let h = img.height;
          if (w > maxSide || h > maxSide) {
            if (ratio >= 1) {
              w = maxSide;
              h = maxSide / ratio;
            } else {
              h = maxSide;
              w = maxSide * ratio;
            }
          }
          const id = uuidv4();
          addOverlay({
            id,
            type: 'image',
            pageId: page.id,
            position: { x: (page.width - w) / 2, y: (page.height - h) / 2 },
            size: { w, h },
            rotation: 0,
            bytes: base64,
            mime: f.type,
          });
          setSelectedOverlayId(id);
          setTool('select');
        }}
      />
    </>
  );
}
