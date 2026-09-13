# Mini PDF 编辑器 — 优化计划

> 依据:`docs/validation-plan.md` 的实测结论 + `scripts/experiment-subset.mjs` 的决定性实验。
> 本文档按「收益 / 风险」排序,每项标注 **影响面 / 工作量 / 风险 / 验证方式**。

---

## 0. 本轮的决定性实验

**问题**:`textBlockEdits.ts` / `flatten.ts` 用 `embedFont(bytes, { subset: false })`,注释称"`subset: true` 对 CID/CFF 字体可能产生不完整子集,导致中文字形缺失"。这个决定让每次涉及中文的导出都塞进 8–12 MB 整字体。

**实验**:`node scripts/experiment-subset.mjs` —— 取 200 个**确认源字体有字形**的汉字(对照组,排除"源字体本来就没有"的假阳性),分别用 `subset: true/false` 嵌入,然后做两道独立校验:

1. pdfjs 提取文字,与源串逐字符比对 + 检查零宽度字形
2. 把嵌入的字体程序从 PDF 里取回来解压,数 CharStrings 里的**字形轮廓**数量

**结果**:

| 指标 | `subset: true` | `subset: false`(现状) |
|------|---------------|----------------------|
| 导出体积 | **68.5 KB** | 7,289.2 KB |
| 提取字符 | 200 / 200 全等 | 200 / 200 全等 |
| 零宽度字形 | 0 | 0 |
| 嵌入字体程序 | 裸 CFF | OTTO 容器 |
| **字形轮廓数** | **201**(200 字 + `.notdef`) | 31,072(整字体) |

**结论**:子集包含**恰好正确的字形轮廓**,一个不缺。注释里的前提**不成立**。
**体积差 106 倍。**

> 严谨性说明:本实验证明的是「字形轮廓存在且文字可正确提取」,未做像素级渲染比对(需要 canvas 依赖)。但「轮廓数恰好 = 使用字符数 + 1」已排除"轮廓缺失"这一唯一可能的事故形态。执行后仍建议人工打开一份导出 PDF 目视确认一次。

---

## 1. 优化项总览

| 编号 | 优化项 | 影响面 | 工作量 | 风险 | 优先级 |
|------|--------|--------|--------|------|--------|
| **O1** | CJK 字体改用子集嵌入 | 导出体积 106x | 小 | 低 | **P0** |
| O2 | 统一 `I`/`S` 快捷键与按钮行为 | 交互正确性 | 小 | 低 | P1 |
| O3 | Inspector 字体下拉统一为 5 类 FontClass | 消除双套 UI | 中 | 中 | P1 |
| O4 | Inspector 默认收起 | 视觉一致性 | 小 | 低 | P2 |
| O5 | 补 `Ctrl/Cmd+S` 保存快捷键 | 效率 | 小 | 低 | P2 |
| O6 | 清理 `FONT_CLASS_TO_PDF_STRATEGY` 失效字段与过期注释 | 可维护性 | 小 | 低 | P2 |
| O7 | `resume.spec.ts` 改为带原因的优雅跳过 | 测试可信度 | 小 | 低 | P2 |
| O8 | 删除死代码:第二套模板子系统 | 减 288 行 | 小 | 低 | P2 |
| O9 | 修订 README 的事实错误 | 文档可信度 | 小 | 低 | P2 |
| O10 | `flatten.ts` 补 CJK italic 斜切 | 导出保真 | 中 | 中 | P3 |

---

## O1 【P0】CJK 字体改用子集嵌入

**改动**:`src/core/writer/textBlockEdits.ts:173`、`src/core/writer/flatten.ts:59` —— `{ subset: false }` → `{ subset: true }`,并改写注释(旧注释是错误的技术判断)。

**收益**:
- 导出体积:含中文的导出从 MB 级降到 KB 级
- 直接消解 validation-plan 的 **B2**(README 声称子集化但实际关闭)
- 显著改善 **C1** 的用户侧影响(导出不再动辄几十 MB)

