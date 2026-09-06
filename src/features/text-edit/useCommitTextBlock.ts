// features/text-edit/useCommitTextBlock.ts
//
// 共享的"把 text-block 的新文字写回"逻辑,被 TextBlockEditLayer(画布
// 上的浮层编辑器)和 Inspector(右侧属性面板的文字内容输入框)同时
// 调用。
//
// 重构后:编辑只更新 overlay,绝不碰 store.pdfBytes。原 PDF 字节始终
// 保持干净,导出时再统一应用所有编辑(见 core/writer/textBlockEdits.ts)。
// 这样:
//   * 编辑即时(同步,无 WASM 引擎调用、无 pdfjs 重载)
//   * 画布与导出一致(都基于"原字 + 白底 + 新字"模型)
//   * 撤销/重做只记录 overlay patch
import { useCallback } from 'react';
import { useDocumentStore } from '../../store/documentStore';
import type { TextBlockItem, RichTextSegment, FontClass } from '../../core/types';
import { FONT_CLASS_TO_CSS } from '../../core/engine/fontClassify';

export interface CommitOptions {
  block: TextBlockItem;
  pageIndex: number;
  newText: string;
  /** Optional rich-text segments from the contenteditable editor. */
  segments?: RichTextSegment[];
}

export interface UseCommitTextBlockReturn {
  /** 同步提交:只更新 overlay,返回是否成功(永远为 true 除非文本未变)。 */
  commit: (options: CommitOptions) => boolean;
}

// TipTap 往返(segments -> 编辑器 -> segments)会引入表示层噪声:
//   * fontFamily 从 PDF 原字体名变成 FONT_CLASS_TO_CSS 的 CSS 串
//   * fontClass 属性在 textStyle mark 上无法往返(被 schema 丢弃)
//   * 块级默认 color/fontSize 被补到每个 segment 上
// 直接 JSON.stringify 比较会把"用户没改样式"误判为"改了样式",触发
// whiteout+重画,导致"只是进入过编辑的块样式自己变了"。这里做语义级
// 比较:把可由 fontClass 推导的 fontFamily 归一,块级默认值归空后再逐段比较。
const CSS_TO_FONT_CLASS: Map<string, FontClass> = new Map(
  Object.entries(FONT_CLASS_TO_CSS).map(([fc, css]) => [css, fc as FontClass])
);

/**
 * segment 的字体归一键。fontClass 直接用;fontFamily 可能是
 * "PDF 原字体名, class CSS"组合串(编辑态 WYSIWYG 字体栈),从中
 * 还原出 class;都不匹配时退回原始字符串。
 */
function fontKeyOf(seg: RichTextSegment): string {
  if (seg.fontClass) return seg.fontClass;
  const ff = seg.fontFamily;
  if (!ff) return '';
  const exact = CSS_TO_FONT_CLASS.get(ff);
  if (exact) return exact;
  for (const [css, fc] of CSS_TO_FONT_CLASS) {
    if (ff.includes(css)) return fc;
  }
  return ff;
}

function segmentCompareKey(
  seg: RichTextSegment,
  defaults: { color?: string; fontSize?: number }
): string {
  const color = !seg.color || seg.color === defaults.color ? '' : seg.color;
  const rawFontSize =
    !seg.fontSize || seg.fontSize === defaults.fontSize ? 0 : seg.fontSize;
  // 2 位小数归一:缩放往返(pt*zoom/zoom)可能引入浮点尾差。
  const fontSize = rawFontSize ? Math.round(rawFontSize * 100) / 100 : 0;
  const fontKey = fontKeyOf(seg);
  return [
    seg.text,
    seg.bold ? 1 : 0,
    seg.italic ? 1 : 0,
    seg.underline ? 1 : 0,
    seg.strike ? 1 : 0,
    color,
    fontSize,
    fontKey,
  ].join('	');
}

function segmentsEquivalent(
  a: RichTextSegment[] | undefined,
  b: RichTextSegment[] | undefined,
  defaults: { color?: string; fontSize?: number }
): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  return a.every(
    (seg, i) => segmentCompareKey(seg, defaults) === segmentCompareKey(b[i], defaults)
  );
}

export function useCommitTextBlock(): UseCommitTextBlockReturn {
  const updateOverlay = useDocumentStore((s) => s.updateOverlay);

  const commit = useCallback(
    ({ block, newText, segments }: CommitOptions): boolean => {
      const defaults = { color: block.color, fontSize: block.fontSize };
      if (newText === block.text) {
        if (segments === undefined) {
          return true;
        }
        // 只是进出编辑器,文字和样式都没变:不写回 overlay。写回会引入
        // TipTap 往返噪声,让块被误判为"样式已改"而触发重画。
        if (segmentsEquivalent(segments, block.segments, defaults)) {
          return true;
        }
      }
      const patch: Partial<TextBlockItem> = { text: newText };
      if (segments !== undefined) {
        // Only store segments if they contain actual formatting.
        const hasFormatting = segments.some(
          (s) => s.bold || s.italic || s.color || s.fontSize || s.fontFamily || s.underline || s.strike
        );
        patch.segments = hasFormatting ? segments : undefined;
      }
      updateOverlay(block.id, patch as Partial<TextBlockItem>);
      return true;
    },
    [updateOverlay]
  );

  return { commit };
}
