// TopBar: top-level bar with logo, file operations, undo/redo, accent picker,
// and theme toggle. Extracted from the original Toolbar.tsx.
//
// Layout: [Logo | 模板]  [打开PDF | 保存 | 打开项目 | 导出PDF]  [↶ ↷ | 5色块 | ☀/🌙 | ?]
//
// Height: h-11 (44px). Uses --accent CSS variables for the export button.
import { useState } from 'react';
import { useHistoryStore } from '../store/historyStore';
import { useEngineStore } from '../store/engineStore';
import { useEditorStore } from '../store/editorStore';
import { exportPdf } from '../features/export/exportPdf';
import { saveProject } from '../features/project-io/saveProject';
import { loadProject } from '../features/project-io/loadProject';
import { LoadingOverlay } from './LoadingOverlay';
import { toast } from '../utils/toast';
import {
  applyTheme,
  getStoredTheme,
  setStoredTheme,
  applyAccent,
  getStoredAccent,
  setStoredAccent,
  ACCENT_COLORS,
  ACCENT_COLOR_KEYS,
  type Theme,
  type AccentColor,
} from '../utils/theme';

export interface TopBarProps {
  onOpenFile: (file: File) => void;
  onProjectLoaded?: () => void;
  onOpenTemplates?: () => void;
}

const ACCENT_COLOR_LABELS: Record<AccentColor, string> = {
  blue: '蓝色',
  purple: '紫色',
  green: '绿色',
  rose: '玫瑰',
  amber: '琥珀',
};

