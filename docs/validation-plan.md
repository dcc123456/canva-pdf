# Mini PDF 编辑器 — 功能验证计划

> 目标:系统性验证「样式是否符合用户行为」「功能是否缺失或多余」「功能是否可优化」三个问题。
> 本文档既是**执行清单**(逐项可勾选),也是**已定位问题的证据台账**(附文件:行号)。

---

## 1. 基线快照(已实测)

| 项目 | 结果 | 说明 |
|------|------|------|
| 开发服务器 | ✅ 正常 | `http://localhost:5173/`,Vite v8.1.0,HTTP 200 |
| 类型检查 | ✅ 通过 | `tsc -b --force`,0 错误 |
| 生产构建 | ✅ 通过 | `vite build`,1.36s,328 modules |
| **产物体积** | ⚠️ **64 MB** | `dist/`;其中 `dist/fonts` **41 MB(占 64%)** |
| Lint | ⚠️ 10 项 | 5 error + 5 warning,**全部为既有问题**(见下) |
| 单元 / 集成测试 | ✅ 63 通过 | 15 文件通过 / 1 文件永久 skip;63 用例通过 / 2 skip |
| 代码规模 | 14,017 行 | `src/` 53 个 `.ts` + 22 个 `.tsx`;`tests/` 15 → **17** 个 |
| 运行环境 | Node v22.22.2 / npm 10.9.7 | 依赖已安装完整 |
| 字体资源 | 4 个 OTF,**41 MB** | `public/fonts/SourceHan{Sans,Serif}CN-{Regular,Bold}.otf` |
| PDFium WASM | 4.5 MB | `dist/assets/pdfium-*.wasm` |
| MuPDF WASM | **10.0 MB** | `dist/assets/mupdf-wasm-*.wasm` —— README 称 ~30 MB,**实为 10 MB** |
| 主 JS chunk | 2.4 MB(903 KB gzip) | `dist/assets/index-*.js` |
| 内置模板 | **两套并存** | `registry.ts` 5 个 / `builtin.ts` 4 个(见 B3) |

**Lint 既有问题(与本次修复无关,可单独排期)**:

| 位置 | 级别 | 规则 |
|------|------|------|
| `src/components/ErrorBoundary.tsx:49` | error | `react-refresh/only-export-components` |
| `src/features/text-edit/RichTextEditor.tsx:278,280,284` | error | `react-hooks/refs`(render 期间访问 ref) |
| `src/features/text-edit/TextBlockEditLayer.tsx:119` | error | `react-hooks/refs` |
| `src/App.tsx:84`、`core/writer/formFields.ts:89`、`core/writer/textQuad.ts:108,133` | warning | 未使用的 `eslint-disable` |
| `src/hooks/useEngineLoad.ts:41` | warning | `exhaustive-deps` 缺失依赖 |

### 1.1 本轮变更快照(工具收敛)

上表是**当时的基线**,保留原样以便对照。本轮按「按任务收敛」重做功能面,实测结果:

| 项目 | 变更前 | 变更后 |
|------|------|------|
| 工具数 | 9 | **7**(选择 / 高亮 / 涂黑 / 画笔 / 签名 / 文字 / 图片) |
| 被移除的功能 | — | 便签、表单(AcroForm)、「编辑文字」工具、「打开项目」按钮 |
| 文本编辑入口 | 「编辑文字」工具 | 「选择」下**双击**文本块 |
| 全文格式化 | TopBar 常驻 checkbox | 打开 PDF 时**确认弹窗** |
| 快捷键 | `V E F H R N T I D S` | `V H R T I D S`(`E`/`F`/`N` 已失效) |
| 测试 | 63 通过 | **100 通过**(+37;新增 `loader-buffer` / `redact-modes` / `redact-export` 等) |
| 主 JS chunk (gzip) | 903 KB | **901 KB** |
| Lint | 10 项(5 error + 5 warning) | **9 项**(5 error + 4 warning)—— 均为既有问题 |
| 类型检查 / 构建 | ✅ | ✅ |

**本轮修掉的两个真实缺陷**(都不是"缺 UI",而是会直接报错/静默失败):

1. **模板抛 `Cannot perform Construct on a detached or out-of-bounds ArrayBuffer`** —— `loadDocument` 把调用方的 buffer 直接交给 pdfjs,而 pdfjs 会 transfer(detach)它;模板流程随后还要用同一份字节。修复:loader 恒给 pdfjs 私有副本。回归测试 `tests/unit/loader-buffer.spec.ts`(已验证:改回旧实现时该测试失败,buffer 变 0 字节)。
2. **模板"应用后空白页"** —— 未打开任何 PDF 时应用模板,`setDoc(null)` 落在已经是 `null` 的 state 上,React bail out,重载 effect 从不触发。修复:effect 同时以 `pdfBytes` 为依赖。见 `src/App.tsx`。

另修:签名底色透明(画布 `clearRect` + 棋盘格提示,导出保留 alpha)、模板无封面(内置模板封面按需渲染并缓存)。

---

## 2. 验证方法

### 三种手段

| 手段 | 适用维度 | 做法 |
|------|---------|------|
| **A. 人工走查** | 样式 / 交互 | 按「用户任务剧本」在浏览器逐条操作,记录期望 vs 实际 |
| **B. 代码审计** | 缺失 / 多余 | 对照 README + ADR 声明的能力,核查实现是否一致、是否有死代码 |
| **C. 自动化回归** | 可优化 | 补单测/集成测试,把「确认过的行为」固化为断言 |

### 判定标准(统一口径)

- **P0 — 功能不可用**:用户按正常预期操作,功能无响应或结果错误。必须修。
- **P1 — 功能不符合预期**:能用,但与用户直觉/文档声明不符。应修。
- **P2 — 体验 / 工程债**:不影响可用性,但造成困惑、冗余或维护成本。可排期。

