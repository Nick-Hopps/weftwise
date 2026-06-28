# Job 详情弹窗（任务日志 + 完整错误）设计

> 日期：2026-06-28
> 状态：设计已确认，待写实现计划

## 一、背景与问题

当前右下角的 job 状态浮层 `ProgressToast`（`src/components/shared/progress-toast.tsx`）信息展示不足：

- 只展示**最新一条消息**（`latestMessage`，最多 2 行）、进度百分比、处理过的文件列表、事件计数。
- 完整的执行**日志**（按时间的事件流）其实已经在前端（`useJobStream` 的 `events[]`，上限 1200 条，每条含 `type`/`data`/时间），但 UI 没有展开展示。
- 任务**失败**时，浮层只显示一行错误摘要；完整错误（`stack` / `cause` / `responseText` / `finishReason` / `usage`）落在 `jobs.resultJson.error`，目前前端没有读取，用户无从排查。

目标：让用户能查看**当前执行任务的完整日志**，并在**失败时查看完整错误信息**（含技术细节、可复制）。

## 二、范围

**纯前端增强**，不触碰后端：

- 不改 DB schema（`jobs` / `job_events` 不动）。
- 不改 worker / 事件发射（`src/server/jobs/*` 不动）。
- 不新增 API 路由（`GET /api/jobs/[id]` 已返回 `resultJson`，`/api/jobs/[id]/events` SSE 已推送全部事件）。

不在本次范围：

- 不改造 `ingest-pill` / `health-view` 等其它 `useJobStream` 消费方（用户只指了浮层）。
- 不抽通用 `Dialog` UI 原语（现有 5 处 modal 各自实现，重构超出本需求）。
- 关闭浮层后日志/错误不做额外持久化入口（仍可由后端 `job_events`/`resultJson` 重建，但本次不加"历史 job 查看器"）。

## 三、形态决策

经对比「toast 内联展开」与「独立详情弹窗」，选定**独立详情弹窗**：

- `ProgressToast` 保持精简（状态 + 进度 + 最新消息），新增「查看详情」入口。
- 点击打开独立 `Dialog`：上半部为可滚动的完整日志时间线；失败时下半部展示完整错误（含 `stack`，可一键复制）。
- 理由：完整错误栈/原始响应需要足够空间与复制能力，浮层 320px 宽不适合；弹窗给详细信息留足空间，浮层继续承担"一眼可读"的角色。

## 四、架构与数据流

```
useJobStream(jobId)  ──{ events, status }──▶  ProgressToast
                                                 │ 透传 events / status
                                                 ▼
                                          JobDetailDialog (open)
                                            ├─ 日志区:  events[].map(eventLogLine)
                                            └─ 失败区:  useQuery(['job', jobId])
                                                          → GET /api/jobs/[id]
                                                          → resultJson.error
```

**关键约束：dialog 不自己 `useJobStream`。** `ProgressToast` 已持有 `events/status`，透传给 dialog，避免对同一 `jobId` 开第二条 `EventSource`（SSE 连接每 jobId 应只有一条）。

## 五、组件设计

### 5.1 `ProgressToast` 改动（`src/components/shared/progress-toast.tsx`）

- 新增本地 state `const [detailOpen, setDetailOpen] = useState(false)`。
- body 内新增入口按钮：
  - 文案：默认「查看详情」，`status==='failed'` 时变「查看错误」并用 `text-danger`。
  - 点击 `setDetailOpen(true)`。
- 渲染 `<JobDetailDialog jobId={jobId} events={events} status={status} open={detailOpen} onClose={() => setDetailOpen(false)} />`。
- 浮层折叠（collapsed）/关闭逻辑不变。

### 5.2 新增 `JobDetailDialog`（`src/components/shared/job-detail-dialog.tsx`）

- props：`{ jobId: string; events: JobStreamEvent[]; status: JobStreamStatus; open: boolean; onClose: () => void }`。
- 外壳：照 `settings-dialog` 惯例 —— `fixed inset-0` 遮罩 + 居中卡片 + `z-sheet` 之上 + Esc/点遮罩关闭；`role="dialog" aria-modal`。
- header：任务类型名（复用 `detectJobType`）+ 状态后缀（— Done / — Failed）+ 关闭按钮。
- body 两段：
  1. **日志区**（始终显示）：
     - `events.map(eventLogLine)` 逐行渲染 `[时间] 消息`，mono 字体，时间正序，`max-h + overflow-y-auto`。
     - error 类事件整行红色高亮（见 §6 判定）。
     - 自动滚到底：仅当用户已处于底部时（记录 scrollTop 判定），避免打断手动上滚。
     - 空事件时显示占位「暂无日志」。
  2. **错误区**（仅 `status==='failed'`）：见 5.3。

