// Core domain types for the mini PDF editor.

export type Tool =
  | 'select'
  | 'highlight'
  | 'text'
  | 'image'
  | 'draw'
  | 'signature'
  | 'redact';

/** Canonical font category used for rendering (see ADR 0001). */
export type FontClass = 'sans' | 'serif' | 'mono' | 'cjk-sans' | 'cjk-serif';

/** Rich-text segment for inline styling within a text element. */
export interface RichTextSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  fontSize?: number;
  fontFamily?: string;
  /** Resolved font class. When absent, the parent block's fontClass is used. */
  fontClass?: FontClass;
  /**
   * 检测时该 segment 对应 atom 的位置(PDF y-down 坐标,仅检测产物持有)。
   * 用于渲染后按区域反推文字颜色等元数据;编辑提交后的新 segments 不携带。
   */
  bbox?: Rect;
}

export type TextAlign = 'left' | 'center' | 'right';

export interface PageMeta {
  id: string;
  index: number;
  rotation: 0 | 90 | 180 | 270;
  width: number;
  height: number;
  isBlank?: boolean;
}

export interface OverlayBase {
  id: string;
  pageId: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// F2
export interface HighlightItem extends OverlayBase {
  type: 'highlight';
  rect: Rect;
  color: string;
  opacity: number;
}

// F3
export interface TextItem extends OverlayBase {
  type: 'text';
  position: { x: number; y: number };
  size: { w: number; h: number };
  rotation: number;
  text: string;
  font: string;
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** Text alignment within the text box. Defaults to 'left'. */
  align?: TextAlign;
  /** Line height multiplier. Defaults to 1.2. */
  lineHeight?: number;
  /** Optional rich-text segments. When absent, the whole text uses bold/italic/color. */
  segments?: RichTextSegment[];
  /** Canonical font class (see ADR 0001). Defaults to 'sans'. */
  fontClass?: FontClass;
}

// F4
export interface ImageItem extends OverlayBase {
  type: 'image';
  position: { x: number; y: number };
  size: { w: number; h: number };
  rotation: number;
  bytes: string; // base64
  mime: string;
}

// F6
export interface DrawingItem extends OverlayBase {
  type: 'drawing';
  path: string;
  color: string;
  width: number;
}

// F10
// 重构后文本编辑只更新 overlay，不再回写 pdfBytes。
// "是否被编辑过" = text !== originalText || bbox 移动了；
// 但 ADR 0003 后,所有 detected block 都在导出时重画(无论是否编辑)。
// originalBbox 是检测时的原始位置(永不改)，bbox 是当前位置(可被拖动)。
// 白底画在 originalBbox(盖原字)，新字画在 bbox(新位置)。
export interface TextBlockItem extends OverlayBase {
  type: 'text-block';
  bbox: Rect;
  originalBbox: Rect;
  originalText: string;
  text: string;
  font: string;
  fontSize: number;
  color: string;
  lineHeight: number;
  bold: boolean;
  italic: boolean;
  /** Text alignment within the block. Defaults to 'left'. */
  align?: TextAlign;
  /** Optional rich-text segments. When absent, the whole text uses bold/italic/color. */
  segments?: RichTextSegment[];
  /** Segments snapshot at detection time. Used to detect user edits to styling. */
  originalSegments?: RichTextSegment[];
  /**
   * 逐 segment 的像素反推文字色(检测颜色缺失时,从渲染像素按 segment
   * bbox 区域反推)。与 segments 按下标对应;编辑提交后颜色会写入
   * segments 本身,此字段仅作为检测补充元数据。
   */
  segTextColors?: string[];
  /** Canonical font class (see ADR 0001). Defaults to 'sans'. */
  fontClass?: FontClass;
}

// R1 — 涂黑 / 密文
//
// 与 highlight 的**本质区别**:highlight 只是画一层半透明色块,原文仍在
// 内容流里,可以复制、可以提取;redact 在导出时会把该矩形内的文字**从
// 内容流中字节级删除**,并抹除覆盖区域的图片像素、移除被触及的矢量图元
// (见 core/writer/redact.ts 的 'full' 模式)。
//
// 因此这个 overlay 的 rect 是**破坏性**的:导出后不可撤销。
export interface RedactItem extends OverlayBase {
  type: 'redact';
  rect: Rect;
  /** 遮盖色,默认纯黑。设为白色即为"涂白"。 */
  color: string;
  /** 可选备注(导出时**不会**写进 PDF,仅本地记录遮盖原因)。 */
  label?: string;
}

export type OverlayItem =
  | HighlightItem
  | TextItem
  | ImageItem
  | DrawingItem
  | TextBlockItem
  | RedactItem;

export interface ProjectFile {
  version: 2;
  pdf: string; // base64 of original PDF
  pages: PageMeta[];
  overlays: OverlayItem[];
  createdAt: string;
}

export interface Template {
  id: string;
  name: string;
  thumbnail?: string;
  source: 'builtin' | 'user';
  pdf: string; // base64
  createdAt: string;
}
