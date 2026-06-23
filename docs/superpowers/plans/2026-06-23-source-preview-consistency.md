# 正文预览 source 渲染对齐首页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 wiki 正文阅读页的 "Sources" 分屏预览中，PDF 用浏览器原生阅读器、HTML 用沙箱 iframe、Markdown/Text 直接渲染 —— 与从首页打开 `/sources/[id]` 完全一致。

**Architecture:** 复用首页 `SourceViewer` 已在用的 `/api/sources/{id}/raw` 端点（该端点从 source 记录自身派生 subject，所以不带 header 的 `<iframe src>` 即可工作）。把 `SourceBody` 的 PDF/HTML 分支换成 iframe，删掉自定义 `PdfDocument` 与 `dangerouslySetInnerHTML`；随后裁掉后端 `readPageSources` 不再被渲染的 PDF 分页 / HTML 正文 payload，并从 `PageSourceDoc` 契约移除 `pages?` / `html?`。

**Tech Stack:** Next.js 15 (App Router) + React 19 + TypeScript 5 + Tailwind。

## Global Constraints

- 代码注释用**中文**。
- git commit message 用**中文**、一句话总结；**禁止** AI 署名 trailer（无 `Co-Authored-By` / `Generated with` 脚注）。
- 客户端组件样式走 Tailwind + `cn()`；颜色用 CSS 变量类（`bg-surface` / `text-prose-body` 等）。
- iframe 的 `src` 是直连 `/api/sources/{id}/raw` 的普通 URL（**不**经 `useApiFetch`：iframe 无法设 header，该端点本就从 source 记录派生 subject）——与 `SourceViewer` 一致。
- 任务顺序固定：先 Task 1（前端停止读取 `pages`/`html`），再 Task 2（后端停止生产 + 契约移除字段），保证每次提交都能编译通过。

---

### Task 1: 正文预览 PDF/HTML 改用 iframe（对齐首页）

**Files:**
- Modify: `src/components/wiki/wiki-reading-view.tsx`（`SourceBody` 函数 288-315 行；删除 `PdfDocument` 函数 317-336 行）

**Interfaces:**
- Consumes: `PageSourceDoc`（`@/lib/contracts`，本任务只用到 `id` / `name` / `format` / `text`，不再读 `pages` / `html`）；`renderMarkdown`（`@/lib/markdown-client`，已 import）。
- Produces: 无新增导出。`SourceBody` 签名不变：`function SourceBody({ source }: { source: PageSourceDoc })`。

**参考实现（首页 `SourceViewer` 的对应分支，须保持一致）：**
```tsx
// src/app/(app)/_components/source-viewer.tsx
const rawUrl = `/api/sources/${id}/raw`;
// pdf:
<iframe src={rawUrl} title={filename} className="min-h-0 flex-1 border-0 bg-canvas" />
// html:
<iframe src={rawUrl} title={filename} sandbox="" className="min-h-0 flex-1 border-0 bg-white" />
```
> 分屏面板的高度上下文与独立页不同：独立页用 `flex h-full` 填满，分屏仅在 `lg` 下有界高、移动端堆叠后无界高。因此 iframe 用 `h-[80vh] w-full border-0 lg:h-full`（移动端给可滚动视口高，桌面端填满面板），而非照搬 `min-h-0 flex-1`。

- [ ] **Step 1: 重写 `SourceBody`，删除 `PdfDocument`**

把 `src/components/wiki/wiki-reading-view.tsx` 中现有的 `SourceBody`（288-315 行）整体替换为下面内容，并**删除**其后的 `PdfDocument` 函数（317-336 行，含其上方那行注释 `/** Minimal PDF-reader chrome… */`）：

