# Wiki 窄写工具 Phase 2B 设计

**日期：** 2026-07-13

**状态：** 已完成（2026-07-13）

**实现证据：** `01a6002`–`40befe2`（契约、事务内核、工具、Fix/Curate 与 Query 审批）、`3050509`（合并收口）
**来源：** `docs/superpowers/specs/2026-07-10-wiki-tooling-and-workflow-governance-design.md` 第九章

## 一、目标

Phase 2B 新增两个受约束的 Wiki 写工具：

- `wiki.metadata.patch`：只更新 `title / summary / tags / aliases`，逐字保留正文；
- `wiki.link.ensure`：只维护一个明确、已验证的 wikilink，不允许模型自由重写整页。

两个工具必须共用确定性 plan/apply 与 Saga 写入内核：

- Query 只通过 `wiki.preview_change` 生成预览，批准后由服务端重算并应用；
- Fix / Curate 在 job capability、ToolProfile、scope policy 与各自 Guard 通过后直接执行；
- 所有写入仍是 `createChangeset → validateChangeset → applyChangeset → git commit`；
- 不新增 LLM task 或模型调用，因此 `llm-config.example.json` 保持不变。

## 二、非目标

本阶段不实现：

- Research 候选来源的批准 provenance（Phase 2C）；
- Ask AI “保存到 Wiki”的统一 create 审批路径（Phase 2D）；
- 自动生成 `Related` 段落或基于模型常识猜测自然锚点；
- 自动创建目标页、跨 Subject 写入目标页或批量维护多条关系；
- 新数据库表、LLM task route 或前端审批组件。`pending_actions.operation` 的既有 CHECK 必须做兼容迁移，否则新 operation 无法持久化。

## 三、安全边界

### 3.1 Query

Query 的 `query:read` / `query:propose` Profile 边界不变：

- `query:read` 只有只读工具；
- `query:propose` 只比 read 多 `wiki.preview_change`；
- `wiki.metadata.patch` 与 `wiki.link.ensure` 不直接进入 Query ToolSet；
- `wiki.preview_change` 新增 `metadata-patch` / `link-ensure` operation；
- 创建 pending action 时只 plan/diff，不写 vault、SQLite、git，也不入队；
- 批准时从服务端持久化 payload 重算 plan，并沿用 payload hash、TTL、原子 claim、`preHead` 陈旧检测。

这保证口头确认、历史消息或模型自行调用均不能越过批准按钮。

### 3.2 Fix / Curate

- Fix 与 Curate 只在携带匹配 job capability 时获得真实写工具；
- Curate 的 compile policy 对 source page 做 `allowedPageSlugs` 校验；scoped Fix 保留 subject-wide 证据读取，并扩展既有 `scopeFixWrites()` 只包装写能力；
- Fix 继续经过 `FixGuard.canWrite/canEditPage`，每次成功写入计为一次 update；
- Curate 继续经过 `CurateGuard.canEditPage`，每次成功写入计为一次 update；
- `wiki.link.ensure` 的跨主题 target 只用于存在性验证，不扩大当前 Subject 的写 scope；
- `index` / `log` 等 `META_PAGE_SLUGS` 仍禁止编辑。

## 四、公共契约

### 4.1 `wiki.metadata.patch`

```ts
interface MetadataPatchInput {
  slug: string;
  title?: string;
  summary?: string;
  tags?: string[];
  aliases?: string[];
}
```

规则：