### 5.3 错误区取数与渲染

- 取数：`useQuery({ queryKey: ['job', jobId], queryFn: () => apiFetch('/api/jobs/' + jobId), enabled: open && status === 'failed' })`。
  - 经 `useApiFetch()` / `@/lib/api-fetch`，遵守项目"禁止手写 fetch"约定。
- 解析：`JSON.parse(job.resultJson).error` →（纯函数 `parseJobError`，见 §6）得到结构化 `{ message, stack?, cause?, responseText?, finishReason?, usage? }`。
- 渲染：
  - 顶部醒目 `error.message`。
  - 可折叠「技术细节」：`stack` / `cause` / `responseText` / `finishReason` / `usage`（存在才显示），mono + `whitespace-pre-wrap` + 可滚动。
  - 「复制」按钮：`navigator.clipboard.writeText(完整 error JSON)`，复制后短暂反馈（图标切换）。
- 兜底：拉取中显示 loading；拉取失败或 `resultJson` 无 `error` 时，回落展示流里最后一条 error 事件文本 / `latestMessage`，避免空白。

## 六、纯函数（可单测）

放在 `src/lib/`（客户端可用，无 server 依赖）：

### `eventLogLine(event: JobStreamEvent): { time: string; text: string; isError: boolean }`

- `text`：复用现有优先级 `data.message || data.step || data.description || ''`；为空时回落 `event.type`。
- `time`：取 `data.createdAt`（SSE 注入的 ISO），格式化为 `HH:mm:ss`；缺失时返回空串。
- `isError`：`event.type === 'job:failed'` 或 `event.type.endsWith(':error')`。

### `parseJobError(resultJson: string | null | undefined): JobError | null`

- `JSON.parse` 容错（`try/catch`），取 `.error`；归一化为 `{ message, stack?, cause?, responseText?, finishReason?, usage? }`。
- 解析失败 / 无 error 时返回 `null`。

> `latestMessage` 的提取逻辑当前内联在 `use-job-stream.ts`；本次将"逐条提取"抽成 `eventLogLine`。是否让 hook 复用该函数为可选优化，不强求（避免扩大改动面）。

## 七、UI 原语与样式

- 复用 `IconButton` + lucide 图标（关闭 `X`、复制 `Copy`/`Check`、折叠 `ChevronRight`/`ChevronDown`）。
- 颜色走 CSS 变量：`bg-surface` / `text-foreground-secondary` / `text-danger` / `border-border` 等。
- 不新增 UI 原语；modal 外壳就地实现（与 `settings-dialog` 风格一致）。

## 八、测试

- `src/lib/__tests__/`：
  - `eventLogLine`：覆盖 `message/step/description` 优先级、嵌套 `data`、全缺字段回落 `type`、error 事件 `isError=true`、`createdAt` 缺失/正常格式化。
  - `parseJobError`：合法 JSON 带 error / 无 error / 非法 JSON / null 输入。
- 组件层：项目无现成组件测试基建，沿用惯例不强加（保留为后续可选）。

## 九、风险与边界

- **双 SSE 连接**：靠"dialog 不自建 `useJobStream`、由 toast 透传"规避。
- **完整错误时序**：失败后 `resultJson` 已落库，`GET /api/jobs/[id]` 权威可取；即使 SSE `final` 事件已带 `resultJson`，仍以接口为准更可靠。
- **大日志性能**：`events` 上限 1200 条，逐行渲染可接受；如需可加虚拟滚动（本次不做）。
- **复制兼容性**：`navigator.clipboard` 在非安全上下文不可用时，按钮置灰或回落（次要，按需处理）。

## 十、验收标准

1. 浮层出现「查看详情/查看错误」入口；点击打开弹窗。
2. 弹窗日志区按时间逐行展示当前任务全部事件，error 行红色高亮，可滚动。
3. 任务失败时，弹窗展示完整错误（`message` + 可折叠 `stack`/`cause`/`responseText` 等），可一键复制完整 error JSON。
4. dialog 不引入对同一 jobId 的第二条 SSE 连接。
5. `eventLogLine` / `parseJobError` 纯函数单测通过；`tsc --noEmit` 通过。
