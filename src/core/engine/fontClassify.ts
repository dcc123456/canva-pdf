// core/engine/fontClassify.ts
//
// PDF 字体名 -> FontClass 映射(ADR 0001)。
//
// 输入:MuPDF / pdfjs / pdfium 报告的 PDF 字体名,可能是
//   - 子集化前缀 + 字体名,如 "ABCDEF+PingFangSC-Regular"
//   - MuPDF 泛化名 "embedded" / "g_d0_f1"
//   - 真实字体名 "Helvetica-Bold" / "SimSun" / "SourceHanSansCN-Regular"
//
// 输出:FontClass ('sans' | 'serif' | 'mono' | 'cjk-sans' | 'cjk-serif')
//
// 渲染端(TipTap 与 pdf-lib)按 FontClass 查表得具体字体,
// 保证两端使用同一份字体文件(见 ADR 0001)。
import type { FontClass } from '../types';

// 西文 sans-serif 关键词:命中即归 'sans'
const SANS_KEYWORDS = [
  'arial', 'helvetica', 'sans', 'sans-serif', 'sansserif',
  'frutiger', 'futura', 'myriad', 'univers', ' Gotham', 'open sans',
  'roboto', 'inter', 'lato', 'montserrat', 'source sans', 'noto sans',
  'pingfang', 'hiragino', 'yu gothic', 'meiryo', 'ms gothic', 'gothic',
  'ms pgothic', 'malgun', 'microsoft yahei', '微软雅黑', '雅黑',
  'heiti', '黑体', 'simhei', 'pingfang sc', 'pingfang hk', 'pingfang tc',
  'stheiti', 'apple color', 'san francisco', 'segoe ui',
];

// 西文 serif 关键词:命中即归 'serif'
const SERIF_KEYWORDS = [
  'times', 'times new roman', 'palatino', 'garamond', 'georgia',
  'baskerville', 'caslon', 'cambria', 'constantia', 'didot',
  'hoefler', 'plantin', 'source serif', 'noto serif', 'roboto slab',
  'clarendon', 'bookman', 'cambria', 'cursive', ' Brush', 'snell',
];

// 等宽字体关键词:命中即归 'mono'
const MONO_KEYWORDS = [
  'courier', 'courier new', 'mono', 'monospace', 'consolas',
  'menlo', 'monaco', 'source code', 'noto mono', 'roboto mono',
  'JetBrains', 'fira code', 'iosevka', 'dejavu sans mono',
];

// CJK 黑体(sans)关键词:命中即归 'cjk-sans'
const CJK_SANS_KEYWORDS = [
  'pingfang', 'hiragino sans', 'hiragino sans gb', 'yu gothic',
  'meiryo', 'ms gothic', 'ms pgothic', 'source han sans',
  'sourcehan sans', 'noto sans cjk', 'noto sans sc', 'noto sans jp',
  'noto sans kr', 'microsoft yahei', 'ms yahei', '微软雅黑', '雅黑',
  'simhei', '黑体', 'heiti', 'heisei', 'gothic', 'malgun gothic',
  'apple sd gothic neo', 'nanum gothic', 'pingfang sc',
  'pingfang hk', 'pingfang tc', 'stheiti', 'wenquanyi', 'droid sans',
];

// CJK 宋体(serif)关键词:命中即归 'cjk-serif'
const CJK_SERIF_KEYWORDS = [
  'simsun', 'nsimsun', 'song', 'songti', 'song ti', 'ms mincho',
  'ms pmincho', 'yu mincho', 'hiragino mincho', 'source han serif',
  'sourcehan serif', 'noto serif cjk', 'noto serif sc', 'noto serif jp',
  'noto serif kr', 'simsum', 'fangsong', '仿宋', '宋体', 'mincho',
  'myeongjo', 'nanum myungjo', 'batang',
];

// 粗体关键词(用于 bold 判定,不参与 fontClass)
const BOLD_KEYWORDS = [
  'bold', 'black', 'heavy', 'semibold', 'semi-bold', 'demibold',
  'medium', 'ultra', 'extrabold', 'extra-bold', 'ultrabold',
  'demi', 'condensed bold', 'narrow bold',
];

// 斜体关键词(用于 italic 判定)
const ITALIC_KEYWORDS = ['italic', 'oblique', 'slant', 'slanted', 'inclined'];

function normalize(fontName: string): string {
  // 去子集前缀 "ABCDEF+" -> ""
  const stripped = fontName.replace(/^[A-Z]{6}\+/, '');
  return stripped.toLowerCase().replace(/[_\s]+/g, ' ').trim();
}

function matchesAny(name: string, keywords: string[]): boolean {
  return keywords.some((k) => name.includes(k));
}

