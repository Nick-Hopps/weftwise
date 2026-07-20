# Plan：URL Source 链接化与远程沙箱预览

对应 spec：`docs/specs/2026-07-20-url-source-live-preview.md`
分支：`feat/url-source-live-preview`（worktree）

## 任务拆分

### T1 URL Source 身份与无 raw 持久化（TDD）

- 文件：
  - `src/server/sources/url-source.ts`（规范化 URL、身份 hash、metadata 解析）
  - `src/server/sources/source-store.ts`（新增 `saveUrlSource`）
  - `src/server/sources/source-ingest-transaction.ts`（raw/url 判别输入，共用
    source+job 原子事务与文件补偿）
  - `src/server/sources/__tests__/{url-source,source-store,source-ingest-transaction}.test.ts`
- 先写失败测试：
  1. 规范化同一 URL 得到稳定 filename/hash，拒绝非公开 HTTP(S) URL；
  2. `saveUrlSource` 只写 sidecar/DB，不写 raw HTML；同 Subject+URL 幂等；
  3. URL source 与 ingest job 原子创建，job params 仍只含受控
     `sourceId/filename/subjectId`；enqueue 失败会补偿 sidecar/source 行。
- 验证：
  `npx vitest run src/server/sources/__tests__/url-source.test.ts src/server/sources/__tests__/source-store.test.ts src/server/sources/__tests__/source-ingest-transaction.test.ts`

### T2 URL Route、Research 与 worker 抓取边界（TDD）

- 文件：
  - `src/server/sources/url-ingest.ts`
  - `src/app/api/ingest/route.ts`
  - `src/server/services/ingest-service.ts`
  - `src/server/services/research-import-service.ts`
  - 对应 `__tests__`。
- 先写失败测试：
  1. URL batch 只持久化引用，不调用 fetch；一条失败不影响其他；
  2. `POST /api/ingest` 返回 202 后不存在 raw HTML，source metadata 有 URL；
  3. ingest worker 遇 URL Source 才调用 `fetchUrlSource` 并使用返回 HTML 解析；普通文件
     继续读 raw；URL attempt 检测到 checkpoint 时清理后重跑；
  4. Research coordinator 创建 URL 引用+child job，不预下载 HTML，claim/lineage 原子性不变。
- 验证：
  `npx vitest run src/server/sources/__tests__/url-ingest.test.ts src/app/api/ingest/__tests__/route.test.ts src/server/services/__tests__/ingest-service.test.ts src/server/services/__tests__/research-import-service.test.ts`

### T3 远程沙箱预览、回退与 stale 语义（TDD）

- 文件：
  - `src/lib/contracts.ts`（`PageSourceDoc.sourceUrl?`）
  - `src/server/sources/source-reader.ts`
  - `src/server/sources/source-staleness.ts`
  - `src/app/(app)/sources/[id]/page.tsx`
  - `src/app/(app)/_components/source-viewer.tsx`
  - `src/components/wiki/{wiki-reading-view,html-source-frame}.tsx`
  - `src/app/api/sources/[id]/raw/route.ts`
  - 对应 source/route 测试。
- 行为：
  - metadata 有合法 `originUrl` 时强制 `format='html'`、`sourceUrl=originUrl`；两个预览
    入口 iframe 直接使用 URL，默认禁脚本，用户确认后仅放开 `allow-scripts`；
  - `referrerPolicy='no-referrer'`，始终不加 `allow-same-origin`；
  - 展示 Open original；raw route 对 URL Source 307/308 到原 URL，普通 HTML 保持原
    CSP raw 响应；
  - `isSourceStale` 对合法 URL 引用返回 false，对普通文件继续核对落盘 hash。
- 验证：
  `npx vitest run src/server/sources/__tests__/url-source.test.ts src/server/sources/__tests__/source-staleness.test.ts src/app/api/sources/[id]/raw/__tests__/route.test.ts`

### T4 文档同步、全量验证与提交

- 同步：根 `CLAUDE.md`、`src/app/CLAUDE.md`、`src/components/CLAUDE.md`、
  `src/server/{sources,services}/CLAUDE.md`，更新 URL Source 数据流、限制与 Changelog。
- 检查旧 URL source 向后兼容、上传 HTML 不回归，以及 worktree diff/commit 落点。
- 全量验证：
  - `npx tsc --noEmit`
  - `npm run lint`
  - `npx vitest run`
  - `npm run build`

### T5 左侧 Sources 列表展示网页标题与描述（TDD）

- 文件：
  - `src/server/sources/parsers/html-parser.ts`（确定性提取 title/description）
  - `src/server/sources/{source-loader,source-store,url-source}.ts`（worker 写回与读取）
  - `src/app/api/sources/route.ts`（轻量列表 DTO）
  - `src/components/layout/sidebar.tsx`（标题 + 描述两行展示）
  - 对应 `__tests__`。
- 先写失败测试：
  1. HTML parser 按标准 meta/OG 回退提取标题和描述，解码 entity 并归一空白；
  2. URL worker loader 返回展示元数据，Ingest handler 将其写回 sidecar 与 SQLite；
  3. `GET /api/sources` 对 URL Source 返回已持久化 title/description，缺标题时回退 hostname，
     且列表请求不联网；普通文件仍回退 filename。
- UI：左侧 Sources 项以网页标题为主行、描述为次行；tooltip 同时包含两者。没有描述时
  保持单行紧凑高度，不展示原始 URL 作为标签。
- 验证：
  `npx vitest run src/server/sources/__tests__/html-parser.test.ts src/server/sources/__tests__/source-loader.test.ts src/server/sources/__tests__/source-store.test.ts src/app/api/sources/__tests__/route.test.ts src/server/services/__tests__/ingest-service.test.ts`
- 提交：设计/计划使用 `docs:`，实现与文档同步使用一个 `feat:`；完成后提醒是否用
  `--no-ff` 回合 main 并清理 worktree。
