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
