// TemplateGallery: modal panel triggered by the Toolbar's "📚 模板" button.
//
// Two sections:
//   1. Built-in templates (synchronous metadata list from
//      `BUILTIN_TEMPLATES`).
//   2. User templates (from `loadUserTemplates`, persisted in localStorage).
//
// Each card shows a cover: for built-ins we render page 1 of the generated
// PDF with pdfjs on first open (and cache it for the session); for user
// templates we use the PNG stored alongside the template. If a cover cannot
// be produced we fall back to a first-letter placeholder.
import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { v4 as uuidv4 } from 'uuid';
import {
  BUILTIN_TEMPLATES,
  applyBuiltinTemplate,
  generateBuiltinPdf,
  getBuiltinTemplate,
} from '../../core/templates/registry';
import {
  addUserTemplate,
  loadUserTemplates,
  removeUserTemplate,
} from '../../core/templates/user';
import { renderPdfThumbnail } from '../../core/templates/thumbnail';
import { fromBase64 } from '../../core/project/serialize';
import { loadDocument } from '../../core/pdf/loader';
import { useDocumentStore } from '../../store/documentStore';
import { useEditorStore } from '../../store/editorStore';
import { useHistoryStore } from '../../store/historyStore';
import type { Template } from '../../core/types';

export interface TemplateGalleryProps {
  open: boolean;
  onClose: () => void;
  /** Called after a template is successfully applied. */
  onApplied?: (result: { templateId: string; name: string }) => void;
}

function thumbnailLabel(name: string): string {
  // First non-space character, fall back to "?" if no letters.
  for (const ch of name) {
    if (ch.trim()) return ch.toUpperCase();
  }
  return '?';
}

/**
 * 内置模板的封面缓存。内置模板的 PDF 由 pdf-lib 确定性生成,同一份
 * session 里内容不会变,所以每个模板只渲染一次。
 */
const builtinCoverCache = new Map<string, string>();

