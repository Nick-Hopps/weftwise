# Health 三类处置操作手动中断

- 日期：2026-07-20
- 状态：已定稿
- 关联计划：[docs/plans/2026-07-20-health-actions-manual-cancel.md](../plans/2026-07-20-health-actions-manual-cancel.md)

## 一、背景与问题

Health 当前成组提供「整理」「修复」「研究」三个处置按钮。任务启动后，按钮通过 `loading` 进入禁用态，用户只能等待任务结束，无法在原工作流中手动中断。

服务端已有通用 `POST /api/jobs/:id/cancel`：它会原子地把 pending/running job 置为取消终态、清理检查点并发出 `job:cancelled`。Fix 与 Curate 的工具循环也已轮询取消标记并中断模型请求。缺口有两处：

1. Health 没有把三个处置按钮接到取消 API；刷新恢复出的在途任务同样只能等待。
2. Research 的 query 生成、Tavily 搜索和 triage 没有消费取消信号。仅把 job 置为终态并不能阻止后台继续调用外部服务，甚至可能继续持久化候选 run。

## 二、目标与成功标准

1. 「整理」「修复」「研究」任一操作处于 pending/running 时，原按钮原位切换为可点击的 Stop 命令。
2. 点击 Stop 调用该按钮当前绑定 job 的通用取消 API；请求进行中阻止重复点击。
3. 页面刷新后从 active jobs 恢复出的 Fix、Curate、Research 仍显示 Stop 并可取消。
4. 取消成功后由既有 SSE 终态闭环释放 busy 状态、刷新 Health snapshot 与 active jobs，不在客户端伪造完成状态。
5. Research 在 query LLM、并行搜索、triage LLM 任一阶段都能响应取消；取消后不得写入新的 Research provenance run。
6. 取消请求失败时在 Health 工作区显示可读错误，保留可重试的 Stop 入口。

## 三、范围边界

### 包含

- Health 批量「整理」「修复」「研究」三个操作按钮。
- 同一状态机也自然覆盖逐 finding 启动后对应的批量按钮，因为二者共享 workflow job。
- pending 与 running job。
- Research 的模型请求、Tavily HTTP 请求和持久化前闸门。

### 不包含

- 右上角独立的「运行/重新检查」Health check 按钮。
- 自定义 Research 候选批准后的 import/verification 子任务取消。
- Re-ingest、Delete Source 与候选对话框动作。
- 对已完成写入的回滚。Fix/Curate 是多步 Saga/工具操作；取消只停止后续工作，已成功提交的独立变更保留，并由现有 Health 投影在后续刷新中反映。

## 四、方案对比

### 方案 A：按钮原位 Stop + 通用取消 API + Research 全链路 abort（推荐）

- 复用当前 job ID、SSE、取消 API 和 worker 终态语义。
- 前端只新增取消请求状态，不另建平行任务状态机。
- Research 使用同一个外部 abort signal 串起两个结构化 LLM 调用和全部搜索请求，并在持久化前再次检查取消标记。
- 优点：行为真实、刷新可恢复、改动边界清晰；取消后不会继续产生 Research side effect。
- 缺点：Fix/Curate 已完成的单步写入不会回滚，这是现有多步任务模型的明确语义。

### 方案 B：只在前端调用取消 API

- UI 很快显示终态，但 Research handler 仍可能在后台消耗网络/模型资源并写 provenance。
- 不满足“中断”的真实语义，拒绝。

### 方案 C：为 Health 新建专用取消路由

- 可在路由中限制 job type，但会复制通用取消事务、事件和 Research 对账逻辑。
- 当前 UI 已从可信服务端快照/active jobs 获得 job ID，新增路由收益不足，拒绝。

## 五、交互与状态设计

- idle：保持现有图标、文案、数量和禁用规则。
- pending/running：按钮显示 Square 图标与 `Stop` 文案，按钮使用 danger intent；此时点击执行取消，不再触发新的 remediation。
- cancelling：按钮显示 loading，保持禁用，直到请求返回。
- cancel API 成功：等待 `job:cancelled` SSE；既有 effect 负责清 job ID、释放 action gate、失效查询。
- cancel API 失败：移除 cancelling 状态，显示 `health.error.cancelStatus` 或 `health.error.cancelRetry`，允许再次点击。
- 409（任务已终态）：视为幂等收敛，主动失效 active jobs/Health snapshot，等待当前 SSE/服务端事实清理 UI。

## 六、后端取消传播

1. `generateStructuredOutput` 新增可选 `abortSignal`，与自身 timeout 共用内部 controller；所有退出路径移除 listener。
2. `webSearch` 新增可选 `AbortSignal`，与 8 秒搜索 timeout 合并；不改变其他调用方。
3. `runResearchJob` 建立 job 级 controller，轮询 `queue.isCancelRequested(job.id)`：
   - 启动和每个阶段边界立即检查；
   - 在途 LLM/search 收到 abort；
   - `Promise.allSettled` 吞掉搜索 abort 后，再由阶段闸门统一抛 `AgentCancelled`；
   - `persistResearchRun` 前最后检查，保证取消后不创建 run；
   - finally 清理轮询定时器。
4. worker 继续用既有 `AgentCancelled` 分类，不重试，并保持取消终态幂等。

## 七、测试策略

- 客户端纯 helper：成功、409 幂等收敛、非 2xx 可读错误、网络失败。
- Health UI 静态/逻辑测试：运行态三个按钮派生为 Stop，idle 保持原动作。
- Research service：取消信号贯通 query/search/triage，取消后不持久化 run。
- provider registry：外部 signal abort 结构化输出并清理资源。
- web search：外部 signal 传给 fetch，保留 timeout 行为。
- 回归：Health、Research、LLM provider、web-search、jobs cancel/worker 相关测试，以及类型、lint、build。