### 必备样例素材 ✅ 已生成并校验

```bash
npm run fixtures          # 生成 + 校验(等价于下面两条)
npm run fixtures:verify   # 仅校验现有素材
```

素材写入 `fixtures/`(已加入 `.gitignore` —— S6 按设计超过 5 MB,不适合入库;脚本是确定性的,随时可重建)。

| 编号 | 文件 | 体积 | 覆盖内容 | 校验结果 |
|------|------|------|---------|---------|
| S1 | `s1-chinese.pdf` | 207 KB | 思源黑/宋体各 Regular + Bold、中文标点、数字混排 | ✅ 1 页 / 14 个 text item / 含中文与标点 |
| S2 | `s2-mixed-color.pdf` | 48 KB | **同一段落内**黑+红、黑+红+橙、中英混排 | ✅ 12 个 text item / 中英齐备 / 含 ERROR+WARN |
| S3 | `s3-multipage.pdf` | 19 KB | 12 页,每页 4×4 矢量表格线 + 栅格图 + 10 行正文 | ✅ 12 页 / 820 字符 / 含 image xobject |
| S4 | `s4-acroform.pdf` | 7 KB | 文本域、复选框、单选组、下拉框各一 | ✅ 4 字段,类型与名称全部匹配 |
| S5 | `s5-scanned.pdf` | 171 KB | 2 页整页位图,**无文字层** | ✅ **0 个 text item** / 含 image xobject |
| S6 | `s6-large.pdf` | 7.14 MB | 25 页中文正文,整字重嵌入 | ✅ 25 页 / >5 MB / 含中文文字层 |

**关于 S5 的说明**:它是脚本合成的"伪扫描件"(白底 + 灰度噪点 + 深色文本条),不是真实扫描图。目的是提供**确定无文字层**的输入来验证降级路径。若需真实扫描件,请自行替换同名文件后重跑 `npm run fixtures:verify`。

**关于 S4 的说明**:下拉框选项用 ASCII(`Beijing/Shanghai/Shenzhen`)。pdf-lib 生成表单外观流时用 WinAnsi 编码,写入中文选项有编码风险,故未使用中文。若需验证中文表单值,请在应用内手动输入。

**已知噪声**:S1/S2/S6 的 CJK 字体以 `subset: true` 嵌入,pdfjs 读取时会输出大量 `Out of bounds subrIndex for callsubr` / `getFontFileType: Unable to detect correct font file Type/Subtype` 警告。**文字仍可正常提取**(S1 提取到 14 个 text item),校验脚本已把 verbosity 降到只报错误。这个现象与 B2 相关 —— 见下方补充。

---

## 3. 维度 A — 样式 / 交互是否符合用户行为

### A1 【P0 → ✅ 已修复】缩放「放大」在 100% 及以上完全失效

**证据**:`src/store/editorStore.ts:4`(档位)+ `:56-67`(`findClosestZoom`)

```
ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4]
zoomIn  = findClosestZoom(current + 0.25)
```

实测步进轨迹:

```
zoomIn  从 1.0 起 : 1 -> 1 -> 1 -> 1 -> 1 -> 1 -> 1   ← 永远不动
zoomOut 从 1.0 起 : 1 -> 0.75 -> 0.5 -> 0.25 -> 0.25  ← 到 25% 后卡死
```

**根因**:`findClosestZoom(1.25)` 时 `|1.25-1| == |1.25-1.5| == 0.25`,而比较用的是严格小于 `d < bestDiff`,数组靠前的 1.0 胜出 → 不变。同样的并列出现在 1.5→1.75、2→2.25、4→4.25。

**影响**:底栏 `+` 按钮 与 `+`/`=` 快捷键 在默认 100% 缩放下**完全无响应**。这是用户最先会点的按钮之一。

**验证步骤**:
1. 打开任意 PDF(默认 100%)
2. 点击底栏 `+`(或按 `+` 键)3 次
3. 观察百分比读数

**判定**:读数应递增到 150% / 200% / 400%。当前为**恒定 100%** → 不通过。

**修复方向**:改用「按索引步进」而非「按数值就近吸附」——`zoomIn` 取当前档位在 `ZOOM_LEVELS` 中的下一个索引;或把比较改为 `<=` 并配合向上取整。同时补 `1.25 / 3 / 6` 等档位。

**✅ 已修复(2026-09-12)**

`src/store/editorStore.ts` 中删除 `findClosestZoom`,改为 `stepZoom(current, direction)` —— 取「严格大于 / 严格小于当前值的最近档位」,两端做钳制:

```ts
function stepZoom(current: number, direction: 1 | -1): number {
  const base = ZOOM_LEVELS;
  const EPS = 1e-6;
  if (direction === 1) {
    for (const z of base) if (z > current + EPS) return z;
    return base[base.length - 1];
  }
  for (let i = base.length - 1; i >= 0; i -= 1) if (base[i] < current - EPS) return base[i];
  return base[0];
}
```

选择「严格大于/小于」而非「索引 ±1」的原因:后者在遇到非档位值时(如未来"适应宽度"算出的 0.9)会先吸附到最近档位再跳档,0.9 → 1.5 会漏掉 1.0;前者天然不跳档。

**回归测试**:`tests/unit/zoom.spec.ts`(6 个用例)—— 覆盖「从默认 100% 放大」、「走遍所有档位(上/下)」、「非档位值不跳档」、「上下往返」。这些用例在旧实现上必然失败。

**未做(仍列为 C4)**:补充 `1.25 / 3 / 6` 档位、增加"适应宽度/页面"。本次只修 P0 逻辑错误,不扩大 UX 变更面。

---

### A2 【P1】`I` / `S` 快捷键与工具栏按钮行为不一致