/**
 * 从 PDF 字体名推导 FontClass。规则(按优先级):
 *   1. CJK 黑体 / 宋体关键词优先(避免 "Source Han Serif" 被先匹配成 sans)
 *   2. 西文 sans / serif / mono 关键词
 *   3. 默认 'sans'(对于纯 ASCII 内容)或 'cjk-sans'(如果调用方知道内容含 CJK)
 *
 * 注意:本函数仅按字体名判定,不看实际文字内容。如果字体名是泛化的
 * "embedded" / "g_d0_f1",无法判定,返回 null。调用方应该再 fallback 到
 * 基于内容含 CJK 的判定(see classifyByContent)。
 */
export function classifyFont(fontName: string | undefined | null): FontClass | null {
  if (!fontName) return null;
  const name = normalize(fontName);
  if (!name || name === 'embedded' || /^g_d\d+_f\d+$/.test(name)) {
    return null;
  }
  // CJK 优先(避免 Source Han Sans 被先匹配成 sans)
  if (matchesAny(name, CJK_SANS_KEYWORDS)) return 'cjk-sans';
  if (matchesAny(name, CJK_SERIF_KEYWORDS)) return 'cjk-serif';
  if (matchesAny(name, MONO_KEYWORDS)) return 'mono';
  if (matchesAny(name, SERIF_KEYWORDS)) return 'serif';
  if (matchesAny(name, SANS_KEYWORDS)) return 'sans';
  // 未匹配:返回 null,调用方决定 fallback
  return null;
}

/**
 * 按文本内容判定 FontClass 的 fallback。用于字体名泛化时。
 * 含 CJK -> 'cjk-sans';否则 'sans'。
 */
export function classifyByContent(text: string): FontClass {
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) > 0x7e) return 'cjk-sans';
  }
  return 'sans';
}

/**
 * 组合判定:优先按字体名,失败则按内容。
 */
export function classifyFontWithFallback(
  fontName: string | undefined | null,
  text: string
): FontClass {
  return classifyFont(fontName) ?? classifyByContent(text);
}

/**
 * 检测粗体。基于字体名关键词。
 */
export function detectBold(fontName: string | undefined | null): boolean {
  if (!fontName) return false;
  const name = normalize(fontName);
  if (!name) return false;
  return matchesAny(name, BOLD_KEYWORDS);
}

/**
 * 检测斜体。基于字体名关键词。
 */
export function detectItalic(fontName: string | undefined | null): boolean {
  if (!fontName) return false;
  const name = normalize(fontName);
  if (!name) return false;
  return matchesAny(name, ITALIC_KEYWORDS);
}

// ---------- FontClass -> 具体字体映射 --------------------------------------------

/**
 * FontClass -> CSS font-family 字符串(TipTap 用)。
 * Source Han Sans 通过 @font-face 加载(见 index.css),其他使用系统字体。
 */
export const FONT_CLASS_TO_CSS: Record<FontClass, string> = {
  sans: 'Arial, "Helvetica Neue", Helvetica, sans-serif',
  serif: '"Times New Roman", Times, serif',
  mono: '"Courier New", Courier, monospace',
  'cjk-sans': '"Source Han Sans CN", "Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", sans-serif',
  'cjk-serif': '"Source Han Serif CN", "Source Han Serif SC", "Noto Serif CJK SC", "SimSun", "Songti SC", serif',
};

// ---------- PDF 原字体名 -> 浏览器 font-family --------------------------------

const SYMBOL_FONT_RE = /wingdings|webdings|dingbat|marlett|symbol/i;

/** 符号字体(Wingdings 等):字形映射不可靠,不能按名字直接交给浏览器渲染。 */
export function isSymbolFontName(name: string | undefined | null): boolean {
  return !!name && SYMBOL_FONT_RE.test(name);
}

/**
 * PDF 字体名 -> 浏览器 font-family 候选列表(按优先级)。
 *   "ABCDEF+STSongti-SC-Regular" -> ["STSongti-SC-Regular", "STSongti-SC"]
 * 先尝试完整 PostScript 名(能命中时还原原字形/原字重),再尝试去字重
 * 后缀的族名。泛化名(embedded / g_d0_f1)与符号字体返回 null。
 */
export function pdfFontFamilyCandidates(
  fontName: string | undefined | null
): string[] | null {
  if (!fontName || isSymbolFontName(fontName)) return null;
  const stripped = fontName.replace(/^[A-Z]{6}\+/, '').trim();
  if (!stripped || stripped === 'embedded' || /^g_d\d+_f\d+$/.test(stripped)) {
    return null;
  }
  const stem = stripped
    .replace(
      /[-_ ]?(Regular|Bold|Light|Medium|Heavy|Black|Italic|Oblique|Thin|ExtraLight|Semibold|Demibold)+$/i,
      ''
    )
    .replace(/[-_ ]+$/, '')
    .trim();
  return stem && stem !== stripped ? [stripped, stem] : [stripped];
}

