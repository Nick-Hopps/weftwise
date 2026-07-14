# Wiki 页面身份迁移 Phase 3D 执行计划

**目标：** 通过 PendingAction 安全迁移当前 Subject 单页 slug/path，并保持 vault、SQLite、来源、链接、向量与 History 一致。

**分支：** `feat/wiki-move-phase3d`
**Worktree：** `.worktrees/wiki-move-phase3d`
**状态：** 已完成

## Task 1：锁定契约、registry 与审批入口

1. 增加 move 输入、PendingAction operation 与 changeset move marker；
2. 先补 payload/registry/profile/tool 红测；
3. 注册 `wiki.move`，只进入 `query:propose`；
4. 接入 ToolContext preview callback、Query intent/prompt/tool activity。

## Task 2：实现 alias 与链接纯内核

1. 增加 page_aliases repo 的同步与解析函数；
2. 索引器从 frontmatter aliases 重建映射；
3. title resolver 与跨 Subject link target 解析 alias；
4. 增加 move link rewrite 纯函数，保留前缀/锚点/显示别名；
5. 页面读路由对旧 slug 做 canonical redirect。

## Task 3：实现 move plan/apply

1. 校验 canonical slug、meta 保护、page/alias 目标冲突；
2. 目标页内容增加旧 slug alias并更新 `updated`；
3. 规划 create target + delete source + 当前 Subject backlink updates；
4. 规划 page_sources 对应 source sidecar auxiliary updates；
5. 生成不暴露 sidecar 内容的精确预览与 result hint。

## Task 4：扩展 Saga、恢复与 History

1. changeset 校验只允许受控 source sidecar auxiliary path；
2. apply/rollback/recovery 按 move marker 正向或反向迁移派生表；
3. move 时重建 pages/FTS/wiki_links/page_aliases；
4. History revert 生成反向 move marker；
5. History/operation scope 忽略 auxiliary entry，并把 move 显示为旧删新建。

## Task 5：接入 PendingAction 与数据库迁移

1. preview/approve/replan 支持 move；
2. 复用页面 action finalizer，保证 embed enqueue + action applied 原子收口；
3. pending_actions CHECK 增加 move；
4. 生成并验证 Drizzle migration 与启动迁移。

## Task 6：文档、验证与 Git 收尾

1. 更新根、wiki/db/agents/services/app/lib/components 模块文档和治理总 spec；
2. 运行定向 Vitest；
3. 运行全量 Vitest、`npx tsc --noEmit`、`npm run lint`、`npm run build`；
4. 确认 `llm-config.example.json` 无差异并检查 `git diff --check`；
5. 使用中文一句话提交；
6. 回到 main 执行 `git merge --no-ff feat/wiki-move-phase3d`；
7. 删除 worktree 和特性分支，确认 main 干净。

## 完成判据

- `wiki.move` 批准前零写入，批准后一次 Saga 完成身份迁移；
- 旧链接、跨 Subject 引用、旧 URL 和 History revert 可用；
- page_sources/sidecar、embedding、maturity、rendition 等派生状态不丢失；
- 全部验证通过，`llm-config.example.json` 不变，并以 `--no-ff` 合回 main。

## 执行结果

- Task 1–6 均已完成；
- 全量 Vitest：238 个测试文件、2088 个用例通过；
- TypeScript、ESLint、生产构建通过；
- `llm-config.example.json` 无差异；
- Git 合并与 worktree 清理在本计划提交后执行。