1. `slug` 必须指向当前 Subject 的现有非系统页；
2. `title / summary / tags / aliases` 至少显式提供一项；
3. `title` trim 后必须非空，最大 200 字符；
4. `summary` trim，允许空字符串用于清空，最大 2,000 字符；
5. tags 每项 trim、移除空项、按规范化文本去重，最多 32 项、单项最多 64 字符；
6. aliases 每项 trim、移除空项、按 `normalizeSlug` 后的身份去重，最多 32 项、单项最多 200 字符；
7. alias 不得与同 Subject 其他页面的 slug、title 或 frontmatter alias 在 `normalizeSlug` 后冲突；
8. 当前页自己的 slug/title/既有 alias 不算“其他页面”冲突，但最终 aliases 内部仍须唯一；
9. title 改变时复用现有 backlink relink，相关页与当前页进入同一 changeset；
10. 页面正文 `doc.body` 必须逐字传入序列化过程，工具不得接收或生成正文；
11. 系统维护 `created / updated / sources`，调用方不能覆盖；
12. 无实际变化时返回明确错误，不创建空 commit。

本阶段的 frontmatter `aliases` 仅作为可编辑 metadata 与身份冲突约束；当前 wikilink title resolver 尚不消费该字段。本阶段不扩展 indexer/resolver，也不宣称 alias 可作为链接目标；alias 解析能力需另行设计索引、歧义与重建语义。

输出：

```ts
{
  updatedSlug: string;
  referencesUpdated: number;
  changedFields: Array<'title' | 'summary' | 'tags' | 'aliases'>;
}
```

### 4.2 `wiki.link.ensure`

```ts
interface LinkEnsureInput {
  sourceSlug: string;
  targetSubjectSlug?: string;
  targetSlug: string;
  oldString: string;
  displayText?: string;
  mode: 'link' | 'unlink' | 'retarget';
}
```

公共规则：

1. `sourceSlug` 必须是当前 Subject 的现有非系统页；
2. `oldString` 非空，且在 source body 中恰好出现一次；它可以带少量上下文用于消歧，但不能跨 frontmatter/body 边界；
3. `targetSubjectSlug` 缺省为当前 Subject；
4. `link` / `retarget` 的 target Subject 与 target page 必须存在；`unlink` 允许目标已不存在，以便修复 broken link；
5. target 只参与链接验证，唯一写入对象始终是 source page；
6. 生成的 wikilink 使用稳定 slug：同主题 `[[target-slug|显示文本]]`，跨主题 `[[subject:target-slug|显示文本]]`；
7. 复用 `resolveWikiLinkTarget` 解析已有 token，复用 `executePagePatch` / `planPagePatch` 完成唯一字符串替换与 Saga；
8. 不自动追加段落、列表或“相关推荐”；找不到调用方提供的自然锚点即失败；
9. 无实际变化时失败，不产生空 commit。

模式规则：

- `link`
  - `oldString` 必须是普通正文上下文，不能包含 wikilink token；
  - 自然锚点为 `displayText ?? oldString`；`displayText` 若提供，trim 后必须非空且在 `oldString` 内恰好出现一次；
  - 锚点在 source body 中必须是可见 prose，不得位于 fenced/inline code、已有 wikilink、Markdown link/image 内；
  - `displayText` 只定位要包装的既有子串，不是 replacement text；替换结果只在 `oldString` 内包装该锚点，周围上下文和最终可见文本均不改变。
- `unlink`
  - `oldString` 必须包含且只包含一个有效 wikilink token；可带少量周围上下文用于消歧；
  - token 解析后的 subject/slug 必须与输入 target 相符，避免解错链接；
  - 替换结果只把该 token 换成当前显示文本：alias 存在则用 alias，否则用原 target 文本；周围上下文不变；
  - `displayText` 若提供，只作为期望显示文本断言，不可借此改写可见文本。
- `retarget`
  - `oldString` 必须包含且只包含一个有效 wikilink token；可带少量周围上下文用于消歧；
  - 保留 token 当前显示文本，只把该 token 替换到已验证的新 target，周围上下文不变；
  - `displayText` 若提供，只作为期望显示文本断言；
  - 新 token 与旧 token 相同则失败。

输出：

```ts
{
  updatedSlug: string;
  mode: 'link' | 'unlink' | 'retarget';
  targetSubjectSlug: string;
  targetSlug: string;
}
```

## 五、确定性执行内核

### 5.1 纯函数层