/**
 * 编辑态 font-family:PDF 原字体名优先(本机装了即还原原字形),
 * FontClass 映射字体兜底(原字体未安装时仍保证视觉接近)。
 */
export function pdfFirstFontFamily(
  fontName: string | undefined | null,
  classCss: string
): string {
  const cands = pdfFontFamilyCandidates(fontName);
  if (!cands) return classCss;
  return cands.map((n) => `"${n}"`).join(', ') + ', ' + classCss;
}

/**
 * FontClass -> 本地字体文件 URL(供 @font-face 用)。
 * Regular + Bold 都有,cjk-sans 和 cjk-serif 各自独立。
 */
export const FONT_CLASS_TO_FONT_FILE: Record<FontClass, { regular: string; bold: string }> = {
  'cjk-sans': {
    regular: `${import.meta.env.BASE_URL}fonts/SourceHanSansCN-Regular.otf`,
    bold: `${import.meta.env.BASE_URL}fonts/SourceHanSansCN-Bold.otf`,
  },
  'cjk-serif': {
    regular: `${import.meta.env.BASE_URL}fonts/SourceHanSerifCN-Regular.otf`,
    bold: `${import.meta.env.BASE_URL}fonts/SourceHanSerifCN-Bold.otf`,
  },
  // sans/serif/mono 走系统字体或 pdf-lib StandardFonts,无本地文件
  sans: { regular: '', bold: '' },
  serif: { regular: '', bold: '' },
  mono: { regular: '', bold: '' },
};

/**
 * FontClass -> pdf-lib 字体策略标识。导出端只读取 `kind` 判别式:
 *   - 'standard:<name>': 用 pdf-lib StandardFonts(Helvetica / Times / Courier)
 *   - 'cjk-file': 走 fontkit 嵌入本地 OTF
 *
 * 注意:CJK 分支**不再**在此声明字体文件 URL。真实加载由
 * `loadCjkFontBytesForVariant(fontClass, weight)`(`core/writer/cjkFont.ts`)
 * 负责,它按 (fontClass, weight) 取 Regular 或 Bold 字重文件。旧版本这里
 * 有一个只指向 Regular 的 `url` 字段,消费方从不读取,已删除以免误导。
 */
export type PdfFontStrategy =
  | { kind: 'standard'; name: 'Helvetica' | 'Times-Roman' | 'Courier' }
  | { kind: 'cjk-file' };

export const FONT_CLASS_TO_PDF_STRATEGY: Record<FontClass, PdfFontStrategy> = {
  sans: { kind: 'standard', name: 'Helvetica' },
  serif: { kind: 'standard', name: 'Times-Roman' },
  mono: { kind: 'standard', name: 'Courier' },
  'cjk-sans': { kind: 'cjk-file' },
  'cjk-serif': { kind: 'cjk-file' },
};

/**
 * 给 pdf-lib 选 bold/italic 变体(仅 StandardFonts 路径用)。
 *
 * CJK 路径不走这里:`loadCjkFontBytesForVariant(fontClass, weight)` 会直接
 * 取真 Bold 字重文件(SourceHanSansCN-Bold.otf 等),italic 由调用方用 CTM
 * 斜切模拟(Source Han 无 italic 变体,是 CJK 排版惯例)。
 */
export function pickStandardFontVariant(
  base: 'Helvetica' | 'Times-Roman' | 'Courier',
  bold: boolean,
  italic: boolean
): 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique' | 'Helvetica-BoldOblique'
  | 'Times-Roman' | 'Times-Bold' | 'Times-Italic' | 'Times-BoldItalic'
  | 'Courier' | 'Courier-Bold' | 'Courier-Oblique' | 'Courier-BoldOblique' {
  if (base === 'Helvetica') {
    if (bold && italic) return 'Helvetica-BoldOblique';
    if (bold) return 'Helvetica-Bold';
    if (italic) return 'Helvetica-Oblique';
    return 'Helvetica';
  }
  if (base === 'Times-Roman') {
    if (bold && italic) return 'Times-BoldItalic';
    if (bold) return 'Times-Bold';
    if (italic) return 'Times-Italic';
    return 'Times-Roman';
  }
  // Courier
  if (bold && italic) return 'Courier-BoldOblique';
  if (bold) return 'Courier-Bold';
  if (italic) return 'Courier-Oblique';
  return 'Courier';
}
