// features/overlays/alignment.ts
//
// 智能对齐(smart guides):拖动块时,把块的左/水平中心/右 与 上/垂直中心/
// 下 分别与「页面边缘 + 页面中心」以及「同页其它块的对应边」比较,距离
// 小于阈值就吸附(snap)并把该对齐位置画成一条贯穿全页的参考线。
//
// 这是 Canva / Figma 风格的"对齐线":既帮用户对齐,又给出明确的视觉反馈。
// 计算是纯函数,SelectionFrame(矢量层)与 TextBlockEditLayer(HTML 层)共用,
// 避免两套逻辑分叉。

import type { OverlayItem } from '../../core/types';

export interface SnapBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Guide {
  /** 'v' = 竖直线(x = pos,贯穿页高);'h' = 水平线(y = pos,贯穿页宽) */
  axis: 'v' | 'h';
  /** 参考线在页面坐标系(pt)中的位置 */
  pos: number;
}

/**
 * 取任意 overlay 的轴对齐包围盒(pt)。SelectionFrame 与 TextBlockEditLayer
 * 共用,避免两套 bbox 取法分叉。SnapBox 与 overlay 模型字段对齐。
 */
export function getOverlayBBox(
  item: OverlayItem
): SnapBox {
  switch (item.type) {
    case 'highlight':
    case 'redact':
      return item.rect;
    case 'text-block':
      return item.bbox;
    case 'text':
    case 'image':
      return {
        x: item.position.x,
        y: item.position.y,
        w: item.size.w,
        h: item.size.h,
      };
    case 'drawing':
      // Drawing 在模型里没有自然 bbox,这里给一个 0 尺寸占位(它不会作为
      // 有效吸附目标参与计算)。
      return { x: 0, y: 0, w: 0, h: 0 };
    default: {
      const _exhaustive: never = item;
      return _exhaustive;
    }
  }
}

/**
 * @param box      当前(拖动中的)块位置
 * @param others   同页其它块的 bbox(已排除自身)
 * @param page     当前页尺寸 { width, height }
 * @param threshold 吸附阈值,单位 pt(建议传 6/zoom,即屏幕上约 6px)
 * @returns 吸附后的 box + 需要绘制的参考线(去重)
 */
export function computeSnap(
  box: SnapBox,
  others: SnapBox[],
  page: { width: number; height: number },
  threshold: number
): { box: SnapBox; guides: Guide[] } {
  let { x, y, w, h } = box;
  const guides: Guide[] = [];

  // 竖直线候选位置(x):页面左/中/右 + 其它块的左/中/右
  const vTargets: number[] = [0, page.width / 2, page.width];
  // 水平线候选位置(y):页面上/中/下 + 其它块的上/中/下
  const hTargets: number[] = [0, page.height / 2, page.height];
  for (const o of others) {
    vTargets.push(o.x, o.x + o.w / 2, o.x + o.w);
    hTargets.push(o.y, o.y + o.h / 2, o.y + o.h);
  }

  // 被拖动块的三个参考点
  const mvX = [x, x + w / 2, x + w];
  const mvY = [y, y + h / 2, y + h];

  // —— 水平吸附(决定竖向参考线)——
  let bestVd = threshold;
  let bestVTarget = 0;
  let bestVRef = 0;
  let vHit = false;
  for (const t of vTargets) {
    for (const m of mvX) {
      const d = Math.abs(t - m);
      if (d < bestVd) {
        bestVd = d;
        bestVTarget = t;
        bestVRef = m;
        vHit = true;
      }
    }
  }
  if (vHit) {
    x += bestVTarget - bestVRef;
    guides.push({ axis: 'v', pos: bestVTarget });
  }

  // —— 垂直吸附(决定水平参考线)——
  let bestHd = threshold;
  let bestHTarget = 0;
  let bestHRef = 0;
  let hHit = false;
  for (const t of hTargets) {
    for (const m of mvY) {
      const d = Math.abs(t - m);
      if (d < bestHd) {
        bestHd = d;
        bestHTarget = t;
        bestHRef = m;
        hHit = true;
      }
    }
  }
  if (hHit) {
    y += bestHTarget - bestHRef;
    guides.push({ axis: 'h', pos: bestHTarget });
  }

  // 去重(同 axis + 同 pos 只画一条)
  const seen = new Set<string>();
  const dedup: Guide[] = [];
  for (const g of guides) {
    const key = `${g.axis}:${g.pos}`;
    if (!seen.has(key)) {
      seen.add(key);
      dedup.push(g);
    }
  }

  return { box: { x, y, w, h }, guides: dedup };
}