/** 打开模板库时,按需为还没有封面的内置模板渲染封面。 */
function useBuiltinCovers(open: boolean): Record<string, string> {
  const [covers, setCovers] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const [id, url] of builtinCoverCache) initial[id] = url;
    return initial;
  });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      for (const tpl of BUILTIN_TEMPLATES) {
        if (builtinCoverCache.has(tpl.id)) continue;
        const bytes = await generateBuiltinPdf(tpl.id);
        const url = await renderPdfThumbnail(bytes);
        if (cancelled) return;
        if (url) {
          builtinCoverCache.set(tpl.id, url);
          setCovers((prev) => ({ ...prev, [tpl.id]: url }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  return covers;
}

export function TemplateGallery({ open, onClose, onApplied }: TemplateGalleryProps) {
  const [userTemplates, setUserTemplates] = useState<Template[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const builtinCovers = useBuiltinCovers(open);

  // Refresh user templates when the gallery opens.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUserTemplates(loadUserTemplates());
    setError(null);
  }, [open]);

  // Close context menu on any global click / Escape.
  useEffect(() => {
    if (!menu) return;
    function close() {
      setMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenu(null);
    }
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const handleApply = useCallback(
    async (id: string) => {
      setBusyId(id);
      setError(null);
      try {
        const result = await applyBuiltinTemplate(id);
        const meta = getBuiltinTemplate(id);
        onApplied?.({ templateId: result.templateId, name: meta?.name ?? id });
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [onApplied, onClose]
  );

  const handleApplyUser = useCallback(
    async (tpl: Template) => {
      setBusyId(tpl.id);
      setError(null);
      try {
        const bytes = fromBase64(tpl.pdf);
        const doc = await loadDocument(bytes);
        const newPages = [];
        for (let i = 1; i <= doc.numPages; i += 1) {
          const p = await doc.getPage(i);
          const vp = p.getViewport({ scale: 1 });
          newPages.push({
            id: uuidv4(),
            index: i - 1,
            rotation: 0 as const,
            width: vp.width,
            height: vp.height,
          });
          p.cleanup();
        }

        useDocumentStore.getState().setPdfBytes(bytes);
        useDocumentStore.getState().setPdfName(tpl.name);
        useDocumentStore.getState().setPages(newPages);
        useDocumentStore.getState().setOverlays([]);
        useEditorStore.getState().setTotalPages(newPages.length);
        useEditorStore.getState().setCurrentPage(0);
        useHistoryStore.getState().clear();
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('canva:document-replaced'));
        }
        onApplied?.({ templateId: tpl.id, name: tpl.name });
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [onApplied, onClose]
  );

  const handleSaveAsUserTemplate = useCallback(async () => {
    const bytes = useDocumentStore.getState().pdfBytes;
    if (!bytes) {
      setError('请先打开 PDF 后再保存为模板');
      return;
    }
    const name = window.prompt('为当前文档命名(将作为模板)', '我的模板') ?? '';
    if (!name.trim()) return;
    setBusyId('__save__');
    try {
      const cloned = bytes.slice();
      const tpl = await addUserTemplate(name.trim(), cloned);
      setUserTemplates(loadUserTemplates());
      onApplied?.({ templateId: tpl.id, name: tpl.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }, [onApplied]);

  const handleDeleteUser = useCallback((id: string) => {
    removeUserTemplate(id);
    setUserTemplates(loadUserTemplates());
    setMenu(null);
  }, []);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-[80vh] w-[min(960px,90vw)] flex-col rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div>
            <div className="text-base font-semibold text-gray-800">模板库</div>
            <div className="text-xs text-gray-500">选择一个模板快速开始</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSaveAsUserTemplate}
              disabled={busyId === '__save__'}
              className="rounded border bg-white px-3 py-1 text-xs hover:bg-gray-50 disabled:opacity-50"
            >
              {busyId === '__save__' ? '保存中…' : '保存当前为模板'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded border bg-white px-3 py-1 text-xs hover:bg-gray-50"
            >
              关闭
            </button>
          </div>
        </div>

        {error && (
          <div className="mx-5 mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <Section title="内置模板" hint="由 pdf-lib 在内存中生成">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {BUILTIN_TEMPLATES.map((tpl) => (
                <TemplateCard
                  key={tpl.id}
                  title={tpl.name}
                  thumbnailText={thumbnailLabel(tpl.name)}
                  thumbnailSrc={builtinCovers[tpl.id]}
                  busy={busyId === tpl.id}
                  onApply={() => handleApply(tpl.id)}
                  variant="builtin"
                />
              ))}
            </div>
          </Section>

          <Section title="我的模板" hint={`${userTemplates.length} 个`}>
            {userTemplates.length === 0 ? (
              <div className="rounded border border-dashed border-gray-300 bg-gray-50 px-4 py-8 text-center text-xs text-gray-500">
                尚未保存任何模板。打开一个 PDF 后点击右上角“保存当前为模板”即可创建。
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {userTemplates.map((tpl) => (
                  <TemplateCard
                    key={tpl.id}
                    title={tpl.name}
                    thumbnailText={thumbnailLabel(tpl.name)}
                    thumbnailSrc={tpl.thumbnail}
                    busy={busyId === tpl.id}
                    onApply={() => handleApplyUser(tpl)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ id: tpl.id, x: e.clientX, y: e.clientY });
                    }}
                    variant="user"
                  />
                ))}
              </div>
            )}
          </Section>
        </div>

        {menu && (
          <div
            className="fixed z-50 w-32 rounded border bg-white py-1 text-xs shadow"
            style={{ left: menu.x, top: menu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => handleDeleteUser(menu.id)}
              className="block w-full px-3 py-1 text-left text-red-600 hover:bg-red-50"
            >
              删除
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
        {hint && <span className="text-xs text-gray-400">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

interface TemplateCardProps {
  title: string;
  thumbnailText: string;
  thumbnailSrc?: string;
  busy: boolean;
  onApply: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  variant: 'builtin' | 'user';
}

function TemplateCard({
  title,
  thumbnailText,
  thumbnailSrc,
  busy,
  onApply,
  onContextMenu,
  variant,
}: TemplateCardProps) {
  return (
    <div
      onContextMenu={onContextMenu}
      className={clsx(
        'group flex flex-col gap-2 rounded border bg-white p-2 shadow-sm transition',
        variant === 'user' ? 'hover:border-blue-300' : 'hover:border-gray-400'
      )}
    >
      <div className="flex h-32 items-center justify-center overflow-hidden rounded bg-gray-100">
        {thumbnailSrc ? (
          <img
            src={thumbnailSrc}
            alt={title}
            className="max-h-full max-w-full object-contain"
            draggable={false}
          />
        ) : (
          <span className="text-3xl font-bold text-gray-400">{thumbnailText}</span>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="truncate text-xs text-gray-700" title={title}>
          {title}
        </div>
        <button
          type="button"
          onClick={onApply}
          disabled={busy}
          className="shrink-0 rounded bg-blue-600 px-2 py-0.5 text-xs text-white enabled:hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? '应用…' : '应用'}
        </button>
      </div>
    </div>
  );
}