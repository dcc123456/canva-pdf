// Engine abstraction: a common interface for text-block detection.
//
// 重构后引擎只保留"只读"能力(detect)。文本编辑不再在编辑时调引擎 --
// 编辑只改 overlay,导出时统一应用。
//
// 引擎路由(core/engine/router.ts)仍按 mupdf > pdfium > pdflib-overlay
// 优先级选择,用于 detectTextBlocks。
import type { FontClass, Rect, RichTextSegment } from '../types';

export type EngineKind = 'mupdf' | 'pdflib-overlay' | 'pdfium';

export interface TextBlock {
  id: string;
  bbox: Rect;
  text: string;
  font: string;
  fontSize: number;
  color: string;
  lineHeight: number;
  bold: boolean;
  italic: boolean;
  /** Per-line rich-text segments (preserves mixed bold/italic within a block). */
  segments?: RichTextSegment[];
  /** Text alignment detected from line position. */
  align?: 'left' | 'center' | 'right';
  /** Canonical font class (see ADR 0001). Resolved from `font` name. */
  fontClass?: FontClass;
}

export interface DetectTextBlocksOptions {
  /** Optional current page index; some engines can be page-aware. */
  pageIndex: number;
  /** Raw PDF bytes of the source document. */
  pdfBytes: Uint8Array;
}

export interface EngineInterface {
  /** Identifier of the engine implementation. */
  readonly kind: EngineKind;

  /** Detect text blocks on a given page. */
  detectTextBlocks(
    options: DetectTextBlocksOptions
  ): Promise<TextBlock[]>;
}
