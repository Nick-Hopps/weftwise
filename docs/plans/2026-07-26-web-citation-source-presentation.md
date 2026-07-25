# Plan：Ingest 自主检索网页源的标题与描述展示

日期：2026-07-26
设计稿：[docs/specs/2026-07-26-web-citation-source-presentation.md](../specs/2026-07-26-web-citation-source-presentation.md)

按 TDD 推进，每个任务独立可验证、独立提交。

## 任务 1：抽出 Source 展示元数据单一真实源

- 新增 `src/server/sources/source-presentation.ts`：`SourcePresentation`、
  `SOURCE_TITLE_MAX_LENGTH` / `SOURCE_DESCRIPTION_MAX_LENGTH`、
  `normalizeSourcePresentation`、`readSourcePresentation`。
- `src/server/sources/url-source.ts` 改为复用该模块（删除本地归一化实现，
  `normalizeUrlSourcePresentation` / `UrlSourcePresentation` 收敛为再导出）。
- 新增 `src/server/sources/__tests__/source-presentation.test.ts`：空白折叠、超长截断、
  空串→undefined、非字符串→undefined、`metadataJson` 非法 JSON → 空展示。
- 验证：`npx vitest run src/server/sources/__tests__/source-presentation.test.ts src/server/sources/__tests__/url-source.test.ts`

## 任务 2：`saveRawSource` 支持写入展示元数据

- `source-store.ts`：`extra` 增加 `presentation?: SourcePresentation`，创建 canonical
  source 时写入 sidecar + SQLite `metadata_json`；`updateUrlSourcePresentation`
  更名为 `updateSourcePresentation`（调用点：`ingest-service.ts`、既有测试）。
- 测试（`source-store.test.ts`）：新增「raw Source 保存网页标题/描述到 sidecar 与 DB」
  与「命中内容去重时不覆盖既有展示字段」。
- 验证：`npx vitest run src/server/sources/__tests__/source-store.test.ts`

## 任务 3：Ingest 引用网页源派生标题与描述

- `ingest-service.ts::buildWebSourceImports`：派生 `presentation`（标题回退 hostname，
  描述回退正文首段）并传给 `saveSource`；调用点透传给 `saveRawSource`。
- 测试（`ingest-finalize-sources.test.ts`）：标题/描述透传、标题为空回退 hostname、
  snippet 为空回退正文首段、单源失败不影响其余。
- 验证：`npx vitest run src/server/services/__tests__/ingest-finalize-sources.test.ts src/server/services/__tests__/ingest-service.test.ts`

## 任务 4：`GET /api/sources` 展示已持久化标题与描述

- `src/app/api/sources/route.ts`：按 `readSourcePresentation → URL hostname → filename`
  解析标题，描述统一取展示字段。
- 测试（`src/app/api/sources/__tests__/route.test.ts`）：raw 网页 Source 返回标题+描述；
  无展示字段的普通文件仍回退 filename；URL Source 行为不变。
- 验证：`npx vitest run src/app/api/sources/__tests__/route.test.ts`

## 任务 5：存量网页 Source 回填脚本

- 新增 `scripts/backfill-source-presentation.ts` + `package.json` script
  `db:backfill-source-presentation`；解析逻辑（`# 标题` / `Source: <url>` / 正文首段）
  抽为纯函数并单测。
- 验证：`npx vitest run scripts/__tests__/backfill-source-presentation.test.ts`，
  随后在本地 vault 上实跑脚本并检查侧边栏。

## 任务 6：文档同步

- 更新 `src/server/sources/CLAUDE.md`（新模块、更名后的 API、展示字段泛化）、
  `src/app/CLAUDE.md`（`/api/sources` 行为）、根 `AGENTS.md` 相关描述与 changelog 行。
- 验证：`npm run lint` + 全量 `npx vitest run`。
