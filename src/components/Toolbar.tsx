// Toolbar: horizontal icon-only tool palette rendered below the TopBar.
// Replaces the vertical ToolSidebar (which lived on the left edge). Tools are
// shown as icon glyphs with a `title` tooltip for the label + shortcut.
//
// Pen options (color / width) appear inline when the draw tool is active.
import clsx from 'clsx';
import { useEditorStore } from '../store/editorStore';
import { usePenStore } from '../store/penStore';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import type { Tool } from '../core/types';
import { runEngineDetection } from '../features/text-edit/runEngineDetection';
import { useAutoDetectTextBlocks } from '../features/text-edit/useAutoDetectTextBlocks';

interface ToolDef {
  tool: Tool;
  label: string;
  shortcut: string;
  icon: string; // glyph rendered as the button's visual icon
}

const TOOLS: ToolDef[] = [
  { tool: 'select', label: '选择', shortcut: 'V', icon: '↖' },
  { tool: 'edit-text', label: '编辑文字', shortcut: 'E', icon: '✎' },
  { tool: 'form', label: '表单', shortcut: 'F', icon: '☐' },
  { tool: 'highlight', label: '高亮', shortcut: 'H', icon: '◑' },
  { tool: 'note', label: '便签', shortcut: 'N', icon: '☰' },
  { tool: 'text', label: '文字', shortcut: 'T', icon: 'T' },
  { tool: 'image', label: '图片', shortcut: 'I', icon: '▦' },
  { tool: 'draw', label: '画笔', shortcut: 'D', icon: '✏' },
  { tool: 'signature', label: '签名', shortcut: 'S', icon: '✒' },
];

export interface ToolbarProps {
  onPickImage: () => void;
  onOpenSignature: () => void;
}

export function Toolbar({ onPickImage, onOpenSignature }: ToolbarProps) {
  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);

  const penColor = usePenStore((s) => s.color);
  const penWidth = usePenStore((s) => s.width);
  const setPenColor = usePenStore((s) => s.setColor);
  const setPenWidth = usePenStore((s) => s.setWidth);

  // Wire up global keyboard shortcuts (tool switching, undo/redo, delete, esc).
  useKeyboardShortcuts();

  // Auto-run text-block detection when edit-text is active and the current
  // page hasn't been detected yet (default tool is edit-text).
  useAutoDetectTextBlocks();

  function pickTool(t: Tool) {
    if (t === 'image') {
      onPickImage();
      return;
    }
    if (t === 'signature') {
      onOpenSignature();
      return;
    }
    // 重复点击已激活的工具时不重复检测(当前页已有块时检测会直接跳过)。
    const prevTool = useEditorStore.getState().tool;
    setTool(t);
    if ((t === 'edit-text' || t === 'form') && prevTool !== t) {
      void runEngineDetection(t);
    }
  }

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-gray-200 bg-white px-2 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
      {TOOLS.map((t) => {
        const isActive = tool === t.tool;
        return (
          <button
            key={t.tool}
            type="button"
            title={`${t.label} (${t.shortcut})`}
            onClick={() => pickTool(t.tool)}
            aria-label={t.label}
            className={clsx(
              'flex h-7 w-7 items-center justify-center rounded-md text-base transition',
              isActive
                ? 'bg-[var(--accent-light)] text-[var(--accent-text)]'
                : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'
            )}
          >
            <span className="leading-none">{t.icon}</span>
          </button>
        );
      })}

      {/* Pen options: inline when draw is active */}
      {tool === 'draw' && (
        <div className="ml-2 flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2 py-1 dark:border-gray-600 dark:bg-gray-700">
          <label className="flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-400">
            <span>颜色</span>
            <input
              type="color"
              value={penColor}
              onChange={(e) => setPenColor(e.target.value)}
              className="h-5 w-7 cursor-pointer border-0 bg-transparent p-0"
              title="画笔颜色"
            />
          </label>
          <label className="flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-400">
            <span>粗细 {penWidth}</span>
            <input
              type="range"
              min={1}
              max={12}
              step={0.5}
              value={penWidth}
              onChange={(e) => setPenWidth(Number(e.target.value))}
              className="w-20"
              title="画笔粗细"
            />
          </label>
        </div>
      )}
    </div>
  );
}
