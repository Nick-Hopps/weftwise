# Wiki 页面身份迁移 Phase 3D 设计

日期：2026-07-14
状态：已完成

## 一、来源与目标

本设计承接 `2026-07-10-wiki-tooling-and-workflow-governance-design.md` 的 Phase 3 第 4 项，实现受治理的 `wiki.move`：

```text
wiki.move({ slug, newSlug })
  → 当前 Subject 内生成精确 PendingAction 预览
  → 用户通过独立批准 API 授权
  → 单 Subject Saga 迁移页面身份及其派生状态
```

这里的 move 是页面 canonical slug/path 变更，不是改 `title`。页面正文与来源必须保留；模型不能直接移动文件，也不能跨 Subject 写入。

## 二、范围

### 2.1 本期实现

1. 新增 `wiki.move` builtin，输入 `{ slug, newSlug }`，`sideEffect:'propose'`，只进入 `query:propose`；
2. 新增 PendingAction operation=`move`，预览展示旧路径删除、新路径创建及当前 Subject 内引用更新；
3. 目标 slug 必须是 canonical、与源不同、未被页面或其他页面 alias 占用；`index/log` 不能作为源或目标；
4. 移动页 frontmatter 保留正文/标题/来源，并把旧 slug 追加到 `aliases`，使 alias 可从 vault 重建；
5. 当前 Subject 内解析到旧页的 wikilink 改写为新 slug，保留 subject 前缀、锚点和显示别名；跨 Subject 源文件不写入；
6. `page_aliases` 从 frontmatter aliases 重建并参与同 Subject、跨 Subject链接解析；旧 URL 服务端重定向到 canonical slug；
7. `page_sources`、source sidecar `linkedPages`、`page_embeddings`、`page_maturity`、`page_renditions` 与 `profile_signals.slug` 随身份迁移；
8. `pages/pages_fts/wiki_links/page_aliases` 在持有 vault 锁时按 vault 全量重建，保证跨 Subject 旧链接解析到新 canonical slug；
9. Changeset 记录明确的 `movedFromPath` 和受控 auxiliary sidecar entries，使失败回滚、崩溃前滚与 History revert 都能确定性恢复；
10. History revert 把 move 反向为新 slug → 旧 slug，并产生反向 alias，兼容移动期间产生的新链接。

### 2.2 非目标

- 不移动页面到其他 Subject；
- 不改页面 title，不把标题重命名与 slug 迁移混为一体；
- 不开放通用文件 rename、任意 path 或任意 DB 主键更新工具；
- 不让 Query 获得直接 create/delete/update 工具；
- 不批量移动多个页面；
- 不新增 LLM task，不修改 `llm-config.example.json`。

## 三、工具与审批契约

### 3.1 `wiki.move`

输入：

```ts
{ slug: string; newSlug: string }
```

输出 `PendingActionView`。handler 只调用现有 preview callback，不写 vault/SQLite/git。

`newSlug` 不静默纠正：非 canonical 输入直接拒绝，避免用户批准的文本与实际路径不同。预览 payload 参与 canonical hash，并保存 `effectiveAt` 与 `preHead`。

### 3.2 批准

批准时重新规划并检查：

- conversation/subject/payload hash/TTL；
- 源页仍存在且不是 meta 页；
- 目标仍未被 page/alias 占用；
- vault HEAD 与预览一致；
- Subject mutation epoch 仍有效。

批准成功后 action 保存 Saga `operationId`；embedding job 与 action `applied` 继续由既有原子 finalizer 收口。

## 四、持久化 alias 与链接语义

移动 `old-page → new-page` 时，目标页 frontmatter aliases 追加 `old-page`。索引器把每页 aliases 规范化后同步到：

```text
page_aliases(subject_id, old_slug, new_slug)
```

规则：

