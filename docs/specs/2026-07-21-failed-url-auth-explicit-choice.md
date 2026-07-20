# Spec：失败 URL 授权任务显式重试或取消

日期：2026-07-21
状态：已定稿

## 背景与问题

全局任务追踪器会在应用启动时恢复 `result.error.code=url-auth-required` 的 failed Ingest，
并回放持久化 SSE 事件。当前 `JobsPanel` 一观察到认证挑战就自动打开授权对话框；页面刷新会
重建客户端内存状态，因此同一批历史失败任务会再次自动弹出，看起来像刷新触发了新的 Ingest。

服务端实际上没有创建新任务。问题在于客户端替用户做了“立即重试授权”的选择，同时任务行
的关闭按钮只做本次会话内移除，没有终结 failed job；刷新后这些任务仍会被恢复。

## 目的

- failed URL 授权任务恢复后只展示在任务面板，不自动打开授权对话框。
- 每个任务明确提供两个选择：授权后重试，或直接取消任务。
- 取消复用现有 `POST /api/jobs/:id/cancel`，持久化 `cancelled=true`、清除检查点，并触发
  Research provenance 对账；刷新后不得再次恢复该任务。
- 授权后重试继续复用 `POST /api/jobs/:id/url-auth` 和同一 job ID，不改变凭证安全边界。
- 普通 failed job 的“移除”行为保持不变。

## 约束

- 不新增 jobs status、数据库迁移或另一套取消 API。
- 不把“关闭授权对话框”解释为取消任务；只有用户点击任务行的取消动作才终结任务。
- cancelled auth job 即使仍保留原 `error.code=url-auth-required`，也必须从恢复列表排除。
- 持久化 SSE 中 `job:cancelled` 必须使旧认证 challenge 失效，不能再接受授权提交入口。
- Research child Ingest 取消后继续走现有通用 cancel route 的 provenance 对账。

## 方案取舍

### 方案 A：任务行显式双动作（推荐）

恢复 failed auth job，但不自动入授权队列。任务行提供 KeyRound“授权后重试”和
CircleX“取消任务”；前者手动打开现有授权框，后者调用通用取消 API，成功后从面板移除。

优点：选择发生在任务上下文内；不打断页面；取消结果持久化；复用现有安全和 provenance
边界。缺点：任务行比普通终态多一个动作。

### 方案 B：刷新后弹出二选一确认框

继续自动弹窗，但先要求用户选择重试或取消。

优点：决策醒目。缺点：刷新仍会被历史任务打断；多个任务会形成连续模态框，不采用。

### 方案 C：新增“待授权”数据库状态

把认证失败从 failed 拆成新的 job status。

优点：领域状态更显式。缺点：会扩散到 worker、SSE、查询、状态机和迁移；现有结构化 error
与 cancelled 标记已经能表达本需求，不采用。

## 客户端数据流

```text
GlobalJobTracker 启动轮询
  -> 恢复 failed + url-auth-required + !cancelled 的 Ingest
  -> JobRow 回放 SSE，识别当前 auth challenge
  -> 只渲染“授权后重试 / 取消任务”，不自动打开对话框

用户选择授权后重试
  -> 手动打开 IngestAuthDialog
  -> POST /api/jobs/:id/url-auth
  -> 同一 job 回到 pending，继续既有 SSE 跟踪

用户选择取消任务
  -> POST /api/jobs/:id/cancel
  -> failed job 写 cancelled=true、清检查点、追加 job:cancelled
  -> 成功后从当前任务面板移除
  -> 后续刷新恢复过滤 cancelled job
```

## 成功标准

- 刷新任意页面时，历史 failed auth jobs 只显示任务行，不自动弹出授权框。
- failed auth job 同时展示“授权后重试”和“取消任务”两个可访问动作及 tooltip。
- 点击授权后重试才打开现有授权对话框，关闭对话框不取消任务。
- 点击取消成功后任务被持久化终结，清除当前行，刷新后不再出现。
- 取消请求失败时保留任务行并展示可重试的错误提示。
- `jobResultRequiresUrlAuth` 和 `currentUrlAuthChallenge` 都拒绝已取消任务/挑战。
- 定向测试、TypeScript、lint、全量 Vitest 与生产构建通过。
