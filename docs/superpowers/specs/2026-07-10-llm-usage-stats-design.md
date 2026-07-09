# LLM 用量统计（Usage Stats）设计

> 日期：2026-07-10
> 状态：已确认（Nick 于 brainstorming 会话中逐项批准）

## 背景与目标

当前所有 LLM 调用的 token 用量只打 console 日志（`provider-registry.ts` 的 `[LLM][Task: ...]` 前缀日志），无任何持久化。用户无法回答"哪个任务/阶段最烧 token、各任务当前用的什么模型"。

目标：在设置弹窗新增 **Usage** 分类，按 task key 逐行展示每个任务实际使用的模型与消耗的 token 数量，支持时间窗切换（7 天 / 30 天 / 全部）。

非目标（YAGNI，明确不做）：

- 不做 per-subject 维度统计（token 是 app 级资源，与 `wikiLanguage` 同理；表结构可后续加列扩展，但历史无法回填）。
- 不做费用（美元）估算。
- 不做趋势图 / 图表，仅表格。
- 不做实时轮询，弹窗打开时取数一次。

## 总体结构

```
provider-registry（4+1 个调用入口，统一埋点，best-effort）
        │ recordUsage(entry)
        ▼
llm_usage 表（明细，一次调用一行） ── worker sweep GC（保留 90 天）
        │ summarizeUsage(sinceMs?)
        ▼
GET /api/usage?window=7d|30d|all（requireAuth 只读）
        ▼
设置弹窗新增 Usage 分类 → UsagePanel（Segmented 时间窗 + 表格 + 合计行）
```

## 1. 存储：新表 `llm_usage`

`src/server/db/schema.ts` 新增：

```
llm_usage
  id            INTEGER PRIMARY KEY AUTOINCREMENT
  task          TEXT NOT NULL      -- resolveTask 后的 task key（query / lint / ingest:writer / embedding …）
  model         TEXT NOT NULL      -- 实际路由到的模型 id（route.model）
  input_tokens  INTEGER NOT NULL DEFAULT 0
  output_tokens INTEGER NOT NULL DEFAULT 0
  created_at    INTEGER NOT NULL   -- epoch ms
  -- 索引：created_at（时间窗过滤 + GC 都按它扫）
```

- 无外键、全局非 subject-scoped。
- 建表走 `db/client.ts` 既有的启动自迁移路径（与 `research_backlog` 等新表相同挂法）。

## 2. 记账埋点：`provider-registry.ts` 统一收口

新增 `src/server/db/repos/usage-repo.ts`：

```ts
recordUsage(entry: { task: string; model: string; inputTokens: number; outputTokens: number }): void
summarizeUsage(sinceMs?: number): UsageSummaryRow[]
  // SELECT task, model, COUNT(*) calls, SUM(input_tokens), SUM(output_tokens)
  // FROM llm_usage [WHERE created_at >= sinceMs] GROUP BY task, model
pruneOldUsage(cutoffMs: number): number   // DELETE WHERE created_at < cutoffMs，返回删除行数
```

`provider-registry.ts` 五个入口的接入方式：

| 入口 | usage 来源 | 时机 |
|------|-----------|------|
| `generateStructuredOutput` | `result.usage`（inputTokens/outputTokens） | await 成功后同步记 |
| `generateTextWithTools` | `result.totalUsage`（多步工具循环累计；缺失回落 `result.usage`） | await 成功后同步记 |
| `streamTextResponse` | `onFinish` 回调的 `usage` | 流结束回调里记，不阻塞流 |
| `streamTextWithTools` | 同上（在现有 options 上补 `onFinish`；若调用方已传则组合调用） | 同上 |
| `generateEmbeddings` | `embedMany` 返回的 `usage.tokens`，记为 inputTokens，outputTokens=0 | await 成功后同步记 |

记账纪律：

- **best-effort**：`recordUsage` 内部 try/catch 全吞 + `console.warn`，记账失败绝不影响 LLM 调用本身；调用点也不 await 任何异步（better-sqlite3 同步 INSERT，本身极快）。
- usage 缺失（供应商不返回、字段为 undefined/NaN）时**不写行**（避免污染统计），而非写 0。
- 失败的 LLM 调用不记账（错误路径的 `e.usage` 不采信；供应商侧此时数据不可靠且多数为空）。
- `task`/`model` 取 `resolveTask` 后的 `route.task` / `route.model`（与日志前缀同源），call-site override 后的实际值。
- Worker 与 Next.js 两进程都会写同一 SQLite：均为单行 INSERT，WAL + `busy_timeout=5000` 足够，不涉及 vault 锁。

## 3. GC：worker sweep tick

挂到 `jobs/worker.ts` 现有低频 sweep tick（与 `pruneOldJobEvents` / `pruneOldOperations` 同级、独立于成熟度维护开关、始终执行）：

- `pruneOldUsage(now - 90 天)`，常量 `USAGE_RETENTION_MS = 90 * 24 * 3600 * 1000` 定义在 usage-repo。

## 4. API：`GET /api/usage`

新路由 `src/app/api/usage/route.ts`：

- `requireAuth(request)`，只读，无 CSRF、无 subject 解析。
- query 参数 `window`：`'7d' | '30d' | 'all'`，缺省 `'30d'`；非法值按缺省处理。
- 响应：`{ window, rows: UsageSummaryRow[] }`，`UsageSummaryRow = { task, model, calls, inputTokens, outputTokens }`；类型入 `src/lib/contracts.ts`。
- 排序：服务端按 `task ASC, model ASC` 返回；同一 task 换过模型自然呈现为多行（可对比新旧模型消耗）。

## 5. UI：设置弹窗 Usage 分类

- `src/components/layout/settings-categories.ts`：`CategoryId` union 与 `SETTINGS_CATEGORIES` 加 `{ id: 'usage', label: 'Usage', icon: BarChart3 }`（lucide），插在 About 之前。
- `settings-content.tsx` 新增 `UsagePanel`（不依赖 settings/savePartial props，独立取数）：
  - 顶部：复用 `ui/segmented` 分段控件切换 `7 days / 30 days / All time`，默认 30 days；
  - 中部：表格，列 Task / Model / Calls / Input / Output（token 数经格式化：≥1000 显示 `12.3k`、≥1M 显示 `1.2M`）；
  - 底部：合计行（calls / input / output 总和）；
  - 空态：`No usage recorded yet.`；
  - 取数：React Query `['usage', window]` 拉 `GET /api/usage?window=...`（经 `useApiFetch`），`staleTime` 短（如 30s），无轮询。
- token 格式化为纯函数 `formatTokenCount(n)`，新建 `src/lib/format.ts`（若已有等价工具文件则并入），供单测。

## 6. 测试

- `usage-repo` 单测：记账写入/字段落库、`summarizeUsage` 分组聚合正确性、`sinceMs` 时间窗边界（含/不含）、`pruneOldUsage` 保留边界。
- `formatTokenCount` 纯函数单测（0 / 999 / 1000 / 1M 边界）。
- provider-registry 埋点：在现有 provider-registry 测试文件中补"成功调用后 recordUsage 被调、usage 缺失不记、recordUsage 抛错不影响返回"三类用例（mock usage-repo）。

## 7. 已知限制

- `streamTextWithTools` 若流被客户端中断（abort），`onFinish` 可能不触发，该次调用不记账——接受（低估而非高估）。
- 历史数据无从回填：上线前的消耗不可见。
- 90 天 GC 后 "All time" 实际上是"最近 90 天"：UsagePanel 底部加一行脚注小字 `Usage data is retained for 90 days.` 说明。
