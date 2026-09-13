// Inspector: right-side property panel for the currently selected overlay.
// - Common: X / Y / W / H / rotation + delete.
// - Text: font family (built-ins + Chinese fonts + Custom), size, color,
//   bold/italic/underline, align, line-height.
// - TextBlock: same as Text. Text content is edited on the canvas.
import { useMemo } from 'react';
import clsx from 'clsx';
import { useDocumentStore } from '../store/documentStore';
import { useEditorStore } from '../store/editorStore';
import type {
  DrawingItem,
  HighlightItem,
  ImageItem,
  OverlayItem,
  RedactItem,
  TextAlign,
  TextBlockItem,
  TextItem,
} from '../core/types';

const BUILTIN_FONTS = [
  'Helvetica',
  'TimesRoman',
  'Courier',
  'SimSun',
  'SimHei',
  'Microsoft YaHei',
  'KaiTi',
] as const;
type BuiltinFont = (typeof BUILTIN_FONTS)[number];
const isBuiltinFont = (s: string): s is BuiltinFont =>
  (BUILTIN_FONTS as readonly string[]).includes(s);

// 统一输入框样式:明确边框/底色,避免"透明穿透"的观感(看不出是可编辑框)。
const inputCls =
  'rounded border border-gray-300 bg-white px-1 py-0.5 text-gray-800 shadow-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100';

// ---------- Shared sub-components --------------------------------------------

interface CommonBoxFields {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

function readCommon(item: OverlayItem): CommonBoxFields | null {
  switch (item.type) {
    case 'highlight': {
      const it = item as HighlightItem;
      return { x: it.rect.x, y: it.rect.y, w: it.rect.w, h: it.rect.h, rotation: 0 };
    }
    case 'redact': {
      const it = item as RedactItem;
      return { x: it.rect.x, y: it.rect.y, w: it.rect.w, h: it.rect.h, rotation: 0 };
    }
    case 'text': {
      const it = item as TextItem;
      return { x: it.position.x, y: it.position.y, w: it.size.w, h: it.size.h, rotation: it.rotation };
    }
    case 'image': {
      const it = item as ImageItem;
      return { x: it.position.x, y: it.position.y, w: it.size.w, h: it.size.h, rotation: it.rotation };
    }
    case 'drawing': {
      return null;
    }
    case 'text-block': {
      return { x: item.bbox.x, y: item.bbox.y, w: item.bbox.w, h: item.bbox.h, rotation: 0 };
    }
    default: {
      const _exhaustive: never = item;
      return _exhaustive;
    }
  }
}

function applyCommon(
  item: OverlayItem,
  common: CommonBoxFields
): Partial<OverlayItem> {
  switch (item.type) {
    case 'highlight':
    case 'redact':
      return { rect: { x: common.x, y: common.y, w: common.w, h: common.h } } as Partial<OverlayItem>;
    case 'text':
      return {
        position: { x: common.x, y: common.y },
        size: { w: common.w, h: common.h },
        rotation: common.rotation,
      } as Partial<OverlayItem>;
    case 'image':
      return {
        position: { x: common.x, y: common.y },
        size: { w: common.w, h: common.h },
        rotation: common.rotation,
      } as Partial<OverlayItem>;
    case 'text-block':
      return { bbox: { x: common.x, y: common.y, w: common.w, h: common.h } } as Partial<OverlayItem>;
    default:
      return {};
  }
}

function NumberInput({
  value,
  onChange,
  step = 1,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <input
      type="number"
      value={Number.isFinite(value) ? Number(value.toFixed(2)) : 0}
      step={step}
      min={min}
      max={max}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) onChange(v);
      }}
      className={clsx(inputCls, 'w-full min-w-0 text-right')}
    />
  );
}

function NumberField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 items-center justify-between gap-2 text-xs text-gray-600">
      <span className="w-10 shrink-0">{label}</span>
      {children}
    </label>
  );
}

function ToggleButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={clsx(
        'h-7 min-w-7 rounded border px-2 text-sm',
        active
          ? 'border-blue-500 bg-blue-100 text-blue-800'
          : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
      )}
    >
      {children}
    </button>
  );
}

