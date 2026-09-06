// exportPdf.ts: 导出管线(MuPDF redaction + 矢量保留 + 编辑分离)。
//
// 架构:
//   1. 加载干净的原 pdfBytes
//   2. applyMupdfRedactions (MuPDF 字节级删字,仅对 edited text-block)
//   3. PDFDocument.load(redactedBytes) + applyPages (copyPages + 旋转)
//   4. applyTextBlockRedraws (画新字;仅对 edited text-block,
//      redacted=true 跳过白底,false 走白底兜底)
//   5. flattenOverlays (非 text-block 的 overlay: highlight/note/
//      text/image/drawing)
//   6. createFormFields (pdf-lib form API 重建 AcroForm)
//   7. save -> 下载
//
// 关键改进:
//   * MuPDF applyRedactions(false,0,0,0) 字节级删字,不再有白底色块
//   * redaction 失败时自动降级为白底覆盖(redacted=false 兜底)
//   * 原 PDF 矢量保留,未编辑文字保留原嵌入字体(bold/color/size 全部保留)
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
import { createFormFields } from '../../core/writer/formFields';
import { loadCjkFontBytesForVariant, containsNonAscii, type FontWeight } from '../../core/writer/cjkFont';
import { downloadBlob } from '../../utils/download';
import type {
  FontClass,
  FormFieldItem,
  TextBlockItem,
} from '../../core/types';

export interface ExportProgress {
  phase: 'load' | 'redact' | 'pages' | 'textedits' | 'flatten' | 'forms' | 'save' | 'done';
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

    // Phase: redact -- 仅对被编辑的 text-block 字节级删字。
    if (editedTextBlocks.length > 0) {
      onProgress?.({ phase: 'redact' });
      const redactEdits: RedactEdit[] = [];
      for (const block of editedTextBlocks) {
        const editorPageIndex = pages.findIndex((p) => p.id === block.pageId);
        if (editorPageIndex < 0) continue;
        const meta = pages[editorPageIndex];
        if (meta.isBlank || meta.index < 0) continue;
        redactEdits.push({
          pageIndex: meta.index,
          originalBbox: block.originalBbox,
        });
      }
      const result = await applyMupdfRedactions(cleanBytes, redactEdits);
      workingBytes = result.bytes;
      redacted = result.redacted;
    } else {
      workingBytes = cleanBytes;
      redacted = true;
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

  // Step 2: 非 text-block / 非 form-field 的 overlay -> flatten。
  // (text-block 已由 applyTextBlockRedraws 处理,form-field 由下一步处理)
  onProgress?.({ phase: 'flatten' });
  const flattenList = overlays.filter(
    (o) => o.type !== 'form-field'
  );
  await flattenOverlays(doc, flattenList, pages);

  // Step 3: 表单字段 -> 用 pdf-lib form API 重建 AcroForm。
  onProgress?.({ phase: 'forms' });
  const formFields = overlays.filter(
    (o): o is FormFieldItem => o.type === 'form-field'
  );
  if (formFields.length > 0) {
    await createFormFields(doc, pages, formFields);
  }

  onProgress?.({ phase: 'save' });
  const bytes = await doc.save();
  downloadBlob(bytes, filename, 'application/pdf');
  onProgress?.({ phase: 'done' });
  return { filename, bytes: bytes.byteLength };
}
