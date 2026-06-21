# 页面在线编辑（Page Inline Editing）设计

> 日期：2026-06-21
> 状态：已确认，待写实现计划
> 关联：特性序列第 ② 项（共 9 项，按价值逐一实现）

---

## 一、背景与动机

wiki 由 LLM 自动生成，但人工修正入口缺失：阅读页是只读，没有任何编辑按钮。一旦 LLM 写错内容，用户只能重新摄入。补一个 human-in-the-loop 编辑入口是信任这套自动生成系统的关键。

现状盘点：

- **`PUT /api/pages/[...slug]` 已完整且走全套 Saga**（`src/app/api/pages/[...slug]/route.ts:77`）：
  - `requireAuth` + `requireCsrf`；
  - `UpdatePageSchema = { content: z.string().min(1) }`；
  - `createChangeset(uuid, subject, [{ action:'update', path: buildWikiPath(subject.slug, slug), content }])`；
  - `validateChangeset`（重抽 wikilink 校验，失败 400）→ `applyChangeset`（fs + SQLite 重索引 + git commit）。
  - **content 是整文件内容**（含 frontmatter）。
- **`GET /api/pages/[...slug]`**（同文件 `:29`）：返回 `{ ...page, content: doc.body, frontmatter, links, backlinks }`——正文与 frontmatter **分开**，无整文件 raw 字段。
- **`@uiw/react-md-editor` 未接线**：仅 `src/app/layout.tsx:4` 引了其 CSS、`globals.css:257` 有主题桥接，无任何编辑器组件。
- wiki 阅读页 `(app)/wiki/[...slug]/page.tsx` 是 **Server Component**，用 `serializeWikiDocument`（已 import）做 round-trip。
- round-trip 单一真相：`parseWikiDocument(raw) / serializeWikiDocument(doc): string`（`src/server/wiki/markdown.ts:58`）。

---

## 二、范围（v1）

人工编辑**已有页面的全文原始 markdown**，经现成 PUT 链路落盘并重索引。

### 已定决策

1. **编辑范围 = 全文原始 markdown**（frontmatter + 正文，一个编辑器，类 Obsidian）。最简、零数据丢失、PUT 原生支持整文件。GET 需新增 `raw` 字段。
2. **入口 = 独立路由** `(app)/wiki/[...slug]/edit`（client 页）；阅读页加「Edit」按钮跳转。读视图保持纯 Server Component。

### 默认决策

3. **编辑器** = `@uiw/react-md-editor`，用 `next/dynamic` + `ssr:false` 封装（该库触碰 `window`），复用已接好的 CSS 主题桥。
4. **保存流程** = `PUT /api/pages/<slug>` `{ content, subjectId }` → 成功后失效相关 React Query 缓存 + `router.push('/wiki/<slug>?s=<subjectSlug>')` 回读页。
5. **错误处理** = PUT 400（changeset 校验失败 / 无效 body）把 `error` + `details` **内联**展示在编辑器上方，留在编辑态让用户修。
6. **Dirty 守卫** = Cancel 时若有未保存改动 → `window.confirm`；不做 `beforeunload`。
7. **meta 页（index/log）可编辑**，spec 注明它们在下次 ingest 由 indexer 重新生成（v1 不特殊处理）。

### 明确不做（YAGNI）

- 新建页面（页面由 ingest 创建）。
- 并发冲突检测 / 乐观锁（单用户，last-write-wins）。
- 结构化 frontmatter 字段编辑（全文 raw 已覆盖）。
- `beforeunload` 离开拦截。

---

## 三、架构与数据流

```
阅读页 /wiki/[...slug]（Server Component）
  └─ 「Edit」按钮（Link → /wiki/[...slug]/edit?s=<subjectSlug>）

编辑页 /wiki/[...slug]/edit（Server Component 壳 → 渲染 client <PageEditor/>）
  └─ GET /api/pages/<slug>  → { ..., raw }       raw = serializeWikiDocument(doc)
  └─ <MDEditor value={raw} onChange={setValue} />   @uiw/react-md-editor, dynamic ssr:false
  └─ Save → PUT /api/pages/<slug> { content: value, subjectId }
       ├─ 200 → invalidate [page, pages, graph, search, backlinks] + router.push('/wiki/<slug>?s=')
       └─ 400/404/网络错误 → 内联错误，留在编辑态
```

- 触发与读取：复用现有 `GET /api/pages/<slug>`（加 raw）与 `PUT`（不改）。
- 编辑器输入 = `raw`（整文件 markdown），输出 = 编辑后的整文件文本，原样作为 PUT `content`。

---

## 四、后端改动

### `GET /api/pages/[...slug]` 增 `raw` 字段

唯一后端改动。在现有响应中追加 `raw`：

```ts
import { serializeWikiDocument } from '@/server/wiki/markdown';
// ...
const doc = readPageInSubject(subject.slug, slug);
return NextResponse.json({
  ...page,
  content: doc?.body ?? '',
  raw: doc ? serializeWikiDocument(doc) : '',   // 🆕 整文件 markdown，供编辑器加载
  frontmatter: doc?.frontmatter ?? null,
  links: doc?.links ?? [],
  backlinks: /* 不变 */,
});
```

`PUT` 链路已完整，**不改**。

---

## 五、新增 / 改动文件

