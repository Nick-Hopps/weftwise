# Tags 页词云展示 — 设计 spec

日期：2026-07-10
状态：已确认

## 目标

`/tags` 索引页从「平铺 chip 列表 + 数字计数」改为**词云**：关联页面越多的 tag 字号越大、颜色越实。纯前端改动，零后端/DB/API 变更。

## 现状

- `src/components/tags/tags-index-view.tsx`：客户端拉 `/api/pages` → `aggregateTags` → flex-wrap 渲染 `TagLink` chip + 计数。
- `src/lib/tags.ts::aggregateTags`：返回 `{tag, count}[]`，count 降序。

## 设计

### 1. 纯函数 `src/lib/tags.ts`

新增：

```ts
/** 词云权重：log 平滑后 min-max 归一化到 [0,1]；max===min 时全取 0.5。 */
export function tagCloudWeights(tags: { tag: string; count: number }[]): { tag: string; count: number; weight: number }[]

/** 确定性打散排序（按 tag 名 djb2 哈希），避免"从大到小递减"的排序感，且 SSR/CSR 一致无 hydration 抖动。 */
export function shuffleTagsDeterministic<T extends { tag: string }>(tags: T[]): T[]
```

- 权重公式：`w = (log(count) - log(min)) / (log(max) - log(min))`，单一 tag 或全部同 count 时 `w = 0.5`。
- 附单测（`src/lib/__tests__/tags.test.ts` 追加）：空数组、单 tag、全同 count、极端偏斜分布、打散确定性（两次调用结果一致）。

### 2. 渲染改造 `tags-index-view.tsx`

- 用 `tagCloudWeights` + `shuffleTagsDeterministic` 得到词条。
- 布局：居中 `flex flex-wrap items-baseline justify-center gap-x-4 gap-y-2`。
- 每个词条是 `<Link href="/tags/<encodeURIComponent(tag)>?s=<subjectSlug>">` 纯文字（**不复用 `TagLink` chip**；其他页面的 `TagLink` 不动）：
  - 字号：`fontSize = ${0.875 + weight * 1.625}rem`（约 14px–40px），行内 style；
  - 热度色：`opacity = 0.45 + weight * 0.55`；颜色用现有 `text-accent`（继承 CSS 变量，暗色主题自动适配）；hover 加下划线；
  - `title="N pages"` 悬停提示，不显示数字计数。
- 空态/loading 骨架/`No tags yet` 文案保持现状。

### 3. 不改的部分

- `aggregateTags` / `pagesWithTag` / `/tags/[tag]` 单标签页 / `TagLink` 组件 / API。

## 错误处理

无新增失败路径；请求失败沿用现状（空列表 → No tags yet）。

## 测试

- 单测：上述纯函数用例。
- 手动：`npx tsc --noEmit` + 浏览器目视 `/tags`（多 tag、单 tag、暗色主题、点击跳转）。
