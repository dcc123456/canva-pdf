// Global keyboard shortcuts for the editor.
// - V / H / T / D / R -> switch tools.
// - I / S -> open the image picker / signature dialog. These mirror the
//   Toolbar buttons, which intercept those two tools instead of setting them;
//   the shortcut must do the same or it silently does nothing.
// - Ctrl/Cmd+S -> save the project (.minipdf.json).
// - Delete / Backspace -> remove the currently selected overlay.
// - Esc -> clear selection.
// - Ctrl/Cmd+Z -> undo, Ctrl/Cmd+Shift+Z (or Ctrl+Y) -> redo.
import { useEffect } from 'react';
import { useEditorStore } from '../store/editorStore';
import { useDocumentStore } from '../store/documentStore';
import { useHistoryStore } from '../store/historyStore';
import { saveProject } from '../features/project-io/saveProject';
import { toast } from '../utils/toast';
import type { Tool } from '../core/types';

const KEY_TO_TOOL: Record<string, Tool> = {
  v: 'select',
  h: 'highlight',
  t: 'text',
  d: 'draw',
  r: 'redact',
};

/**
 * Keys that open external UI rather than switching the active tool.
 * Keep in sync with `Toolbar.pickTool`, which intercepts the same two tools.
 */
const KEY_TO_EVENT: Record<string, string> = {
  i: 'canva:open-image-picker',
  s: 'canva:open-signature',
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useKeyboardShortcuts(): void {
  const setTool = useEditorStore((s) => s.setTool);
  const setSelectedOverlayId = useEditorStore((s) => s.setSelectedOverlayId);
  const selectedOverlayId = useEditorStore((s) => s.selectedOverlayId);
  const removeOverlay = useDocumentStore((s) => s.removeOverlay);
  const undo = useHistoryStore((s) => s.undo);
  const redo = useHistoryStore((s) => s.redo);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;

      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      // Undo / redo — handled first so the mod-key branch doesn't fall
      // through to the tool switcher.
      if (mod && !e.altKey && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
        return;
      }
      if (mod && !e.altKey && key === 'y') {
        e.preventDefault();
        redo();
        return;
      }

      // Save project. Must run before the modifier bail-out below, otherwise
      // Ctrl/Cmd+S falls through to the browser's "save page" dialog.
      if (mod && !e.altKey && key === 's') {
        e.preventDefault();
        try {
          const r = saveProject();
          toast.success(`已保存 ${r.filename}`);
        } catch (err) {
          toast.error(
            `保存失败: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return;
      }

      // Tool keys (no modifier).
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Actions that open external UI — mirrors Toolbar.pickTool.
      if (key in KEY_TO_EVENT) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(KEY_TO_EVENT[key]));
        return;
      }

      if (key in KEY_TO_TOOL) {
        e.preventDefault();
        setTool(KEY_TO_TOOL[key]);
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedOverlayId) {
          e.preventDefault();
          removeOverlay(selectedOverlayId);
          setSelectedOverlayId(null);
        }
        return;
      }

      if (e.key === 'Escape') {
        setSelectedOverlayId(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    setTool,
    setSelectedOverlayId,
    selectedOverlayId,
    removeOverlay,
    undo,
    redo,
  ]);
}
