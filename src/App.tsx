import { useEffect, useState } from 'react';
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
import { EmptyState } from './components/EmptyState';
import { pdfjsLib } from './core/pdf/loader';
import { useDocumentStore } from './store/documentStore';
import { useEditorStore } from './store/editorStore';
import { useTemplateStore } from './store/templateStore';
import { useEngineStore } from './store/engineStore';
import { useHistoryStore } from './store/historyStore';
import { reformatDocument } from './features/text-edit/reformatDocument';
import type { PageMeta } from './core/types';
import { toast } from './utils/toast';

function App() {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [signatureOpen, setSignatureOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Touch all stores so they are constructed on app load.
  useDocumentStore.getState();
  useEditorStore.getState();
  useTemplateStore.getState();
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

  // When template/project load sets doc=null, this effect notices
  // doc===null && store.pdfBytes!==null and auto-reloads the pdfjs document.
  useEffect(() => {
    if (doc !== null) return;
    const bytes = useDocumentStore.getState().pdfBytes;
    if (!bytes) return;
    let cancelled = false;
    (async () => {
      try {
        // Clone the buffer: pdfjs transfers (detaches) it internally.
        const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
        const next = await task.promise;
        if (!cancelled) {
          setDoc(next);
          // eslint-disable-next-line no-console
          console.log(
            '[App] pdfjs document reloaded from %d bytes, %d pages',
            bytes.byteLength,
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
  }, [doc]);

  async function handleOpenFile(file: File) {
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

      // 全文格式化(开关启用时):把全部文本按项目字体重排一遍,
      // 保证整份文档样式统一。异步分页执行,进度条反馈;失败时
      // 保留原字节继续编辑。
      if (useEditorStore.getState().fullReformat) {
        const eng = useEngineStore.getState();
        eng.setDetectionVisible(true);
        eng.setDetectionProgress(0);
        eng.setDetectionLabel('准备中');
        eng.setDetectionTitle('正在全文格式化');
        eng.setEngineStatusMessage(null);
        try {
          const { bytes: newBytes, blocks } = await reformatDocument({
            pdfBytes,
            pages: newPages,
            onProgress: (p, label) => {
              eng.setDetectionProgress(p);
              if (label) eng.setDetectionLabel(label);
            },
          });
          // 全部文本块直接写入 overlay:后续各页无需再检测,
          // 且编辑任一块的"原文"就是格式化后的文本。
          useDocumentStore.getState().setOverlays(blocks);
          setPdfBytes(newBytes);
          // 丢弃原 pdfjs 文档,让 Viewer 从格式化后的字节重新加载。
          setDoc(null);
          toast.success('全文已按项目格式化');
        } catch (err) {
          console.error('[App] 全文格式化失败,保留原 PDF 样式:', err);
          toast.error('全文格式化失败,已保留原样式');
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
          onProjectLoaded={() => {
            // The viewer needs a fresh pdfjs document; clear the existing
            // one so the next render reloads from the current store bytes.
            setDoc(null);
          }}
          onOpenTemplates={() => setTemplatesOpen(true)}
        />
        <Toolbar
          onPickImage={pickImage}
          onOpenSignature={() => setSignatureOpen(true)}
        />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar doc={doc} />
          <main className="flex-1 overflow-hidden">
            <PdfOrEmpty doc={doc} onOpenFile={handleOpenFile} />
          </main>
          <Inspector />
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
        <Toaster />
        <ShortcutsOpener onOpen={() => setShortcutsOpen(true)} />
        <TemplatesOpener onOpen={() => setTemplatesOpen(true)} />
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