**证据**:
- `src/hooks/useKeyboardShortcuts.ts:20-21` — `i → setTool('image')`、`s → setTool('signature')`
- `src/components/Toolbar.tsx:54-62` — `pickTool()` 对 `image` / `signature` **拦截**,改为调用 `onPickImage()` / `onOpenSignature()`,**不设置工具**
- 同文件 `:2-3` 注释声称 "image / signature only surface the picker" —— 与实现相反

**影响**:点「图片」按钮会弹出文件选择框;按 `I` 只把按钮高亮,什么都不会发生。用户会以为坏了。

**验证步骤**:分别用「点击按钮」和「按快捷键」触发 图片 / 签名,对比是否都弹出对应 UI。

**判定**:两条路径行为应一致。当前不一致 → 不通过。

---

### A3 【P1】Inspector 字体下拉与真实渲染管线脱节

**证据**:
- `src/components/Inspector.tsx:21-29` — 字体候选 `Helvetica / TimesRoman / Courier / SimSun / SimHei / Microsoft YaHei / KaiTi`(7 项)
- `src/core/engine/fontClassify.ts:92-106` — 规范模型是 **5 类 FontClass**,靠关键词匹配
- `fontClassify.ts` 的关键词表中 **没有 `kaiti` / `楷体`** → `classifyFont('KaiTi')` 返回 `null`,最终走 `classifyByContent` 兜底
- `src/features/text-edit/RichTextEditor.tsx:473-477` — 画布内富文本工具条用的是另一套 5 项标签(`无衬线 / 衬线 / 等宽 / 中文无衬线 / 中文衬线`)

**影响**:同一个应用里存在**两套字体 UI**。用户在 Inspector 选「楷体」不会得到楷体;选「SimSun」和「Microsoft YaHei」的差异也被折叠成 `cjk-serif` / `cjk-sans` 两类。选「Helvetica」与「Arial」等价但界面呈现为不同选项 → 属"多余选项"。

**验证步骤**:
1. 新建一个文字叠加层,输入中文
2. 依次选择 `KaiTi` / `SimSun` / `Microsoft YaHei`,记录画布渲染字体
3. 分别导出,用 PDF 阅读器查看嵌入字体名

**判定**:所选项与渲染/导出结果应一一对应。当前 `KaiTi` 无法映射 → 不通过。

**修复方向**:Inspector 与 RichTextEditor 统一为同一套 5 项 FontClass 选择器(消除重复 UI);若要保留字体名,需在 `fontClassify.ts` 补齐 `kaiti` 等关键词,并明确"字体名仅作显示、渲染一律走 FontClass"。

---

### A4 【P1】默认工具为「编辑文字」,打开 PDF 即触发 30 MB WASM 加载

**状态:⚠️ 部分处理 —— 默认工具已改,但重载成本仍在**

**证据**:
- `src/store/editorStore.ts:72` — `tool: 'edit-text'`(默认)
- `src/components/Toolbar.tsx:52` — `useAutoDetectTextBlocks()`
- `src/components/Toolbar.tsx:63-68` — 切换工具即 `runEngineDetection(t)`
- `src/components/TopBar.tsx:126-128` — 检测/引擎加载期间全屏 `LoadingOverlay`

**影响**:只想"看 PDF"的用户,一打开文件就被全屏遮罩挡住 1–3 秒。且 README 快捷键表把 `V 选择` 列在首位,暗示"选择"才是主工具。

**验证步骤**:清空 localStorage → 打开 S3(多页 PDF)→ 计时全屏遮罩出现到消失。

**判定**:默认应不阻塞阅读。当前默认工具即触发重型检测 → 存疑,建议默认 `select`。

**实际处置(部分)**:默认工具已改为 `select`(「编辑文字」工具整体移除)。但**重载成本没有消失** —— 因为文本编辑改为「选择」下双击进入,而双击要有块可点,所以自动检测跟着挂到了 `select` 上。行为与改动前一致:打开 PDF 仍会加载 MuPDF WASM 并显示进度遮罩。

**未决的取舍(留给后续决策,本轮未动)**:

| 方案 | 打开 PDF | 可发现性 | 代价 |
|---|---|---|---|
| 现状:`select` 下自动检测 | 1–3s 遮罩 | 好 —— 文本块有 hover 轮廓,提示"这里能点" | 每个 PDF 都付 WASM 成本 |
| 懒检测:首次双击才检测 | 即时 | 差 —— 空白页看不出哪里能编辑 | 双击后要等 1–3s,且需把 `editingIdRef` 提升到 store 以便检测完成后自动进入编辑 |

这不是纯性能问题:两种方案在**可发现性**上是对立的。本轮只做了用户明确要求的"工具收敛",没有替用户做这个决定。

---

### A5 【P2】Inspector 默认展开,与「选中才出现属性」的 Canva 行为自相矛盾

**证据**:
- `src/store/editorStore.ts:77` — `inspectorCollapsed` 默认 `false`(即展开)
- `src/store/editorStore.ts:76` — `sidebarCollapsed` 默认 `true`(缩略图默认隐藏)
- `src/App.tsx:59-68` — 存在「选中元素时自动展开 Inspector」的逻辑,说明设计意图是"默认收起"

**影响**:未选中任何元素时,右侧属性面板已占据空间且内容为空。同一设计里两条规则打架。

**验证步骤**:清空 localStorage → 打开应用 → 观察右侧面板初始状态;再选中一个元素观察是否变化。

**判定**:若默认展开且选中时不产生可见变化,则该自动展开逻辑为冗余 → 不通过。

---

### A6 【P2】LoadingOverlay 在引擎初始化期间进度恒为 0

**证据**:`src/components/TopBar.tsx:127` — `const overlayProgress = mupdfLoading ? 0 : detectionProgress;`

