import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { v4 as uuidv4 } from 'uuid';
import { Viewer } from './features/viewer/Viewer';
import { Sidebar } from './features/viewer/Sidebar';
import { TopBar } from './components/TopBar';
import { Toolbar } from './components/Toolbar';
import { BottomBar } from './components/BottomBar';
import { Inspector } from './components/Inspector';
import { SignatureDialog } from './components/SignatureDialog';
import { TemplateGallery } from './features/templates/TemplateGallery';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Toaster } from './components/Toaster';
import { ShortcutsModal } from './components/ShortcutsModal';
import { ReformatPromptDialog } from './components/ReformatPromptDialog';
import { EmptyState } from './components/EmptyState';
import { pdfjsLib } from './core/pdf/loader';
import { useDocumentStore } from './store/documentStore';
import { useEditorStore } from './store/editorStore';
import { useEngineStore } from './store/engineStore';
import { useHistoryStore } from './store/historyStore';
import { detectAllTextBlocks } from './features/text-edit/reformatDocument';
import type { PageMeta } from './core/types';
import { toast } from './utils/toast';

function App() {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [signatureOpen, setSignatureOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // 选中文件后先挂起,等用户在 ReformatPromptDialog 里明确选择
  // 「全文格式化 / 保持原样」再真正打开。
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const sidebarCollapsed = useEditorStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useEditorStore((s) => s.setSidebarCollapsed);
  const inspectorCollapsed = useEditorStore((s) => s.inspectorCollapsed);
  const setInspectorCollapsed = useEditorStore((s) => s.setInspectorCollapsed);
  // The store's bytes are the single source of truth for what the Viewer shows;
  // the effect below rebinds pdfjs whenever they change (see its comment).
  const pdfBytes = useDocumentStore((s) => s.pdfBytes);

  // Touch all stores so they are constructed on app load.
  useDocumentStore.getState();
  useEditorStore.getState();
  useEngineStore.getState();
  useHistoryStore.getState();

  // Global "?" opens the shortcuts panel.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        e.preventDefault();
        setShortcutsOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 选中元素时自动展开属性面板(Canva 行为:选中才出现属性 UI)。
  // 放在 App(始终挂载):Inspector 折叠时被条件渲染卸载,自己无法响应。
  const selectedOverlayId = useEditorStore((s) => s.selectedOverlayId);
  const prevSelectedRef = useRef(selectedOverlayId);
  useEffect(() => {
    if (selectedOverlayId && selectedOverlayId !== prevSelectedRef.current) {
      setInspectorCollapsed(false);
    }
    prevSelectedRef.current = selectedOverlayId;
  }, [selectedOverlayId, setInspectorCollapsed]);

  // When template/project load sets doc=null, this effect notices
  // doc===null && store.pdfBytes!==null and auto-reloads the pdfjs document.
  //
  // It also keys off `pdfBytes`, because the null-transition trick alone is not
  // enough: applying a template while NO pdf is open calls `setDoc(null)` on a
  // state that is already `null`, React bails out, and the effect never runs —
  // so the template silently rendered as a blank page. Watching the bytes makes
  // the Viewer follow the store regardless of how the bytes got there.
  useEffect(() => {
    if (doc !== null) return;
    if (!pdfBytes) return;
    let cancelled = false;
    (async () => {
      try {
        // Clone the buffer: pdfjs transfers (detaches) it internally.
        const task = pdfjsLib.getDocument({ data: new Uint8Array(pdfBytes) });
        const next = await task.promise;
        if (!cancelled) {
          setDoc(next);
          // eslint-disable-next-line no-console
          console.log(
            '[App] pdfjs document reloaded from %d bytes, %d pages',
            pdfBytes.byteLength,
            next.numPages
          );
        }
      } catch (err) {
        console.error('[App] reload pdfjs document after bytes change failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, pdfBytes]);

  /**
   * 用户选好文件后先不加载,弹窗询问是否全文格式化 —— 这是针对**这一份
   * 文档**的一次性决定,而不是编辑器全局设置(见 ReformatPromptDialog)。
   */
  function handleOpenFile(file: File) {
    setPendingFile(file);
  }

  /**
   * 真正加载 PDF。`reformat` 由 ReformatPromptDialog 的选择传入。
   */
  async function loadPdf(file: File, reformat: boolean) {
    try {
      const buffer = await file.arrayBuffer();
      const sharedView = new Uint8Array(buffer);
      const pdfBytes = new Uint8Array(sharedView);
      const document = await loadDocumentWithProgress(sharedView, () => {});
      const newPages: PageMeta[] = [];
      for (let i = 1; i <= document.numPages; i += 1) {
        const p = await document.getPage(i);
        const viewport = p.getViewport({ scale: 1 });
        newPages.push({
          id: uuidv4(),
          index: i - 1,
          rotation: 0,
          width: viewport.width,
          height: viewport.height,
        });
        p.cleanup();
      }
      setDoc(document);
      const setPages = useDocumentStore.getState().setPages;
      const setPdfBytes = useDocumentStore.getState().setPdfBytes;
      const setPdfName = useDocumentStore.getState().setPdfName;
      const setTotalPages = useEditorStore.getState().setTotalPages;
      const setCurrentPage = useEditorStore.getState().setCurrentPage;
      setPages(newPages);
      setPdfBytes(pdfBytes);
      setPdfName(file.name);
      setTotalPages(document.numPages);
      setCurrentPage(0);
      toast.success(`已打开 ${file.name}`);

      // 全文格式化(用户选择时):把全部页面的文本块检测出来,作为可编辑
      // overlay 写入。**非破坏性** —— 原始 PDF 字节不动,Viewer 继续显示
      // 原文档(外观零改变),双击任意文字块即可进入编辑;导出时只有被改
      // 过的块才会按项目字体重画,未改动的块保持原 PDF 外观。
      // (早期破坏性实现会整份文档按项目字体重排,对任意版式都会丢失
      // fidelity,表现为"乱码 + 格式乱",已废弃。)
      if (reformat) {
        const eng = useEngineStore.getState();
        eng.setDetectionVisible(true);
        eng.setDetectionProgress(0);
        eng.setDetectionLabel('准备中');
        eng.setDetectionTitle('正在检测全文文本');
        eng.setEngineStatusMessage(null);
        try {
          const blocks = await detectAllTextBlocks({
            pdfBytes,
            pages: newPages,
            onProgress: (p, label) => {
              eng.setDetectionProgress(p);
              if (label) eng.setDetectionLabel(label);
            },
          });
          // 全部文本块写入 overlay:后续双击即可编辑;未编辑的块导出时
          // 不重画(原始 PDF 外观完全保留)。
          useDocumentStore.getState().setOverlays(blocks);
          toast.success(`全文文本已可编辑(${blocks.length} 块)`);
        } catch (err) {
          console.error('[App] 全文检测失败,保留原 PDF:', err);
          toast.error('全文检测失败,已保留原样式');
        } finally {
          eng.setDetectionProgress(1);
          eng.setDetectionTitle(null);
          window.setTimeout(() => eng.setDetectionVisible(false), 400);
        }
      }
    } catch (err) {
      console.error(err);
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`打开失败: ${msg}`);
    }
  }

  // Toolbar's "image" button asks the CanvasInteractionLayer to open its
  // hidden file input via this window event.
  function pickImage() {
    window.dispatchEvent(new CustomEvent('canva:open-image-picker'));
  }

  return (
    <ErrorBoundary>
      {/* Canva-style partitioned layout: TopBar / Toolbar / [Sidebar | Viewer | Inspector] / BottomBar */}
      <div className="flex h-screen w-screen flex-col bg-gray-100 text-gray-900 dark:bg-gray-900 dark:text-gray-100">
        <TopBar
          onOpenFile={handleOpenFile}
          onOpenTemplates={() => setTemplatesOpen(true)}
        />
        <Toolbar
          onPickImage={pickImage}
          onOpenSignature={() => setSignatureOpen(true)}
        />
        <div className="flex flex-1 overflow-hidden">
          {sidebarCollapsed ? (
            <button
              type="button"
              onClick={() => setSidebarCollapsed(false)}
              title="显示页面缩略图"
              className="flex w-5 shrink-0 items-center justify-center border-r bg-gray-50 text-xs text-gray-500 hover:bg-gray-200 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
            >
              ⟩
            </button>
          ) : (
            <Sidebar doc={doc} />
          )}
          <main className="flex-1 overflow-hidden">
            <PdfOrEmpty doc={doc} onOpenFile={handleOpenFile} />
          </main>
          {inspectorCollapsed ? (
            <button
              type="button"
              onClick={() => setInspectorCollapsed(false)}
              title="显示属性面板"
              className="flex w-5 shrink-0 items-center justify-center border-l bg-gray-50 text-xs text-gray-500 hover:bg-gray-200 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
            >
              ⟨
            </button>
          ) : (
            <Inspector />
          )}
        </div>
        <BottomBar />
        {/* Modals & overlays */}
        <SignatureDialog
          open={signatureOpen}
          onClose={() => setSignatureOpen(false)}
        />
        <TemplateGallery
          open={templatesOpen}
          onClose={() => setTemplatesOpen(false)}
          onApplied={(r) => {
            toast.success(`已应用模板: ${r.name}`);
            setDoc(null);
          }}
        />
        <ShortcutsModal
          open={shortcutsOpen}
          onClose={() => setShortcutsOpen(false)}
        />
        {/* 打开 PDF 时的一次性确认:全文格式化 or 保持原样 */}
        <ReformatPromptDialog
          open={pendingFile !== null}
          fileName={pendingFile?.name ?? ''}
          onChoose={(reformat) => {
            const f = pendingFile;
            setPendingFile(null);
            if (f) void loadPdf(f, reformat);
          }}
          onCancel={() => setPendingFile(null)}
        />
        <Toaster />
        <ShortcutsOpener onOpen={() => setShortcutsOpen(true)} />
        <TemplatesOpener onOpen={() => setTemplatesOpen(true)} />
        <SignatureOpener onOpen={() => setSignatureOpen(true)} />
        <DocumentReplacedListener
          onReplace={() => {
            setDoc(null);
          }}
        />
      </div>
    </ErrorBoundary>
  );
}

/**
 * Wrap the Viewer with an empty-state component: when no PDF has been
 * opened yet (or after a reset), the user sees three CTAs (template /
 * open / new blank doc).
 */
function PdfOrEmpty({
  doc,
  onOpenFile,
}: {
  doc: PDFDocumentProxy | null;
  onOpenFile: (file: File) => void;
}) {
  const pdfBytes = useDocumentStore((s) => s.pdfBytes);
  const pages = useDocumentStore((s) => s.pages);
  const isEmpty = pdfBytes === null && pages.length === 0;
  if (isEmpty) {
    return (
      <EmptyState
        onOpenFile={onOpenFile}
        onNewBlank={() => {
          // Set a single blank A4 page without bytes - Viewer will draw the
          // blank placeholder. This is enough to start typing / drawing.
          useDocumentStore.getState().setPages([
            {
              id: uuidv4(),
              index: 0,
              rotation: 0,
              width: 595,
              height: 842,
              isBlank: true,
            },
          ]);
          useEditorStore.getState().setTotalPages(1);
          useEditorStore.getState().setCurrentPage(0);
        }}
        onPickTemplate={() => {
          window.dispatchEvent(new CustomEvent('canva:open-templates'));
        }}
      />
    );
  }
  return <Viewer doc={doc} />;
}

/**
 * Listen for the global "?" keypress and tell the parent to open the modal.
 */
function ShortcutsOpener({ onOpen }: { onOpen: () => void }) {
  useEffect(() => {
    const handler = () => onOpen();
    window.addEventListener('canva:open-shortcuts', handler);
    return () => window.removeEventListener('canva:open-shortcuts', handler);
  }, [onOpen]);
  return null;
}

/**
 * Listen for the "open templates" event dispatched by EmptyState's
 * "从模板开始" button and open the TemplateGallery.
 */
function TemplatesOpener({ onOpen }: { onOpen: () => void }) {
  useEffect(() => {
    const handler = () => onOpen();
    window.addEventListener('canva:open-templates', handler);
    return () => window.removeEventListener('canva:open-templates', handler);
  }, [onOpen]);
  return null;
}

/**
 * Listen for the `S` shortcut (and any future programmatic trigger) and open
 * the signature dialog. The `I` shortcut has no equivalent here — it dispatches
 * `canva:open-image-picker`, which CanvasInteractionLayer already handles.
 */
function SignatureOpener({ onOpen }: { onOpen: () => void }) {
  useEffect(() => {
    const handler = () => onOpen();
    window.addEventListener('canva:open-signature', handler);
    return () => window.removeEventListener('canva:open-signature', handler);
  }, [onOpen]);
  return null;
}

/**
 * Listen for the document-replaced event from the template gallery and
 * clear the existing pdfjs doc so the Viewer reloads from the store.
 */
function DocumentReplacedListener({ onReplace }: { onReplace: () => void }) {
  useEffect(() => {
    const handler = () => onReplace();
    window.addEventListener('canva:document-replaced', handler);
    return () => window.removeEventListener('canva:document-replaced', handler);
  }, [onReplace]);
  return null;
}

/**
 * Wrap `loadDocument` with an `onProgress` callback by hooking into the
 * pdfjs loading task. pdfjs's `getDocument` returns a task with an
 * `onProgress` method we can attach a listener to.
 */
async function loadDocumentWithProgress(
  bytes: Uint8Array,
  onProgress: (p: { loaded: number; total: number }) => void
): Promise<PDFDocumentProxy> {
  const task = pdfjsLib.getDocument({ data: bytes });
  task.onProgress = (loaded: number, total: number) => {
    onProgress({ loaded, total });
  };
  return task.promise;
}

export default App;