/** Three-button alignment selector (left / center / right), icon-based. */

function AlignLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <line x1="2" y1="3.5" x2="12" y2="3.5" />
      <line x1="2" y1="7" x2="8" y2="7" />
      <line x1="2" y1="10.5" x2="10" y2="10.5" />
    </svg>
  );
}

function AlignCenterIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <line x1="2" y1="3.5" x2="12" y2="3.5" />
      <line x1="4" y1="7" x2="10" y2="7" />
      <line x1="3" y1="10.5" x2="11" y2="10.5" />
    </svg>
  );
}

function AlignRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <line x1="2" y1="3.5" x2="12" y2="3.5" />
      <line x1="6" y1="7" x2="12" y2="7" />
      <line x1="4" y1="10.5" x2="12" y2="10.5" />
    </svg>
  );
}

function AlignButtonGroup({
  align,
  onChange,
}: {
  align: TextAlign;
  onChange: (a: TextAlign) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <ToggleButton
        active={align === 'left'}
        onClick={() => onChange('left')}
        title="左对齐"
      >
        <AlignLeftIcon />
      </ToggleButton>
      <ToggleButton
        active={align === 'center'}
        onClick={() => onChange('center')}
        title="居中"
      >
        <AlignCenterIcon />
      </ToggleButton>
      <ToggleButton
        active={align === 'right'}
        onClick={() => onChange('right')}
        title="右对齐"
      >
        <AlignRightIcon />
      </ToggleButton>
    </div>
  );
}

/** Shared font selector dropdown for Text and TextBlock controls. */
function FontSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (font: string) => void;
}) {
  const fontIsBuiltin = isBuiltinFont(value);
  return (
    <select
      value={fontIsBuiltin ? value : 'Custom'}
      onChange={(e) => {
        const v = e.target.value;
        if (v === 'Custom') {
          const name = window.prompt('输入字体名称', value || 'sans-serif') ?? value;
          onChange(name);
        } else {
          onChange(v);
        }
      }}
      className={inputCls}
    >
      {BUILTIN_FONTS.map((f) => (
        <option key={f} value={f}>
          {f}
        </option>
      ))}
      <option value="Custom">Custom...</option>
    </select>
  );
}

/**
 * RichTextEditor was previously defined here for editing text content inline
 * in the Inspector panel. Text content is now edited on the canvas via the
 * TipTap-based editor in features/text-edit. The Inspector only handles
 * property controls (font / size / color / align / etc).
 */

// ---------- Main Inspector ----------------------------------------------------