**影响**:30 MB WASM 加载全程进度条停在 0%,用户无法判断是"卡死"还是"在加载"。

**验证步骤**:首次启用编辑文字工具,观察进度条数值变化。

**判定**:进度条应有推进(哪怕是不确定态动画)。恒 0 且无动画 → 不通过。

---

### A7 【P2】状态反馈三通道并存,同一动作重复提示

**证据**:
- `src/components/TopBar.tsx:68-82` — 导出成功后**同时**执行 `setStatusMsg('已导出 …')` 与 `toast.success('PDF 已导出')`
- `src/components/TopBar.tsx:214-218` — 右上角同时渲染 `statusMsg` 与 `engineStatusMessage`

**影响**:一次导出出现两处提示;三套状态源(局部 statusMsg / toast / engineStatusMessage)让"以哪个为准"变得模糊。

**验证步骤**:点击导出,数一数同时出现了几处提示。

**判定**:同一动作应只有一处反馈 → 不通过。

---

### A8 【P2】工具栏图标为 Unicode 字形,语义模糊且跨平台不一致

**状态:✅ 已解决**(经竞品分析 R3 落地)

**证据**:`src/components/Toolbar.tsx:22-30` — 图标为 `↖ ✎ ☐ ◑ ☰ T ▦ ✏ ✒`,仅靠 `title` 提示,无可见文字标签。

**影响**:`✎`(编辑文字)/ `T`(文字)/ `↖`(选择)三者视觉相近,新用户难以区分;Unicode 字形在 Windows / macOS / Linux 渲染差异明显。

**验证步骤**:在三类系统各截一张工具栏图对比;请非项目成员仅看图标说出每个按钮含义。

**判定**:识别率低或平台差异明显 → 建议改 SVG 图标 + 悬停文字标签。

**实际处置**:工具栏改为 3 个任务分组(**编辑** / **注释** / **插入**)+ 每个按钮带可见文字标签,不再依赖用户辨认字形。Unicode 跨平台渲染差异仍在,但已不影响语义识别(标签是文字)。截图见 `docs/competitive-analysis.md` §5.1。

---

### A9 【P2】`--accent` 主题色未覆盖全部选中态,存在硬编码蓝色

**证据**:
- `src/components/Inspector.tsx:174-176` — `ToggleButton` 选中态硬编码 `border-blue-500 bg-blue-100 text-blue-800`
- `src/components/BottomBar.tsx:44` — 页面按钮选中态硬编码 `border-blue-500 bg-blue-50 text-blue-700`
- 对比 `src/components/Toolbar.tsx:85` — 工具选中态使用 `var(--accent-light)` / `var(--accent-text)`

**影响**:切换主题色为「紫色 / 绿色 / 玫瑰 / 琥珀」后,工具条跟随变色,但 Inspector 的粗体/斜体按钮与底栏「页面」按钮仍是蓝色 → 主题色系统不完整。

**验证步骤**:把主题色切到「紫色」,逐个检查所有选中态按钮。

**判定**:所有选中态应随主题色变化。出现残留蓝色 → 不通过。

---

## 4. 维度 B — 功能缺失 / 多余

### B1 【P0 → ✅ 已修复】导出丢失 `fontClass` / `bold` / `italic`(仅限「文字」叠加层)

**证据**:
- `src/core/writer/flatten.ts:46-51` — `getFontForText(text, bold, italic, fontName)` **没有 `fontClass` 参数**
- `src/core/writer/flatten.ts:57` — CJK 分支恒调用 `loadCjkFontBytes()`,即固定 `('cjk-sans', 'regular')`
- 对比 `src/core/writer/textBlockEdits.ts:162-167` — 编辑过的文本块**正确**按 `(fontClass, weight)` 加载变体

**影响**:用「文字」工具(T)插入一段中文,设为「中文衬线」或加粗,画布显示正确,但**导出后变成思源黑体常规体**。同一份文档里"编辑过的原文"和"新加的文字"导出结果不一致。

**验证步骤**:
1. 用「文字」工具插入 `测试中文 Serif Bold`,字体选「中文衬线」并加粗
2. 用「编辑文字」工具把页面上一段原文改成同样的样式
3. 导出,用 PDF 阅读器检查两段文字的实际字体

**判定**:两段应同为思源宋体粗体。当前新加的那段为思源黑体常规 → 不通过。

**修复方向**:给 `getFontForText` 增加 `fontClass` 参数,复用 `loadCjkFontBytesForVariant(fontClass, weight)` 与 `pickStandardFontVariant`。

**✅ 已修复(2026-09-12)**

`src/core/writer/flatten.ts` 的改动:

1. `getFontForText(text, bold, italic, fontName, fontClass)` 增加第 5 个参数
2. 删掉单个 `cjkFont` 变量,改为按 `(fontClass, weight)` 分桶的 `cjkFontCache` + `cjkFontAttempted`,与 `textBlockEdits.ts` 的 `getFont` 对齐
3. CJK 分支改用 `loadCjkFontBytesForVariant(effectiveClass, weight)`,**Bold 走真 Bold 字重文件**
4. 两处调用点传入 fontClass:segments 路径用 `seg.fontClass ?? item.fontClass`,整段路径用 `item.fontClass`
5. 保留原有的防御性兜底:fontClass 为 `sans` 但文本含 CJK(旧项目数据)时仍降级到 `cjk-sans`,避免中文被写成 `?`
6. 抽出 `toAsciiSafe()` 消除两处重复的内联循环

**回归测试**:`tests/unit/flatten-font.spec.ts`(7 个用例)—— 用 `vi.mock` 拦截 `loadCjkFontBytesForVariant` 并断言**被请求的变体**。旧实现恒调 `loadCjkFontBytes()`,该 mock 根本不会被触发,因此用例在旧代码上必然失败。

