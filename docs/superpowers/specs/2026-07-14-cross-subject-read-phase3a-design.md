# Wiki 跨 Subject 只读工具 Phase 3A 设计

日期：2026-07-14  
状态：已确认，进入实现

## 一、来源与目标

本设计承接 `2026-07-10-wiki-tooling-and-workflow-governance-design.md` 的 Phase 3 第 1 项，在不放开任何跨 Subject 写权限的前提下，为 Ask AI 建立完整的跨 Subject 只读闭环：

```text
subject.list
  → wiki.search_cross_subject
  → wiki.read_cross_subject
  → [[subject-slug:page-slug]] 引用
```

总设计明确列出 `subject.list` 与 `wiki.search_cross_subject`。仅返回搜索摘要不足以满足现有“事实必须来自已读正文”的引用纪律，因此本切片补充 `wiki.read_cross_subject`；它只读取显式指定 Subject 的已提交页面正文，不改变现有 `wiki.read` / `wiki.search` 的当前 Subject 语义。

## 二、范围

### 2.1 本期实现

1. `subject.list`：列出可见 Subject 的 id、slug、name、description、pageCount；
2. `wiki.search_cross_subject`：在显式指定的其他 Subject 中检索页面，结果始终携带 `subjectSlug`；
3. `wiki.read_cross_subject`：按 `subjectSlug + slug` 读取正文；
4. 三个工具只加入 `query:read` / `query:propose`；
5. Ask AI prompt 增加跨 Subject 工具策略与 `[[subject:slug]]` 引用规则；
6. 访问收集器用 `subjectSlug + slug` 区分同名页面；
7. Query citation 增加可选 `subjectSlug`，旧持久化 JSON 无需迁移；
8. 聊天引用跳转和 Save-to-Wiki References 正确保留跨 Subject 目标。

### 2.2 非目标

- 不允许跨 Subject create/update/patch/delete/merge/split/reenrich；
- 不让 Fix、Curate、Ingest 获得跨 Subject 工具；
- 不开放其他 Subject 的 raw source、health 或完整图谱；
- 不修改现有 `wiki.search`、`wiki.read`、`source.search/read` 的作用域；
- 不新增 LLM task，不修改 `llm-config.example.json`；
- 不实现 History、workflow command 或 `wiki.move`。

## 三、工具契约

### 3.1 `subject.list`

输入为空对象。输出按 Subject name 稳定排序：

```ts
{
  subjects: Array<{
    id: string;
    slug: string;
    name: string;
    description: string;
    pageCount: number;
  }>;
}
```

`pageCount` 只统计非 meta 页面，避免系统页误导模型。

### 3.2 `wiki.search_cross_subject`

```ts
{
  query: string;
  subjectSlugs: string[]; // 1..5，显式选择
  limit?: number;         // 默认 8，最大 20，总结果上限
}
```

输出：

```ts
{
  hits: Array<{
    subjectSlug: string;
    slug: string;
    title: string;
    summary: string;
  }>;
}
```

约束：

- 调用方必须先从 `subject.list` 获得真实 slug，不接受模糊 Subject 名；
- 当前 Subject 从 `subjectSlugs` 中剔除，避免与 `wiki.search` 重复；
- 未知 Subject 返回稳定错误，不静默扩大到全部 Subject；
- 每个 Subject 复用现有混合检索，按各自排名轮询合并，避免一个大 Subject 垄断结果；
- meta 页面过滤；
- 搜索命中只记元数据访问，不能直接生成 citation。

### 3.3 `wiki.read_cross_subject`

```ts
{ subjectSlug: string; slug: string }
```

返回 `{ found, subjectSlug, slug, title, body }`。当前 Subject 目标拒绝并提示使用 `wiki.read`；未知 Subject、meta 页面、空正文或不存在页面统一返回 `found:false`，不泄露其他存储信息。

## 四、授权与隔离

- 三个工具均为 `sideEffect:'none'`；
- 只进入 Query 两个 profile；
- `ToolContext` 仅新增只读回调，不暴露通用 repo、DB 或 Subject 切换能力；
- 工具 handler 不接受 subjectId，只接受 slug 并由服务端重新解析；
- 跨 Subject 读取不会改变 active Subject，也不会影响 PendingAction 的 subject/payload hash；
- `query:propose` 即使先读取其他 Subject，预览和批准仍只能写 active Subject。

## 五、引用与兼容

共享引用契约升级为：

```ts
interface WikiCitation {
  pageSlug: string;
  excerpt: string;
  subjectSlug?: string;
}
```

兼容策略：

- active Subject 引用继续输出 `{ pageSlug, excerpt }`；
- 跨 Subject 引用额外输出 `subjectSlug`；
- `AccessedPages` 为跨 Subject 页面使用复合键，两个 Subject 的同名 slug 不互相覆盖；
- 引用解析只接受本轮 `wiki.read` / `wiki.read_cross_subject` 真正读过的正文；
- 跨 Subject 答案必须写 `[[subject-slug:page-slug]]`；
- 聊天引用点击跳到 `/wiki/<slug>?s=<subjectSlug>`；
- Save-to-Wiki 的 References 对 active Subject 保持 `[[slug]]`，对其他 Subject 写 `[[subject:slug]]`；
- 历史消息没有 `subjectSlug` 时沿用 active Subject 行为，无 DB 迁移。

## 六、空库与降级

现有 `runQuery` 在 active Subject 无内容时会直接短路，这会阻止“去其他 Subject 查找”。Phase 3A 移除此短路；工具循环可以先 `subject.list` 再跨 Subject 检索。只有模型完成工具循环后仍无内容，才返回既有兜底回答并记录 coverage gap。

## 七、测试与验收

1. registry 注册 20 个 builtin，三个新工具均为只读；
2. Query 两个 profile 包含三工具，其他 profile 精确不含；
3. `subject.list` 排序稳定、pageCount 排除 meta；
4. cross search 要求显式 Subject、拒绝未知/active slug、过滤 meta、限制总结果；
5. cross read 只能读取指定其他 Subject 的已提交非 meta 正文；
6. 同名 slug 的 active/cross 访问互不覆盖；
7. 未读、伪造或 Subject 不匹配的跨主题 wikilink 不产生 citation；
8. 聊天引用与保存 References 保留 `subjectSlug`；
9. PendingAction 仍只绑定 active Subject；
10. 定向测试、全量测试、lint、build 通过；
11. `llm-config.example.json` 与本阶段基线无差异。

## 八、后续阶段

- Phase 3B：History list/diff/revert 审批工具；
- Phase 3C：workflow start/status/cancel；
- Phase 3D：`wiki.move` 独立设计与实现。