- 自映射忽略；同一 old slug 只允许指向一个 canonical page；
- 每次索引目标页替换该页的 alias 集合，页面删除时清掉指向它的 alias；
- title resolver 同时读取 title 与 alias；
- 跨 Subject link 在解析目标 Subject 后再次应用 alias；
- 页面路由遇到旧 slug 时 308 跳转到新 slug，并保留 `?s=`；写 API 不通过 alias 静默改写目标。

当前 Subject 的源码引用会改写成新 slug；跨 Subject 与外部旧链接不改源码，但索引和 URL 通过 alias 解析到新页。

## 五、Saga 与派生状态迁移

Move changeset 使用普通 `delete old + create new + update backlinks`，但新页 create entry 带 `movedFromPath`。Source sidecar 作为 `auxiliary:true` 的受控 `.llm-wiki/sources/<subject>/*.json` entry 同 commit 写入。

`applyChangeset` 在同一 DB transaction 中先按 `movedFromPath` 迁移可保留状态，再重建页面索引：

- `page_sources.page_slug`；
- `page_embeddings.slug`；
- `page_maturity.slug`；
- `page_renditions.slug`；
- `profile_signals.slug`；
- `pages/pages_fts/wiki_links/page_aliases` 从 vault 重建。

目标 slug 在计划阶段必须没有上述 canonical page/alias 冲突。迁移 SQL 使用 subject + 精确 slug，不扩大作用域。

失败路径：

- git commit 前失败：restore `preHead`，反向迁移派生状态并重建索引；
- commit 已成功但 operation 未 applied：recovery 根据 `[cs:<id>]` 前滚，幂等重做迁移与重建；
- History revert：`buildRevertEntries` 识别 `movedFromPath`，生成反向 move marker，恢复原文件/sidecar和派生状态。

## 六、UI、Prompt 与审计

- Query intent 仅把明确的“移动页面/修改 slug/rename slug”识别为 propose；能力询问、教程和否定句保持 read；
- Query prompt 明确 `wiki.move` 只改变 slug/path、不改变 title，且批准按钮是唯一授权；
- tool activity 只展示 `slug → newSlug`；
- PendingAction 卡片复用 page-change diff，不展示 source sidecar 原文；
- History 将一次 move 显示为旧页 delete + 新页 create，diff/回滚继续复用既有 API。

## 七、迁移与兼容

1. pending_actions operation CHECK 增加 `move`，提供启动期原子迁移和 Drizzle migration；
2. `page_aliases` 不改表结构，但从“未使用表面”升级为索引器/路由使用的持久化页面身份映射；
3. 全库 rebuild 从 frontmatter aliases 重建 `page_aliases`，从 sidecar 恢复已迁移的 page_sources；
4. 不新增 LLM task/provider 路由，`llm-config.example.json` 保持不变。

## 八、测试与验收

1. registry 为 28 个 builtin，`wiki.move` 只属于 `query:propose`；
2. preview 零写副作用，非法/meta/冲突/跨路径 slug 被拒绝；
3. 规划结果保留正文/metadata，增加旧 slug alias，并只改写当前 Subject backlink；
4. apply 后旧文件消失、新文件存在，pages/FTS/wiki_links/alias 与 vault 一致；
5. page_sources + sidecar、embedding、maturity、rendition、profile signal 精确迁移；
6. 同 Subject、跨 Subject旧链接和旧 URL 均解析到新页；
7. apply 失败和 recovery rollback 恢复旧身份，History revert 可反向 move；
8. stale preview、重复批准、subject 不匹配继续拒绝；
9. 启动迁移与 Drizzle migration 保留旧 pending action；
10. 定向测试、全量测试、类型检查、lint、build 通过；
11. `git diff -- llm-config.example.json` 为空。

## 九、阶段结论

Phase 3D 已完成，治理总 spec 的 Phase 3 全部完成。后续只保留已声明的兼容清理：观察期结束后删除 `wiki.reenrich` 弃用 alias。

验收结果：238 个测试文件、2088 个用例全通过；`npx tsc --noEmit`、`npm run lint`、`npm run build` 通过；`llm-config.example.json` 无差异。
