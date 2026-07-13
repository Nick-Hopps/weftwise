# Wiki 窄写工具 Phase 2B 执行计划

> **执行方式：** 隔离 worktree + TDD + 分任务 spec review / code quality review + 最终整体验收。

**目标：** 实现 `wiki.metadata.patch` 与 `wiki.link.ensure`，接入 Query 审批、Fix 与 Curate，同时保持既有 Saga、scope、Guard 和 LLM 配置边界。

**设计文档：** `docs/superpowers/specs/2026-07-13-wiki-narrow-write-tools-phase2b-design.md`

**分支：** `feat/wiki-narrow-write-tools-phase2b`  
**worktree：** `.worktrees/wiki-narrow-write-tools-phase2b`  
**基线：** `d4fa243`

## Task 1：冻结公共契约与 metadata 纯函数

**文件：**

- Modify: `src/lib/contracts.ts`
- Create: `src/server/wiki/narrow-write.ts`
- Create: `src/server/wiki/__tests__/narrow-write-metadata.test.ts`

**步骤：**

1. 先写失败测试，覆盖至少一项字段、title/summary 边界、tags/aliases trim 去重和数量/长度限制。
2. 写失败测试，覆盖 alias 与其他页 slug/title/alias 的规范化冲突。
3. 在 contracts 中加入 metadata/link 输入、结果类型及 PendingAction operation。
4. 实现纯函数与集中常量，使测试通过。
5. 运行：

   ```bash
   npx vitest run src/server/wiki/__tests__/narrow-write-metadata.test.ts
   npx tsc --noEmit
   ```

6. 提交：`feat(wiki): 定义窄写契约与元数据规范化`

## Task 2：实现 metadata plan/apply 与服务包装

**文件：**

- Modify: `src/server/wiki/page-operation-plan.ts`
- Modify: `src/server/wiki/page-ops.ts`
- Modify: `src/server/services/page-write.ts`
- Create: `src/server/wiki/__tests__/page-operation-plan-metadata.test.ts`
- Create: `src/server/services/__tests__/page-write-metadata.test.ts`

**步骤：**

1. 先写失败测试：正文逐字保留、title relink、changedFields、单 changeset、空变更拒绝。
2. 先写失败测试：系统页、缺页、alias 冲突、direct apply 后 embed enqueue。
3. 新增 `planPageMetadataPatch`；复用 update relink 逻辑但不让调用方传 body。
4. direct execute 从同一 plan 立即 `applyPlannedPageOperation`，禁止复制第二套 changeset 构造。
5. 新增 page-write plan/direct 包装。
6. 运行相关测试及既有 page update/patch 回归。
7. 提交：`feat(wiki): 实现元数据窄写事务内核`

## Task 3：实现 link ensure 纯函数与 plan/apply

**文件：**

- Modify: `src/server/wiki/narrow-write.ts`
- Modify: `src/server/wiki/page-operation-plan.ts`
- Modify: `src/server/wiki/page-ops.ts`
- Modify: `src/server/services/page-write.ts`
- Create: `src/server/wiki/__tests__/narrow-write-link.test.ts`
- Create: `src/server/wiki/__tests__/page-operation-plan-link.test.ts`
- Create: `src/server/services/__tests__/page-write-link.test.ts`

**步骤：**

1. 先写失败测试覆盖 link/unlink/retarget、显示文本保留、唯一匹配与 token 完整性。
2. 写同 Subject、跨 Subject target 存在性和 source-only 写 scope 测试；target 存在性只适用于 link/retarget，unlink 必须允许 broken target 不存在。
3. 实现 link edit 纯函数，复用 `resolveWikiLinkTarget`。
4. `planPageLinkEnsure` 委托 patch plan；direct execute 应用同一 plan。
5. 服务包装保护 meta、成功后 enqueue embedding。
6. 运行相关测试及 wikilinks/page patch 回归。
7. 提交：`feat(wiki): 实现链接关系窄写事务内核`

## Task 4：注册 builtin 工具并收紧 Profile / compile policy

**文件：**

- Create: `src/server/agents/tools/builtin/wiki-metadata-patch.ts`
- Create: `src/server/agents/tools/builtin/wiki-link-ensure.ts`
- Modify: `src/server/agents/tools/builtin/index.ts`
- Modify: `src/server/agents/tools/tool-context.ts`
- Modify: `src/server/agents/tools/profiles.ts`
- Modify: `src/server/agents/tools/compile.ts`
- Modify: `src/lib/tool-activity.ts`
- Create: `src/server/agents/tools/builtin/__tests__/wiki-metadata-patch.test.ts`
- Create: `src/server/agents/tools/builtin/__tests__/wiki-link-ensure.test.ts`
- Modify: `src/server/agents/tools/builtin/__tests__/registry.test.ts`
- Modify: `src/server/agents/tools/__tests__/profiles.test.ts`
- Modify: `src/server/agents/tools/__tests__/compile.test.ts`

**步骤：**

1. 先写 ToolDef 与 registry 失败测试。
2. 先写 Profile 精确面测试：Query 无真实写工具、Fix links 用 link.ensure、Curate 含两个窄写工具。
3. 写 compile scope 测试：metadata 校验 slug；link 只校验 sourceSlug；跨主题 target 不误判。
4. ToolContext 注入两项能力，审计脱敏 `oldString/displayText`。
5. 更新工具活动摘要，不输出正文或锚点原文。
6. 运行 agents/tools 相关测试。
7. 提交：`feat(agents): 注册窄写工具并收紧执行策略`

## Task 5：接入 Fix 与 Curate 工作流

**文件：**