**残留限制(已写入代码注释)**:
- CJK italic 在 flatten 路径不生效(依赖 CTM 斜切模拟,目前仅 `textBlockEdits` 实现)。中文字体本身无 italic 变体,影响面小,但仍属未对齐。
- `subset: false` 仍在(见 B2),本次未动 —— 它属于独立的体积问题,改动风险更高。

---

### B2 【P1】CJK 字体整字重嵌入,README 声称的「子集化」实际被关闭

**证据**:
- `src/core/writer/textBlockEdits.ts:170-173` — `doc.embedFont(bytes, { subset: false })`,注释说明 `subset: true` 对 CID/CFF 可能产生不完整子集
- `src/core/writer/flatten.ts:59` — 同样 `{ subset: false }`
- `README.md` 决策 #7 — "**CJK 字体子集化** … 避免 PDF 体积爆炸"
- 字体文件单个 **8–12 MB**

**影响**:任何一次涉及中文的导出,都会把 8 MB(黑体)或 12 MB(宋体)整字体塞进 PDF;若同时用到粗体,再叠加一份。**README 的承诺与代码相反**,这是文档与实现的双重问题。

**验证步骤**:导出一份仅含 10 个中文字的 PDF,记录文件大小;对比原始 PDF 大小。

**判定**:体积增量应在数十 KB 量级。当前为 MB 量级 → 不通过。

**修复方向**:二选一 —— (a) 换用可安全子集化的字体文件(如 TTF 而非 CFF/OTF,或改 `@pdf-lib/fontkit` 的子集策略);(b) 如实修订 README,把"子集化"改为"整字体嵌入",并把体积影响写进已知限制。

**生成素材时得到的旁证(2026-09-12)**:S1/S2/S6 用 `subset: true` 嵌入思源字体后,pdfjs 读取时输出大量 `Out of bounds subrIndex for callsubr`、`Not enough parameters for vhcurveto`、`getFontFileType: Unable to detect correct font file Type/Subtype` 警告。但**文字提取仍然成功**(S1 提取到 14 个 text item,内容完整)。

这说明:代码注释里"`subset: true` 对 CID/CFF 可能产生不完整子集,导致中文字形缺失"的说法,**至少对"文字提取"这一路径不成立** —— 子集字体可被解析。但它是否影响**字形渲染**(即字符是否显示为豆腐块)未被验证。

**建议的验证实验**(成本很低,建议排进第 2 轮):
1. 用 `subset: true` 生成一份含 200 个不同汉字的 PDF
2. 在应用内打开,检查每个字是否正常显示
3. 若正常 → 说明子集化可行,`subset: false` 可以改成 `true`,导出体积从 MB 级降到 KB 级,B2 直接消解
4. 若不正常 → 说明注释的担忧成立,只需修订 README 表述

这个实验值得优先做 —— 它可能一次性消解 B2 和 C1 两个问题。

---

### B3 【P1】两套模板子系统并存,其中一套为死代码(~370 行)

**证据**:

| 子系统 | 内置模板 | 用户模板持久化 | 是否被 UI 使用 |
|--------|---------|--------------|--------------|
| `core/templates/registry.ts` | 5 个:`blank-a4` `blank-letter` `resume-modern` `invoice` `meeting-notes` | — | ✅ `TemplateGallery.tsx:15` |
| `core/templates/builtin.ts` | 4 个:`简历` `发票` `合同` `便签` | — | ❌ |
| `core/templates/user.ts` | — | localStorage `canva.userTemplates` | ✅ `TemplateGallery.tsx:20` |
| `core/templates/user-templates.ts` | — | IndexedDB `minipdf/templates` | ❌ |

- `src/store/templateStore.ts:11,28` 引用了 `builtin.ts` + `user-templates.ts`
- `useTemplateStore` 全项目**仅在 `src/App.tsx:19,39` 出现**,且只是 `useTemplateStore.getState()`(为"构造 store"),**没有任何组件订阅其数据**

**影响**:同一功能两套实现,两套内置模板清单(5 vs 4)、两套用户模板存储(localStorage vs IndexedDB)。README 决策 #9 明确写"用 localStorage 而非 IndexedDB",说明 IndexedDB 那套是被废弃的方案,但仍随代码分发。维护者极易改错文件。

**验证步骤**:搜索 `useTemplateStore` / `listBuiltinTemplates` 的全部引用,确认无组件消费。

**判定**:确认无消费方 → 删除 `templateStore.ts` + `builtin.ts` + `user-templates.ts`,并同步 README 目录结构。

---

### B4 【P1】`resume.spec.ts` 永久跳过,依赖 Windows 硬编码路径 → 虚假覆盖率

**证据**:`tests/integration/resume.spec.ts:10` — 读取 `d:\文档\pdf\resume.pdf`,且 `@vitest-environment node`

**影响**:README「测试 / Coverage」一节把它列为"简历模板端到端流程"的覆盖,**但它在 macOS / Linux 上永远不会执行**。测试报告显示的"1 skipped"掩盖了这个空洞。该文件本是 `Invalid UTF-8 leading byte 0xa1` 回归的防线。

**验证步骤**:跑 `npm run test`,确认该文件状态为 skipped;检查其依赖的绝对路径是否存在。

**判定**:测试应可复现运行。依赖本机绝对路径 → 改为 fixture 相对路径 + 环境缺失时 `describe.skipIf` 并打印原因,或直接删除。

---

### B5 【P1】缺失:适应宽度 / 适应页面缩放

**证据**:`src/store/editorStore.ts:4` — `ZOOM_LEVELS` 仅 7 个固定档位;`src/components/BottomBar.tsx:131-144` 为固定档位下拉。全项目无 `fitWidth` / `fitPage` / `scaleMode` 相关实现。

