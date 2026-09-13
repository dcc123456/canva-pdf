// ShortcutsModal: lists every keyboard shortcut the app supports. Opened
// by pressing `?` (handled by the App-level keydown listener) or by a
// Toolbar button in the future. The list is grouped by category so the
// user can skim it quickly.
import { useEffect } from 'react';

export interface ShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

interface Entry {
  keys: string[];
  label: string;
}

interface Group {
  title: string;
  entries: Entry[];
}

const GROUPS: Group[] = [
  {
    title: '工具切换 / Tool',
    entries: [
      { keys: ['V'], label: '选择 / Select' },
      { keys: ['H'], label: '高亮 / Highlight' },
      { keys: ['R'], label: '涂黑·密文 / Redact' },
      { keys: ['T'], label: '文字 / Text' },
      { keys: ['I'], label: '图片 / Image' },
      { keys: ['D'], label: '画笔 / Draw' },
      { keys: ['S'], label: '签名 / Signature' },
    ],
  },
  {
    title: '翻页 / Page',
    entries: [
      { keys: ['←', 'PageUp'], label: '上一页 / Previous' },
      { keys: ['→', 'PageDown'], label: '下一页 / Next' },
    ],
  },
  {
    title: '缩放 / Zoom',
    entries: [
      { keys: ['+', '='], label: '放大 / Zoom in' },
      { keys: ['-', '_'], label: '缩小 / Zoom out' },
      { keys: ['Ctrl', '0'], label: '实际大小 / Actual size' },
    ],
  },
  {
    title: '撤销 / Redo',
    entries: [
      { keys: ['Ctrl', 'Z'], label: '撤销 / Undo' },
      { keys: ['Ctrl', 'Shift', 'Z'], label: '重做 / Redo' },
      { keys: ['Ctrl', 'Y'], label: '重做 (备选) / Redo (alt)' },
    ],
  },
  {
    title: '文件 / File',
    entries: [
      { keys: ['Ctrl', 'S'], label: '保存项目 / Save project' },
    ],
  },
  {
    title: '文本 / Text',
    entries: [
      { keys: ['双击'], label: '进入编辑文字 / Edit block (under 选择)' },
      { keys: ['Ctrl', 'Enter'], label: '提交编辑 / Commit edit' },
      { keys: ['Esc'], label: '取消编辑 / Cancel edit' },
    ],
  },
  {
    title: '其他 / Misc',
    entries: [
      { keys: ['Delete', 'Backspace'], label: '删除选中 / Delete selected' },
      { keys: ['Esc'], label: '取消选中 / Clear selection' },
      { keys: ['?'], label: '本面板 / This panel' },
    ],
  },
];

export function ShortcutsModal({ open, onClose }: ShortcutsModalProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[80vh] w-[min(640px,90vw)] flex-col rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div>
            <div className="text-base font-semibold text-gray-800">快捷键</div>
            <div className="text-xs text-gray-500">按 Esc 或点击空白处关闭</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border bg-white px-3 py-1 text-xs hover:bg-gray-50"
          >
            关闭
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            {GROUPS.map((g) => (
              <section key={g.title}>
                <h3 className="mb-2 text-sm font-semibold text-gray-700">{g.title}</h3>
                <ul className="space-y-1.5">
                  {g.entries.map((e) => (
                    <li
                      key={`${g.title}-${e.label}`}
                      className="flex items-center justify-between gap-3 text-xs text-gray-600"
                    >
                      <span>{e.label}</span>
                      <span className="flex items-center gap-1">
                        {e.keys.map((k, i) => (
                          <span key={`${k}-${i}`} className="flex items-center gap-1">
                            <kbd className="rounded border border-gray-300 bg-gray-50 px-1.5 py-0.5 font-mono text-[11px] text-gray-800 shadow-sm">
                              {k}
                            </kbd>
                            {i < e.keys.length - 1 && <span className="text-gray-400">+</span>}
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}