**风险与对策**:
- 风险:极端字符(罕用字、兼容区汉字)可能不在子集内
- 对策:`textBlockEdits.ts` 已有 try/catch + 降级到 Helvetica 的兜底路径,不会崩
- 回归测试:新增断言「含 CJK 的导出产物 < 500 KB」,旧实现必然失败

**验证方式**:`npm run test` + 人工导出一份 S1 目视确认。

---

## O2 【P1】统一 `I`/`S` 快捷键与按钮行为

**问题**:`Toolbar.tsx:54-62` 的 `pickTool` 对 `image`/`signature` 拦截为打开选择器;**不**设置工具。而 `useKeyboardShortcuts.ts:20-21` 的 `i`/`s` 只调 `setTool`。结果:点按钮弹选择框,按快捷键只高亮、无反应。同文件 `:2-3` 注释声称两者行为一致 —— 与实现相反。

**改动**:把「工具切换」与「需要外部 UI 的动作」解耦。快捷键触发 image/signature 时,派发与按钮相同的 window 事件:
- `canva:open-image-picker`(已存在,`App.tsx:177` 派发)
- 签名对话框需要一个新事件 `canva:open-signature`,由 `App.tsx` 监听

**验证方式**:新增单测断言快捷键与按钮走同一路径(可用 spy 监听 window 事件);人工按 `I`/`S` 确认弹出 UI。

---

## O3 【P1】Inspector 字体下拉统一为 5 类 FontClass

**问题**:`Inspector.tsx:21-29` 提供 7 个字体名(`Helvetica/TimesRoman/Courier/SimSun/SimHei/Microsoft YaHei/KaiTi`),而 ADR 0001 的规范模型是 5 类 FontClass。`fontClassify.ts` 关键词表中**没有 `kaiti`**,选「楷体」无法映射。同时 `RichTextEditor.tsx:473-477` 已有另一套正确的 5 项选择器 —— 同一应用两套字体 UI。

**改动**:`Inspector.tsx` 改用与 `RichTextEditor` 相同的 5 项(`FONT_CLASS_TO_CSS` 的 key/label),删除 `BUILTIN_FONTS` 常量与 `isBuiltinFont`。

**风险**:中 —— 改变了 Inspector 的可见选项,需要设计确认(是否保留"字体名"作为展示层)。

**建议**:先做,但单独提交以便回滚。若产品上需要保留字体名展示,则改为「5 类选择器 + 原字体名只读显示」。

---

## O4 【P2】Inspector 默认收起

**问题**:`editorStore.ts:77` `inspectorCollapsed` 默认 `false`(展开),但 `App.tsx:59-68` 有「选中元素时自动展开 Inspector」的逻辑 —— 设计意图是默认收起。两条规则打架。

**改动**:默认值改为 `true`,与 `sidebarCollapsed`(默认 `true`)对齐。

**风险**:低。但注意 localStorage 已存了旧值,需清缓存才能看到变化 —— 验证时用无痕窗口。

---

## O5 【P2】补 `Ctrl/Cmd+S` 保存快捷键

**问题**:导出/保存是核心动作却无快捷键。用户按 `Ctrl+S` 会触发浏览器原生"保存网页"。

**改动**:在 `useKeyboardShortcuts.ts` 绑定 `Ctrl/Cmd+S` → 拦截默认行为 → 调 `saveProject()`。

**风险**:低。

---

## O6 【P2】清理失效字段与过期注释

**问题**:
- `fontClassify.ts:237-249` `FONT_CLASS_TO_PDF_STRATEGY` 的 `url` 字段已失效 —— 消费方(`textBlockEdits.ts:139,337,430`)只读 `kind`,真实加载走 `loadCjkFontBytesForVariant(fontClass, weight)`
- 同文件 `:251-254` 注释仍写"CJK 路径目前只有 Regular,粗斜体用 stroke/skew 模拟",与 `cjkFont.ts` 已支持真 Bold 的事实矛盾

