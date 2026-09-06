// LoadingOverlay: full-screen translucent mask with a centered spinner
// and a "loading engine (xx%)" label. Used while the PDF edit engine
// (MuPDF or pdf-lib fallback) is being prepared.
import clsx from 'clsx';

export interface LoadingOverlayProps {
  progress: number; // 0..1
  label?: string;
  visible: boolean;
  error?: string | null;
  /** 弹窗标题(如"正在全文格式化"),缺省为引擎加载标题。 */
  title?: string;
  onDismiss?: () => void;
}

export function LoadingOverlay({
  progress,
  label,
  visible,
  error,
  title,
  onDismiss,
}: LoadingOverlayProps) {
  if (!visible && !error) return null;
  const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
  return (
    <div
      className={clsx(
        'fixed inset-0 z-50 flex items-center justify-center bg-black/40'
      )}
      role="dialog"
      aria-modal="true"
    >
      <div className="w-[320px] rounded-lg border border-gray-200 bg-white p-5 shadow-lg">
        <div className="mb-3 text-sm font-semibold text-gray-800">
          {error ? '引擎加载失败' : (title ?? '正在加载 PDF 引擎')}
        </div>
        {!error && (
          <>
            <div className="mb-1 flex justify-between text-xs text-gray-500">
              <span>{label ?? '初始化'}</span>
              <span>{pct}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded bg-gray-200">
              <div
                className="h-full bg-blue-500 transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          </>
        )}
        {error && (
          <div className="text-xs text-red-600">
            {error}
            <div className="mt-1 text-gray-500">
              已自动切换到兜底引擎,功能可用但可能受限。
            </div>
          </div>
        )}
        {(error || progress >= 1) && onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="mt-4 w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs hover:bg-gray-50"
          >
            {error ? '继续 (使用兜底)' : '完成'}
          </button>
        )}
      </div>
    </div>
  );
}