export function Inspector() {
  const selectedId = useEditorStore((s) => s.selectedOverlayId);
  const setSelectedOverlayId = useEditorStore((s) => s.setSelectedOverlayId);
  const setInspectorCollapsed = useEditorStore((s) => s.setInspectorCollapsed);
  const overlays = useDocumentStore((s) => s.overlays);
  const updateOverlay = useDocumentStore((s) => s.updateOverlay);
  const removeOverlay = useDocumentStore((s) => s.removeOverlay);

  const item = useMemo(
    () => overlays.find((o) => o.id === selectedId) ?? null,
    [overlays, selectedId]
  );

  if (!item) {
    return (
      <aside className="flex h-full w-[260px] flex-col gap-2 overflow-y-auto border-l bg-gray-50 p-3 text-xs text-gray-500">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-gray-700">属性</div>
          <button
            type="button"
            onClick={() => setInspectorCollapsed(true)}
            title="收起属性面板"
            className="rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-200"
          >
            ⟩
          </button>
        </div>
        <div className="rounded border border-dashed border-gray-300 bg-white p-4 text-center">
          未选中任何叠加元素
        </div>
      </aside>
    );
  }

  const common = readCommon(item);
  const current = item;

  const patchCommon = (field: keyof CommonBoxFields, value: number) => {
    if (!common) return;
    const next: CommonBoxFields = { ...common, [field]: value };
    const patch = applyCommon(current, next);
    if (Object.keys(patch).length > 0) {
      updateOverlay(current.id, patch);
    }
  };

  return (
    <aside className="flex h-full w-[260px] flex-col gap-3 overflow-y-auto border-l bg-gray-50 p-3 text-xs">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <div className="text-sm font-semibold text-gray-700">属性</div>
          <button
            type="button"
            onClick={() => setInspectorCollapsed(true)}
            title="收起属性面板"
            className="rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-200"
          >
            ⟩
          </button>
        </div>
        <button
          type="button"
          onClick={() => {
            removeOverlay(item.id);
            setSelectedOverlayId(null);
          }}
          className="rounded border border-red-300 bg-white px-2 py-0.5 text-xs text-red-700 hover:bg-red-50"
          title="删除选中的元素 (Del)"
        >
          删除
        </button>
      </div>

      <div className="rounded border bg-white p-2">
        <div className="mb-2 text-[11px] uppercase tracking-wide text-gray-400">类型</div>
        <div className="text-sm text-gray-800">{typeLabel(item)}</div>
      </div>

      {common && (
        <div className="rounded border bg-white p-2">
          <div className="mb-2 text-[11px] uppercase tracking-wide text-gray-400">位置 / 尺寸</div>
          <div className="grid grid-cols-2 gap-2">
            <NumberField label="X">
              <NumberInput value={common.x} onChange={(v) => patchCommon('x', v)} />
            </NumberField>
            <NumberField label="Y">
              <NumberInput value={common.y} onChange={(v) => patchCommon('y', v)} />
            </NumberField>
            <NumberField label="W">
              <NumberInput value={common.w} min={1} onChange={(v) => patchCommon('w', v)} />
            </NumberField>
            <NumberField label="H">
              <NumberInput value={common.h} min={1} onChange={(v) => patchCommon('h', v)} />
            </NumberField>
            <NumberField label="旋转">
              <NumberInput
                value={common.rotation}
                step={5}
                onChange={(v) => patchCommon('rotation', v)}
              />
            </NumberField>
          </div>
        </div>
      )}

      {item.type === 'text' && <TextControls item={item} updateOverlay={updateOverlay} />}
      {item.type === 'text-block' && (
        <TextBlockControls
          item={item as TextBlockItem}
          updateOverlay={updateOverlay}
        />
      )}
      {item.type === 'highlight' && (
        <HighlightControls
          item={item as HighlightItem}
          updateOverlay={updateOverlay}
        />
      )}
      {item.type === 'redact' && (
        <RedactControls
          item={item as RedactItem}
          updateOverlay={updateOverlay}
        />
      )}
      {item.type === 'drawing' && (
        <DrawingControls
          item={item as DrawingItem}
          updateOverlay={updateOverlay}
        />
      )}
    </aside>
  );
}

function typeLabel(item: OverlayItem): string {
  switch (item.type) {
    case 'highlight':
      return '高亮';
    case 'redact':
      return '涂黑 / 密文';
    case 'text':
      return '文字';
    case 'image':
      return '图片';
    case 'drawing':
      return '画笔';
    case 'text-block':
      return '原文本块';
    default: {
      const _exhaustive: never = item;
      return _exhaustive;
    }
  }
}

// ---------- TextControls (TextItem) ------------------------------------------

