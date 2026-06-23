# 正文预览 source 与首页直接打开一致 — 设计

> 日期：2026-06-23
> 目标：让 wiki 正文阅读页的 "Sources" 分屏预览，在渲染各类源时与首页直接打开 source（`/sources/[id]`）**完全一致**：PDF 用浏览器原生 PDF 阅读器、Markdown 直接渲染、HTML/URL 通过 iframe 加载。

---

## 一、问题

同一份 source 在两个入口的渲染方式不一致：

| 入口 | 组件 | PDF | HTML | Markdown | Text |
|------|------|-----|------|----------|------|
| **首页直接打开**（`/sources/[id]`） | `SourceViewer`（`_components/source-viewer.tsx`） | `<iframe src=…/raw>` 浏览器原生阅读器，完整文件 | `<iframe src=…/raw sandbox="">` 沙箱化，完整文件 | `renderMarkdown()` | `<pre>` |
| **正文分屏预览** | `SourceBody`（`wiki/wiki-reading-view.tsx`） | `PdfDocument`：把抽取的分页文本塞进 `<pre>`（截断 60 页 × 8K） | `dangerouslySetInnerHTML`（截断 120K，**XSS 风险**） | `renderMarkdown()` | `<pre>` |

差异只出在 **PDF** 与 **HTML** 两类：

- PDF：分屏里看到的是后端抽取的纯文本分页，不是真正的 PDF 阅读器。
- HTML：分屏里用 `dangerouslySetInnerHTML` 直接注入原始 HTML，既与首页（沙箱 iframe）不一致，也存在 XSS 隐患。

Markdown 与 Text 两类**已经一致**（都是直接渲染 / `<pre>`），仅正文宽度因场景不同而不同（首页独立页 760px、分屏窄栏 62ch），属有意为之，不在本次变更范围。

---

## 二、关键事实（变更的支点）

- `PageSourceDoc.id` **就是真实的 source id**（`source-reader.ts:56` `base = { id: src.id, … }`）。
- `GET /api/sources/[id]/raw` 已能为任意 source 流式返回原始文件（PDF 二进制 / HTML / 文本），且 subject 从 source 自身记录派生 —— 因此一个不带 header 的 `<iframe src>` 即可工作（首页正是这么用的）。

结论：正文预览**无需新增任何 API 或数据通路**，直接复用首页同一个 `/api/sources/{id}/raw` 端点即可对齐。

---

## 三、方案

采用「就地对齐 + 后端清理」：把 `SourceBody` 中 PDF/HTML 两个分支改成与 `SourceViewer` 完全一致的 iframe，同时清理后端不再被渲染的 payload。

合理存在差异的部分（窄栏的 markdown 正文宽度/排版）保持各自上下文专属，不强行合并进同一组件 —— 真正发生漂移、且本次要修的，只有 PDF/HTML 的 iframe 渲染，它在两处都收敛成完全相同的两三行 `<iframe>`。

### 3.1 前端 —— `src/components/wiki/wiki-reading-view.tsx`（`SourceBody`）

- **PDF** → `<iframe src="/api/sources/{id}/raw" title={name} …>`（浏览器原生阅读器，完整文件），替换 `PdfDocument`。
- **HTML** → `<iframe src="/api/sources/{id}/raw" title={name} sandbox="" …>`（沙箱化，完整文件），替换 `dangerouslySetInnerHTML`（同时关闭现有 XSS 隐患）。
- **Markdown / Text** → 保持不变（已直接渲染 / `<pre>`）。
- 删除已无引用的 `PdfDocument` 组件。
- **高度处理**（唯一的真实布局细节）：独立页 viewer 填满整列高度（`flex h-full` + `flex-1`）；分屏面板仅在 `lg` 下有界高（外层 `lg:h-[calc(100vh-var(--header-height))]`），移动端堆叠后无界高，`h-full` 的 iframe 会塌成默认高度。因此 iframe 用 `className="h-[80vh] w-full border-0 lg:h-full"`：移动端给一个可滚动的视口高，桌面端填满面板。HTML iframe 额外保留 `bg-white`。
- `SourcesPane` 顶部的 meta 行与「preview truncated」徽标逻辑（`src.meta ?? src.format` + `src.truncated`）保持不变 —— 清理后端后 PDF/HTML 不再设 `truncated`，徽标自然只对 markdown/text 生效。

### 3.2 后端 —— `src/server/sources/source-reader.ts`（`readPageSources`）

- **PDF**：不再拼装分页文本 → 仅返回 `{ id, name, format, added, meta: 'PDF' }`。删除 `PDF_MAX_SHEETS` / `PDF_SHEET_CAP` 及分页组装逻辑。（页数由浏览器 PDF 阅读器自身展示；完整文件直出，不再涉及「preview truncated」。）
- **HTML**：不再读取最多 120K 原始正文 → 仅返回 base + `meta: 'HTML'`。
- **Markdown / Text**：保持不变 —— 仍读原文、按 `TEXT_CAP`(120K) 截断、设 `truncated`、下发 `text`。
- `added` 仍按现有逻辑取 `sidecar.savedAt ?? src.parsedAt`（PDF/HTML 仍读一次 sidecar 取日期，但不再读 chunks）。

### 3.3 契约 —— `src/lib/contracts.ts`（`PageSourceDoc`）

- 移除已不再使用的 `pages?` 与 `html?` 字段。`truncated?` 此后仅对 markdown/text 有实际意义（注释同步说明）。

---

## 四、净效果（行为）

正文分屏预览中：PDF 由浏览器原生 PDF 阅读器打开、HTML 在沙箱 iframe 中加载、Markdown/Text 直接渲染 —— 与从首页打开该 source 完全一致。PDF/HTML 不再被截断；Markdown/Text 维持 120K 上限。

---

## 五、影响面 / 风险

- `PageSourceDoc.pages` / `.html` 的唯一生产者是 `readPageSources`、唯一消费者是 `SourceBody`，移除安全。
- `GET /api/sources?slug=` 的唯一消费者是 `WikiReadingView`，响应体收缩（PDF 不再含分页、HTML 不再含正文）只让 payload 变小，无其他下游。
- 已存在的 `readPageSources` 单测若断言了 PDF `pages` / HTML `html`，需同步更新为新形状。

---

## 六、验证

1. `npm run lint`
2. `npm run build`
3. 若有 `readPageSources` 单测，`npx vitest run` 对应文件。
4. 手动：打开一个分别挂有 PDF / HTML / Markdown / Text 源的页面，点 "Sources (n)" 分屏，逐一确认与对应 `/sources/[id]` 独立页渲染一致（PDF 原生阅读器、HTML 沙箱 iframe、Markdown 渲染、Text 等宽）。

---

## 七、改动文件清单

- `src/components/wiki/wiki-reading-view.tsx` —— `SourceBody` 改 iframe，删 `PdfDocument`。
- `src/server/sources/source-reader.ts` —— 裁掉 PDF/HTML 的 payload 准备。
- `src/lib/contracts.ts` —— `PageSourceDoc` 去掉 `pages?` / `html?`。
