// Document store: pages, overlays, and the underlying PDF bytes.
// All mutations are wrapped in `produceWithPatches` and the resulting
// (forward, inverse) patch pair is pushed to the history store, so
// Ctrl/Cmd+Z works out of the box.
import { create } from 'zustand';
import { produceWithPatches, type Patch } from 'immer';
import { v4 as uuidv4 } from 'uuid';
import type { OverlayItem, PageMeta, Rect } from '../core/types';
import { useHistoryStore } from './historyStore';

export interface DocumentState {
  pages: PageMeta[];
  overlays: OverlayItem[];
  pdfBytes: Uint8Array | null;
  pdfName: string;
  /** Per-page background color (hex), sampled from the rendered canvas. */
  pageBgColors: Record<string, string>;
  /**
   * 块的"底板矩形"(PDF y-down 坐标):文字压在彩色底板上时,从渲染
   * 像素实测的底板范围(可能比文字 bbox 大,含内边距)。移动块后白底
   * 需覆盖整个底板,否则残留彩色边框。
   */
  panelRects: Record<string, Rect>;
  setPanelRect: (overlayId: string, rect: Rect | null) => void;

  setPages: (pages: PageMeta[]) => void;
  addPage: (page?: Partial<PageMeta>) => void;
  removePage: (pageId: string) => void;
  setPdfBytes: (bytes: Uint8Array | null) => void;
  setPdfName: (name: string) => void;
  setOverlays: (overlays: OverlayItem[]) => void;
  setPageBgColor: (pageId: string, color: string) => void;

  addOverlay: (overlay: OverlayItem) => void;
  updateOverlay: (id: string, patch: Partial<OverlayItem>) => void;
  removeOverlay: (id: string) => void;
  clearOverlays: () => void;
  /** Shift multiple overlays' bbox.y in one history step (reflow). */
  shiftBlocks: (shifts: Array<{ id: string; dy: number }>) => void;
}

function defaultA4Page(index: number): PageMeta {
  return {
    id: uuidv4(),
    index,
    rotation: 0,
    width: 595,
    height: 842,
    isBlank: true,
  };
}

type Setter = (
  fn: (state: DocumentState) => DocumentState | Partial<DocumentState>
) => void;

/**
 * Run a mutator under Immer's produceWithPatches and record both the
 * forward and inverse patches to the history store. The mutator may
 * return a value, which is also merged into the resulting state.
 */
function applyWithHistory(
  set: Setter,
  mutator: (draft: DocumentState) => void
): void {
  set((state) => {
    const [next, patches, inverse] = produceWithPatches(state, (draft) => {
      mutator(draft);
    });
    if (patches.length > 0 || inverse.length > 0) {
      useHistoryStore
        .getState()
        .push({ forward: patches as Patch[], inverse: inverse as Patch[] });
    }
    return next;
  });
}

export const useDocumentStore = create<DocumentState>((set) => ({
  pages: [defaultA4Page(0)],
  overlays: [],
  pdfBytes: null,
  pdfName: '',
  pageBgColors: {},
  panelRects: {},

  setPages: (pages) =>
    applyWithHistory(set, (draft) => {
      draft.pages = pages;
      const pageIds = new Set(pages.map((p) => p.id));
      draft.overlays = draft.overlays.filter((o) => pageIds.has(o.pageId));
    }),

  setPageBgColor: (pageId, color) =>
    // No history: bgColor detection is metadata, not a user action.
    set((state) => ({ pageBgColors: { ...state.pageBgColors, [pageId]: color } })),

  setPanelRect: (overlayId, rect) =>
    // No history: panel rect measurement is metadata, not a user action.
    set((state) => {
      const next = { ...state.panelRects };
      if (rect) {
        next[overlayId] = rect;
      } else {
        delete next[overlayId];
      }
      return { panelRects: next };
    }),

  addPage: (page) =>
    applyWithHistory(set, (draft) => {
      const next: PageMeta = {
        id: page?.id ?? uuidv4(),
        index: draft.pages.length,
        rotation: page?.rotation ?? 0,
        width: page?.width ?? 595,
        height: page?.height ?? 842,
        isBlank: page?.isBlank ?? true,
      };
      draft.pages.push(next);
    }),

  removePage: (pageId) =>
    applyWithHistory(set, (draft) => {
      draft.pages = draft.pages.filter((p) => p.id !== pageId);
      draft.overlays = draft.overlays.filter((o) => o.pageId !== pageId);
    }),

  setPdfBytes: (bytes) =>
    applyWithHistory(set, (draft) => {
      // Deep-clone the ArrayBuffer here. Once we hand the bytes to pdfjs
      // (via getDocument in App.handleOpenFile), the worker transfers the
      // Uint8Array's underlying buffer, which detaches it for the
      // sending side. If the stored reference shared that same buffer,
      // every subsequent pdfjs call — e.g. detectTextBlocks via the
      // "E" tool or AcroForm parsing via "F" — would fail with
      //   DataCloneError: ArrayBuffer at index 0 is already detached.
      // The clone makes `state.pdfBytes` a distinct owner, so any
      // worker-side detach cannot corrupt it.
      draft.pdfBytes = bytes === null ? null : new Uint8Array(bytes);
    }),

  setPdfName: (name) =>
    applyWithHistory(set, (draft) => {
      draft.pdfName = name;
    }),

  setOverlays: (overlays) =>
    applyWithHistory(set, (draft) => {
      draft.overlays = overlays;
    }),

  addOverlay: (overlay) =>
    applyWithHistory(set, (draft) => {
      draft.overlays.push(overlay);
    }),

  updateOverlay: (id, patch) =>
    applyWithHistory(set, (draft) => {
      const idx = draft.overlays.findIndex((o) => o.id === id);
      if (idx === -1) return;
      const current = draft.overlays[idx];
      // Merge shallow for discriminated-union shape.
      Object.assign(current, patch);
    }),

  removeOverlay: (id) =>
    applyWithHistory(set, (draft) => {
      draft.overlays = draft.overlays.filter((o) => o.id !== id);
    }),

  clearOverlays: () =>
    applyWithHistory(set, (draft) => {
      draft.overlays = [];
    }),

  shiftBlocks: (shifts) =>
    applyWithHistory(set, (draft) => {
      for (const { id, dy } of shifts) {
        const idx = draft.overlays.findIndex((o) => o.id === id);
        if (idx === -1) continue;
        const ov = draft.overlays[idx];
        if (ov.type === 'text-block' || ov.type === 'form-field') {
          ov.bbox = { ...ov.bbox, y: ov.bbox.y + dy };
        }
      }
    }),
}));