- Modify: `src/server/services/fix-tools.ts`
- Modify: `src/server/services/curate-tools.ts`
- Modify: `src/server/services/fix-service.ts`
- Modify: `src/server/services/curate-service.ts`
- Modify: `src/server/wiki/curate-plan.ts`
- Modify: `src/server/llm/prompts/fix-prompt.ts`
- Modify: `src/server/llm/prompts/curate-prompt.ts`
- Modify: `src/server/services/__tests__/fix-tools.test.ts`
- Modify: `src/server/services/__tests__/curate-tools.test.ts`
- Modify: `src/server/wiki/__tests__/curate-plan.test.ts`
- Modify: `src/server/services/__tests__/fix-service.test.ts`
- Modify: `src/server/services/__tests__/curate-service.test.ts`
- Modify: `src/server/llm/prompts/__tests__/fix-prompt.test.ts`
- Modify: `src/server/llm/prompts/__tests__/curate-prompt.test.ts`

**步骤：**

1. 先写失败测试：Fix Guard deny 不执行；扩展 `scopeFixWrites()` 后 remediation scoped Fix 保持 subject-wide 读取、只允许 finding 对应 source page、允许范围外 target 作为只读验证目标；CurateGuard 新增 `canEditPage` 与独立 `update` cap，allow 后记录 update 并 emit。
2. Fix links profile 迁移到 `wiki.link.ensure`；contradiction 保留通用 patch/update。
3. Curate Auto/Manual 注入两个 direct 能力；source 受 allowedSet，target 只读验证；同步 `CURATE_CAPS`、`CurateTotals`、空结果、完成摘要和 cap 日志。
4. Fix/Curate ToolContext 均直接调用不 enqueue 的 page-ops 内核，继续只在 job 结束且 `totals.writes > 0` 时统一 enqueue 一次。
5. 更新 prompt，明确先 read、唯一自然锚点、不生成 Related 段落。
6. 运行 Fix/Curate 工具、服务与 prompt 测试。
7. 提交：`feat(workflow): 接入 Fix 与 Curate 窄写流程`

## Task 6：接入 Query PendingAction 审批闭环

**文件：**

- Modify: `src/server/services/pending-action-payload.ts`
- Modify: `src/server/services/pending-action-service.ts`
- Modify: `src/server/db/schema.ts`
- Modify: `src/server/db/client.ts`
- Create: `drizzle/0003_pending_action_narrow_writes.sql`（以 `npm run db:generate` 实际输出为准）
- Modify: `drizzle/meta/_journal.json`
- Create: `drizzle/meta/0003_snapshot.json`（以生成结果为准）
- Modify: `src/server/agents/tools/builtin/wiki-preview-change.ts`
- Modify: `src/server/llm/prompts/query-prompt.ts`
- Modify: `src/server/services/__tests__/pending-action-payload.test.ts`
- Modify: `src/server/services/__tests__/pending-action-service-preview.test.ts`
- Modify: `src/server/services/__tests__/pending-action-service-approval.test.ts`
- Create: `src/server/db/__tests__/pending-actions-migration.test.ts`
- Modify: `src/server/agents/tools/builtin/__tests__/wiki-preview-change.test.ts`
- Modify: `src/server/services/__tests__/resolve-query-tools.test.ts`
- Modify: `src/server/llm/prompts/__tests__/query-prompt.test.ts`

**步骤：**

1. 先写两个新 operation 的 schema/normalize/hash 失败测试。
2. 先写旧 CHECK 兼容迁移测试：历史行保留、新 operation 可插入、未知值仍拒绝；故意触发 copy 失败时事务回滚并保留旧表/历史行。
3. 更新 schema CHECK，生成结构迁移；同步 `client.ts::ensureTables` 的原子启动期自迁移，重建序列必须位于单个 SQLite transaction。
4. 写 preview 不 apply、approve 重算/apply、stale 刷新测试；page plan 批准成功恰好 enqueue 一次 embedding，stale/reject/fail/re-enrich 不误触发。
5. 扩展 planPreview/replanRecord 穷尽分支。
6. 更新 preview 工具描述与 Query prompt；真实窄写工具仍不得进入 Query Profile。
7. 运行 DB migration、PendingAction、query tools/service、API 相关回归。
8. 提交：`feat(query): 支持窄写操作预览与审批`

## Task 7：文档、配置审计与全量验收

**文件：**

- Modify: `src/server/agents/CLAUDE.md`
- Modify: `src/server/wiki/CLAUDE.md`
- Modify: `src/server/services/CLAUDE.md`
- Modify: `src/lib/CLAUDE.md`
- Modify: `CLAUDE.md`
- Verify unchanged: `llm-config.example.json`

**步骤：**

1. 更新工具清单、Profile、Wiki 内核、服务工作流与测试统计文档。
2. 扫描死表面与配置漂移：

   ```bash
   rg -n "wiki\.metadata\.patch|wiki\.link\.ensure|metadata-patch|link-ensure" src docs
   rg -n "dispatch\.skill|commit_changeset" src examples
   git diff --exit-code d4fa243 -- llm-config.example.json
   ```

3. 运行：

   ```bash
   npx vitest run
   npm run lint
   npx tsc --noEmit
   npm run build
   ```

4. 执行整分支 spec review 与 code quality review，修复所有 blocker/important finding。
5. 提交：`docs: 同步 Wiki 窄写工具与工作流文档`
6. 确认 worktree clean。

## Task 8：回合主分支并清理

1. 返回主工作区，确认 main 无未提交改动。
2. 执行：

   ```bash
   git merge --no-ff feat/wiki-narrow-write-tools-phase2b -m "merge: 合并 feat/wiki-narrow-write-tools-phase2b"
   ```

3. 在 main 上运行关键回归或验证 merge tree 与已验收 feature tree 一致。
4. 删除 worktree，再删除特性分支。
5. 最终报告提交、测试、配置审计与后续 Phase 2C/2D 状态。
