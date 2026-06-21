# 标签导航（Tag Navigation）设计

> 日期：2026-06-21
> 状态：已确认，待写实现计划
> 关联：特性序列第 ③ 项（共 9 项，按价值逐一实现）

---

## 一、背景与动机

页面已有 tags（LLM 在 ingest 时写入 frontmatter），但仅作展示、点不动、不能按 tag 浏览或筛选。补一层标签导航，让知识网络多一个组织维度。

现状盘点：

- `pages.tags` 是 `text('tags').default('[]')`（JSON 数组列），pages-repo 解析为 `string[]`（`safeParseJson`）。
- **pages-repo 无任何 tag 查询方法**（无 getByTag / listAllTags）。
- tag chips 用 `<Tag>`（`@/components/ui/tag`，一个 `<span>`）渲染在 4 处，**全不可点**：
  - `src/components/wiki/frontmatter-display.tsx`（阅读页页头）
  - `src/components/layout/context-panel-context-tab.tsx`（右侧上下文面板）
  - `src/app/(app)/page.tsx`（首页最近页卡片，`tags.slice(0,2)`）
  - （wiki 阅读页经 PageRenderer 把 tags 传给 frontmatter-display）
- **`GET /api/pages`** 返回当前 subject 的**全部**页（含 tags，不在服务端排除 meta；客户端用 `isMetaPage` 过滤）。
- `meta` 标签标记系统页（index/log），`pages-repo.isMetaPage(page)` = `(page.tags ?? []).includes('meta')`。

结论：tags 数据已随 `/api/pages` 到客户端，标签聚合/过滤可纯客户端完成，无需新后端。

---

## 二、范围（v1）

让 tags 可导航：可点 chips + 单标签页 + 标签索引页 + 侧边栏入口。

### 已定决策

1. **界面**：① 所有 tag chips 可点 → `/tags/<tag>?s=<subjectSlug>`；② `/tags/<tag>` 列出当前 subject 内带该 tag 的页；③ `/tags` 索引列出所有 tag + 页计数；④ 侧边栏「Tags」入口。

### 默认决策

2. **纯客户端聚合**：复用 `GET /api/pages`（已含 tags），**不新增后端接口**。
3. **排除 `meta` 系统标签**：不进索引/标签云、不渲染为可点 chip（它是系统页标记，非内容标签）。
4. **共享 `<TagLink>` 组件**（`<Link>` 包 `<Tag>`），在 frontmatter-display / context-panel-context-tab / dashboard 三处复用，避免重复链接逻辑。
5. **侧边栏「Tags」入口**放 footer（与 Health / Settings 同区）。
6. **tag 不归一化**：按存储原样匹配（LLM 生成的字符串）；URL 用 `encodeURIComponent` / `decodeURIComponent`。
7. **作用域 = 当前 subject**（与全 app 一致）。

### 明确不做（YAGNI）

- 标签重命名 / 合并 / 编辑（编辑 frontmatter 走特性②的整文件编辑）。
- 跨 subject 标签聚合。
- 侧边栏标签云（界面问题已选「不含侧边栏标签云」，仅一个入口链接）。
- 后端 tag 接口 / DB tag 索引（客户端聚合足够；页数量级是个人知识库规模）。

---

## 三、架构与数据流

```
GET /api/pages（现成，返回当前 subject 全部页含 tags）
  │
  ├─ /tags 索引页：aggregateTags(pages) → [{ tag, count }]（排除 meta）→ tag+count 链接网格
  ├─ /tags/<tag> 页：pagesWithTag(pages, decodeURIComponent(tag)) → 页链接列表（+ 空态）
  └─ <TagLink>（frontmatter / context panel / dashboard 的 chip）→ Link 到 /tags/<tag>?s=<subjectSlug>
```

纯函数 `aggregateTags` / `pagesWithTag` 承载可测逻辑；客户端组件用 React Query 拉 `/api/pages`（`['pages', subjectId]`，与 sidebar 同 key，复用缓存）。

---

## 四、纯函数契约（`src/lib/tags.ts`）

```ts
import type { WikiPage } from '@/lib/contracts';

const META_TAG = 'meta';

// 聚合所有非 meta tag 的页计数；按 count 降序、同 count 按 tag 字母升序；meta 标签本身不计入。
// 带 meta 标签的页（系统页）其 meta 之外的标签也不计入（系统页不参与内容标签导航）。
export function aggregateTags(pages: WikiPage[]): { tag: string; count: number }[];

// 返回带指定 tag 的页（排除 meta 系统页）；tag 区分大小写按原样匹配。
export function pagesWithTag(pages: WikiPage[], tag: string): WikiPage[];
```

> 约定：聚合与过滤都先排除 `isMetaPage` 的系统页（带 `meta` 标签者），保证标签导航只覆盖内容页。

---

## 五、新增 / 改动文件