```tsx
function SourceBody({ source }: { source: PageSourceDoc }) {
  // PDF/HTML 与首页一致：直接由浏览器加载完整原始文件（PDF 原生阅读器 / 沙箱 iframe）。
  const rawUrl = `/api/sources/${source.id}/raw`;

  if (source.format === 'pdf') {
    return (
      <iframe src={rawUrl} title={source.name} className="h-[80vh] w-full border-0 lg:h-full" />
    );
  }

  if (source.format === 'html') {
    return (
      <iframe
        src={rawUrl}
        title={source.name}
        sandbox=""
        className="h-[80vh] w-full border-0 bg-white lg:h-full"
      />
    );
  }

  if (source.format === 'markdown') {
    return (
      <div className="mx-auto max-w-[62ch] px-7 pb-[72px] pt-7">
        <div className="font-sans text-md text-prose-body [&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-prose-quote [&_blockquote]:pl-4 [&_code]:rounded-sm [&_code]:bg-prose-code-bg [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.875em] [&_h1]:mb-3 [&_h1]:mt-6 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:text-prose-heading [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-prose-heading [&_li]:mb-1 [&_ol]:mb-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:mb-4 [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-prose-code-bg [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-sm [&_strong]:font-semibold [&_strong]:text-prose-heading [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-6">
          {renderMarkdown(source.text ?? '')}
        </div>
      </div>
    );
  }

  // text
  return (
    <pre className="m-0 max-w-[78ch] whitespace-pre-wrap break-words px-7 pb-[72px] pt-7 font-mono text-[13px] leading-[21px] text-prose-body">
      {source.text}
    </pre>
  );
}
```

> markdown / text 两个分支与改前**逐字一致**（含全部 Tailwind 类），仅 pdf/html 改成 iframe、并删掉 `PdfDocument`。

- [ ] **Step 2: 确认无残留引用**

Run: `grep -n "PdfDocument\|source.pages\|source.html\|dangerouslySetInnerHTML" src/components/wiki/wiki-reading-view.tsx`
Expected: 无任何匹配（全部已删除）。

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 改动的文件无类型错误（`PageSourceDoc.pages` / `.html` 此刻仍是契约上的可选字段，未被引用不报错）。若出现与本改动无关的既有错误，忽略。

- [ ] **Step 4: 提交**

```bash
git add src/components/wiki/wiki-reading-view.tsx
git commit -m "fix(ui): 正文预览 PDF/HTML 改用 iframe 对齐首页"
```

---

### Task 2: 后端裁掉 PDF/HTML payload + 契约移除 `pages`/`html`

**Files:**
- Modify: `src/server/sources/source-reader.ts`（删 `PDF_MAX_SHEETS` / `PDF_SHEET_CAP` 常量；重写 `readPageSources` 循环体）
- Modify: `src/lib/contracts.ts`（`PageSourceDoc` 接口 127-142 行）

**Interfaces:**
- Consumes: `sourcesRepo.getSourcesForPage` / `getSourceMetadata` / `getRawSourceContent`（签名不变）。
- Produces: `readPageSources(subject, pageSlug): PageSourceDoc[]` 签名不变；返回的 PDF/HTML 文档此后仅含 `{ id, name, format, added, meta }`（不再含 `pages` / `html` / `truncated`）。`PageSourceDoc` 去掉 `pages?` / `html?`。

- [ ] **Step 1: 重写 `readPageSources`，删除 PDF 常量**

在 `src/server/sources/source-reader.ts` 中：

(a) 删除第 9-10 行两个常量（保留 `TEXT_CAP`）：
```ts
const PDF_MAX_SHEETS = 60;
const PDF_SHEET_CAP = 8_000;
```

