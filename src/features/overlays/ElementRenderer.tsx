// ElementRenderer: dispatches SVG rendering for each overlay item type.
import type { OverlayItem, RichTextSegment } from '../../core/types';
import { useDocumentStore } from '../../store/documentStore';

export interface ElementRendererProps {
  overlay: OverlayItem;
  selected?: boolean;
}

/** Build the inline-segment spans for a foreignObject div. */
function renderSegments(
  segments: RichTextSegment[] | undefined,
  text: string,
  color: string,
  fontFamily: string
) {
  if (!segments || segments.length === 0) {
    return text;
  }
  return segments.map((s, i) => {
    const decos: string[] = [];
    if (s.underline) decos.push('underline');
    if (s.strike) decos.push('line-through');
    return (
      <span
        key={i}
        style={{
          fontWeight: s.bold ? 700 : 400,
          fontStyle: s.italic ? 'italic' : 'normal',
          textDecoration: decos.length > 0 ? decos.join(' ') : 'none',
          color: s.color || color,
          fontSize: s.fontSize ? `${s.fontSize}px` : undefined,
          fontFamily: s.fontFamily || fontFamily,
        }}
      >
        {s.text}
      </span>
    );
  });
}

export function ElementRenderer({ overlay, selected = false }: ElementRendererProps) {
  const pageBgColor =
    useDocumentStore((s) => s.pageBgColors[overlay.id]) || '#ffffff';
  switch (overlay.type) {
    case 'highlight': {
      return (
        <rect
          x={overlay.rect.x}
          y={overlay.rect.y}
          width={overlay.rect.w}
          height={overlay.rect.h}
          fill={overlay.color}
          fillOpacity={overlay.opacity}
          pointerEvents="none"
        />
      );
    }
    case 'note': {
      // Phase 7: square corners (pdf-lib does not support rounded rects),
      // opacity 0.9, stroke #a16207, text 80 chars with \n support.
      const noteLines = overlay.text.slice(0, 80).split('\n');
      return (
        <g pointerEvents="none">
          <rect
            x={overlay.position.x}
            y={overlay.position.y}
            width={overlay.size.w}
            height={overlay.size.h}
            fill={overlay.color}
            fillOpacity={0.9}
            stroke="#a16207"
            strokeWidth={1}
          />
          {noteLines.map((line, i) => (
            <text
              key={i}
              x={overlay.position.x + 6}
              y={overlay.position.y + 16 + i * 12}
              fontSize={10}
              fill="#1f2937"
            >
              {line}
            </text>
          ))}
        </g>
      );
    }
    case 'text': {
      // Phase 2+3+4+6: use foreignObject for auto-wrap, alignment,
      // multi-line and rich-text segments.
      const lh = overlay.lineHeight || 1.2;
      const align = overlay.align || 'left';
      return (
        <g
          pointerEvents="none"
          transform={
            overlay.rotation !== 0
              ? `rotate(${overlay.rotation} ${overlay.position.x} ${overlay.position.y})`
              : undefined
          }
        >
          {/* Dashed selection border */}
          <rect
            x={overlay.position.x}
            y={overlay.position.y}
            width={overlay.size.w}
            height={overlay.size.h}
            fill="transparent"
            stroke="#d1d5db"
            strokeDasharray="2,2"
            strokeWidth={0.5}
          />
          {/* foreignObject embeds HTML so CSS handles wrapping, alignment
              and rich-text segments natively. Coordinates are in PDF space
              (the SVG viewBox handles zoom scaling). */}
          <foreignObject
            x={overlay.position.x}
            y={overlay.position.y}
            width={overlay.size.w}
            height={overlay.size.h}
          >
            <div
              style={{
                width: '100%',
                height: '100%',
                fontFamily: overlay.font,
                fontSize: overlay.fontSize,
                color: overlay.color,
                fontWeight: overlay.bold ? 700 : 400,
                fontStyle: overlay.italic ? 'italic' : 'normal',
                textDecoration: overlay.underline ? 'underline' : 'none',
                textAlign: align,
                lineHeight: String(lh),
                whiteSpace: 'pre-wrap',
                tabSize: 4,
                wordBreak: 'break-word',
                overflow: 'hidden',
                boxSizing: 'border-box',
                margin: 0,
                padding: 0,
              }}
            >
              {renderSegments(overlay.segments, overlay.text, overlay.color, overlay.font)}
            </div>
          </foreignObject>
        </g>
      );
    }
    case 'image': {
      return (
        <image
          x={overlay.position.x}
          y={overlay.position.y}
          width={overlay.size.w}
          height={overlay.size.h}
          href={`data:${overlay.mime};base64,${overlay.bytes}`}
          transform={`rotate(${overlay.rotation} ${overlay.position.x} ${overlay.position.y})`}
          preserveAspectRatio="none"
          pointerEvents="none"
        />
      );
    }
    case 'drawing': {
      return (
        <path
          d={overlay.path}
          stroke={overlay.color}
          strokeWidth={overlay.width}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          pointerEvents="none"
        />
      );
    }
    case 'text-block': {
      // text-block 文字由 PDF.js 在底层 canvas 渲染,正常情况下我们不
      // 再重复渲染 -- 但当用户进入"编辑文字"模式或拖动该 block 时,
      // 底层 canvas 上的原字仍然显示,与编辑浮层 / 拖动后的视觉位置
      // 不一致,所以需要用白色矩形先把底层 canvas 上的原字遮住,再在
      // 上方画文字。
      const moved =
        overlay.bbox.x !== overlay.originalBbox.x ||
        overlay.bbox.y !== overlay.originalBbox.y ||
        overlay.bbox.w !== overlay.originalBbox.w ||
        overlay.bbox.h !== overlay.originalBbox.h;
      // Detect styling changes: if segments differ from the detection-time
      // snapshot (originalSegments), the user applied/changed bold/italic/color.
      const segsChanged =
        overlay.originalSegments != null
          ? JSON.stringify(overlay.segments ?? []) !==
            JSON.stringify(overlay.originalSegments)
          : (overlay.segments != null && overlay.segments.length > 0);
      const edited = overlay.text !== overlay.originalText || moved || segsChanged;
      const showOverlay = edited || selected;
      const lh = overlay.lineHeight || 1.2;
      const align = overlay.align || 'left';
      // 白底颜色:未移动的块用采样底色(保住彩色底板);移动过的块原位置
      // 应恢复页面底色(白),底色跟随块走到新位置。
      const whiteoutFill = moved ? '#ffffff' : pageBgColor;
      return (
        <>
          {/* 白底画在 originalBbox:盖住 pdfjs canvas 上原位置的原字。
              加 pad(与导出端 whiteout 的 padX/padY 一致):字形(尤其
              大写字母)边缘会溢出检测 bbox 1-2px,不留 pad 会露出原字残影。 */}
          {showOverlay && (
            <rect
              x={overlay.originalBbox.x - 1}
              y={overlay.originalBbox.y - overlay.originalBbox.h * 0.15}
              width={overlay.originalBbox.w + 2}
              height={overlay.originalBbox.h * 1.3}
              fill={whiteoutFill}
              pointerEvents="none"
            />
          )}
          {/* 选中框画在 bbox(当前位置) */}
          <rect
            x={overlay.bbox.x}
            y={overlay.bbox.y}
            width={overlay.bbox.w}
            height={overlay.bbox.h}
            fill="transparent"
            stroke="#60a5fa"
            strokeOpacity={selected ? 0.9 : 0.5}
            strokeWidth={selected ? 0.75 : 0.5}
            strokeDasharray="3 2"
            pointerEvents="none"
          />
          {/* 新字画在 bbox(当前位置) -- Phase 2+3+4+6: foreignObject
              for wrapping, alignment, multi-line and segments。
              编辑字体与原字有 1-2px 度量差,固定 bbox 宽高会挤断行/裁剪;
              与编辑态一致用 max-content 宽度 + overflow visible。 */}
          {showOverlay && (
            <foreignObject
              x={overlay.bbox.x}
              y={overlay.bbox.y}
              width={overlay.bbox.w}
              height={overlay.bbox.h}
              style={{ overflow: 'visible' }}
            >
              <div
                style={{
                  width: 'max-content',
                  minWidth: '100%',
                  minHeight: '100%',
                  // 重画文字自带底色(与白底同色):白底矩形只覆盖
                  // originalBbox,重画文字超出/变化的部分若没有底色,
                  // 底层 canvas 的原字会透过来与重画文字叠在一起。
                  background: pageBgColor,
                  fontFamily: overlay.font,
                  fontSize: overlay.fontSize,
                  color: overlay.color,
                  fontWeight: overlay.bold ? 700 : 400,
                  fontStyle: overlay.italic ? 'italic' : 'normal',
                  textAlign: align,
                  lineHeight: String(lh),
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  boxSizing: 'border-box',
                  margin: 0,
                  padding: 0,
                }}
              >
                {renderSegments(overlay.segments, overlay.text, overlay.color, overlay.font)}
              </div>
            </foreignObject>
          )}
        </>
      );
    }
    case 'form-field': {
      return (
        <rect
          x={overlay.bbox.x}
          y={overlay.bbox.y}
          width={overlay.bbox.w}
          height={overlay.bbox.h}
          fill="rgba(34,197,94,0.1)"
          stroke="#22c55e"
          strokeWidth={0.5}
          pointerEvents="none"
        />
      );
    }
    default: {
      // Exhaustiveness check
      const _exhaustive: never = overlay;
      return _exhaustive;
    }
  }
}