新增窄写纯函数模块，负责：

- 规范化 metadata patch；
- 计算实际 changed fields；
- 扫描同 Subject frontmatter 并校验 alias identity 冲突；
- 把 link ensure 输入转换为唯一 `{ oldString, newString }` edit；
- 校验 link/unlink/retarget 的 token 形态、显示文本和目标一致性。

纯函数不写盘、不读网络、不调用 LLM，边界用单元测试固定。

### 5.2 plan/apply 层

`PlannedPageOperation.operation` 扩展：

```ts
'create' | 'update' | 'patch' | 'delete' | 'metadata-patch' | 'link-ensure'
```

- `planPageMetadataPatch` 构造当前页 + title relink 相关页的一次 changeset；
- `planPageLinkEnsure` 先生成确定性 edit，再委托 page patch plan；
- direct execute 路径使用同一计划构造逻辑后立即 apply，避免 direct 与 approval 两套语义漂移；
- preview 保存 diff、affected pages、warnings 与 `preHead`；
- approval 重算同一 plan，若 `preHead` 改变则刷新预览并要求重新批准。

### 5.3 服务包装

`page-write.ts` 新增 plan/direct 包装：

- `planMetadataPatchInSubject` / `patchMetadataInSubject`；
- `planLinkEnsureInSubject` / `ensureLinkInSubject`。

服务包装统一完成系统页保护、向量回填与对外错误消息。向量调度所有权按入口唯一归属：

- 面向同步 API/未来直接调用的 page-write direct wrapper 成功后 enqueue 一次；
- Fix/Curate worker ToolContext 直接调用不 enqueue 的 page-ops 事务内核，继续由 job 结束时按 `totals.writes > 0` 统一 enqueue 一次；
- PendingAction 批准并成功 apply 任意 page plan 后 enqueue 一次，既覆盖两个新 operation，也修正既有 create/update/patch/delete 批准路径未触发向量回填的问题；
- 陈旧、拒绝、失败和 re-enrich workflow 分支不得触发。

### 5.4 PendingAction 兼容迁移

现有 `pending_actions_operation_check` 只允许 `create/update/patch/delete/reenrich`。本阶段必须同时更新：

- Drizzle schema CHECK；
- 新安装使用的迁移快照；
- `client.ts::ensureTables` 启动期自迁移：检测旧 CHECK 后在单个 SQLite transaction 内执行 `_new → INSERT SELECT → DROP → RENAME`，保留全部历史行，并由 `ensureIndexes` 重建索引；
- 迁移回归测试：旧表历史 action 不丢失，新 `metadata-patch/link-ensure` 可插入，未知 operation 仍被拒绝；故意让 copy 违反新 CHECK 时事务回滚，旧表和历史行保持原状。

迁移只扩展枚举约束，不新增表或业务数据。

## 六、工具注册与 Profile

新增 builtin ToolDef：

- `src/server/agents/tools/builtin/wiki-metadata-patch.ts`；
- `src/server/agents/tools/builtin/wiki-link-ensure.ts`。

Profile 变化：

| Profile | 变化 |
|---|---|
| `query:read` | 不变 |
| `query:propose` | 仍只有 `wiki.preview_change` 提案能力，不直接加窄写工具 |
| `fix:links` | 用 `wiki.link.ensure` 替换通用 `wiki.patch` |
| `fix:contradiction` | 保留 `wiki.patch` / `wiki.update`，并加入 `wiki.link.ensure` |
| `curate:auto` | 加入 `wiki.link.ensure` / `wiki.metadata.patch`，side effect 增加 `update` |
| `curate:manual` | 同 auto，另保留 create/delete |

compile policy 新增两类 source slug 提取与上下文 wrapper：

- metadata 以 `slug` 校验；
- link ensure 只以 `sourceSlug` 校验，不能把跨主题 `targetSlug` 错当作当前 Subject 写 scope。

审计日志继续脱敏 `oldString / displayText`，并记录 source page、mode、target identity 和结果。