| 文件 | 类型 | 职责 |
|------|------|------|
| `src/lib/tags.ts` | 新增 | 纯函数 `aggregateTags` / `pagesWithTag`（含 `META_TAG` 常量）— TDD 目标 |
| `src/components/wiki/tag-link.tsx` | 新增 | 可点 tag chip：`<Link href=/tags/<encode(tag)>?s=<subjectSlug>><Tag tone size>{tag}</Tag></Link>`；props `{ tag, subjectSlug, tone?, size? }` |
| `src/app/(app)/tags/page.tsx` | 新增 | 索引页壳（Server Component）→ `<TagsIndexView/>` |
| `src/app/(app)/tags/[tag]/page.tsx` | 新增 | 单标签页壳（Server Component）→ `await params` 取 tag → `<TagPagesView tag=... />` |
| `src/components/tags/tags-index-view.tsx` | 新增 | client：拉 `/api/pages` → `aggregateTags` → tag+count 网格（每项 `<TagLink>` + count）；空态 |
| `src/components/tags/tag-pages-view.tsx` | 新增 | client：拉 `/api/pages` → `pagesWithTag` → 页链接列表（链到 `/wiki/<slug>?s=`）+ 「No pages with this tag」空态 + 标题显示 tag |
| `src/components/wiki/frontmatter-display.tsx` | 改动 | tag chip 换 `<TagLink>`（需 subjectSlug；见下"约束"） |
| `src/components/layout/context-panel-context-tab.tsx` | 改动 | tag chip 换 `<TagLink>` |
| `src/app/(app)/page.tsx` | 改动 | 首页最近页卡片 tag chip 换 `<TagLink>` |
| `src/components/layout/sidebar.tsx` | 改动 | footer 加「Tags」入口（`<Link href="/tags">` + Tag/Hash 图标）|

### subjectSlug 传递约束

`<TagLink>` 需要 `subjectSlug` 构造 `?s=`。各处来源：
- **frontmatter-display**：当前无 subjectSlug；由 PageRenderer 透传（PageRenderer 也无）→ 最终由 wiki 阅读页（Server Component，有 `subject.slug`）经 `editHref` 同款方式传一个 `subjectSlug` prop 下来。**采用：阅读页传 `subjectSlug={subject.slug}` → PageRenderer 透传 → frontmatter-display 给 TagLink。**
- **context-panel-context-tab**（client）：用 `useCurrentSubject().slug`。
- **dashboard `(app)/page.tsx`**（Server Component，已有 active subject）：传 subject.slug。
- **tags 视图内**（client）：用 `useCurrentSubject().slug`。

---

## 六、UI 行为

- **`/tags` 索引**：标题「Tags」+ tag 卡片/行网格，每项 `<TagLink>` + 计数（`tabular-nums`）。无 tag → 「No tags yet.」空态。
- **`/tags/<tag>`**：标题「# <tag>」+ 该 tag 的页链接列表（页标题 → `/wiki/<slug>?s=`）。无匹配页 → 「No pages with this tag.」空态 + 返回 `/tags` 链接。
- **TagLink**：视觉沿用现有 `<Tag tone size>`，外层 `<Link>` 加 hover 态；保持 chip 外观。
- **sidebar「Tags」**：footer 行，链到 `/tags`，pathname 前缀 `/tags` 时 active。

---

## 七、边界处理

- URL tag 段 `decodeURIComponent`；含特殊字符的 tag 由 `encodeURIComponent` 编码（TagLink 构造时）。
- 未知 / 无匹配 tag：`pagesWithTag` 返回空 → 空态文案。
- `meta` 标签：`aggregateTags` 不计入；系统页（带 meta）不参与；TagLink 不会为 meta 生成（调用方对 chip 列表已不含 meta，或 TagLink 内部对 `tag==='meta'` 也可直接渲染普通 Tag 不加链接——采用调用方过滤 meta，保持 TagLink 单一职责）。
- tag 大小写：按存储原样；若 LLM 产出 `Math` 与 `math` 视为两个不同 tag（不归一化，YAGNI）。

---

## 八、测试（node-only，无 RTL）

1. **`src/lib/tags.ts` 纯函数**
   - `aggregateTags`：多页多 tag 计数正确；按 count 降序、同 count 字母升序；排除 `meta` 标签；排除带 meta 的系统页；空输入返回 `[]`。
   - `pagesWithTag`：返回含该 tag 的内容页；排除 meta 系统页；未知 tag 返回 `[]`；大小写区分。
2. 路由/组件无单测（项目无 DOM 测试环境）；tsc + dev 验收（chips 可点跳转、索引页计数、单标签页列表与空态、侧边栏入口）。

---

## 九、不变量与依赖

- 不新增后端接口、不改 `/api/pages`、不改 DB schema。
- 客户端 HTTP 只用 `@/lib/api-fetch`（GET 用 `useApiFetch()` 自动注入 subjectId）。
- 复用 `@/components/ui/tag` 的 `<Tag>` 与设计系统；颜色用 CSS 变量类。
- 深链 `/wiki/<slug>?s=<subjectSlug>` 与 `/tags/<tag>?s=<subjectSlug>` 风格一致。
- `src/lib/tags.ts` 为纯函数，不依赖 server/DB/Next，可在 node 环境单测；类型从 `@/lib/contracts` 引入。
- 门禁 = `npx tsc --noEmit` + `npx vitest run`；`npm run lint` 在 BASE 即坏，非门禁。
- commit message 中文、一句话；禁止任何 AI 署名 trailer / 脚注。
