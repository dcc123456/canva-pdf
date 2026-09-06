// features/text-edit/reformatDocument.ts
//
// 全文格式化(可选,开关控制):打开 PDF 时把全部页面的文本块检测出来,
// 用本项目支持的字体/样式把整份文档重画一遍,使全文样式统一 --
// 不再出现"编辑过的块是项目样式、未编辑的块是原 PDF 样式"的混排。
//
// 流程:
//   1. 逐页检测文本块(异步分页:每页之间让出主线程,进度条实时反馈;
//      pdfjs 的颜色抽取本来就跑在 worker 线程)
//   2. MuPDF 字节级删除全部已检测文本(不碰图片/矢量)
//   3. pdf-lib 按项目字体重画所有文本块(与编辑/导出同一套映射)
//   4. 返回新字节 + 全部文本块(调用方写入 overlay,后续编辑即所见即所得)
//
// 任一步失败都会抛出,由调用方决定回退(保留原字节继续编辑)。
import { PDFDocument } from 'pdf-lib';
import { detectTextBlocksForPage } from './detectTextBlocks';
import { applyMupdfRedactions, type RedactEdit } from '../../core/writer/redact';
import { applyTextBlockRedraws } from '../../core/writer/textBlockEdits';
import {
  loadCjkFontBytesForVariant,
  containsNonAscii,
  type FontWeight,
} from '../../core/writer/cjkFont';
import type { FontClass, PageMeta, TextBlockItem } from '../../core/types';

export interface ReformatDocumentOptions {
  pdfBytes: Uint8Array;
  pages: PageMeta[];
  onProgress?: (progress: number, label?: string) => void;
}

export interface ReformatDocumentResult {
  /** 格式化后的 PDF 字节(全部文本已按项目格式重画)。 */
  bytes: Uint8Array;
  /** 全部检测出的文本块(带 pageId,可直接写入 overlay)。 */
  blocks: TextBlockItem[];
}

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function reformatDocument(
  options: ReformatDocumentOptions
): Promise<ReformatDocumentResult> {
  const { pdfBytes, pages, onProgress } = options;
  const totalPages = pages.length;
  const blocks: TextBlockItem[] = [];

  // Phase 1: 逐页检测(0 -> 0.6)
  for (let i = 0; i < totalPages; i++) {
    const page = pages[i];
    if (page.isBlank) continue;
    onProgress?.(((i + 0.5) / totalPages) * 0.6, `检测第 ${i + 1}/${totalPages} 页文本`);
    await yieldToUi();
    const { blocks: pageBlocks } = await detectTextBlocksForPage({
      pageIndex: page.index,
      pdfBytes: new Uint8Array(pdfBytes),
    });
    for (const b of pageBlocks) {
      blocks.push({
        id: b.id,
        pageId: page.id,
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
      });
    }
  }

  // Phase 2: redact 全部文本(0.6 -> 0.75)
  onProgress?.(0.62, '删除原始文本');
  await yieldToUi();
  const redactEdits: RedactEdit[] = [];
  for (const block of blocks) {
    const idx = pages.findIndex((p) => p.id === block.pageId);
    const meta = pages[idx];
    if (!meta || meta.isBlank || meta.index < 0) continue;
    redactEdits.push({
      pageIndex: meta.index,
      originalBbox: block.originalBbox,
    });
  }
  const { bytes: redactedBytes, redacted } = await applyMupdfRedactions(
    new Uint8Array(pdfBytes),
    redactEdits
  );

  // Phase 3: 按项目字体重画全部文本块(0.75 -> 0.95)
  onProgress?.(0.78, '按项目字体重画');
  await yieldToUi();
  const doc = await PDFDocument.load(redactedBytes);
  // 预热 CJK 字体(与 exportPdf 相同的变体收集逻辑)。
  const neededVariants = new Set<string>();
  const addVariant = (
    fontClass: FontClass | undefined,
    bold: boolean,
    text: string
  ) => {
    let fc = fontClass;
    if (!fc) {
      fc = containsNonAscii(text) ? 'cjk-sans' : 'sans';
    }
    if (fc !== 'cjk-sans' && fc !== 'cjk-serif') return;
    neededVariants.add(`${fc}:${bold ? 'bold' : 'regular'}`);
  };
  for (const b of blocks) {
    addVariant(b.fontClass, !!b.bold, b.text);
    for (const seg of b.segments ?? []) {
      addVariant(seg.fontClass ?? b.fontClass, !!seg.bold, seg.text);
    }
  }
  await Promise.all(
    [...neededVariants].map((key) => {
      const [fc, w] = key.split(':') as [FontClass, FontWeight];
      return loadCjkFontBytesForVariant(fc, w);
    })
  );
  await applyTextBlockRedraws({
    doc,
    originalBytes: redactedBytes,
    pages,
    textBlocks: blocks,
    redacted,
  });

  // Phase 4: 保存(0.95 -> 1)
  onProgress?.(0.97, '保存文档');
  await yieldToUi();
  const bytes = await doc.save();
  onProgress?.(1, '完成');
  return { bytes, blocks };
}