**改动**:删除 `url` 字段(或补全为 `{regular, bold}`),重写注释。

**风险**:低 —— 需确认无外部消费。

---

## O7 【P2】`resume.spec.ts` 优雅跳过

**问题**:`tests/integration/resume.spec.ts:10` 读 `d:\文档\pdf\resume.pdf`,macOS/Linux 永不执行。测试报告显示 "1 skipped" 掩盖了这个空洞。

**改动**:改为 `describe.skipIf(!existsSync(fixture))`,并在跳过时 `console.warn` 说明原因与如何提供 fixture。这样在 Windows 上仍能跑,其他平台明确说明为何跳过 —— 而不是静默消失。

**风险**:低。

---

## O8 【P2】删除死代码:第二套模板子系统

**已核实无消费方**(实际发现 4 个死文件,共 288 行):

| 文件 | 状态 |
|------|------|
| `core/templates/registry.ts` | ✅ 在用(`TemplateGallery.tsx:15`) |
| `core/templates/user.ts` | ✅ 在用(`TemplateGallery.tsx:20`) |
| `core/templates/builtin.ts` | ❌ 仅 `templateStore.ts:11` 引用 |
| `core/templates/user-templates.ts` | ❌ 仅 `templateStore.ts:10` 引用 |
| `store/templateStore.ts` | ❌ 仅 `App.tsx:39` 空调用 `getState()`,无组件订阅 |
| `core/templates/thumbnail.ts` | ❌ `generateThumbnail` 零调用(`user.ts` 有私有同名实现) |

**改动**:删除上述 4 个文件 + `App.tsx` 中的 import 与 `useTemplateStore.getState()` 调用。

**风险**:低 —— 已通过引用链核实。建议删除前再跑一次 `npm run typecheck` + 测试。

---

## O9 【P2】修订 README 的事实错误

| 位置 | 现状 | 实际 | 
|------|------|------|
| 已知限制 | MuPDF WASM ~30 MB | **10.0 MB**(构建产物实测) |
| 决策 #7 | "CJK 字体子集化 … 避免 PDF 体积爆炸" | 代码是 `subset: false` 整字体嵌入(O1 修复后此条才成立) |
| 目录结构 | 含 `ToolSidebar`、`FloatingTextToolbar` | 两个文件都不存在 |
| 目录结构 | 未区分 `registry` / `builtin` | 两套并行系统(O8 删除后需同步) |

**改动**:逐条修正,并在 O1/O8 完成后同步。

---

## O10 【P3】`flatten.ts` 补 CJK italic 斜切

**问题**:B1 修复后 CJK 的 bold 已走真字重文件,但 italic 在 `flatten.ts` 路径不生效(需 `page.pushOperators` 设 CTM 斜切矩阵)。`textBlockEdits.ts` 已实现。

**改动**:在 `drawTextItem` 的 CJK 分支补 CTM 斜切,与 `textBlockEdits` 对齐。

**风险**:中 —— 涉及底层操作符,需目视验证。中文字体本身无 italic 变体,优先级低。

---

## 2. 执行顺序

| 阶段 | 内容 | 状态 |
|------|------|------|
| 阶段一 | O1(子集化)+ 回归测试 | ✅ 已执行 |
| 阶段二 | O2 / O4 / O5 / O6 / O7(低风险正确性修复) | ✅ 已执行 |
| 阶段三 | O8(删死代码)+ O9(文档修订) | ✅ 已执行 |
| 阶段四 | O3(字体 UI 统一)—— 需设计确认 | ⬜ 待确认 |
| 阶段五 | O10(CJK italic) | ⬜ 待排期 |

**每阶段的收口标准**:`npm run typecheck` 通过、`npm run test` 全绿、`npm run build` 通过、lint 不新增问题。

---

## 3. 执行结果

### 验收指标