| 文件 | 类型 | 职责 |
|------|------|------|
| `src/components/wiki/md-editor.tsx` | 新增 | `@uiw/react-md-editor` 的 `dynamic(ssr:false)` 薄封装；统一 props（`value` / `onChange` / `height` / data-color-mode），避免在多处重复 dynamic 样板 |
| `src/components/wiki/page-editor.tsx` | 新增 | client 容器：React Query 拉 `raw` → MDEditor → Save/Cancel → PUT → 失效缓存 + 跳转；错误内联；dirty 守卫；空内容禁用 Save |
| `src/app/(app)/wiki/[...slug]/edit/page.tsx` | 新增 | 编辑路由壳（Server Component）：解析 slug → 渲染 `<PageEditor slug=... />` |
| `src/app/api/pages/[...slug]/route.ts` | 改动 | GET 响应加 `raw` 字段（+ import serializeWikiDocument） |
| `src/app/(app)/wiki/[...slug]/page.tsx` | 改动 | 页头加「Edit」`<Link href={/wiki/<slug>/edit?s=<subjectSlug>}>`（Server Component，无 client island） |

---

## 六、组件契约

### `md-editor.tsx`

```ts
'use client';
// 用 next/dynamic ssr:false 加载 @uiw/react-md-editor，统一封装。
interface MdEditorProps {
  value: string;
  onChange: (next: string) => void;
  height?: number;       // 默认如 520
}
export function MdEditor(props: MdEditorProps): JSX.Element;
```

- `data-color-mode` 跟随 `useUIStore().darkMode`（light/dark），与全站主题一致。

### `page-editor.tsx`

```ts
'use client';
interface PageEditorProps {
  slug: string;          // 由路由壳传入（slugParts.join('/')）
}
export function PageEditor({ slug }: PageEditorProps): JSX.Element;
```

行为：
- `useQuery(['page', subjectId, slug])` 拉 `GET /api/pages/<slug>`，取 `raw` 初始化编辑器 `value`。
- `dirty = value !== initialRaw`。
- Save（`useMutation`）：`PUT` `{ content: value, subjectId }`；成功 → `invalidateQueries` 各相关 key + `router.push('/wiki/<slug>?s=<subjectSlug>')`；失败 → 设 `errorText`（含 `details` 摘要）。
- Cancel：`dirty` 时 `window.confirm('Discard unsaved changes?')`；确认或不 dirty → `router.push('/wiki/<slug>?s=<subjectSlug>')`。
- Save 在 `value.trim() === ''` 或 `!dirty` 或 mutation pending 时禁用。

---

## 七、状态与 UI

`page-editor.tsx` 状态：

- **loading**：拉 raw 中 → skeleton。
- **editing**：MDEditor + 顶栏（标题/slug + Cancel + Save，Save 带 loading）；错误横幅（有 errorText 时）。
- **load-error**：GET 失败（404 等）→ 错误卡片 + 返回链接。

UI 复用设计系统原语（Button/Tag/Panel）与 CSS 变量类，沿用 subjects 页客户端模式。

---

## 八、边界处理

- **空内容**：`UpdatePageSchema` 要求 `content.min(1)`；编辑器 `value.trim()===''` 时禁用 Save（前端先挡）。
- **PUT 400**（changeset 校验失败，如新写的 wikilink 解析不了 / 无效）：内联展示 `error` 与 `details`，留在编辑态。
- **PUT 404**（页面被并发删除）/ 网络错误：内联错误提示。
- **meta 页（index/log）**：可编辑；下次 ingest 由 indexer 重新生成（v1 不拦截，不特殊处理）。
- **全文 round-trip**：编辑器加载 `serializeWikiDocument(doc)`，保存写回整文件，indexer 重新 `parseWikiDocument` 解析 frontmatter/links——天然保留 frontmatter。

---

## 九、测试（node-only，无 RTL）

1. **`GET /api/pages/<slug>` 路由测试**（vi.mock 模式，参考 `lint/latest`、`retry`）：
   - mock `requireAuth` 放行、`resolveSubjectFromRequest` 返回 subject、`pagesRepo.getPageBySlug` 返回 page、`getBacklinks` 返回 []、`readPageInSubject` 返回一个已知 `WikiDocument`。
   - 断言响应含 `raw` 且等于 `serializeWikiDocument(thatDoc)`（serialize 用真实实现，纯函数）。
   - page 不存在时 404（保持既有行为）。

2. React 组件（PageEditor / MdEditor）无单测（项目无 DOM 测试环境）；正确性通过 `npx tsc --noEmit` + dev 验收（启动 dev:all → 打开某页 → Edit → 改一处 → Save → 回读页看到更新；改一个非法 wikilink → Save → 看内联错误）。

---

## 十、不变量与依赖

- 不改 `PUT` / `DELETE` 行为与 Saga 顺序。
- 客户端 HTTP 只用 `@/lib/api-fetch`：GET 用 `useApiFetch()`（自动注入 `?subjectId`），PUT 在 body 显式带 `subjectId`。
- 编辑器 dynamic import 必须 `ssr:false` 且只在 `'use client'` 组件内（Next 15 约束）。
- 深链/跳转遵循 `/wiki/<slug>?s=<subjectSlug>` 风格。
- 复用 `serializeWikiDocument`（单一 round-trip 真相），不在别处复刻序列化。
- 门禁 = `npx tsc --noEmit` + `npx vitest run`；`npm run lint` 在 BASE 即坏，非门禁。
- 复用 `components/ui/*` 原语，不自造按钮/面板。