## 七、工作流接入

### 7.1 Fix

- `broken-link` / `missing-crossref` 指示模型优先使用 `wiki.link.ensure`；
- 链接专用 Profile 不再提供通用正文 `wiki.patch`；
- remediation context 收窄的 Fix 继续保持 subject-wide read/search/inspect/source evidence；所选 finding 页面集合交给既有 `scopeFixWrites()`，并把 `linkEnsure` 纳入 write-only wrapper。范围外 source 拒绝，范围外 target 仍可作为只读验证目标，不得借 target 扩大写 scope；FixGuard 继续独立执行 cap 与系统页保护；
- contradiction Profile 保留通用 patch/update 处理事实冲突，并可用 link ensure 维护明确关系；
- FixGuard 成功后以 `record('update')` 计数；
- 失败仍由工具返回 `ok:false`，模型可在剩余步骤中读取证据后修正输入。

### 7.2 Curate

- Auto / Manual 均可在 allowedSet 内补一条自然 cross-reference 或调整 metadata；
- link ensure 只要求 source page 在 allowedSet；target 可以是同 Subject allowedSet 外页面或显式跨主题页面，因为 target 不被写入；
- 不允许用该工具新增 Related 段落；模型必须先 `wiki.read`，引用正文中已经存在的唯一自然锚点；
- CurateGuard 新增 `canEditPage` 与独立 `update` cap（默认 5）；成功后以 `record('update')` 计数，既有 merge/split/create/delete caps 不变。

### 7.3 Query

- Query prompt 只指导模型调用 `wiki_preview_change` 的新 operation；
- UI 继续消费现有 PendingActionView，无新 API 或组件；
- diff 仍显示完整 frontmatter/body 文件差异，但 metadata patch 的 body 行应完全不变，link ensure 只出现目标片段差异。

## 八、测试策略

### 8.1 纯函数与 Wiki 内核

- metadata 字段至少一项、trim/去重/上限、空提交；
- alias 与其他页 slug/title/alias 冲突；
- body 字节级保留、title relink 与单 changeset；
- link 三模式、唯一匹配、token 形态、显示文本保留；
- 同主题/跨主题 target 存在性与系统页保护；
- 新链接 unresolved 时整批拒绝。

### 8.2 工具体系

- registry 注册两个工具；
- ToolDef handler 成功/失败；
- Profile 精确工具面与 side effect；
- compile job capability、source scope、target 不误判、审计脱敏；
- Fix/Curate Guard allow/deny 与计数。

### 8.3 审批闭环

- payload schema/normalize/hash 覆盖两个 operation；
- preview 不写盘；
- approve 重算并 apply；
- page plan apply 成功后恰好触发一次 embedding 回填，stale/reject/fail/re-enrich 不误触发；
- stale preview 刷新；
- Query propose 仍不含真实写工具；
- PendingAction API/UI 旧操作回归。
- 旧 pending_actions CHECK 的启动期迁移保留历史数据并接受新 operation。

### 8.4 全量验证

```bash
npx vitest run
npm run lint
npx tsc --noEmit
npm run build
git diff --exit-code a608542 -- llm-config.example.json
```

## 九、验收标准

1. 两个 builtin 工具均已注册并由受控 Profile 使用；
2. Query 只能生成两个新 operation 的 pending preview，不能直接执行真实工具；
3. metadata patch 正文逐字不变，title relink 同 changeset，aliases 冲突被拒绝；
4. link ensure 每次只改 source body 的一个唯一片段；link/retarget 目标必须存在，unlink 允许移除目标不存在的 broken link，unlink/retarget 均保留显示文本；
5. Fix 链接修复不再依赖任意正文 patch；Curate 可在 Guard/scope 内使用两个窄写工具；
6. direct 与 approval 路径复用同一 plan/apply 语义；
7. 全量测试、lint、类型检查、build 通过；
8. `llm-config.example.json` 无差异。
