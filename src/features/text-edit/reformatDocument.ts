// features/text-edit/reformatDocument.ts
//
// 全文格式化(打开 PDF 时的一次性确认):把全部页面的文本块检测出来,
// 作为可编辑 overlay 写入 store。**非破坏性** —— 不删除原字、不重画整份
// 文档,原始 PDF 字节保持不变,Viewer 继续显示原文档(外观零改变)。
//
// 设计依据:本文档核心原则是"编辑只改 overlay、原 PDF 字节不动"。早期曾
// 实现过破坏性版本(删除全部原字 + 按项目字体重画整份文档),但任意版式
// 都会丢失 fidelity(对齐/字距/多栏/字体),表现为"乱码 + 格式乱",故废弃。
// 现在全文格式化只做"检测 + 写入 overlay":双击任意文字块即可进入编辑,
// 导出时只有被改过的块才走项目字体重画,未改动的块保持原 PDF 外观。
import { detectTextBlocksForPage } from './detectTextBlocks';
import type { PageMeta, TextBlockItem } from '../../core/types';
import type { TextBlock } from '../../core/engine/types';

export interface ReformatDocumentOptions {
  pdfBytes: Uint8Array;
  pages: PageMeta[];
  onProgress?: (progress: number, label?: string) => void;
}

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * 把检测端返回的 TextBlock 映射成 overlay 用的 TextBlockItem。
 * 原始文本与重画文本都初始化为检测文本(原始 = 重画),这样未编辑的块在
 * 导出时不会被重画(保持原 PDF 外观),只有被改过的块才走项目字体重画。
 */
function toTextBlockItem(b: TextBlock, pageId: string): TextBlockItem {
  return {
    id: b.id,
    pageId,
    type: 'text-block',
    bbox: b.bbox,
    originalBbox: b.bbox,
    originalText: b.text,
    text: b.text,
    font: b.font,
    fontSize: b.fontSize,
    color: b.color,
    lineHeight: b.lineHeight,
    bold: b.bold,
    italic: b.italic,
    align: b.align,
    segments: b.segments,
    originalSegments: b.segments,
    fontClass: b.fontClass,
  };
}

/**
 * 仅检测:把全部页面的文本块检测出来并映射成可编辑 overlay,**不**删除原
 * 字、也**不**重画。用于"全文格式化"的非破坏性路径 —— 原始 PDF 字节不变,
 * Viewer 继续显示原文档(外观零改变),双击任意文字块即可进入编辑。
 *
 * 与原破坏性 reformatDocument 的区别:reformatDocument 会把整份文档按项目
 * 字体字节级重排(删除原字 + 重画),对任意版式都会丢失 fidelity(对齐/字距/
 * 多栏/字体),导致"乱码 + 格式乱"。本文档的核心原则是"编辑只改 overlay、原
 * PDF 字节不动",因此全文格式化应只做检测 + 写入 overlay,而非整体重排。
 */
export async function detectAllTextBlocks(
  options: ReformatDocumentOptions
): Promise<TextBlockItem[]> {
  const { pdfBytes, pages, onProgress } = options;
  const totalPages = pages.length;
  const blocks: TextBlockItem[] = [];
  for (let i = 0; i < totalPages; i++) {
    const page = pages[i];
    if (page.isBlank) continue;
    onProgress?.((i + 0.5) / totalPages, `检测第 ${i + 1}/${totalPages} 页文本`);
    await yieldToUi();
    const { blocks: pageBlocks } = await detectTextBlocksForPage({
      pageIndex: page.index,
      pdfBytes: new Uint8Array(pdfBytes),
    });
    for (const b of pageBlocks) {
      blocks.push(toTextBlockItem(b, page.id));
    }
  }
  return blocks;
}