| 指标 | 执行前 | 执行后 |
|------|--------|--------|
| 测试用例 | 50 通过 | **78 通过**(+28) |
| 测试文件 | 13 通过 / 1 skip | 17 通过 / 1 skip |
| 类型检查 | ✅ | ✅ |
| 构建 | ✅ | ✅ |
| Lint | 5 error + 5 warning | 5 error + 5 warning(未新增) |
| 含中文导出体积 | ~7.3 MB | **~70 KB** |
| `dist/` 产物 | 64 MB | 64 MB(**未变,见下方说明**) |
| 死代码 | 4 个文件 / 288 行 | **已删除**(净减 288 行) |

> **关于 `dist/` 未变小**:O1 解决的是**导出产物**体积(用户拿到的 PDF),不是**应用包**体积。`public/fonts/` 的 41 MB 仍随 `vite build` 全量拷入 `dist/`,这是 C1,需另做(按需加载 / 字体子集化 / CDN)。

### 逐项落地

| 编号 | 状态 | 实际改动 |
|------|------|---------|
| **O1** | ✅ | `textBlockEdits.ts:173`、`flatten.ts:59` → `{ subset: true }`,重写错误注释;新增 `tests/unit/subset-embed.spec.ts`(2 例)。**已验证该测试在 `subset: false` 下失败**(7,463,782 B > 512,000 B) |
| **O2** | ✅ | `useKeyboardShortcuts.ts` 拆出 `KEY_TO_EVENT`,`i`/`s` 改为派发 `canva:open-image-picker` / `canva:open-signature`;`App.tsx` 新增 `SignatureOpener` 监听。新增 `tests/unit/shortcuts.spec.ts`(13 例) |
| **O4** | ✅ | `editorStore.ts` `inspectorCollapsed` 默认 `false` → `true`,与选中自动展开逻辑对齐 |
| **O5** | ✅ | `useKeyboardShortcuts.ts` 绑定 `Ctrl/Cmd+S` → `saveProject()` + toast;`ShortcutsModal.tsx` 新增「文件」分组;README 快捷键表同步 |
| **O6** | ✅ | `fontClassify.ts` 删除 `PdfFontStrategy` 的 `url` 字段(已确认消费方只读 `kind`),重写两处过期注释 |
| **O7** | ✅ | `resume.spec.ts` 改为 `existsSync` + `MINIPDF_RESUME_PDF` 环境变量,跳过时 `console.warn` 打印原因 |
| **O8** | ✅ | 删除 **4 个**死文件(比计划多一个):`templates/builtin.ts`、`templates/user-templates.ts`、`templates/thumbnail.ts`、`store/templateStore.ts`;清理 `App.tsx` 的 import 与空调用 |
| **O9** | ✅ | README 修正:MuPDF 30MB→10MB、字体 40MB→41MB、目录结构(移除不存在的 `ToolSidebar`/`FloatingTextToolbar`、补 `docs/` `scripts/` `fixtures/`)、决策 #7 补实测佐证、快捷键表与测试覆盖清单同步 |
| **O3** | ⬜ | 未执行 —— 会改变 Inspector 可见选项,需先确认产品意图 |
| **O10** | ⬜ | 未执行 |

### 意外收获

`core/templates/thumbnail.ts` 的 `generateThumbnail` 也是零调用(计划里没列)。`user.ts` 有自己私有的 `generateThumbnailDataUrl`,该模块是被遗忘的重复实现。一并删除。

### 待确认项

- **O3**:Inspector 的 7 项字体下拉是否保留「字体名」作为展示层?若保留,方案应为「5 类 FontClass 选择器 + 原字体名只读展示」;若不保留,直接换成 5 项。
- **O1 的目视确认**:实验证明字形轮廓齐全 + 文字可提取,但未做像素级渲染比对。建议人工打开一份导出 PDF 确认一次。
- **C1 仍未解**:41 MB 字体仍随包分发。可选方案见 validation-plan C1。