**影响**:阅读 PDF 时最常用的两种缩放模式(适应宽度 / 适应整页)不存在。用户被迫手动试档位。这是 PDF 阅读器的基线能力。

**验证步骤**:在缩放控件中寻找"适应宽度/适应页面"入口。

**判定**:不存在 → 判定为缺失。

---

### B6 【P1】缺失:PDF 内文本搜索

**证据**:全项目无文本搜索实现;`useKeyboardShortcuts.ts` 未绑定 `Ctrl/Cmd+F`。

**影响**:PDF 编辑器/阅读器的高频功能。20 页以上文档(S6)无法定位内容。

**验证步骤**:按 `Ctrl/Cmd+F`,观察是否有搜索 UI。

**判定**:无 → 判定为缺失(可视排期决定是否做)。

---

### B7 【P2】WebP 静默丢弃 —— 应在导入时拦截,而非导出时告警

**证据**:README「已知限制」—— "图片可上传 WebP 但 pdf-lib 仅支持 PNG/JPG,导出时 WebP 会被跳过并打印警告"

**影响**:用户上传 WebP 后一切正常(画布可见),导出时该图片**无声消失**,只在控制台留一条警告。这是静默数据丢失,对普通用户等于"图片丢了"。

**验证步骤**:上传一张 WebP → 确认画布显示 → 导出 → 在 PDF 中查找该图片。

**判定**:应在导入时立即提示"WebP 暂不支持导出,请改用 PNG/JPG"并拒绝或自动转码。当前静默跳过 → 不通过。

---

### B8 【P2】缺失:导出 / 保存快捷键

**证据**:`src/hooks/useKeyboardShortcuts.ts` 仅绑定工具切换、Delete、Esc、撤销/重做。导出(`Ctrl/Cmd+E`?)、保存项目(`Ctrl/Cmd+S`)无快捷键。

**影响**:导出是核心动作,却只能鼠标点击。用户按 `Ctrl+S` 会触发浏览器"保存网页",体验割裂。

**验证步骤**:按 `Ctrl/Cmd+S`,观察是否触发浏览器原生保存对话框。

**判定**:应被应用拦截并映射到「保存项目」→ 当前不通过。

---

### B9 【P2】功能重叠:`select` 与 `edit-text` 的边界模糊

**状态:✅ 已解决**(经竞品分析 R3 落地)

**证据**:`src/core/types.ts:3-12` 定义 9 个工具;`src/components/Toolbar.tsx:21-31` 中 `select(↖)` 与 `edit-text(✎)` 相邻,`text(T)` 与二者语义交叉。

**影响**:三个工具都与"文字/选中"相关,用户难以预判用哪个。需明确:**select** = 选中/移动已有叠加层;**edit-text** = 编辑 PDF 原有文字;**text** = 新建文字框。

**验证步骤**:请测试者描述三者的区别;观察是否存在"用错工具后无反馈"的情况。

**判定**:若无法用一句话区分,或误用后无提示 → 需要更清晰的图标/标签/空态引导。

**实际处置(两步)**:第一步(R3)把三者的文字标签直接写在按钮上 —— 「选择」/「编辑文字」/「文字」,并按任务分组,`select` 与 `edit-text` 归入「编辑」组,`text` 归入「插入」组。

第二步(工具收敛)**从根上消除了重叠**:`edit-text` 工具被删除,文本编辑改为「选择」下双击文本块。现在只剩两个语义清晰的概念 —— 「选择」(选中/移动叠加层 + 双击改原有文字)与「文字」(新建文字框),不再需要用户区分三个相近工具。快捷键 `E` 随之移除。

---

### B10 【P2】`README.md` 目录结构与实际不符

**证据**:
- README 列 `components/` 含 `ToolSidebar` 与 `FloatingTextToolbar` —— **两个文件均不存在**
- `src/components/Toolbar.tsx:1-3` 注释明确写 "Replaces the vertical ToolSidebar"
- README 列 `core/templates/` 含 `registry / builtin / user / user-templates / thumbnail`,未说明 `registry` 与 `builtin` 是两套并行系统(见 B3)

**验证步骤**:逐条比对 README 目录树与 `find src -type f`。

**判定**:应完全一致 → 当前不通过。

---

## 5. 维度 C — 可优化项

### C1 【P1】41 MB 字体资源无条件随包分发(实测产物 64 MB)

**证据**:`public/fonts/` 下 4 个 OTF 共 **41 MB**;`src/index.css:7` 用 `@font-face` 加载,`cjkFont.ts:95` 在导出时按需 `fetch`。

**实测**:`npm run build` 后 `dist/` 总计 **64 MB**,其中 `dist/fonts` **41 MB(占 64%)**。`vite build` 会把 `public/` 全量拷入产物,不做任何裁剪。

**问题**:即使文档全是英文,41 MB 字体也会随产物分发;用户是否实际下载取决于 `@font-face` 是否被触发。

**优化方向**:
- 用 `unicode-range` 或按需 `@font-face`(`font-display: swap`)避免首屏拉取
- 考虑改用体积更小的子集字体(仅常用 3500 字 → 单文件可降到 ~2–3 MB)
- 或改为 CDN 按需加载(`cjkFont.ts:57-61` 已有 CDN 兜底,可把本地文件降为可选项)

**验证方法**:构建后统计 `dist/` 体积;用 DevTools Network 面板观察打开英文 PDF 时的实际字体请求。

---

### C2 【P1】导出成本随页数线性增长,ADR 0004 的分页流水线未落地

**证据**:`docs/adr/0004-paginated-detection-redraw-pipeline.md` 状态为「规划中」;README 已知限制列出"分页检测流水线待落地 …大文档导出仍可能在主线程阻塞数秒"。

**优化方向**:按 ADR 0004 实施 —— 打开 PDF 时同步检测当前页,其余页交由 Web Worker 后台逐页检测,导出时等待就绪并显示进度。