export function TopBar({ onOpenFile, onProjectLoaded, onOpenTemplates }: TopBarProps) {
  const pastLen = useHistoryStore((s) => s.past.length);
  const futureLen = useHistoryStore((s) => s.future.length);
  const undo = useHistoryStore((s) => s.undo);
  const redo = useHistoryStore((s) => s.redo);

  const mupdfLoading = useEngineStore((s) => s.mupdfLoading);
  const mupdfError = useEngineStore((s) => s.mupdfError);
  const detectionVisible = useEngineStore((s) => s.detectionVisible);
  const detectionProgress = useEngineStore((s) => s.detectionProgress);
  const detectionLabel = useEngineStore((s) => s.detectionLabel);
  const detectionTitle = useEngineStore((s) => s.detectionTitle);
  const engineStatusMessage = useEngineStore((s) => s.engineStatusMessage);

  const fullReformat = useEditorStore((s) => s.fullReformat);
  const setFullReformat = useEditorStore((s) => s.setFullReformat);

  const [busyPhase, setBusyPhase] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme());
  const [accent, setAccent] = useState<AccentColor>(() => getStoredAccent());

  /* --- file operations (moved from Toolbar.tsx) --- */

  async function handleExport() {
    setStatusMsg(null);
    setBusyPhase('load');
    try {
      const result = await exportPdf((p) => setBusyPhase(p.phase));
      setStatusMsg(`已导出 ${result.filename} (${result.bytes} B)`);
      toast.success('PDF 已导出');
    } catch (err) {
      console.error(err);
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMsg(`导出失败: ${msg}`);
      toast.error(`导出失败: ${msg}`);
    } finally {
      setBusyPhase(null);
      window.setTimeout(() => setStatusMsg(null), 4000);
    }
  }

  function handleSaveProject() {
    try {
      const result = saveProject();
      setStatusMsg(`已保存 ${result.filename} (${result.bytes} B)`);
    } catch (err) {
      setStatusMsg(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      window.setTimeout(() => setStatusMsg(null), 4000);
    }
  }

  async function handleOpenProject() {
    try {
      await loadProject({ onPdfJsDoc: () => onProjectLoaded?.() });
      setStatusMsg('项目已加载');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/cancel/i.test(msg)) {
        setStatusMsg(`打开失败: ${msg}`);
      }
    } finally {
      window.setTimeout(() => setStatusMsg(null), 4000);
    }
  }

  /* --- theme + accent --- */

  function handleThemeToggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
    setStoredTheme(next);
  }

  function handleAccentChange(color: AccentColor) {
    setAccent(color);
    applyAccent(color);
    setStoredAccent(color);
  }

  /* --- LoadingOverlay: shown during engine init OR text/form detection --- */
  const showOverlay = detectionVisible || mupdfLoading;
  const overlayProgress = mupdfLoading ? 0 : detectionProgress;
  const overlayLabel = mupdfLoading ? '初始化引擎' : detectionLabel;

  return (
    <header className="flex h-11 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-3 text-sm dark:border-gray-700 dark:bg-gray-800">
      {/* Left: logo + templates */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">
          Mini PDF 编辑器
        </span>
        {onOpenTemplates && (
          <button
            type="button"
            onClick={onOpenTemplates}
            title="选择模板快速开始 (?)"
            data-toolbar-action="templates"
            className="rounded border border-gray-200 bg-white px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
          >
            模板
          </button>
        )}

        {/* 全文格式化开关:打开 PDF 时把全部文本按项目字体重排,全文样式统一 */}
        <label
          title="打开 PDF 时自动把全文按本项目支持的字体重排一遍,保证整份文档样式统一(编辑前后不再混排两种样式)。耗时与文档大小相关,处理期间会显示进度。"
          className="flex cursor-pointer items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
        >
          <input
            type="checkbox"
            checked={fullReformat}
            onChange={(e) => setFullReformat(e.target.checked)}
            className="h-3 w-3"
          />
          全文格式化
        </label>
      </div>

      {/* Center: file operations */}
      <div className="flex items-center gap-1.5">
        {/* Open PDF: label + hidden file input */}
        <label className="flex cursor-pointer items-center rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600">
          打开 PDF
          <input
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onOpenFile(f);
              e.target.value = '';
            }}
          />
        </label>

        <button
          type="button"
          onClick={handleSaveProject}
          title="保存项目 (.minipdf.json)"
          className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
        >
          保存
        </button>

        <button
          type="button"
          onClick={handleOpenProject}
          title="打开项目 (.minipdf.json)"
          className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
        >
          打开项目
        </button>

        {/* Export: accent-colored primary action button */}
        <button
          type="button"
          onClick={handleExport}
          disabled={busyPhase !== null}
          title="导出 PDF"
          className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-xs text-white transition hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busyPhase ? `导出中… (${busyPhase})` : '导出 PDF'}
        </button>
      </div>

      {/* Right: undo/redo + accent picker + theme toggle + shortcuts */}
      <div className="flex items-center gap-2">
        {/* Status messages */}
        {(statusMsg || engineStatusMessage) && (
          <span className="mr-1 max-w-[200px] truncate text-xs text-gray-500 dark:text-gray-400">
            {statusMsg ?? engineStatusMessage}
          </span>
        )}

        {/* Undo / Redo */}
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            title="撤销 (Ctrl/Cmd+Z)"
            onClick={undo}
            disabled={pastLen === 0}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-700 enabled:hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
          >
            ↶
          </button>
          <button
            type="button"
            title="重做 (Ctrl/Cmd+Shift+Z)"
            onClick={redo}
            disabled={futureLen === 0}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-700 enabled:hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
          >
            ↷
          </button>
        </div>

        <div className="h-5 w-px bg-gray-200 dark:bg-gray-600" />

        {/* Accent color picker: dropdown */}
        <select
          value={accent}
          onChange={(e) => handleAccentChange(e.target.value as AccentColor)}
          title="主题色"
          className="h-7 rounded-md border border-gray-200 bg-white px-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
        >
          {ACCENT_COLOR_KEYS.map((color) => (
            <option key={color} value={color}>
              {ACCENT_COLOR_LABELS[color]}
            </option>
          ))}
        </select>
        {/* Current accent color swatch */}
        <span
          aria-hidden
          className="h-3.5 w-3.5 rounded-full border border-gray-300"
          style={{ backgroundColor: ACCENT_COLORS[accent].main }}
        />

        <div className="h-5 w-px bg-gray-200 dark:bg-gray-600" />

        {/* Theme toggle */}
        <button
          type="button"
          onClick={handleThemeToggle}
          title="切换暗色 / 亮色主题"
          className="flex h-7 w-7 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
        >
          {theme === 'dark' ? '☀' : '🌙'}
        </button>

        {/* Shortcuts help */}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('canva:open-shortcuts'))}
          title="查看快捷键 (?)"
          className="flex h-7 w-7 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
        >
          ?
        </button>
      </div>

      <LoadingOverlay
        visible={showOverlay}
        progress={overlayProgress}
        label={overlayLabel}
        title={detectionTitle ?? undefined}
        error={mupdfError}
        onDismiss={() => {
          useEngineStore.getState().setDetectionVisible(false);
          useEngineStore.getState().setMupdfError(null);
        }}
      />
    </header>
  );
}
