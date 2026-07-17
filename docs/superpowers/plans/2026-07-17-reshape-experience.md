# Reshape 自由重塑与版本体验实施计划

## Task 1：锁定自由重塑 Prompt 与服务行为

涉及文件：

- `src/server/llm/prompts/reshape-prompt.ts`
- `src/server/llm/prompts/__tests__/reshape-prompt.test.ts`
- `src/server/services/reshape-service.ts`
- `src/server/services/__tests__/reshape-service.test.ts`

步骤：

1. 先写失败测试：Prompt 必须允许重组/删改/扩写、禁止默认只追加，并说明可调用图片工具。
2. 先写失败测试：大幅缩写的输出应直接成功，不能因旧 0.8 长度护栏回落。
3. 重写 Prompt，删除 Reshape 的 `checkRewriteFidelity`、重试与 fallback 分支。
4. 验证：`npx vitest run src/server/llm/prompts/__tests__/reshape-prompt.test.ts src/server/services/__tests__/reshape-service.test.ts`。

## Task 2：接入可取消的 Reshape 生图工具

涉及文件：

- `src/server/agents/tools/builtin/image-generate.ts`
- `src/server/agents/tools/builtin/__tests__/image-generate.test.ts`
- `src/server/services/reshape-service.ts`
- `src/server/services/__tests__/reshape-service.test.ts`

步骤：

1. 先写失败测试：`generateImageAsset` 接收 abort signal 并传入 Google 图片调用。
2. 先写失败测试：Reshape 模型可调用单一图片工具，工具结果 URL 被最终 Markdown 使用，图片只暂存在返回值。
3. 扩展通用生图函数的 abort 接口；Reshape 用 AI SDK 工具循环调用它。
4. 验证 Task 1/2 定向测试。

## Task 3：持久化 Markdown 与 rendition 图片

涉及文件：

- `src/server/db/schema.ts`
- `src/server/db/client.ts`
- `src/server/db/repos/renditions-repo.ts`
- `src/server/db/repos/__tests__/renditions-repo.test.ts`
- `src/app/api/rendition-assets/[id]/route.ts`
- `src/app/api/rendition-assets/[id]/__tests__/route.test.ts`
- `drizzle/*`

步骤：

1. 先写真实 SQLite 失败测试：已保存版本在 canonical/画像变化后仍可取回；原子替换会清理旧图片并插入新图片。
2. 新增 `page_rendition_assets` schema 与启动期幂等迁移；实现 `getLatestRendition`、`replaceRendition`、`getRenditionAsset`。
3. 新增受鉴权图片读取路由并写路由测试。
4. 运行 `npm run db:generate` 生成 Drizzle 迁移。
5. 验证 DB 与资产路由定向测试。

## Task 4：拆分读取与强制刷新 API

涉及文件：

- `src/app/api/lens/[...slug]/route.ts`
- `src/app/api/lens/[...slug]/__tests__/lens-route.test.ts`

步骤：

1. 先改测试并确认失败：GET 只返回 saved/canonical，不调用模型；POST 每次强制生成并落库；失败/abort 不落库。
2. GET 改为纯读取；新增带 auth/CSRF/subject 的 POST。
3. POST 将 request signal 传入服务，并只在完整成功后调用 `replaceRendition`。
4. 验证 Lens route 定向测试。

## Task 5：实现读取、Refresh 与 Cancel 交互

涉及文件：

- `src/hooks/use-lens.ts`
- `src/hooks/__tests__/use-lens.test.tsx`（如现有测试设施适配）
- `src/components/wiki/page-actions.tsx`
- `src/components/wiki/wiki-reading-view.tsx`
- `src/components/wiki/__tests__/page-actions.test.tsx`

步骤：

1. 先写失败组件测试：loading 有 Cancel；reshaped 有 Show original 与 Refresh；refreshing 有 Cancel 且保留已显示版本。
2. Hook 提供 `loadSaved()`、`refresh()`、`cancel()`，用独立 AbortController 管理 POST；取消不作为 error。
3. 阅读页把状态扩为 idle/loading/refreshing/reshaped/unavailable，接入操作回调。
4. 保持现有设计系统与键盘/ARIA 可访问性。
5. 验证组件、TypeScript 与 lint。

## Task 6：文档、回归与集成

涉及文件：

- `src/server/{db,llm,services}/CLAUDE.md`
- `src/app/CLAUDE.md`
- `src/components/CLAUDE.md`
- 根 `AGENTS.md`（仅当架构导航需要更新）

步骤：

1. 同步 Reshape 持久化、生图、API 与 UI 状态文档。
2. 运行定向测试、`npm test`、`npm run lint`、`npm run build`，记录完整输出与退出码。
3. 每个 Task 完成后使用英文类型前缀 + 中文一句话提交；实现提交使用 `feat:`，与本 `docs:` 提交配对。
4. 检查 feature diff，在 main 上 `git merge --no-ff feat/reshape-experience`，merge message 包含分支名。
5. 删除 worktree 与特性分支，确认最终 commit 落在 main。

## Task 7：补齐 Review 发现的生命周期与成功判定

涉及文件：

- `src/server/db/repos/renditions-repo.ts`
- `src/server/wiki/indexer.ts`
- `src/server/wiki/page-identity-migration.ts`
- `src/app/api/reset/route.ts`
- 对应 repo / page move / reset / page delete 测试

步骤：

1. 先写失败测试：删页后 rendition 与图片消失；页面 move 同步迁移资产归属；Subject/global reset 不残留资产。
2. 增加按页删除与资产迁移 repo 操作，并接入 indexer、page identity migration 与 reset 事务。
3. 验证页面删除重建不会返回旧 rendition，move 后 Refresh 能清理旧图片。

## Task 8：拒绝空正文并过滤未引用图片

涉及文件：

- `src/server/services/reshape-service.ts`
- `src/server/services/__tests__/reshape-service.test.ts`

步骤：

1. 先写失败测试：空文本流抛错；生成但未被 Markdown 引用的图片不进入返回资产；引用未知 rendition ID 时抛错。
2. 增加最终 Markdown 非空校验与本次请求资产引用解析，只返回实际引用资产。
3. 跑 Reshape service 与 Lens route 定向测试，确认失败不触发 `replaceRendition`。

## Task 9：呈现 stale 保存版本

涉及文件：

- `src/components/wiki/page-actions.tsx`
- `src/components/wiki/wiki-reading-view.tsx`
- `src/components/wiki/__tests__/page-actions-reshape.test.tsx`

步骤：

1. 先写失败组件测试：stale 重塑版显示旧版本提示；新鲜版本保持现有文案。
2. 把 `LensResult.stale` 传入状态行，以现有行内层级显示警示图标和短文案。
3. 验证 Refresh/Cancel/Show original 行为与现有布局不回归。