**验证方法**:用 S6(20 页+)计时导出,记录主线程阻塞时长(Performance 面板观察 long task)。

---

### C3 【P1】检测结果未做跨会话缓存

**证据**:`useAutoDetectTextBlocks`(`src/features/text-edit/useAutoDetectTextBlocks.ts`)每次进入页面按需触发;`engineStore` 无持久化。切换页面再切回,或重新打开同一文件,均需重跑检测。

**优化方向**:按 `(文件指纹, 页码)` 缓存检测结果;对同一文件重复打开复用缓存。

**验证方法**:打开 S3 → 逐页翻一遍 → 回到第 1 页,观察是否重跑检测(看 LoadingOverlay 与控制台日志)。

---

### C4 【P2】缩放档位稀疏且步进语义错误

**证据**:见 A1。`ZOOM_LEVELS` 缺 `1.25 / 3 / 6`;`findClosestZoom` 的"就近吸附"模型与"逐档步进"的用户预期不符。

**优化方向**:改为索引步进;补充常用档位;增加"适应宽度/页面"作为档位之外的独立模式。

---

### C5 【P2】`FONT_CLASS_TO_PDF_STRATEGY` 的 `url` 字段已失效,注释过期

**证据**:
- `src/core/engine/fontClassify.ts:237-249` — `cjk-sans` / `cjk-serif` 各只声明一个 `url`(恒为 Regular)
- 消费方 `textBlockEdits.ts:139,337,430` **只读取 `kind` 判别式**,真实加载走 `loadCjkFontBytesForVariant(fontClass, weight)`
- 同文件 `:251-254` 注释仍写 "CJK 路径目前只有 Regular,粗斜体用 stroke/skew 模拟" —— 与 `cjkFont.ts` 已支持真 Bold 字重的事实**矛盾**

**优化方向**:删除失效的 `url` 字段(或补全 `{regular, bold}`),更新注释。避免后续维护者按错误注释改代码。

---

### C6 【P2】`cjkFont.ts` 保留多个废弃 API

**证据**:`src/core/writer/cjkFont.ts:79` `setCjkSansFontBytes`、`:147` `loadCjkFontBytes` —— 注释自述"旧 API 保留:等价于 …"

**优化方向**:确认无外部消费后删除,减少导出端分支。

---

### C7 【P2】笔迹贝塞尔曲线被线性化

**证据**:README 已知限制 —— "画笔精度:贝塞尔曲线被线性化,放大后可见到多边形锯齿"

**优化方向**:改为在 PDF 中输出真实贝塞尔曲线(`page.drawSvgPath` 支持 `C` 指令),而非折线逼近。

**验证方法**:用画笔签个名 → 放大到 400% → 观察曲线边缘。

---

### C8 【P2】`documentStore` 之外的状态变更不可撤销

**证据**:`README` 决策 #8 —— "撤销/重做基于 Immer patches … 代价:不能撤销跨 store 的副作用"

**现状**:页面增删(`documentStore.addPage/removePage`)可撤销;但缩放、切页、工具切换(`editorStore`)不入历史。需确认这是**有意为之**还是遗漏 —— 若用户误删页面后 `Ctrl+Z`,再改一次缩放,撤销栈是否仍指向正确的页面操作。

**验证方法**:新增页 → 撤销 → 缩放 → 再撤销 → 观察撤销目标是否符合预期。

---

### C9 【P2】测试覆盖集中在纯函数,缺少交互路径

**证据**:`tests/unit/` 覆盖 `coords / serialize / history / export-pages / detectTextBlocks / registry / toast / engineStore / mupdfEngine / pdfiumEngine / readUtf16LE` —— 全为纯函数/状态机。**没有任何组件级测试**(`RichTextEditor` 的 TipTap 往返、`Inspector` 的字段编辑、拖拽/缩放交互均未覆盖)。

**优化方向**:引入 `@testing-library/react`(已装)补组件测试,优先覆盖:
- TipTap 富文本往返(`segments` ↔ HTML)
- Inspector 数值字段 → store 更新
- 工具切换 → 检测触发(见 A2,可把修复固化为断言)

---

## 6. 建议执行顺序

> **进度**:第 1 轮的基线采集已完成(见第 1 节),两个 P0 已修复并补了回归测试(见 A1 / B1)。第 2–4 轮待执行。

### 第 1 轮 — 补齐基线 + 确认 P0 ✅ 已完成

1. ✅ 跑 `npm run typecheck` / `npm run lint` / `npm run build`,记录结果与 `dist/` 体积(64 MB,字体占 41 MB)
2. ✅ 按 S1–S6 生成样例素材 —— `npm run fixtures`,20/20 校验项通过(见第 2 节)
3. ✅ 确认并修复 **A1(缩放失效)**、**B1(导出丢字体)**,各配回归测试
   - 测试从 50 通过 → **63 通过**(新增 `tests/unit/zoom.spec.ts` 6 例 + `tests/unit/flatten-font.spec.ts` 7 例)
   - 类型检查通过;构建通过;lint 未新增问题

> **第 2 轮可以开始了** —— 素材已就绪。建议先做 B2 里的那个「子集化可行性实验」,它成本低、可能一次性消解 B2 + C1。

### 第 2 轮 — 人工走查三个维度(1 天)

4. 按「用户任务剧本」走查:打开 → 阅读(翻页/缩放) → 编辑文字 → 加叠加层 → 表单 → 导出 → 保存/重开项目
5. 逐条勾选 A1–A9、B1–B10、C1–C9,记录期望 vs 实际
6. 产出「问题清单」:编号 / 维度 / 优先级 / 复现步骤 / 期望 / 实际 / 截图

### 第 3 轮 — 代码审计收口(半天)

