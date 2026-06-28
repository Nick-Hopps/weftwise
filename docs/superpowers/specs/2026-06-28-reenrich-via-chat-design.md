# 设计：对话触发 re-enrich（移除按钮）

> 日期：2026-06-28
> 状态：已批准，待落实施计划

## 一、目标

移除阅读页 frontmatter 上的 **Re-enrich** 按钮，改为通过 **Ask AI 对话**触发"重新增益"。用户在对话里说"重新增益这一页 / X 页"，对话 AI 复述确认后调用一个写动作工具入队 `re-enrich` job。

## 二、动机

- 现状：阅读页 frontmatter 右侧的 `Re-enrich` 按钮 → `ReenrichDialog` 弹窗 → `POST /api/re-enrich`（参数 `{slug, subjectId}`）→ 入队 `re-enrich` job。
- 自 2026-06-25 起，Ask AI 已是 **agentic 工具循环**（`wiki.read/search/list` 三只读工具 + `streamText({tools, maxSteps:6})`）。把"重新增益"这一动作并入对话，是该方向的自然延伸，减少散落的命令式按钮。

## 三、方案选择

| 方案 | 说明 | 取舍 |
|------|------|------|
| **A：给对话循环加写动作工具 `wiki.reenrich`**（采纳）| 模型自驱决定何时调用；确认逻辑靠对话两轮 + 系统提示约束 | 与 agentic Ask AI / 工具体系收敛方向一致；代价是引入**第一个 `sideEffect:'write'` 的 query 工具**，打破 query 工具链刻意的只读隔离 |
| B：在 `/api/query` route 做意图识别后入队 | 路由层正则/启发式识别"重新增益"意图 | 脆弱、不 agentic、把动作逻辑塞进路由层，方向相反；否决 |

**采纳 A。**

## 四、关键决策（已与用户确认）

1. **目标页解析 = 当前页优先 + 可点名**：默认针对用户正在阅读的页（`currentPageSlug`）；用户点名其他页时，AI 用 `wiki.search/list` 解析出 slug。
2. **触发 = 总是先确认再执行**：AI 先复述"我将重新增益 XX 页，确认吗？"，用户明确同意后才调用工具（确认天然分散在对话两轮，靠系统提示约束）。
3. **进度反馈 = fire-and-forget**：工具入队后，对话只告知"已在后台启动，稍后刷新页面查看"；不在聊天里订阅 job 事件流。进度由现有全局 job tracker 负责（保留 `reenrich:start` 事件）。

## 五、架构与改动单元

### ① 移除按钮 UI
- 删 `src/components/wiki/reenrich-button.tsx`
- 删 `src/components/wiki/reenrich-dialog.tsx`
- `src/components/wiki/frontmatter-display.tsx`：移除 `ReenrichButton` 的 import 与使用（约第 58 行）

### ② 抽共享入队 helper + 删死路由
- 新增纯服务端 helper `enqueueReenrich(subjectId, slug)`（建议放 `src/server/services/reenrich-service.ts` 或同目录新文件）：
  - 校验：页面在该 subject 下存在；非 meta 页（`index`/`log`，且 tags 不含 `meta`）。
  - 入队：`queue.enqueue('re-enrich', { slug, subjectId }, subjectId)`，返回 `{ jobId }`。
  - 校验失败抛**描述性错误**（消息可直接转述给用户），如"页面 X 不存在"/"meta 页不能重新增益"。
- 删 `src/app/api/re-enrich/route.ts`（dialog 移除后唯一调用方消失，成为死代码；符合本项目删 MCP / 删 merge-split API 的清理惯例）。
- 迁移测试：`src/app/api/re-enrich/__tests__/validate.test.ts`（2 用例）覆盖的是 slug/meta 校验逻辑，随逻辑迁到 `enqueueReenrich` 的单测，原文件删除。

### ③ 新工具 `wiki.reenrich`（写）
- 在 builtin registry 新增工具定义（`src/server/agents/tools/builtin/`）：
  - 名称沿用 `wiki.*` 命名空间（与 `wiki.read/search/list` 一致）。
  - `sideEffect: 'write'`。
  - 输入 `{ slug: string }`（必填；"当前页"由模型从注入的 currentPageSlug 上下文填入）。
  - 输出 `{ ok: boolean, jobId?: string, message: string }`。
  - handler 调 `ctx.reenrich(slug)` 能力：能力缺失（如 ingest 场景）→ 返回 `{ ok:false, message:'...' }`，不崩；helper 抛错 → 捕获转成 `{ ok:false, message }`。
