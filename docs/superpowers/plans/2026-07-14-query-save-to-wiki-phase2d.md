# Query Save-to-Wiki Phase 2D 执行计划

> **执行方式：** 隔离 worktree + TDD + 分任务检查 + 最终全量验收。

**目标：** 让 Ask AI “保存到 Wiki”与 `wiki.create` 共用 create plan/apply command，统一 slug、frontmatter、Saga、operation 归属与 embedding 行为，并补齐 worker 重试恢复。

**设计文档：** `docs/superpowers/specs/2026-07-14-query-save-to-wiki-phase2d-design.md`

**分支：** `feat/query-save-to-wiki-phase2d`
**worktree：** `.worktrees/query-save-to-wiki-phase2d`
**基线：** `41b3b5e`

## Task 1：让 shared create command 接受真实 job ID

**文件：**

- Modify: `src/server/services/page-write.ts`
- Modify: `src/server/services/__tests__/page-write.test.ts`

**步骤：**

1. 先写失败测试：显式 `jobId` 原样传给 `executePageCreate`；默认路径仍生成非空 ID。
2. 写失败测试：title trim、body 默认值、tags 透传；execute 失败时不 enqueue embedding。
3. 为 `createPageInSubject` 增加可选 `{ jobId }`，其余调用方签名兼容。
4. 运行：

   ```bash
   npx vitest run src/server/services/__tests__/page-write.test.ts src/server/wiki/__tests__/page-operation-plan.test.ts src/server/wiki/__tests__/page-ops-create-delete.test.ts
   npx tsc --noEmit
   ```

5. 提交：`重构：统一页面创建命令的任务上下文`

## Task 2：迁移 save-to-wiki 编排并补齐重试恢复

**文件：**

- Modify: `src/server/services/query-service.ts`
- Create: `src/server/services/__tests__/query-save-to-wiki.test.ts`
- Modify: `src/server/db/repos/operations-repo.ts`（仅在现有查询不足时）
- Modify: `src/server/db/repos/__tests__/operations-repo.test.ts`（仅在 repo 增加窄查询时）

**步骤：**

1. 先写失败测试：Query answer/citations 被确定性组装为正文，shared command 收到 `query-answer`、真实 job ID，且没有 `sources` 输入。
2. 写冲突 slug 测试：shared command 返回 `foo-2` 时 `saveQueryAsPage` 原样返回。
3. 写恢复测试：同一 job 已有 applied create operation 时不再次 create，返回 canonical path slug 并补 enqueue embedding。
4. 写歧义/损坏 operation 测试：多个 create、非法 path、页面不存在均拒绝猜测。
5. 删除 Query service 的 pages/frontmatter/changeset/slug 创建依赖，改调 `createPageInSubject`。
6. 让 run handler 的业务事件与 job result 使用真实 created slug。
7. 运行：

   ```bash
   npx vitest run src/server/services/__tests__/query-save-to-wiki.test.ts src/server/services/__tests__/query-service-agentic.test.ts src/server/services/__tests__/page-write.test.ts
   npx tsc --noEmit
   ```

8. 提交：`重构：统一问答保存与页面创建路径`

## Task 3：清理客户端 slug 猜测并做 API 回归

**文件：**

- Modify: `src/components/chat/save-to-wiki-button.tsx`
- Create: `src/components/chat/__tests__/save-to-wiki-button.test.tsx`（现有测试设施适用时）
- Modify: `src/app/api/query/__tests__/route.test.ts`

**步骤：**

1. 确认 `onSaved` 无生产消费者后，删除 `normalizeSlug(title)` 的提前回调和无效 prop。
2. 补 save-only 失败测试：只 enqueue subject-scoped job，返回 202/jobId，不调用 query LLM。
3. 补 query+save 测试：使用生成的 answer/citations 入队，返回 `saveJobId`。
4. 回归缺 title、缺 question、auth、CSRF、跨 Subject 解析。
5. 运行：

   ```bash
   npx vitest run src/app/api/query/__tests__/route.test.ts src/components/chat/__tests__
   npx tsc --noEmit
   ```

6. 提交：`修复：移除问答保存的客户端 slug 猜测`

## Task 4：文档、配置审计与全量验收

**文件：**

- Modify: `src/server/services/CLAUDE.md`
- Modify: `src/components/CLAUDE.md`
- Modify: `CLAUDE.md`
- Verify unchanged: `llm-config.example.json`

**步骤：**

1. 同步 shared create command、save-to-wiki 引用语义、embedding 与重试恢复。
2. 扫描旧路径：

   ```bash
   rg -n "saveQueryAsPage|query-answer|citations.map.*pageSlug|createChangeset|serializeFrontmatter" src/server/services/query-service.ts src/server/services
   git diff --exit-code 41b3b5e -- llm-config.example.json
   ```

3. 运行：

   ```bash
   npx vitest run
   npx tsc --noEmit
   npm run lint
   npm run build
   git diff --check 41b3b5e..HEAD
   ```

4. 检查 Query ToolProfile、PendingAction create、History job type、Subject mutation epoch 与 embedding 回归。
5. 提交：`文档：同步问答保存统一创建工作流`

## Task 5：回合主分支并清理

1. 确认特性 worktree clean，主工作区 `main` 无用户改动。
2. 在主工作区执行：

   ```bash
   git merge --no-ff feat/query-save-to-wiki-phase2d -m "合并 feat/query-save-to-wiki-phase2d：完成问答保存统一创建 Phase 2D"
   ```

3. 在 main 运行关键回归并确认 merge tree 与 feature tree 一致。
4. 删除 `.worktrees/query-save-to-wiki-phase2d`，再删除特性分支。
5. 报告提交、验证、配置审计结果，以及工具治理 Phase 2 是否全部完成。