/**
 * 缩放时的边缘吸附:与 computeSnap 类似,但只把"正在被拖动的边"吸附到
 * 页面边缘/中心及其它块的对应边。中心参考点(x+w/2、y+h/2)在缩放时无意义,
 * 故 computeSnap 不适用于缩放场景。TextBlockEditLayer 的 HTML resize 手柄
 * 共用此函数,corner 手柄同时传两个 activeEdges(如 'se' → ['s','e'])。
 *
 * @param activeEdges 当前正在被拖动的边集合,来自 handle 名('nw'→['n','w'])
 */
export type ActiveEdge = 'n' | 's' | 'e' | 'w';
export function computeEdgeSnap(
  box: SnapBox,
  others: SnapBox[],
  page: { width: number; height: number },
  threshold: number,
  activeEdges: ActiveEdge[]
): { box: SnapBox; guides: Guide[] } {
  let { x, y, w, h } = box;
  const guides: Guide[] = [];

  const vTargets: number[] = [0, page.width / 2, page.width];
  const hTargets: number[] = [0, page.height / 2, page.height];
  for (const o of others) {
    vTargets.push(o.x, o.x + o.w / 2, o.x + o.w);
    hTargets.push(o.y, o.y + o.h / 2, o.y + o.h);
  }

  // w (left edge): 产生竖参考线
  if (activeEdges.includes('w')) {
    let best = threshold;
    let bestT = 0;
    let hit = false;
    for (const t of vTargets) {
      const d = Math.abs(t - x);
      if (d < best) {
        best = d;
        bestT = t;
        hit = true;
      }
    }
    if (hit) {
      x = bestT;
      guides.push({ axis: 'v', pos: bestT });
    }
  }
  // e (right edge)
  if (activeEdges.includes('e')) {
    const right = x + w;
    let best = threshold;
    let bestT = 0;
    let hit = false;
    for (const t of vTargets) {
      const d = Math.abs(t - right);
      if (d < best) {
        best = d;
        bestT = t;
        hit = true;
      }
    }
    if (hit) {
      w = bestT - x;
      guides.push({ axis: 'v', pos: bestT });
    }
  }
  // n (top edge): 产生横参考线
  if (activeEdges.includes('n')) {
    let best = threshold;
    let bestT = 0;
    let hit = false;
    for (const t of hTargets) {
      const d = Math.abs(t - y);
      if (d < best) {
        best = d;
        bestT = t;
        hit = true;
      }
    }
    if (hit) {
      y = bestT;
      guides.push({ axis: 'h', pos: bestT });
    }
  }
  // s (bottom edge)
  if (activeEdges.includes('s')) {
    const bottom = y + h;
    let best = threshold;
    let bestT = 0;
    let hit = false;
    for (const t of hTargets) {
      const d = Math.abs(t - bottom);
      if (d < best) {
        best = d;
        bestT = t;
        hit = true;
      }
    }
    if (hit) {
      h = bestT - y;
      guides.push({ axis: 'h', pos: bestT });
    }
  }

  // 去重
  const seen = new Set<string>();
  const dedup: Guide[] = [];
  for (const g of guides) {
    const key = `${g.axis}:${g.pos}`;
    if (!seen.has(key)) {
      seen.add(key);
      dedup.push(g);
    }
  }

  return { box: { x, y, w, h }, guides: dedup };
}
