// exportPdf.ts: 导出管线(MuPDF redaction + 矢量保留 + 编辑分离)。
//
// 架构:
//   1. 加载干净的原 pdfBytes
//   2. applyMupdfRedactions (MuPDF 字节级删字;两种模式见 core/writer/redact.ts)
//        - 被编辑的 text-block -> 'text-only'(只删字,保留图片/矢量)
//        - 涂黑/密文 overlay   -> 'full'(删字 + 抹图片像素 + 移除矢量)
//   3. PDFDocument.load(redactedBytes) + applyPages (copyPages + 旋转)
//   4. applyTextBlockRedraws (画新字;redacted=true 跳过白底,false 走白底兜底)
//   5. flattenOverlays (highlight/text/image/drawing/**redact 黑框**)
//   6. save -> 下载
//
// 关键改进:
//   * MuPDF applyRedactions 字节级删字,不再有白底色块
//   * redaction 失败时自动降级为白底覆盖(redacted=false 兜底)
//   * 原 PDF 矢量保留,未编辑文字保留原嵌入字体(bold/color/size 全部保留)
//
// 安全约束(重要):涂黑/密文 overlay 存在时,**禁止**走兜底降级。若 redaction
// 失败,直接抛错中止导出 —— 否则用户会拿到一份"黑框画上了、内容其实还在
// 文件里"的假脱敏 PDF。详见下方 throw。
//
// 注意:ADR 0003 原计划"重画所有 detected text-block",但因目前缺少
// Source Han Sans Bold 字重 + 颜色抽取精度不足,重画会丢失原 PDF 的
// bold/color/size 信息。暂时回退为"仅重画编辑过的块"。等 Bold CJK
// 字体落地 + 颜色抽取鲁棒后再启用全量重画。
import { PDFDocument } from 'pdf-lib';
import { useDocumentStore } from '../../store/documentStore';
import { applyPages } from '../../core/writer/pages';
import { flattenOverlays } from '../../core/writer/flatten';
import { applyTextBlockRedraws } from '../../core/writer/textBlockEdits';
import { applyMupdfRedactions, type RedactEdit } from '../../core/writer/redact';
import { loadCjkFontBytesForVariant, containsNonAscii, type FontWeight } from '../../core/writer/cjkFont';
import { downloadBlob } from '../../utils/download';
import type { FontClass, RedactItem, TextBlockItem } from '../../core/types';

export interface ExportProgress {
  phase: 'load' | 'redact' | 'pages' | 'textedits' | 'flatten' | 'save' | 'done';
}

export interface ExportResult {
  filename: string;
  bytes: number;
}

