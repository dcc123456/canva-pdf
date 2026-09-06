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
  /** 左侧页面缩略图侧栏是否收起(Canva 式,默认收起)。 */
  sidebarCollapsed: boolean;
  /** 右侧属性面板是否收起(选中元素时自动展开)。 */
  inspectorCollapsed: boolean;

  setCurrentPage: (index: number) => void;
  setZoom: (zoom: number) => void;
  setTool: (tool: Tool) => void;
  setTotalPages: (n: number) => void;
  setSelectedOverlayId: (id: string | null) => void;
  setFullReformat: (v: boolean) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setInspectorCollapsed: (v: boolean) => void;
  nextPage: () => void;
  prevPage: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

const FULL_REFORMAT_KEY = 'minipdf.fullReformat';
const SIDEBAR_COLLAPSED_KEY = 'minipdf.sidebarCollapsed';
const INSPECTOR_COLLAPSED_KEY = 'minipdf.inspectorCollapsed';

function loadFullReformat(): boolean {
  try {
    return localStorage.getItem(FULL_REFORMAT_KEY) === '1';
  } catch {
    return false;
  }
}

function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === '1';
  } catch {
    return fallback;
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
  sidebarCollapsed: loadFlag(SIDEBAR_COLLAPSED_KEY, true),
  inspectorCollapsed: loadFlag(INSPECTOR_COLLAPSED_KEY, false),

  setCurrentPage: (index) =>
    set(() => ({
      currentPageIndex: Math.max(0, Math.min(Math.max(0, get().totalPages - 1), index)),
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

  setSidebarCollapsed: (v) => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, v ? '1' : '0');
    } catch {
      /* 忽略存储失败(隐私模式等) */
    }
    set({ sidebarCollapsed: v });
  },

  setInspectorCollapsed: (v) => {
    try {
      localStorage.setItem(INSPECTOR_COLLAPSED_KEY, v ? '1' : '0');
    } catch {
      /* 忽略存储失败(隐私模式等) */
    }
    set({ inspectorCollapsed: v });
  },

  nextPage: () => {
    const { currentPageIndex, totalPages } = get();
    set({ currentPageIndex: Math.min(totalPages - 1, currentPageIndex + 1) });
  },

  prevPage: () => {
    const { currentPageIndex } = get();
    set({ currentPageIndex: Math.max(0, currentPageIndex - 1) });
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