- 在 `createBuiltinToolRegistry()` 注册该工具。

### ④ 扩展 ToolContext
- `src/server/agents/tools/tool-context.ts`：给 `ToolContext` 增可选能力
  `reenrich?(slug: string): Promise<{ jobId: string }>`。
- **仅 query context 注入**该能力（在 `src/server/services/query-tools.ts::buildQueryToolContext` 内实现，内部调 ② 的 `enqueueReenrich`，绑定当前 subject）。
- ingest context（`agentToolContext`）**不注入** → 维持 ingest 侧不可经工具触发 re-enrich。

### ⑤ query 接线 + 系统提示
- `src/server/services/query-service.ts`：把 `wiki.reenrich` 加入 query 工具集解析
  （`createBuiltinToolRegistry().resolve([... , 'wiki.reenrich'])`）。
- 确保 `currentPageSlug`（及标题）清晰注入 agentic query 的提示，让模型在"这一页"时填当前页 slug。
- 更新 `QUERY_AGENTIC_SYSTEM_PROMPT`，新增一段说明：
  - 何时用 `wiki.reenrich`、它做什么（重跑增益流水线，新增 callout 讲解层）。
  - **调用前必须先复述将增益哪一页并等用户明确确认**；目标模糊（多页命中 / 无当前页）就反问。
  - 入队后用 fire-and-forget 话术告知用户"已在后台启动，稍后刷新页面查看"。

### ⑥ 聊天活动渲染
- `src/components/chat/message-list.tsx`：给 reenrich 工具加图标（✨）与动词（"Re-enriching"）。
- `src/app/api/query/route.ts::summarizeToolArgs`：为 reenrich 工具补摘要（显示目标 slug）。
- **实现时核对工具名在 SSE/UI 的真实拼写**：文档里 `wiki.search`（注册名）与 UI 的 `search_wiki`/`read_page` 存在出入，AI SDK 工具键命名可能经过 compile 阶段转换；以代码实际 key 为准，确保 tool-call 事件的 `toolName` 与 UI 映射一致。
- 保留 `src/hooks/use-job-stream.ts` 中 `reenrich:start` 事件注册，全局 job tracker 仍能叙述进度。

## 六、错误与边界

- 不在页面上下文里说"这一页"（聊天 tab 无 currentPageSlug）→ 模型反问哪一页。
- 目标页不存在 / 是 meta 页 → helper 抛描述性错误，工具返回 `{ok:false,message}`，模型转述。
- 鉴权/CSRF/subject 解析：复用 `/api/query` 现有链路，无新增鉴权面；工具在已鉴权的 query 请求上下文内入队，绑定已解析的 subject。

## 七、测试策略

- `enqueueReenrich` helper 单测：缺页报错 / meta 页（index、log、tags 含 meta）报错 / 正常入队参数 `{slug, subjectId}` 正确（迁移自原 route validate 测试）。
- `wiki.reenrich` 工具 handler 单测：能力存在 → 返回 `{ok:true, jobId}`；能力缺失 → `{ok:false}` 优雅降级；helper 抛错 → 捕获为 `{ok:false, message}`。
- query 工具上下文：`buildQueryToolContext` 注入了 `reenrich` 能力（存在性断言）。

## 八、已知限制

- **确认闸门靠系统提示**（非硬性状态机），模型理论上可能跳过确认直接调用工具。MVP 接受，提示词写强、明确。
- 沿用 re-enrich 现有 skill 版本门控（ingest-enricher / ingest-verifier 最低版本）；与本次改动无关，不动。

## 九、不做（YAGNI）

- 不在聊天内做 job 进度条 / 完成态订阅（fire-and-forget 已定）。
- 不支持批量/范围重新增益（"把关于 X 的所有页都增益"）——本次只单页。
- 不实现 IDEAS.md 里"弹窗提供自定义源"（已被本方向取代）。