export async function exportPdf(
  onProgress?: (p: ExportProgress) => void
): Promise<ExportResult> {
  const { pages, overlays, pdfBytes, pdfName } = useDocumentStore.getState();
  const safeName = (pdfName || 'document').replace(/\.pdf$/i, '');
  const filename = `${safeName}-edited.pdf`;

  onProgress?.({ phase: 'load' });

  // 仅重画被编辑过的 text-block(原 PDF 矢量保留 + 未编辑文字保留原嵌入字体)。
  // ADR 0003 的"全文本重画"暂时回退,见文件头注释。
  const editedTextBlocks = overlays.filter(
    (o): o is TextBlockItem =>
      o.type === 'text-block' &&
      (o.text !== o.originalText ||
        o.bbox.x !== o.originalBbox.x ||
        o.bbox.y !== o.originalBbox.y ||
        o.bbox.w !== o.originalBbox.w ||
        o.bbox.h !== o.originalBbox.h ||
        // Styling changed: segments differ from detection-time snapshot.
        (o.originalSegments != null
          ? JSON.stringify(o.segments ?? []) !==
            JSON.stringify(o.originalSegments)
          : o.segments != null && o.segments.length > 0))
  );

  let doc: PDFDocument;
  let workingBytes: Uint8Array;
  let redacted = false;
  if (pdfBytes) {
    const cleanBytes = pdfBytes.slice();

    // 涂黑/密文 overlay:需要 'full' 模式(删字 + 抹图片像素 + 移除矢量)。
    const redactItems = overlays.filter(
      (o): o is RedactItem => o.type === 'redact'
    );

    // Phase: redact —— 两类编辑合并成一次调用,但各自携带 mode,由
    // core/writer/redact.ts 按 (页, 模式) 分组后分别应用参数。
    // 注意:两种模式合并成一次调用意味着"任一组失败则整体失败"。这是有意
    // 为之 —— 涂黑场景下部分成功比整体失败更危险(见下方安全约束)。
    const redactEdits: RedactEdit[] = [];
    for (const block of editedTextBlocks) {
      const meta = pages.find((p) => p.id === block.pageId);
      if (!meta || meta.isBlank || meta.index < 0) continue;
      redactEdits.push({
        pageIndex: meta.index,
        originalBbox: block.originalBbox,
        mode: 'text-only',
      });
    }
    for (const item of redactItems) {
      const meta = pages.find((p) => p.id === item.pageId);
      if (!meta || meta.isBlank || meta.index < 0) continue;
      redactEdits.push({
        pageIndex: meta.index,
        originalBbox: item.rect,
        mode: 'full',
      });
    }

    if (redactEdits.length > 0) {
      onProgress?.({ phase: 'redact' });
      const result = await applyMupdfRedactions(cleanBytes, redactEdits);
      workingBytes = result.bytes;
      redacted = result.redacted;
    } else {
      workingBytes = cleanBytes;
      redacted = true;
    }

    // 安全约束:涂黑/密文不允许静默降级。
    //
    // redact.ts 的兜底是"返回原始字节 + redacted:false",对文本编辑来说
    // 这是合理的优雅降级(还有白底覆盖兜底)。但涂黑工具的语义是"内容已从
    // 文件中删除",一旦 redaction 没跑成,导出的 PDF 会是黑框之下的原文
    // 依然可复制、可提取 —— 这正是竞品评测反复警告的"假脱敏"。宁可导出
    // 失败并明确报错,也不能交付这种文件。
    if (redactItems.length > 0 && !redacted) {
      throw new Error(
        '涂黑/密文失败:无法从 PDF 内容流中删除被遮盖的内容。' +
          '为避免导出一份"看起来已脱敏、实际仍可提取原文"的文件,已中止导出。' +
          '请重试;若持续失败,请改用「高亮」或先另存后再处理。'
      );
    }

    doc = await PDFDocument.load(workingBytes);
  } else {
    // Brand-new blank document.
    doc = await PDFDocument.create();
    workingBytes = await doc.save();
    redacted = true;
  }

  onProgress?.({ phase: 'pages' });
  await applyPages(doc, pages, workingBytes);

  // Step 1: 对已编辑 text-block 重画新字。
  // redacted=true: MuPDF 已删原字,只画新字。
  // redacted=false: 走白底覆盖 + 重画(兜底)。
  onProgress?.({ phase: 'textedits' });
  if (editedTextBlocks.length > 0) {
    // 预加载 CJK 字体:收集所有需要的 (fontClass, weight) 组合。
    // Bold 块需要 Bold 字重文件,非 Bold 块用 Regular。
    const neededVariants = new Set<string>();
    const addVariant = (fontClass: FontClass | undefined, bold: boolean, text: string) => {
      let fc = fontClass;
      if (!fc) {
        // 老项目无 fontClass,按内容判定
        fc = containsNonAscii(text) ? 'cjk-sans' : 'sans';
      }
      if (fc !== 'cjk-sans' && fc !== 'cjk-serif') return;
      const weight: FontWeight = bold ? 'bold' : 'regular';
      neededVariants.add(`${fc}:${weight}`);
    };
    for (const b of editedTextBlocks) {
      addVariant(b.fontClass, !!b.bold, b.text);
      if (b.segments) {
        for (const seg of b.segments) {
          addVariant(seg.fontClass ?? b.fontClass, !!seg.bold, seg.text);
        }
      }
    }
    const promises = [...neededVariants].map((key) => {
      const [fc, w] = key.split(':') as [FontClass, FontWeight];
      return loadCjkFontBytesForVariant(fc, w);
    });
    await Promise.all(promises);
    await applyTextBlockRedraws({
      doc,
      originalBytes: workingBytes,
      pages,
      textBlocks: editedTextBlocks,
      redacted,
      pageBgColors: useDocumentStore.getState().pageBgColors,
      panelRects: useDocumentStore.getState().panelRects,
      segTextColorsFor: (block) => block.segTextColors,
    });
  }

  // Step 2: 所有非 text-block 的 overlay -> flatten。
  // (text-block 已由 applyTextBlockRedraws 处理)
  onProgress?.({ phase: 'flatten' });
  await flattenOverlays(doc, overlays, pages);

  onProgress?.({ phase: 'save' });
  const bytes = await doc.save();
  downloadBlob(bytes, filename, 'application/pdf');
  onProgress?.({ phase: 'done' });
  return { filename, bytes: bytes.byteLength };
}