7. 对照 README + 4 份 ADR 逐条核查实现一致性(重点:B2 子集化、B3 双模板系统、B10 目录结构)
8. 确认死代码清单(建议用 `knip` 或 `ts-prune` 辅助),评估删除影响面

### 第 4 轮 — 修复 + 回归(按优先级排期)

9. 修 P0 → 补回归测试(把 A1 的档位步进、B1 的字体变体选择固化为单测)
10. 修 P1 → 同步修订 README(尤其 B2 的"子集化"表述)
11. P2 按价值排序

---

## 7. 交付物

| 交付物 | 形式 | 说明 |
|--------|------|------|
| 验证执行清单 | 本文档勾选版 | 逐项标注 通过 / 不通过 / 待验证 |
| 问题清单 | 表格 | 编号 / 维度 / 优先级 / 复现步骤 / 期望 / 实际 / 截图 |
| 死代码清单 | 文件列表 + 影响面 | 含 B3 的两套模板子系统 |
| 文档修订单 | README diff | 修正 B2 子集化、B3 双模板、B10 目录结构 |
| 回归测试 | `tests/` 新增用例 | 优先覆盖 A1、A2、B1 |

---

## 附录 A — 已实测确认的缺陷

> **首轮已修复 11 项**(A1 A2 A5 B1 B2 B3 B4 B8 B10 B11 C5)。修复过程与验收指标见 [`optimization-plan.md`](./optimization-plan.md) §3。
> **竞品分析后追加修复 2 项**:A8 + B9(工具栏按任务分组 + 可见文字标签,见 [`competitive-analysis.md`](./competitive-analysis.md) §5.1)。
> 仍待处理:**A3**(字体 UI 统一,需设计确认)、**A4/A6/A7/A9**、**B5/B6/B7**、**C1/C2/C3/C4/C7/C8/C9**。

| 编号 | 优先级 | 状态 | 缺陷 | 证据 | 确认方式 |
|------|--------|------|------|------|---------|
| A1 | **P0** | ✅ **已修复** | 缩放「放大」在 100% / 150% / 200% / 400% 全部失效 | `editorStore.ts:4,56-67` | ✅ 已用脚本实测步进轨迹 |
| B1 | **P0** | ✅ **已修复** | 「文字」叠加层导出丢失 fontClass / bold / italic | `flatten.ts:46-51,57` | ✅ 代码审计(与 `textBlockEdits.ts:162-167` 对比) |
| A2 | P1 | ✅ **已修复** | `I`/`S` 快捷键与按钮行为不一致 | `useKeyboardShortcuts.ts:20-21` vs `Toolbar.tsx:54-62` | ✅ 代码审计(两处实现互斥) |
| A3 | P1 | 待修 | Inspector 字体下拉 7 项 vs 规范 5 类,`KaiTi` 无映射 | `Inspector.tsx:21-29` + `fontClassify.ts:92-106` | ✅ 代码审计 |
| B2 | P1 | ✅ **已修复** | CJK 整字重嵌入,README「子集化」未生效 | `textBlockEdits.ts:173`、`flatten.ts:59`、README 决策 #7 | ✅ 代码审计(`subset: false` 显式写出) |
| B3 | P1 | ✅ **已修复** | 两套模板子系统,一套为死代码(实为 4 个文件 / 288 行) | `templateStore.ts` / `builtin.ts` / `user-templates.ts` / `thumbnail.ts` | ✅ 引用链审计(无组件订阅) |
| B4 | P1 | ✅ **已修复** | `resume.spec.ts` 永久 skip(依赖 `d:\` 路径) | `tests/integration/resume.spec.ts:10` | ✅ 测试运行实测 1 file skipped |
| B8 | P2 | ✅ **已修复** | 缺失导出/保存快捷键 | `useKeyboardShortcuts.ts` 原仅绑定工具切换 | ✅ 代码审计 |
| A5 | P2 | ✅ **已修复** | Inspector 默认展开,与选中自动展开逻辑矛盾 | `editorStore.ts:77` + `App.tsx:59-68` | ✅ 代码审计 |
| A9 | P2 | 待修 | 主题色未覆盖 Inspector / BottomBar 选中态 | `Inspector.tsx:174-176`、`BottomBar.tsx:44` | ✅ 代码审计(硬编码 blue) |
| B10 | P2 | ✅ **已修复** | README 目录树含不存在的 `ToolSidebar` / `FloatingTextToolbar` | README vs `find src` | ✅ 文件系统比对 |
| B11 | P2 | ✅ **已修复** | README 称 MuPDF WASM ~30 MB,**实测产物 10.0 MB** | `dist/assets/mupdf-wasm-*.wasm` | ✅ 构建产物实测 |
| C5 | P2 | ✅ **已修复** | `FONT_CLASS_TO_PDF_STRATEGY.url` 失效 + 注释过期 | `fontClassify.ts:237-254` | ✅ 代码审计 |

> **B11 备注**:README 在「已知限制」中把 MuPDF 加载体积写成 ~30 MB,而生产构建的实际产物是 **9,991.58 kB(≈10 MB,gzip 4.6 MB)**。这个数字被用来解释"首次启用编辑文字需 1–3s",偏大的估值会误导性能预期。建议一并修正。

## 附录 B — 待人工验证(需在浏览器中确认)

A4(默认工具触发 WASM 加载耗时)、A6(进度条恒 0)、A7(重复提示)、B5(缺适应宽度)、B6(缺搜索)、B7(WebP 静默丢弃)、B8(缺导出快捷键)、C1(字体请求时机)、C2(大文档导出耗时)、C3(检测缓存)、C7(笔迹锯齿)、C8(撤销边界)

> 已解决:A8(图标识别率)、B9(工具语义重叠) —— 见 §A8 / §B9 的「实际处置」。