(b) 把 `readPageSources` 的 `for` 循环体（现 50-86 行）整体替换为：
```ts
  for (const src of sources) {
    const format = formatFor(src.filename);
    const sidecar = (getSourceMetadata(src.id) as SourceSidecar | null) ?? {};
    const added = (sidecar.savedAt ?? src.parsedAt ?? '').slice(0, 10);

    const base = { id: src.id, name: src.filename, format, added } as PageSourceDoc;

    // pdf / html 在客户端由 iframe 加载完整原始文件（见 wiki-reading-view 的 SourceBody），
    // 这里只下发元数据，不再准备分页文本 / HTML 正文 payload。
    if (format === 'pdf' || format === 'html') {
      docs.push({ ...base, meta: FORMAT_LABEL[format] });
      continue;
    }

    // markdown / text —— 优先用原始文件，回退到解析后的 chunks。
    const chunks = Array.isArray(sidecar.chunks) ? sidecar.chunks : [];
    const raw = getRawSourceContent(subject.slug, src.filename);
    const full = raw ?? chunks.map((c) => c.text ?? '').join('\n\n');
    const truncated = full.length > TEXT_CAP;
    const content = truncated ? full.slice(0, TEXT_CAP) : full;
    docs.push({ ...base, meta: FORMAT_LABEL[format], text: content, truncated });
  }
```

> `SidecarChunk` / `SourceSidecar` 接口、`formatFor`、`FORMAT_LABEL`、`TEXT_CAP` 均保持不变，仍被 markdown/text 分支使用。

- [ ] **Step 2: `PageSourceDoc` 移除 `pages?` / `html?`**

把 `src/lib/contracts.ts` 的 `PageSourceDoc` 接口及其上方注释（127-142 行）替换为：
```ts
/**
 * A source document a page was written from, prepared for the split reading
 * view. Markdown/text ship their (capped) body in `text`; pdf/html ship no
 * payload and are rendered client-side via an iframe over `/api/sources/{id}/raw`.
 */
export interface PageSourceDoc {
  id: string;
  name: string;
  format: PageSourceFormat;
  added: string;
  meta?: string;
  /** 仅 markdown/text 有意义：正文按 120K 截断时为 true。pdf/html 直出完整文件，不截断。 */
  truncated?: boolean;
  /** markdown/text 的正文（已截断）。pdf/html 不下发 payload（由 iframe 渲染）。 */
  text?: string;
}
```

- [ ] **Step 3: 确认无残留引用**

Run: `grep -rn "\.pages\b\|\.html\b" src/server/sources/source-reader.ts; grep -n "pages?\|html?" src/lib/contracts.ts`
Expected: source-reader 无 `.pages`/`.html` 残留；contracts 的 `PageSourceDoc` 不再有 `pages?` / `html?`（其它接口若有同名属性属正常，仅关注 `PageSourceDoc` 段）。

- [ ] **Step 4: 类型检查 + lint + 构建**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: 全部通过；无与本改动相关的类型/lint 错误（移除 `pages`/`html` 后，因 Task 1 已停止读取、本任务已停止生产，无任何残留引用）。

- [ ] **Step 5: 提交**

```bash
git add src/server/sources/source-reader.ts src/lib/contracts.ts
git commit -m "refactor(sources): readPageSources 不再为 PDF/HTML 准备 payload"
```

---

### 手动验证（实现完成后，非提交步骤）

1. `npm run dev:all` 启动。
2. 打开一个分别挂有 **PDF / HTML / Markdown / Text** 源的 wiki 页，点击 "Sources (n)" 展开分屏。
3. 逐一切换源 tab，确认渲染与对应 `/sources/[id]` 独立页一致：
   - PDF → 浏览器原生 PDF 阅读器（可翻页/缩放），非纯文本分页；
   - HTML → 沙箱 iframe 加载（脚本被沙箱拦截）；
   - Markdown → 直接渲染；
   - Text → 等宽 `<pre>`。
4. 移动端窄屏（或缩窄窗口）下确认 PDF/HTML iframe 有可滚动高度、不塌陷。

---

## 文档收尾（可选，按项目惯例）

实现合入后，按需在根 `CLAUDE.md` 第九节 Changelog 追加一行（日期 2026-06-23：正文预览 source 渲染对齐首页直接打开）。组件文档 `src/components/CLAUDE.md` 的 `wiki/wiki-reading-view` 描述如有提及 PDF 自定义阅读器，可同步更新为 iframe。
