// ReformatPromptDialog: 打开 PDF 时询问是否「全文格式化」。
//
// 为什么是弹窗,而不是 TopBar 上的常驻开关:
// 全文格式化会检测整份文档的文本块(耗时与文档页数相关),它是**针对某一份
// 文档的一次性决定**,不是编辑器的全局模式。
// 常驻 checkbox 把"一次性决定"伪装成"持久设置":用户既看不出它会影响
// 什么,也很容易在不知情的情况下一直开着它。
//
// 因此改为:每次打开 PDF 时明确询问一次,并写清代价与可逆性。
//
// 注意:现在全文格式化是**非破坏性**的 —— 只把检测到的文本块写成可编辑
// overlay,原始 PDF 字节不动,外观完全保留。双击任意文字块即可编辑;导出
// 时只有被改过的块才重画,未改动的块保持原 PDF 外观。
import { useEffect } from 'react';

export interface ReformatPromptDialogProps {
  open: boolean;
  /** 即将打开的 PDF 文件名,让用户确认自己选对了文件。 */
  fileName: string;
  onChoose: (reformat: boolean) => void;
  onCancel: () => void;
}

export function ReformatPromptDialog({
  open,
  fileName,
  onChoose,
  onCancel,
}: ReformatPromptDialogProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="全文格式化确认"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-[min(520px,92vw)] rounded-lg bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-800">
              是否全文格式化?
            </h2>
            <p className="mt-0.5 truncate text-xs text-gray-500" title={fileName}>
              {fileName}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="shrink-0 rounded px-2 py-0.5 text-gray-500 hover:bg-gray-100"
            aria-label="取消"
          >
            ✕
          </button>
        </div>

        <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-xs leading-relaxed text-gray-600">
          <p>
            <strong className="text-gray-800">全文格式化</strong>
            :检测整份文档的全部文字,把它们变成可直接双击编辑的文本块。
            原始 PDF 外观完全保留(不重排、不删字);只有你实际改动的块在
            导出时才会按项目字体重画。代价是打开时多花一些时间(与文档
            页数相关)。
          </p>
          <p className="mt-2">
            <strong className="text-gray-800">保持原样</strong>
            :保留 PDF 原有字体与排版,打开更快。仍可正常高亮、涂黑、插入
            文字/图片,以及双击修改文本块。
          </p>
          <p className="mt-2 text-gray-500">
            这只是本次打开的选择,不会保存为默认设置 —— 下次打开仍会再问一次。
          </p>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-600 hover:bg-gray-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onChoose(false)}
            className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50"
          >
            保持原样
          </button>
          <button
            type="button"
            onClick={() => onChoose(true)}
            className="rounded bg-[var(--accent)] px-3 py-1 text-sm text-white transition hover:bg-[var(--accent-hover)]"
          >
            全文格式化
          </button>
        </div>
      </div>
    </div>
  );
}
