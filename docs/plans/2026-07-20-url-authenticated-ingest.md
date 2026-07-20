# Plan：URL Ingest 登录态凭证授权

对应 spec：`docs/specs/2026-07-20-url-authenticated-ingest.md`
分支：`feat/url-authenticated-ingest`（worktree）

## 任务拆分

### T1 认证失败分类与精确 origin 请求边界（TDD）

- 文件：
  - `src/server/sources/url-fetcher.ts`
  - `src/server/sources/source-loader.ts`
  - `src/server/services/ingest-service.ts`
  - `src/server/sources/__tests__/{url-fetcher,source-loader}.test.ts`
  - `src/server/services/__tests__/ingest-service.test.ts`
- 先写失败测试：
  1. 401/403 抛出结构化 `UrlAuthenticationRequiredError`，携带 status/authOrigin，但不读响应体；
  2. exact-origin 请求携带 Cookie/Authorization；同源重定向继续携带，跨源重定向移除；
  3. ingest handler 把认证失败转为 `ingest:auth-required` 事件后保持 job 失败。
- 验证：
  `npx vitest run src/server/sources/__tests__/url-fetcher.test.ts src/server/sources/__tests__/source-loader.test.ts src/server/services/__tests__/ingest-service.test.ts`

### T2 加密临时 grant 与后端授权 API（TDD）

- 文件：
  - `src/server/sources/source-auth-grant.ts`
  - `src/server/sources/__tests__/source-auth-grant.test.ts`
  - `src/app/api/jobs/[id]/url-auth/route.ts`
  - `src/app/api/jobs/[id]/url-auth/__tests__/route.test.ts`
  - `src/server/db/repos/jobs-repo.ts`（读取结构化失败事件或原子重排复用）
- 先写失败测试：
  1. grant 文件只有 AES-GCM envelope，磁盘内容不含 Cookie/Authorization 明文；
  2. TTL、错 job/source、篡改密文和 CRLF header 均 fail closed；
  3. API 只接受当前 Subject 下、普通 failed URL ingest 的 auth-required 任务；
  4. 成功创建 grant 并原子重排；CAS 失败补偿 grant；Research child 返回 422。
- 验证：
  `npx vitest run src/server/sources/__tests__/source-auth-grant.test.ts src/app/api/jobs/[id]/url-auth/__tests__/route.test.ts`

### T3 Worker 使用、保留与清理授权（TDD）

- 文件：
  - `src/server/sources/source-loader.ts`
  - `src/server/services/ingest-service.ts`
  - 对应 source/service 测试。
- 行为：
  - handler 从 job params 读取 grant ID，按 job/source 解密；
  - 下游失败时保留 grant 供同 job 自动/人工 retry，完整 ingest 成功后删除；
  - grant 缺失/过期时回到无凭证抓取，仍可产生新的 auth-required；
  - 新授权替换旧 grant 后 best-effort 删除旧文件。
- 验证：
  `npx vitest run src/server/sources/__tests__/source-loader.test.ts src/server/services/__tests__/ingest-service.test.ts src/app/api/jobs/[id]/retry/__tests__/route.test.ts`

### T4 Ingest 认证对话框（TDD）

- 文件：
  - `src/app/(app)/_components/ingest-auth-dialog.tsx`
  - `src/app/(app)/_components/ingest-workbench.tsx`
  - `src/app/(app)/_components/ingest-live-view.tsx`
  - `src/hooks/use-job-stream.ts`（事件类型注册）
  - `src/lib/i18n/messages/{en,zh-CN}.ts`
  - 对应纯逻辑/静态渲染测试。
- 行为：
  - 从 `ingest:auth-required` 事件派生 `authOrigin/status/sourceId`；
  - 失败态主操作由 Retry 改为 Sign in；对话框提供 Open sign-in page、密码型 Cookie 与
    可选 Authorization 输入；提交后关闭并复用原 job SSE；
  - 普通失败仍显示原 Retry/Resume；所有按钮、错误和辅助文案双语。
- 验证：
  `npx vitest run src/app/(app)/_components/__tests__/ingest-auth-dialog.test.ts src/hooks/__tests__/job-stream-logic.test.ts`

### T5 文档同步、全量验证与提交

- 同步根 `CLAUDE.md`、`src/app/CLAUDE.md`、`src/components/CLAUDE.md`、
  `src/server/{jobs,sources,services}/CLAUDE.md`，记录 API、临时密文与部署限制。
- 检查 git diff 不含密钥、grant、测试数据或无关改动。
- 全量验证：
  - `npx tsc --noEmit`
  - `npm run lint`
  - `npx vitest run`
  - `npm run build`
- 提交：设计与计划用 `docs:`；每个实现任务完成后按最小可评审边界提交 `feat:` / `test:`，
  完成后提醒是否用 `--no-ff` 回合 main 并清理 worktree。
