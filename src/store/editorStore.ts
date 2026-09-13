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
  /** 左侧页面缩略图侧栏是否收起(Canva 式,默认收起)。 */
  sidebarCollapsed: boolean;
  /** 右侧属性面板是否收起(选中元素时自动展开)。 */
  inspectorCollapsed: boolean;

  setCurrentPage: (index: number) => void;
  setZoom: (zoom: number) => void;
  setTool: (tool: Tool) => void;
  setTotalPages: (n: number) => void;
  setSelectedOverlayId: (id: string | null) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setInspectorCollapsed: (v: boolean) => void;
  nextPage: () => void;
  prevPage: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

const SIDEBAR_COLLAPSED_KEY = 'minipdf.sidebarCollapsed';
const INSPECTOR_COLLAPSED_KEY = 'minipdf.inspectorCollapsed';

function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === '1';
  } catch {
    return fallback;
  }
}

/**
 * 取相对当前缩放值的"上一档 / 下一档"。
 *
 * 不能用"就近吸附"实现(旧版本正是如此,是个 bug):`ZOOM_LEVELS` 档位
 * 间距不均,1.0 与 1.5 的中点是 1.25,`closest(1.25)` 会并列命中 1.0
 * (比较用严格小于,数组靠前的值胜出),于是 100% 及以上按"放大"毫无
 * 反应 —— 而 100% 恰是默认值。1.5→1.75、2→2.25、4→4.25 同样并列。
 *
 * 改为"严格大于 / 小于当前值的最近档位",顺带也能正确处理非档位值
 * (例如未来"适应宽度"算出的 1.17),不会跳档。
 */
function stepZoom(current: number, direction: 1 | -1): number {
  const base = ZOOM_LEVELS;
  const EPS = 1e-6;
  if (direction === 1) {
    for (const z of base) {
      if (z > current + EPS) return z;
    }
    return base[base.length - 1];
  }
  for (let i = base.length - 1; i >= 0; i -= 1) {
    if (base[i] < current - EPS) return base[i];
  }
  return base[0];
}

export const useEditorStore = create<EditorState>((set, get) => ({
  currentPageIndex: 0,
  zoom: 1,
  tool: 'select',
  totalPages: 0,
  selectedOverlayId: null,
  sidebarCollapsed: loadFlag(SIDEBAR_COLLAPSED_KEY, true),
  // 默认收起:与 Canva 的"选中才出现属性 UI"一致。App.tsx 已有「选中元素时
  // 自动展开 Inspector」的逻辑,原先默认展开会让那段逻辑成为空操作。
  inspectorCollapsed: loadFlag(INSPECTOR_COLLAPSED_KEY, true),

  setCurrentPage: (index) =>
    set(() => ({
      currentPageIndex: Math.max(0, Math.min(Math.max(0, get().totalPages - 1), index)),
    })),

  setZoom: (zoom) => set({ zoom: Math.max(0.1, Math.min(8, zoom)) }),

  setTool: (tool) => set({ tool }),

  setTotalPages: (n) => set({ totalPages: Math.max(0, n) }),

  setSelectedOverlayId: (id) => set({ selectedOverlayId: id }),

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
    set({ zoom: stepZoom(get().zoom, 1) });
  },

  zoomOut: () => {
    set({ zoom: stepZoom(get().zoom, -1) });
  },
}));
