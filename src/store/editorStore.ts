import { create } from 'zustand';
import type { Tool } from '../core/types';

export const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4] as const;
export type ZoomLevel = (typeof ZOOM_LEVELS)[number];

export interface EditorState {
  currentPageIndex: number;
  zoom: number;
  tool: Tool;
  totalPages: number;
  selectedOverlayId: string | null;
  /** 打开 PDF 时是否自动"全文格式化"(全部文本按项目字体重排)。 */
  fullReformat: boolean;

  setCurrentPage: (index: number) => void;
  setZoom: (zoom: number) => void;
  setTool: (tool: Tool) => void;
  setTotalPages: (n: number) => void;
  setSelectedOverlayId: (id: string | null) => void;
  setFullReformat: (v: boolean) => void;
  nextPage: () => void;
  prevPage: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

const FULL_REFORMAT_KEY = 'minipdf.fullReformat';

function loadFullReformat(): boolean {
  try {
    return localStorage.getItem(FULL_REFORMAT_KEY) === '1';
  } catch {
    return false;
  }
}

function findClosestZoom(target: number, base: readonly number[] = ZOOM_LEVELS): number {
  let best: number = base[0];
  let bestDiff = Math.abs(target - best);
  for (const z of base) {
    const d = Math.abs(target - z);
    if (d < bestDiff) {
      best = z;
      bestDiff = d;
    }
  }
  return best;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  currentPageIndex: 0,
  zoom: 1,
  tool: 'edit-text',
  totalPages: 0,
  selectedOverlayId: null,
  fullReformat: loadFullReformat(),

  setCurrentPage: (index) =>
    set(() => ({
      currentPageIndex: Math.max(0, Math.min(Math.max(0, get().totalPages - 1), index)),
      // 切页时清除选中:上一页的选中 id 对新页面无效,
      // 否则 Inspector 会显示错误的属性、块也会带着残留高亮。
      selectedOverlayId: null,
    })),

  setZoom: (zoom) => set({ zoom: Math.max(0.1, Math.min(8, zoom)) }),

  setTool: (tool) => set({ tool }),

  setTotalPages: (n) => set({ totalPages: Math.max(0, n) }),

  setSelectedOverlayId: (id) => set({ selectedOverlayId: id }),

  setFullReformat: (v) => {
    try {
      localStorage.setItem(FULL_REFORMAT_KEY, v ? '1' : '0');
    } catch {
      /* 忽略存储失败(隐私模式等) */
    }
    set({ fullReformat: v });
  },

  nextPage: () => {
    const { currentPageIndex, totalPages } = get();
    set({
      currentPageIndex: Math.min(totalPages - 1, currentPageIndex + 1),
      selectedOverlayId: null,
    });
  },

  prevPage: () => {
    const { currentPageIndex } = get();
    set({ currentPageIndex: Math.max(0, currentPageIndex - 1), selectedOverlayId: null });
  },

  zoomIn: () => {
    const current = get().zoom;
    const next = findClosestZoom(current + 0.25);
    set({ zoom: next });
  },

  zoomOut: () => {
    const current = get().zoom;
    const next = findClosestZoom(current - 0.25);
    set({ zoom: next });
  },
}));