function TextControls({
  item,
  updateOverlay,
}: {
  item: TextItem;
  updateOverlay: (id: string, patch: Partial<OverlayItem>) => void;
}) {
  const align: TextAlign = item.align || 'left';

  return (
    <div className="rounded border bg-white p-2">
      <div className="mb-2 text-[11px] uppercase tracking-wide text-gray-400">文字</div>
      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-xs text-gray-600">
          字体
          <FontSelector
            value={item.font}
            onChange={(font) => updateOverlay(item.id, { font } as Partial<OverlayItem>)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-600">
          字号
          <input
            type="number"
            min={6}
            max={144}
            value={item.fontSize}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) {
                updateOverlay(item.id, { fontSize: Math.max(6, Math.min(144, v)) } as Partial<OverlayItem>);
              }
            }}
            className={inputCls}
          />
        </label>
        <label className="flex items-center justify-between gap-2 text-xs text-gray-600">
          颜色
          <input
            type="color"
            value={item.color}
            onChange={(e) =>
              updateOverlay(item.id, { color: e.target.value } as Partial<OverlayItem>)
            }
            className="h-7 w-10 cursor-pointer border-0 bg-transparent p-0"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-600">
          行距
          <input
            type="number"
            min={0.5}
            max={5}
            step={0.05}
            value={item.lineHeight ?? 1.2}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) {
                updateOverlay(item.id, {
                  lineHeight: Math.max(0.5, Math.min(5, v)),
                } as Partial<OverlayItem>);
              }
            }}
            className={inputCls}
          />
        </label>
        {/* Phase 4: alignment buttons */}
        <div className="flex items-center gap-1">
          <AlignButtonGroup
            align={align}
            onChange={(a) => updateOverlay(item.id, { align: a } as Partial<OverlayItem>)}
          />
        </div>
      </div>
    </div>
  );
}

// ---------- HighlightControls ------------------------------------------------

function HighlightControls({
  item,
  updateOverlay,
}: {
  item: HighlightItem;
  updateOverlay: (id: string, patch: Partial<OverlayItem>) => void;
}) {
  return (
    <div className="rounded border bg-white p-2">
      <div className="mb-2 text-[11px] uppercase tracking-wide text-gray-400">高亮</div>
      <label className="flex items-center justify-between text-xs text-gray-600">
        颜色
        <input
          type="color"
          value={item.color}
          onChange={(e) => updateOverlay(item.id, { color: e.target.value } as Partial<OverlayItem>)}
          className="h-7 w-10 cursor-pointer border-0 bg-transparent p-0"
        />
      </label>
      <label className="mt-2 flex flex-col gap-1 text-xs text-gray-600">
        不透明度
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={item.opacity}
          onChange={(e) => updateOverlay(item.id, { opacity: Number(e.target.value) } as Partial<OverlayItem>)}
        />
      </label>
    </div>
  );
}

// ---------- RedactControls ---------------------------------------------------
//
// 涂黑 / 密文。与 HighlightControls 长得像,但语义完全不同:高亮只是画一层
// 半透明色,原文仍在内容流里可复制;涂黑会在导出时把该矩形内的文字从内容
// 流中字节级删除,并抹除覆盖区域的图片像素与矢量图元。
//
// 面板必须把"不可撤销"讲清楚 —— 这是本应用唯一的破坏性操作,用户误以为
// 它像高亮一样可以反悔是很危险的。
function RedactControls({
  item,
  updateOverlay,
}: {
  item: RedactItem;
  updateOverlay: (id: string, patch: Partial<OverlayItem>) => void;
}) {
  return (
    <div className="rounded border bg-white p-2">
      <div className="mb-2 text-[11px] uppercase tracking-wide text-gray-400">
        涂黑 / 密文
      </div>

      <div className="mb-2 rounded border border-amber-300 bg-amber-50 p-2 text-[11px] leading-relaxed text-amber-900">
        导出时会把此框内的<strong>文字从内容流中删除</strong>,并抹除覆盖的图片
        像素与矢量图元。与"高亮"不同,这<strong>无法通过再次导出还原</strong>
        —— 请确认后再导出。
      </div>

      <label className="flex items-center justify-between text-xs text-gray-600">
        遮盖色
        <input
          type="color"
          value={item.color}
          onChange={(e) =>
            updateOverlay(item.id, { color: e.target.value } as Partial<OverlayItem>)
          }
          className="h-7 w-10 cursor-pointer border-0 bg-transparent p-0"
        />
      </label>

      <div className="mt-2 flex items-center gap-1">
        <button
          type="button"
          onClick={() =>
            updateOverlay(item.id, { color: '#000000' } as Partial<OverlayItem>)
          }
          className="rounded border border-gray-300 bg-white px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50"
          title="标准涂黑"
        >
          涂黑
        </button>
        <button
          type="button"
          onClick={() =>
            updateOverlay(item.id, { color: '#ffffff' } as Partial<OverlayItem>)
          }
          className="rounded border border-gray-300 bg-white px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50"
          title="涂白(适合白底文档,视觉上更干净)"
        >
          涂白
        </button>
      </div>

      <label className="mt-3 flex flex-col gap-1 text-xs text-gray-600">
        备注(仅本地记录,不会写入 PDF)
        <input
          type="text"
          value={item.label ?? ''}
          placeholder="例如:客户姓名"
          onChange={(e) =>
            updateOverlay(item.id, { label: e.target.value } as Partial<OverlayItem>)
          }
          className={inputCls}
        />
      </label>
    </div>
  );
}

