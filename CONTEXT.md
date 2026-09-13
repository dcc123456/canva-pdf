# Mini PDF Editor

一个浏览器内本地运行的 PDF 编辑器,核心是"编辑只改 overlay,导出时统一应用"的分离架构。
_Prior terminology_: PDF annotator, canvas overlay editor

## Language

### 文档与覆盖

**PDF Bytes**:
原始 PDF 文件字节,运行时不修改。导出时基于此构建新 PDF。
_Avoid_: source pdf, original document

**Overlay**:
独立的覆盖对象(高亮/涂黑/文字/图片/画笔/文本块),叠加在 PDF 渲染层之上。导出时通过 `flatten.ts` 转换为 pdf-lib 绘制命令。
_Avoid_: annotation, layer object

**TextBlock**:
MuPDF/pdfjs 检测出的"段落级"文本区域,带 font/fontSize/color/bold/italic/segments。是文本编辑的最小单位。
_Avoid_: text region, paragraph

**TextBlockItem**:
TextBlock 在 overlay 中的存储形态(`type: 'text-block'`)。比 TextBlock 多 `originalText` / `originalBbox` / `originalSegments`,用于判定是否被编辑。
_Avoid_: text overlay, text annotation

**Segment**:
文本块内"内联样式一致"的文本片段。一个块由若干 segment 顺序拼接而成。每段可有独立 bold/italic/underline/strike/color/fontSize/fontFamily。
_Avoid_: span, run, style segment

**Atom**:
MuPDF 在 `toStructuredText('preserve-spans')` 下产出的"同字体单行"单元。多个 atom 同 baseline 拼成一行,多行聚合成段落。一个 segment 通常对应一个或多个同样式 atom。
_Avoid_: pdf span, stext line

### 编辑边界

**Detected Text Block**:
页面上被检测出来的文本块。导出时**只有 Edited Text Block 被重画**(走 whiteout/redaction + 重画)。未编辑的 detected block 保留原 PDF 字节(完整原嵌入字体 + bold/color/size 信息)。
ADR 0003 原计划"全文本重画"已回退,因 Source Han Sans Bold 字重缺失 + 颜色抽取精度不足。
_Avoid_: detected overlay, scanned block

**Edited Text Block**:
`text !== originalText` 或 `bbox` 相对 `originalBbox` 发生位移或 `segments` 与 `originalSegments` 不一致的文本块。只有 Edited Text Block 在导出时走字符级 whiteout + 重画。
_Avoid_: modified block, changed overlay

**矢量保留 (Vector Preservation)**:
原 PDF 的所有元素(图片、路径、表格线、未编辑文本)在导出时保留原始字节。仅 Edited Text Block 被替换为映射字体重画。这与 README Decision #3 的原始表述一致 -- ADR 0003 的"矢量保留收窄为非文本元素"已回退。
_Avoid_: vector fidelity, full preservation

**Whiteout**:
导出时对 Edited Text Block 原字位置的字符级白色矩形覆盖。`core/writer/textQuad.ts` 通过 pdfjs transform 矩阵反推每字符四角点,精确白底覆盖避免色块溢出。
_Avoid_: mask, erase rectangle

**Redaction**:
MuPDF 字节级删字(`Redact + applyRedactions`),物理抹除原字。Redaction 可用时跳过 Whiteout 直接画新字。Redaction 不可用时降级到 Whiteout。
_Avoid_: byte-level erase, content removal

### 引擎

**Engine**:
文本块检测后端,按优先级降级:`mupdf` > `pdfium` > `pdflib-overlay`。三种 EngineKind 在 `core/engine/types.ts` 中定义。引擎只保留只读的 `detectTextBlocks` —— 表单解析(`parseFormFields`)已随表单功能移除。
_Avoid_: backend, parser

**Engine Routing**:
首次按 `'edit'` 或 `'render'` 模式请求 Engine 时按优先级试探,首次成功后缓存。加载失败自动降级。
_Avoid_: engine selection, fallback chain

### 字体

**Font Class**:
字体的规范化分类:`'sans' | 'serif' | 'mono' | 'cjk-sans' | 'cjk-serif'`。检测时由 PDF 字体名推导,渲染时由 fontClass 查表得具体字体(Arial / Times New Roman / Courier New / 思源黑体 / 思源宋体)。`block.font` 字段保留 PDF 原字体名仅用于调试,实际渲染一律走 fontClass。
_Avoid_: font category, font family class

**Web-safe Font Mapping**:
PDF 字体名 -> fontClass -> 具体字体的两段式映射。西文按衬线/无衬线/等宽划分;CJK 按黑体/宋体划分。同一 fontClass 在 TipTap(CSS font-family + @font-face 本地资源)和 pdf-lib(embedFont)两端使用**同一份字体文件**,保证视觉一致。
_Avoid_: font table, font resolution

### 已移除的领域概念

**AcroForm Field**:
PDF 内嵌的交互式表单字段(text/checkbox/radio/select/signature)。**本项目已移除表单功能** —— 早先的实现只能读原字段并在导出时用 pdf-lib 重建,无法新建字段树,属于半成品。`FormFieldItem`、`parseFormFields`、`features/forms/`、`core/writer/formFields.ts` 均已删除。
_Avoid_: pdf form, interactive field

**Sticky Note**:
便签叠加层(`type: 'note'`)。**已移除** —— 与「文字」叠加层能力重叠,且导出后不可再编辑。`StickyNoteItem` 与 Inspector 的 `NoteControls` 均已删除,需要贴纸效果请用「高亮」。
_Avoid_: comment, annotation pin
