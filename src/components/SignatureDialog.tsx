// SignatureDialog: modal that lets the user draw a signature on an HTML canvas
// and save it as an ImageItem overlay.
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useDocumentStore } from '../store/documentStore';
import { useEditorStore } from '../store/editorStore';
import { usePenStore } from '../store/penStore';

export interface SignatureDialogProps {
  open: boolean;
  onClose: () => void;
}

const CANVAS_W = 480;
const CANVAS_H = 180;

export function SignatureDialog({ open, onClose }: SignatureDialogProps) {
  const addOverlay = useDocumentStore((s) => s.addOverlay);
  const setSelectedOverlayId = useEditorStore((s) => s.setSelectedOverlayId);
  const setTool = useEditorStore((s) => s.setTool);
  const currentPageIndex = useEditorStore((s) => s.currentPageIndex);
  const pages = useDocumentStore((s) => s.pages);
  const penColor = usePenStore((s) => s.color);
  const penWidth = usePenStore((s) => s.width);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef<{ active: boolean; lastX: number; lastY: number }>({
    active: false,
    lastX: 0,
    lastY: 0,
  });
  const [hasInk, setHasInk] = useState(false);

  // Reset canvas whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = CANVAS_W * dpr;
    c.height = CANVAS_H * dpr;
    c.style.width = `${CANVAS_W}px`;
    c.style.height = `${CANVAS_H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 透明底色:签名保存为带 alpha 的 PNG,叠加到 PDF 上时不会盖住原内容。
    // (旧实现填白,导出后是一个白色矩形盖在正文上。)
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    setHasInk(false);
  }, [open]);

  if (!open) return null;

  function getPoint(e: ReactPointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const p = getPoint(e);
    drawingRef.current = { active: true, lastX: p.x, lastY: p.y };
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.strokeStyle = penColor;
    ctx.lineWidth = penWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    setHasInk(true);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current.active) return;
    const p = getPoint(e);
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    drawingRef.current.lastX = p.x;
    drawingRef.current.lastY = p.y;
  }

  function onPointerUp(e: ReactPointerEvent<HTMLCanvasElement>) {
    drawingRef.current.active = false;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  function clearCanvas() {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    setHasInk(false);
  }

  function save() {
    const c = canvasRef.current;
    if (!c) return;
    const dataUrl = c.toDataURL('image/png');
    // strip "data:image/png;base64,"
    const idx = dataUrl.indexOf(',');
    if (idx < 0) return;
    const base64 = dataUrl.slice(idx + 1);

    // Insert as ImageItem at the center of the current page.
    const page =
      pages[Math.min(currentPageIndex, Math.max(0, pages.length - 1))] ??
      pages[0];
    if (!page) return;
    const w = Math.min(200, (CANVAS_W / CANVAS_H) * 200);
    const h = 200;
    addOverlay({
      id: uuidv4(),
      type: 'image',
      pageId: page.id,
      position: { x: page.width / 2 - w / 2, y: page.height / 2 - h / 2 },
      size: { w, h },
      rotation: 0,
      bytes: base64,
      mime: 'image/png',
    });
    setSelectedOverlayId(null);
    setTool('select');
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="绘制签名"
    >
      <div className="w-[540px] max-w-[95vw] rounded-lg bg-white p-4 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-800">签名</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-gray-500 hover:bg-gray-100"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
        <p className="mb-2 text-xs text-gray-500">
          在下方区域中绘制你的签名,然后点击保存。背景为透明(棋盘格仅作提示),
          叠加到 PDF 上不会遮盖原有内容。
        </p>
        <div className="flex justify-center">
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            className="rounded border"
            style={{
              width: CANVAS_W,
              height: CANVAS_H,
              touchAction: 'none',
              // 棋盘格:直观表明画布是透明底,而非白底。
              backgroundColor: '#ffffff',
              backgroundImage:
                'linear-gradient(45deg, #e5e7eb 25%, transparent 25%), ' +
                'linear-gradient(-45deg, #e5e7eb 25%, transparent 25%), ' +
                'linear-gradient(45deg, transparent 75%, #e5e7eb 75%), ' +
                'linear-gradient(-45deg, transparent 75%, #e5e7eb 75%)',
              backgroundSize: '16px 16px',
              backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
            }}
          />
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={clearCanvas}
            className="rounded border px-3 py-1 text-sm hover:bg-gray-50"
          >
            清空
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded border px-3 py-1 text-sm hover:bg-gray-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!hasInk}
            className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