// ---------- DrawingControls --------------------------------------------------

function DrawingControls({
  item,
  updateOverlay,
}: {
  item: DrawingItem;
  updateOverlay: (id: string, patch: Partial<OverlayItem>) => void;
}) {
  return (
    <div className="rounded border bg-white p-2">
      <div className="mb-2 text-[11px] uppercase tracking-wide text-gray-400">画笔</div>
      <label className="flex items-center justify-between text-xs text-gray-600">
        颜色
        <input
          type="color"
          value={item.color}
          onChange={(e) => updateOverlay(item.id, { color: e.target.value } as Partial<OverlayItem>)}
          className="h-7 w-10 cursor-pointer border-0 bg-transparent p-0"
        />
      </label>
      <label className="mt-2 flex flex-col gap-1 text-xs text-gray-600">
        粗细
        <input
          type="range"
          min={0.5}
          max={12}
          step={0.5}
          value={item.width}
          onChange={(e) => updateOverlay(item.id, { width: Number(e.target.value) } as Partial<OverlayItem>)}
        />
      </label>
    </div>
  );
}

// ---------- TextBlockControls ------------------------------------------------
//
// Inspector 面板里的"原文本块"控件:
//   * 字体 / 字号 / 颜色 / 行距 / 对齐 -- 只影响 flatten 阶段重画新文字
//     的视觉效果,不需要再过引擎,直接 updateOverlay 即可。
//   * 文字内容编辑在画布上的 TipTap 编辑器中完成 (双击文本块进入编辑)。
function TextBlockControls({
  item,
  updateOverlay,
}: {
  item: TextBlockItem;
  updateOverlay: (id: string, patch: Partial<OverlayItem>) => void;
}) {
  const align: TextAlign = item.align || 'left';

  return (
    <div className="rounded border bg-white p-2">
      <div className="mb-2 text-[11px] uppercase tracking-wide text-gray-400">
        原文本块
      </div>

      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-xs text-gray-600">
          字体
          <FontSelector
            value={item.font}
            onChange={(font) => updateOverlay(item.id, { font } as Partial<OverlayItem>)}
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-gray-600">
          字号
          <input
            type="number"
            min={6}
            max={144}
            value={item.fontSize}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) {
                updateOverlay(item.id, {
                  fontSize: Math.max(6, Math.min(144, v)),
                } as Partial<OverlayItem>);
              }
            }}
            className={inputCls}
          />
        </label>

        <label className="flex items-center justify-between gap-2 text-xs text-gray-600">
          颜色
          <input
            type="color"
            value={item.color || '#000000'}
            onChange={(e) =>
              updateOverlay(item.id, { color: e.target.value } as Partial<OverlayItem>)
            }
            className="h-7 w-10 cursor-pointer border-0 bg-transparent p-0"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-gray-600">
          行距
          <input
            type="number"
            min={0.5}
            max={5}
            step={0.05}
            value={item.lineHeight ?? 1.2}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) {
                updateOverlay(item.id, {
                  lineHeight: Math.max(0.5, Math.min(5, v)),
                } as Partial<OverlayItem>);
              }
            }}
            className={inputCls}
          />
        </label>

        {/* Phase 4: alignment buttons */}
        <div className="flex items-center gap-1">
          <AlignButtonGroup
            align={align}
            onChange={(a) => updateOverlay(item.id, { align: a } as Partial<OverlayItem>)}
          />
        </div>
      </div>
    </div>
  );
}
