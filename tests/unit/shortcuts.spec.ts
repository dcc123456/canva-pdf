// shortcuts.spec.ts — regression net for keyboard shortcut wiring.
//
// Two bugs this locks down:
//   1. `I` / `S` used to only call `setTool(...)`, while the matching Toolbar
//      buttons intercept those tools to open the image picker / signature
//      dialog. Pressing the key highlighted a button and did nothing else.
//   2. There was no Ctrl/Cmd+S binding, so the browser's native "save page"
//      dialog fired instead of saving the project.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboardShortcuts } from '../../src/hooks/useKeyboardShortcuts';
import { useEditorStore } from '../../src/store/editorStore';

const { saveProjectMock } = vi.hoisted(() => ({ saveProjectMock: vi.fn() }));

vi.mock('../../src/features/project-io/saveProject', () => ({
  saveProject: saveProjectMock,
}));

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  window.dispatchEvent(e);
  return e;
}

describe('useKeyboardShortcuts', () => {
  beforeEach(() => {
    saveProjectMock.mockReset();
    saveProjectMock.mockReturnValue({ filename: 'doc.minipdf.json', bytes: 123 });
    useEditorStore.setState({ tool: 'select', selectedOverlayId: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('I / S open external UI instead of just switching tools', () => {
    it('dispatches the image-picker event on "I" and leaves the tool alone', () => {
      const spy = vi.fn();
      window.addEventListener('canva:open-image-picker', spy);

      const { unmount } = renderHook(() => useKeyboardShortcuts());
      press('i');

      expect(spy).toHaveBeenCalledTimes(1);
      // The Toolbar button does not set the tool either — behaviour must match.
      expect(useEditorStore.getState().tool).toBe('select');

      unmount();
      window.removeEventListener('canva:open-image-picker', spy);
    });

    it('dispatches the signature event on "S" and leaves the tool alone', () => {
      const spy = vi.fn();
      window.addEventListener('canva:open-signature', spy);

      const { unmount } = renderHook(() => useKeyboardShortcuts());
      press('s');

      expect(spy).toHaveBeenCalledTimes(1);
      expect(useEditorStore.getState().tool).toBe('select');

      unmount();
      window.removeEventListener('canva:open-signature', spy);
    });
  });

  describe('plain tool keys still switch tools', () => {
    it.each([
      ['v', 'select'],
      ['h', 'highlight'],
      ['t', 'text'],
      ['d', 'draw'],
      ['r', 'redact'],
    ])('%s -> %s', (key, tool) => {
      const { unmount } = renderHook(() => useKeyboardShortcuts());
      useEditorStore.setState({ tool: 'select' });
      press(key);
      expect(useEditorStore.getState().tool).toBe(tool);
      unmount();
    });

    // `E` / `F` / `N` used to map to the 编辑文字 / 表单 / 便签 tools. Those
    // tools are gone: text editing now happens by double-clicking a block
    // under 选择, and forms / sticky notes were removed entirely. The keys
    // must therefore be inert rather than silently switching to nothing.
    it.each([['e'], ['f'], ['n']])('"%s" no longer switches tools', (key) => {
      const { unmount } = renderHook(() => useKeyboardShortcuts());
      useEditorStore.setState({ tool: 'select' });
      press(key);
      expect(useEditorStore.getState().tool).toBe('select');
      unmount();
    });
  });

  describe('Ctrl/Cmd+S saves the project', () => {
    it('calls saveProject and prevents the browser default', () => {
      const { unmount } = renderHook(() => useKeyboardShortcuts());

      const e = press('s', { ctrlKey: true });

      expect(saveProjectMock).toHaveBeenCalledTimes(1);
      expect(e.defaultPrevented).toBe(true);

      unmount();
    });

    it('works with the meta key too (macOS)', () => {
      const { unmount } = renderHook(() => useKeyboardShortcuts());
      press('s', { metaKey: true });
      expect(saveProjectMock).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('reports a failure without throwing', () => {
      saveProjectMock.mockImplementation(() => {
        throw new Error('boom');
      });
      const { unmount } = renderHook(() => useKeyboardShortcuts());

      expect(() => press('s', { ctrlKey: true })).not.toThrow();

      unmount();
    });
  });

  it('ignores keys typed into an input', () => {
    const spy = vi.fn();
    window.addEventListener('canva:open-image-picker', spy);

    const { unmount } = renderHook(() => useKeyboardShortcuts());
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'i', bubbles: true, cancelable: true })
    );

    expect(spy).not.toHaveBeenCalled();

    unmount();
    input.remove();
    window.removeEventListener('canva:open-image-picker', spy);
  });
});
