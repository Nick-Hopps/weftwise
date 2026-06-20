# 正文 KaTeX 公式渲染设计

> 日期：2026-06-20
> 状态：设计待评审
> 范围：仅 **wiki 正文**渲染（不动聊天消息 / `/ask` 回答 / 编辑器）

---

## 一、背景与目标

正文 markdown 目前不渲染数学公式，源文件里的 `$E=mc^2$` 只会原样显示成文本。目标是让 wiki 正文支持 LaTeX 数学公式：

- 行内公式 `$…$`；
- 块级公式 `$$…$$`；
- 仅作用于 **wiki 正文**，聊天消息与 `/ask` 回答保持纯文本。

本次只做**渲染**——若源 markdown 含 `$…$` 即渲染；不改 LLM 产出逻辑（见第七节"非目标"）。

---

## 二、现状（事实基础）

所有 markdown 渲染都走**同一个纯客户端、同步**函数 `renderMarkdown()`（`src/lib/markdown-client.ts`）：

```
remarkParse → remarkFrontmatter → remarkWikiLinks → remarkRehype → rehypeReact
```

用 `processSync` 同步执行。该函数喂三处：

| 调用点 | 用途 | 本次是否开公式 |
|--------|------|----------------|
| `src/components/wiki/page-renderer.tsx` | wiki 正文 | ✅ 开 |
| `src/components/chat/message-list.tsx` | 聊天消息 | ❌ 不开 |
| `src/components/search/command-palette.tsx` | `/ask` 回答 | ❌ 不开 |

**关键约束**：`rehype-pretty-code`（代码高亮）虽在依赖中，但被刻意弃用——它是异步的，与 `processSync` 冲突。**因此公式方案也必须同步**。KaTeX 同步、轻量，满足此约束（MathJax 体积更大，已排除）。

---

## 三、管线改造（`src/lib/markdown-client.ts`）

给 `renderMarkdown` 增加第三个可选参数：

```ts
export function renderMarkdown(
  content: string,
  titleSlugMap?: Record<string, string>,
  options?: { math?: boolean },
): React.ReactElement
```

仅当 `options.math === true` 时挂载公式插件，管线变为：

```
remarkParse
  → remarkFrontmatter
  → [remarkMath]          ← 新增（仅 math:true）
  → remarkWikiLinks
  → remarkRehype
  → [rehypeKatex]         ← 新增（仅 math:true）
  → rehypeReact
```

- `remark-math` 把 `$…$` / `$$…$$` 解析为独立 mdast 节点，**先于** `remarkWikiLinks` 运行，使公式内部不会被 wikilink 扫描器（只处理 `[[…]]` 的文本节点）触碰，二者互不干扰。
- `remark-rehype` 把 math 节点转成 `<span class="math math-inline">…</span>` / `class="math-display"` 的 hast；`rehype-katex` 在 hast 上把它们渲染为 KaTeX 输出。
- 全程同步，复用现有 `processSync`，无需改异步。

---

## 四、调用点（只改一处）

- `page-renderer.tsx`：`renderMarkdown(content, titleSlugMap, { math: true })`；
- `message-list.tsx` / `command-palette.tsx`：**不动**，继续走两参数版本（无公式、无额外解析开销）。

---

## 五、依赖与样式

- 新增依赖：`katex`、`remark-math@^6`、`rehype-katex@^7`（匹配 unified 11 / remark 11 的 micromark 体系）。
- `src/app/layout.tsx` 增加 `import 'katex/dist/katex.min.css';`（与现有 `@uiw/react-markdown-preview/markdown.css` 同处导入）。KaTeX CSS 带数学字体（woff2，由 webpack 从 `node_modules` 解析并发到静态资源）。CSS 对无公式页面是惰性的，不影响聊天/回答。
- **包体代价**：KaTeX 会进入包含 `renderMarkdown` 的客户端 chunk（gzip 后约几十 KB）。因需保持同步无法懒加载，权衡后接受。

---

## 六、KaTeX 选项、安全与排版

### 选项（传给 `rehype-katex`）

- `{ throwOnError: false }` —— **必须**。否则非法 LaTeX 会让 `processSync` 抛错、整页渲染崩溃；关掉后非法公式以红色显示其源码。
- 保持默认 `trust: false`：禁用 `\href` / `\includegraphics` 等可注入 HTML 的命令。正文是 LLM 生成内容，此项保证无 XSS 注入面。
- 输出保持默认 `htmlAndMathml`（含隐藏 MathML，利于无障碍/屏幕阅读器）。**降级预案**：若 `rehype-react` 渲染 MathML 节点出问题，改为 `output: 'html'`。

### 排版与主题

- KaTeX 默认 `color: inherit`，自动跟随正文 `text-prose-body`，暗色模式无需额外处理。
- 块级公式过宽会撑破页面 → 在 `page-renderer.tsx` 的 `proseClassName` 加 `[&_.katex-display]:overflow-x-auto`，让宽公式横向滚动而非溢出。改动仍局限在正文组件，不污染全局。

---

## 七、非目标与已知边界

### 非目标

- **不改 LLM 产出**：ingest / query / lint 的 prompt 不动。本次只渲染源文件里已有的 `$…$`。是否让 LLM 主动产出 LaTeX 为可选后续，另开议题。
- **不动聊天 / `/ask` / 编辑器**：仅 wiki 正文。

### 已知边界（记录，不阻塞）

- **货币 `$` 误判**：如 `between $5 and $10$` 可能被误解析为公式。`remark-math` 默认 `singleDollarTextMath: true`。本项目是用户主动写公式的知识库，保留默认；若日后困扰，可关闭单美元行内数学（需届时评估对存量内容的影响）。

---

## 八、测试

`markdown-client` 目前无测试。新增 vitest（`src/lib/__tests__/markdown-client.test.ts`，用 `react-dom/server` 的 `renderToStaticMarkup` 把结果转字符串断言）：

1. `math:true` 时 `$E=mc^2$` 输出含 `.katex`（验证行内公式渲染）；
2. `$$…$$` 输出含 `.katex-display`（验证块级公式）；
3. `math:false`（默认）时 `$…$` 原样保留为文本（验证聊天/回答不受影响）；
4. 非法 LaTeX（如 `$\frac{$`）**不抛错**（验证 `throwOnError:false` 这条安全保证）；
5. 公式与 wikilink 共存：`[[Page]] 与 $x^2$` 两者都正确渲染（验证插件顺序无冲突）。

---

## 九、改动文件清单

| 文件 | 改动 |
|------|------|
| `package.json` | 新增 `katex` / `remark-math` / `rehype-katex` 依赖 |
| `src/lib/markdown-client.ts` | 加 `options.math` 参数；条件挂载 `remark-math` + `rehype-katex` |
| `src/components/wiki/page-renderer.tsx` | 调用传 `{ math: true }`；`proseClassName` 加 `.katex-display` 横向滚动 |
| `src/app/layout.tsx` | `import 'katex/dist/katex.min.css'` |
| `src/lib/__tests__/markdown-client.test.ts` | 新增单测（5 项） |
