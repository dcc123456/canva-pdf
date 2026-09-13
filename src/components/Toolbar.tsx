// Toolbar: horizontal tool palette rendered below the TopBar.
// Replaces the vertical ToolSidebar (which lived on the left edge).
//
// R3 — 按任务分组。原先是 9 个纯图标按钮平铺,仅靠 `title` 提示,新用户
// 无法区分 `↖`(选择)/ `✎`(编辑文字)/ `T`(文字)三者 —— 这正是验证计划
// A8 记录的问题;工具语义重叠则是 B9。改成任务分组 + **可见文字标签**
// 后,两个问题一并解决,同时把「涂黑」这个破坏性工具归入「注释」组而不是
// 与选择混在一起。
//
// 文本编辑不再是独立工具:在「选择」下双击文本块即可直接改字
// (见 features/text-edit/TextBlockEditLayer.tsx)。
//
// 工具组:
//   编辑 —— 选择
//   注释 —— 高亮 / 涂黑 / 画笔 / 签名
//   插入 —— 文字 / 图片
//
// 画笔的颜色/粗细选项、涂黑的警示条在对应工具激活时内联展开。
import clsx from 'clsx';
import { useEditorStore } from '../store/editorStore';
import { usePenStore } from '../store/penStore';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import type { Tool } from '../core/types';
import { useAutoDetectTextBlocks } from '../features/text-edit/useAutoDetectTextBlocks';

interface ToolDef {
  tool: Tool;
  label: string;
  shortcut: string;
  icon: string; // glyph rendered as the button's visual icon
}

interface ToolGroup {
  id: string;
  label: string;
  tools: ToolDef[];
}

const GROUPS: ToolGroup[] = [
  {
    id: 'edit',
    label: '编辑',
    tools: [{ tool: 'select', label: '选择', shortcut: 'V', icon: '↖' }],
  },
  {
    id: 'annotate',
    label: '注释',
    tools: [
      { tool: 'highlight', label: '高亮', shortcut: 'H', icon: '◑' },
      { tool: 'redact', label: '涂黑', shortcut: 'R', icon: '■' },
      { tool: 'draw', label: '画笔', shortcut: 'D', icon: '✏' },
      { tool: 'signature', label: '签名', shortcut: 'S', icon: '✒' },
    ],
  },
  {
    id: 'insert',
    label: '插入',
    tools: [
      { tool: 'text', label: '文字', shortcut: 'T', icon: 'T' },
      { tool: 'image', label: '图片', shortcut: 'I', icon: '▦' },
    ],
  },
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

  // Auto-run text-block detection when `select` is active and the current
  // page hasn't been detected yet (double-click enters text editing).
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
    setTool(t);
  }

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-gray-200 bg-white px-2 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
      {GROUPS.map((group, gi) => (
        <div key={group.id} className="flex shrink-0 items-center gap-1">
          {gi > 0 && (
            <span
              aria-hidden
              className="mx-1 h-5 w-px shrink-0 bg-gray-200 dark:bg-gray-600"
            />
          )}
          <span className="mr-0.5 shrink-0 text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
            {group.label}
          </span>
          {group.tools.map((t) => {
            const isActive = tool === t.tool;
            return (
              <button
                key={t.tool}
                type="button"
                title={`${t.label} (${t.shortcut})`}
                onClick={() => pickTool(t.tool)}
                aria-label={t.label}
                aria-pressed={isActive}
                className={clsx(
                  'flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 transition',
                  isActive
                    ? 'bg-[var(--accent-light)] text-[var(--accent-text)]'
                    : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'
                )}
              >
                <span className="text-base leading-none">{t.icon}</span>
                <span className="whitespace-nowrap leading-none">{t.label}</span>
              </button>
            );
          })}
        </div>
      ))}

      {/* 涂黑警示:这是应用内唯一的破坏性工具,激活时必须显式提示。 */}
      {tool === 'redact' && (
        <div className="ml-2 flex shrink-0 items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
          <span>
            拖拽框选要遮盖的区域。导出时会<strong>从文件中删除</strong>框内文字
            与图片内容,不可撤销。
          </span>
        </div>
      )}

      {/* Pen options: inline when draw is active */}
      {tool === 'draw' && (
        <div className="ml-2 flex shrink-0 items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2 py-1 dark:border-gray-600 dark:bg-gray-700">
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
