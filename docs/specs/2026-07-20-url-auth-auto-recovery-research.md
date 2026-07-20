# Spec：URL 登录态自动恢复与 Research 接入

日期：2026-07-20
状态：已定稿

## 背景与问题

现有 URL Ingest 已能把 401/403 归类为 `ingest:auth-required`，并允许用户在
`/ingest` 工作台点击“登录”后提交短期加密凭证。但恢复入口仍有两个缺口：

- 认证挑战出现后只替换失败主操作，不会主动弹出，用户容易把它当成普通任务失败；
- Research 批准候选后创建的 child Ingest 不进入 `/ingest` 工作台，通用授权 API 还会显式
  拒绝其 `researchProvenance`，因此受保护候选无法沿原 Research run 恢复。

## 目的

- 任意被全局任务跟踪器观察到的 URL Ingest 在认证挑战成为当前失败原因时自动弹出授权框。
- 页面刷新后仍能从持久化 job result + SSE 历史恢复尚未处理的认证挑战。
- 多个认证挑战按任务排队，一次只展示一个；同一持久化 challenge 不重复打扰。
- 用户关闭自动弹窗后任务保持失败，可从任务行或 `/ingest` 再次手动打开。
- Research child Ingest 提交授权后，原子恢复同一个 child job、delivery 与 run，不绕过
  approval/provenance 契约，也不创建新的 Research run。

## 约束

- Cookie/Authorization 的加密、TTL、exact-origin 与跨源重定向剥离规则保持不变。
- 自动弹窗依据服务端持久化的 `ingest:auth-required`，不能根据错误文案猜测。
- 全局任务列表跨 Subject；授权请求必须携带任务自身 `subjectId`，不能依赖当前 UI Subject。
- Research run 已进入 verification、审批/候选 lineage 不匹配、delivery 不再 failed 或 child
  被取消时继续 fail closed。
- 自动弹窗不能与 `/ingest` 工作台的手动弹窗同时抢占同一 challenge。

## 方案取舍

### 方案 A：全局任务面板统一协调（推荐）

`GlobalJobTracker` 同时恢复 active job 与 `url-auth-required` failed Ingest；每个 job row 从 SSE
历史归约当前 challenge，再把请求交给 `JobsPanel` 的单一队列。队首渲染复用的
`IngestAuthDialog`，授权成功后发布既有 `wiki:job-started` 事件，让同一行重新订阅。

优点：普通 Ingest 与 Research child 共用真实全局入口；页面位置无关；容易去重和串行展示。
缺点：需要让全局 tracked job 保存 `subjectId`，并给失败认证任务增加一次列表查询。

### 方案 B：分别在 Ingest 与 Research UI 内接入

在工作台和 Research 候选弹窗各自监听 child job 并渲染授权框。

优点：局部改动直观。缺点：两套 SSE/恢复/弹窗状态会漂移；用户离开 Health 后 Research 无入口；
普通 Ingest 在全局任务面板与工作台同时观察时还会产生重复弹窗。不采用。

### 方案 C：服务端推送全局认证通知

新增跨任务 SSE 或通知表，由 Providers 订阅全部 challenge。

优点：客户端无需逐行协调。缺点：引入新的全局事件基础设施和生命周期，超出本次需求。不采用。

## 客户端数据流

```text
GlobalJobTracker poll
  -> running + pending + failed(type=ingest)
  -> failed 仅保留 result.error.code=url-auth-required
  -> JobRow 订阅/回放该 job SSE
  -> currentUrlAuthChallenge(events) 返回 challengeId + origin + sourceId
  -> JobsPanel 按 challengeId 去重并排队
  -> 自动打开队首 IngestAuthDialog

用户关闭
  -> 本页会话记住 challengeId，不自动重开
  -> 任务行保留 KeyRound 手动入口

用户授权成功
  -> POST /api/jobs/:id/url-auth（body 带 job.subjectId）
  -> 发布 wiki:job-started
  -> 行回到 pending/running 并续订同一 job SSE
  -> challenge 后出现 job:retrying，旧 challenge 自动失效
```

`challengeId` 使用持久化 `job_events.id`。这样同一事件被工作台与全局任务面板同时回放时仍是
同一身份；授权后若目标站再次返回 401/403，新事件拥有新 ID，可以再次自动提示。

## Research 原子恢复

认证 API 仍先完成通用校验：当前 failed Ingest、URL Source、最新 challenge 与 source 一致，
以及凭证 header 合法。识别到 `researchProvenance` 后：

```text
create encrypted grant
  -> retryResearchIngestJob({ ..., sourceAuthGrantId })
  -> IMMEDIATE transaction
       validate run/approval/candidate/delivery/job/source
       merge sourceAuthGrantId into existing job params
       failed job -> pending
       failed delivery -> queued
       run -> importing + version++
  -> emit job:retrying { authenticated: true, research: true }
```

事务失败时 API 删除刚创建的 grant；事务成功后再 best-effort 删除旧 grant。普通 Ingest 继续走
`requeueJobWithParams`。Research response 可附带最新 `researchRun`，但凭证内容始终不回显。

## 非目标

- 不自动读取浏览器 Cookie，不新增用户名/密码表单或受控浏览器。
- 不把一次授权推广给同 origin 的其他任务或候选。
- 不改变 Research 候选审批、重新选择、批量导入与 verification 规则。
- 不为普通非认证失败的 Research import 增加自动 retry。

## 成功标准

- 当前 challenge 进入 failed 后，无需点击任务按钮即自动显示授权框。
- 页面刷新可恢复未处理 challenge；关闭后本页不反复弹出，手动入口仍可再次打开。
- 多个 challenge 逐个展示；授权/关闭一个不会丢失其余 challenge。
- 普通 Ingest 与 Research child 都能提交加密 grant 并复用原 job ID。
- Research 授权成功时 job/delivery/run 原子恢复；任一 CAS/lineage 失败时三者都不变且新 grant 被删除。
- 跨 Subject job 使用自身 subjectId 授权，不受当前 UI Subject 影响。
- 定向测试、`npx tsc --noEmit`、`npm run lint`、`npx vitest run` 与 `npm run build` 通过。
