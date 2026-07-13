# Research 批准溯源 Phase 2C 设计

**日期：** 2026-07-13  
**状态：** 已实现
**来源：** `docs/superpowers/specs/2026-07-10-wiki-tooling-and-workflow-governance-design.md` 第十章与 Phase 2 第 4 项

## 一、目标

Phase 2C 将现有 `Research → 候选确认 → Ingest` 从浏览器内的临时选择升级为服务端可验证、可恢复、可审计的闭环：

```text
finding ID / 手动 topic
  → research job / research run
  → 稳定 candidate ID
  → 不可变 approval selection
  → research-import coordinator
  → source / ingest child job
  → touched pages / operation / git commit
  → verification lint
  → finding fixed / residual / delivery failed
```

必须满足：

- Research 仍只负责发现候选，不直接写 Vault；
- 用户批准必须由专用 API 在服务端持久化，不能由对话文本或客户端 URL 代替；
- 批准后继续复用既有 URL 抓取、source store、Ingest、Saga、索引和 Git 提交链路；
- 所有 Research 与通用 URL Ingest 抓取统一经过 SSRF-safe 出网守卫；用户批准不是访问内网地址的授权；
- 浏览器刷新、关闭弹窗或 worker 重启后仍能恢复当前批次及每条候选结果；
- candidate、approval、source、ingest job、operation、commit 和 touched pages 可串成完整 provenance；
- finding 是否修复只由批准后的验证 lint 判断，不能把“已 ingest”直接等同于“已修复”；
- 本阶段不新增 LLM task、prompt 或模型路由，因此 `llm-config.example.json` 保持不变；finding 批次批准并完成导入后会复用既有 `lint` route 执行一次验证，因而会产生一次既有 lint 模型调用与用量记录。

## 二、现状与缺口

当前 Research 已保留 `lintJobId / findingIds / remediationContext`，并在 job 结果中返回候选；但后续链路存在四个断点：

1. 候选没有稳定 ID，只以 URL 存在于 `jobs.result_json`；
2. `ResearchCandidatesDialog` 只在 React 本地状态中保存选中 URL，刷新后丢失；
3. 确认按钮直接调用通用 `POST /api/ingest { urls }`，Ingest job 不知道来源于哪个 finding、research job 或批准记录；
4. `remediation-status` 只知道 Research 有候选，因此会持续返回 `awaiting-approval`，无法区分导入中、验证中、已修复和残留。

`pending_actions` 不适合复用：它是 conversation-scoped 的单操作审批，具有 30 分钟 TTL 和页面操作 CHECK；Research 可以来自 Health、手动主题或 backlog，是多候选、多子任务、允许部分失败的长期批次。二者应共享安全原则，而不共享表和状态机。

## 三、非目标

本阶段不实现：

- 无人值守自动批准或按分数自动导入；
- 让模型调用 Research、批准、Ingest 或验证工具；这些仍是固定 workflow command；
- 候选级的精确 finding 归因。一个 finding 批次中的已批准候选保守关联该批次的全部 finding，最终以新 lint 逐 ID 验证；
- 修改通用 `/api/ingest` 的请求契约，或允许客户端通过该端点注入 research provenance；
- 删除已保存 source、回滚已完成 Ingest，或为候选导入构造跨子任务 ACID；
- 重做 Research 搜索/triage prompt、调整模型路由或改变候选质量评分；
- 在本阶段重构 `research_backlog` 的业务状态。backlog 继续保存 `researchJobId`，详情通过 run API 恢复；
- 对历史 Research job 做回填。迁移前的 job 仍可读旧 `resultJson`，但没有新的 approval provenance。

## 四、安全与信任边界

### 4.1 批准权

- 批准 API 必须执行 `requireAuth`、`requireCsrf` 和 `resolveSubjectFromRequest(required:true)`；
- 请求体只接受服务端签发的 `candidateIds`、`expectedVersion` 和 `idempotencyKey`；
- 服务端按 run + subject 重新读取候选快照和规范化 URL，拒绝任意 URL、跨 run ID、跨 Subject ID、重复 ID 和空选择；
- 首次批准在 SQLite `IMMEDIATE` 事务中原子写入不可变 selection、候选决策和协调 job；
- 同一幂等键且 payload hash 相同返回原结果；相同键不同 payload、版本陈旧或已有不同 selection 均返回 409；
- 关闭弹窗、发送“继续/批准”等聊天消息、读取 job 结果均不能改变批准状态。

### 4.2 写入权

- Research job 仍不触碰 Vault；
- `research-import` coordinator 只能读取该 approval 已保存的候选，不能接受调用方传入 URL；
- coordinator 只负责抓取、经 token-aware source get-or-create 落地原始资料，并入队既有 `ingest` child job；
- Vault 写入只能由既有 Ingest Service 经 Saga 完成；
- 通用 `/api/ingest` 保持独立，不能伪造或补写 Research lineage。

### 4.3 SSRF 与重定向边界

Research/Tavily/LLM 返回的 URL 一律视为不可信输入。现有仅检查 `http(s)` 且 `redirect:'follow'` 的抓取方式不足，本阶段必须把 `fetchUrlSource` 收紧为所有 URL Ingest 共用的出网守卫：

- 拒绝 URL userinfo、非法 hostname、非 `http/https` 协议；
- 对 IP literal 与 DNS 全部解析结果拒绝 loopback、private、link-local、carrier-grade NAT、multicast、unspecified、documentation/reserved 等不可公开路由网段，同时覆盖 IPv4-mapped IPv6；
- DNS 解析后把连接固定到已验证的公开地址，并保留原 hostname 的 Host/SNI/TLS hostname 校验，不能“先验 DNS、后由 fetch 再解析”留下 rebinding 窗口；
- 使用手动重定向，最多 5 跳；每个 `Location` 都重新做协议、userinfo、DNS/IP 和 pinned connection 校验；
- timeout、content-type 与 5MB 流式上限继续生效，超限时立即中止而不是先完整读入内存；
- 候选持久化时先做确定性的 URL 语法与 IP literal 校验，实际抓取时始终重新执行完整 DNS/pinned 校验；
- 同一 validator 同时覆盖 Research coordinator 和既有通用 `/api/ingest { urls }`，避免两条抓取路径安全语义漂移。

测试使用可注入 resolver/request transport，覆盖私网字面量、混合公私 DNS 答案、IPv4-mapped IPv6、DNS rebinding 固定地址和 public→private redirect；测试不得访问真实网络。

### 4.4 Subject 隔离与日志

- 所有 run、candidate、approval 和 delivery 行都必须带可验证的 Subject 归属；
- API 对不存在、跨 Subject 或无权访问的 run 统一返回 404；
- 日志只记录 ID、状态、计数、hostname、job/operation/commit 标识与脱敏错误，不记录完整正文、抓取内容、完整候选摘要或 LLM credential。

## 五、持久化模型

新增五张专用表。Research job、Ingest job 和 operation 可能受既有保留策略清理，因此 provenance 表保存标识与必要结果快照，不依赖外键级联到 `jobs` 或 `operations`。

### 5.1 `research_runs`

| 字段 | 语义 |
|---|---|
| `id` | run UUID，主键 |
| `subject_id` | Subject 外键，删除 Subject 时级联 |
| `research_job_id` | 原 Research job ID，唯一 |
| `origin` | `findings` 或 `topic` |
| `lint_job_id` | finding 批次来源 lint job；手动 topic 为 null |
| `topic` | 手动主题；finding 批次为 null |
| `topics_json / queries_json` | Research 已执行输入与查询快照，用于 worker 重启后直接恢复 |
| `candidate_set_hash` | 按候选稳定顺序计算的规范化快照 hash |
| `status` | run 状态 |
| `version` | 乐观锁版本，候选落地后从 1 开始 |
| `verification_lint_job_id` | 后置验证 lint job，可空 |
| `created_at / updated_at / completed_at` | 生命周期时间 |
| `error_json` | 脱敏终态错误，可空 |

run 状态：

```ts
type ResearchRunStatus =
  | 'awaiting-approval'
  | 'importing'
  | 'verifying'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'dismissed'
  | 'empty';
```

`empty` 表示 Research 正常完成但无候选；`partial` 表示至少一条候选完成 Ingest，但存在 delivery 失败或验证后仍有原 finding；`completed` 只表示已批准批次的所有成功 delivery 已物化且原 finding 均通过后置 lint 消失。手动 topic 没有 finding 时，在所有 delivery 终态后即可 `completed/partial/failed`，不额外创建 lint。

### 5.2 `research_run_findings`

复合主键 `(run_id, finding_id)`，保存本批次稳定 finding ID，并以 `snapshot_json` 保存当时的 `type / severity / pageSlug / sourceId / sourceFilename / description / suggestedFix / subjectSlug`。同时保存：

- `verification_status`：`pending / fixed / residual / unverifiable`；
- `verified_at`：验证终态时间；
- `verification_snapshot_json`：residual 时保存新 lint 中对应 finding 快照；lint 失败/损坏时保存脱敏不可验证原因。

该表只声明“这些候选为此 finding 批次发现”，不宣称某个候选只对应某一条 finding。即使来源/验证 lint job 后续清理，原始 hash、当时问题和最终逐 finding 结论仍可解释和审计。

### 5.3 `research_candidates`

| 字段 | 语义 |
|---|---|
| `id` | `sha256(runId + "\n" + normalizedUrl)`，稳定 candidate ID |
| `run_id` | 批次；Subject 从 run 唯一派生 |
| `normalized_url` | URL 身份，run 内唯一 |
| `snapshot_json` | Research 当时的 title/url/snippet/score/reason 快照 |
| `rank` | Research 结果顺序 |
| `decision` | `pending / approved / rejected` |
| `approval_id / decided_at` | 决策来源与时间，可空 |

候选快照一旦写入不可由前端修改。Research job 因瞬时错误重跑时，以 `research_job_id` 找到同一 run；相同 candidate set 幂等返回，candidate set hash 不同则拒绝覆盖并让 job 失败，防止已经展示或批准的证据漂移。

### 5.4 `research_approvals`

| 字段 | 语义 |
|---|---|
| `id` | approval UUID |
| `run_id` | 一对一 run；Subject 从 run 唯一派生 |
| `selected_candidate_ids_json` | 排序后的不可变选择 |
| `payload_hash` | runId + version + selection 的 canonical hash |
| `idempotency_key` | 客户端请求幂等键，run 内唯一 |
| `coordinator_job_id` | `research-import` job |
| `created_at` | 批准事实时间 |

每个 run 最多一个 approval。approval 是不可变批准事实，不复制工作流状态；run 是批次状态唯一真实源，candidate delivery 是单项状态唯一真实源。

### 5.5 `research_candidate_ingests`

复合主键 `(approval_id, candidate_id)`，每个获批候选一行：

| 字段 | 语义 |
|---|---|
| `run_id` | 一致性键；Subject 从 run 唯一派生 |
| `normalized_url` | approval 时保存的 URL 身份 |
| `status` | delivery 状态 |
| `source_id / ingest_job_id` | 已保存 source 与 child job，可空 |
| `operation_ids_json` | Ingest 已应用 operation ID 快照 |
| `touched_pages_json` | 去重、排序的实际页面动作；系统页单独标识 |
| `commit_sha` | Ingest 结果 commit SHA，可空 |
| `claim_token / lease_expires_at / attempt_count` | 候选级 coordinator CAS claim 与恢复租约 |
| `created_at / updated_at / completed_at` | 生命周期时间 |
| `error_json` | 单候选脱敏错误，可空 |

delivery 状态：

```ts
type ResearchCandidateIngestStatus =
  | 'pending'
  | 'fetching'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed';
```

`touched_pages_json` 的正式结构为：

```ts
Array<{
  slug: string;
  action: 'created' | 'updated';
  system: boolean;
}>
```

它从 Ingest `resultJson.pagesCreated/pagesUpdated` 物化；结果缺失或损坏时立即回退读取 `operationsRepo.listAppliedForJob`。按 slug 去重、排序；同一 slug 冲突时 `created` 优先。该快照必须在 operation 保留清理前写入 provenance 表。`index/log` 等系统页可以保留在审计结果中，但 `system:true`，不能作为 finding 已修复的证明。

coordinator 必须用候选级租约防止同一 job lease 被两个 worker 重入：

1. `pending` 或已过期 `fetching` 通过条件更新 claim 为 `fetching`，写入随机 claim token、lease 和 attempt；
2. 网络抓取期间可续租；所有 source/job/status 回写都必须匹配 claim token；
3. 旧 handler 即使仍在运行，token 失效后也不能入队 child job；
4. 抓取完成后不得直接调用普通的非原子“先查再写”；必须进入专用 `IMMEDIATE` transaction，再次校验 token/lease，随后在同一事务中完成 source get-or-create、sourceId 回写、ingest job INSERT 和 delivery queued；
5. `sources(subject_id, content_hash, filename)` 新增唯一约束。source store 并发 loser 读取 winner、删除自己新建的 sidecar 并复用 winner ID；raw 文件路径相同且内容 hash 相同。`ingest_job_id` 同样唯一；
6. 旧 token 在事务前失效时不能创建 source 或入队；事务已开始时新 owner 无法并发 claim，从根上消除重复 source/orphan sidecar 窗口。

### 5.6 索引、CHECK 与删除顺序

- `sources(subject_id, content_hash, filename)`、`research_runs.research_job_id`、`research_approvals.run_id`、`research_candidate_ingests.ingest_job_id` 为 UNIQUE；`research_candidates(run_id, normalized_url)` 为组合 UNIQUE；
- delivery 的 `(approval_id, run_id)` 与 `(candidate_id, run_id)` 使用复合 FK/唯一键保证 approval、candidate 属于同一 run；children 不重复保存 subjectId，Subject 从 run 唯一派生；
- `research_candidates` 的可空 `(approval_id, run_id)` 也使用复合 FK 指向 `research_approvals(id, run_id)`，防止 candidate 引用其他 run 的 approval；
- 为 `research_runs(subject_id, status, updated_at)`、`research_candidates(run_id, rank)`、`research_candidate_ingests(status, lease_expires_at)` 建索引；
- schema 和数据库迁移都包含 status/decision CHECK；
- `client.ts::ensureTables` 必须覆盖新安装和旧库补表/补索引；
- `sources` 唯一索引迁移先合并历史重复项：稳定选择 canonical source，迁移 `page_sources`、合法 jobs params 与 provenance 引用，删除 loser source/sidecar，再创建唯一索引；迁移失败整体回滚 DB，文件清理由可重入维护步骤补偿；
- `subjectsRepo.deleteWithContents` 与 reset 路径按 child → approval/candidate/finding → run 顺序删除，不能让 Subject 删除被 `restrict` 阻断；删除/重置 Subject 的产品语义是有意清除该 Subject 的全部 provenance；
- 删除或 reset 的 active job 检查必须和 DB purge 位于同一个 `IMMEDIATE` transaction；事务内若目标 Subject 存在 `pending/running` job，或存在 `subject_id IS NULL` 的全局 lint 等覆盖任务，则整体回滚并返回 409；
- reset 的同步文件清理在同一受控维护临界区内完成；所有 Phase 2C 新 enqueue/source 写路径必须在 transaction/claim 时重新确认 Subject 与 run 仍存在，失败时不重建已删除内容；
- API 与 repo 测试必须覆盖跨 Subject、FK、CHECK、级联/显式删除和索引。

### 5.7 Subject maintenance epoch

仅靠 active job 检查无法覆盖“URL 正在网络抓取、尚未保存 source/入队”的请求。本阶段为 `subjects` 增加内部写状态：

```ts
maintenance_state: 'active' | 'resetting';
mutation_epoch: number;
```

规则：

1. file/text/URL Ingest 与 Research coordinator 在开始潜在长操作前领取 `{ subjectId, mutationEpoch }`；
2. 所有生产 source 写路径统一调用 `persistSourceAndEnqueueIngest` 或其 token-aware 变体，在同一个 `IMMEDIATE` transaction 内重新校验 subject 存在、state=active、epoch 未改变，然后完成 source get-or-create、文件/sidecar、source 行、ingest job INSERT；
3. URL 批次抓取前领取 epoch。若 reset/delete 在网络等待期间发生，返回后的事务因 subject 不存在、state 非 active 或 epoch 改变而失败，且不得写 raw/sidecar 或 job；
4. reset 在一个 `IMMEDIATE` transaction 内检查 active/global jobs、把 state 改为 resetting、递增 epoch 并 purge DB；同步文件重建完成后再原子恢复 active。失败路径在 `finally` 恢复 state，但不回退 epoch；
5. 若 source+job 已先原子落地，reset 的 active job guard 会阻止 reset；若 reset 先提升 epoch，旧请求无法落地，从而关闭两种顺序的竞态；
6. delete 在 `IMMEDIATE` transaction 内检查后直接删除 subject；旧 lease 因 subject 不存在而失败；
7. `resolveSubjectFromRequest` 的读语义不变；写 Service/repo 才消费 maintenance lease，避免把内部状态镜像到客户端。

`saveRawSource` 可以保留为内部低层能力，但 Route/Research 不得再使用“save 后另行 enqueue”的两步组合。

## 六、Research 结果落地

`runResearchJob` 解析参数后先按 `research_job_id` 查找完整 run：若已存在，直接从持久化的 topics/queries/candidates 构造同一结果，不重复调用 LLM 或 web search。没有 run 时才执行研究，并在候选 triage 完成后、返回 job 结果前执行：

1. 规范化候选 URL，按最终结果顺序生成 candidate snapshot；
2. 以 `research_job_id` 幂等创建 run；
3. finding 来源同时写入 `research_run_findings` 的 ID 与可解释快照；
4. 写入稳定 candidates、candidate set hash、`version=1`；
5. 有候选则 run 为 `awaiting-approval`，无候选为 `empty`；
6. 同时保存 topics/queries 快照，返回 `{ runId, candidates: [{ id, ...snapshot }], topics, queries }`。

run/candidate 写入必须位于同一 SQLite transaction。若持久化失败，Research job 失败，不返回不可恢复的临时候选。

## 七、批准 API 与读取 API

### 7.1 读取

```text
GET /api/research-runs/[id]
```

返回：

```ts
interface ResearchRunView {
  id: string;
  researchJobId: string;
  status: ResearchRunStatus;
  version: number;
  findings: ResearchFindingView[];
  candidates: Array<ResearchCandidateSnapshot & {
    id: string;
    decision: 'pending' | 'approved' | 'rejected';
    delivery: ResearchCandidateDeliveryView | null;
  }>;
  approval: ResearchApprovalView | null;
  verificationLintJobId: string | null;
  updatedAt: string;
}
```

允许用 `researchJobId` 查找 run 的 repo/service 辅助方法，便于 Health、backlog 和旧 job 结果恢复；公开路由仍以 run ID 为主。

### 7.2 批准

```text
POST /api/research-runs/[id]/approve
```

请求：

```ts
{
  candidateIds: string[];
  expectedVersion: number;
  idempotencyKey: string;
  subjectId: string;
}
```

原子步骤：

1. 校验请求结构，candidate ID 不得为空、重复或超出上限；
2. 对 selection 做 canonical sort，并用请求中的 runId/version/selection 计算 payload hash；
3. 按 `(runId, idempotencyKey)` 查既有 approval：同 payload hash 直接幂等返回；不同 hash 返回 409；
4. 只有不存在该幂等键时，才校验 run 为 `awaiting-approval`、version 与 Subject 匹配；
5. 重新读取候选并校验全部属于 run；
6. 创建唯一 approval；选中候选标为 `approved`，其余标为 `rejected`；
7. 为选中候选创建 `pending` delivery 行；
8. 创建 `research-import` job，params 只保存 `approvalId / runId / subjectId`；
9. 写入 coordinatorJobId，run 转为 `importing`，version + 1；
10. 返回最新 `ResearchRunView` 和 coordinator job ID。

数据库 claim、approval、delivery 与 coordinator job 必须由同一个 `better-sqlite3` 连接上的 transaction-scoped repo helper 在同一个 `IMMEDIATE` transaction 中完成；不能在事务内调用没有原子性承诺的普通 `queue.enqueue`，避免“已批准但未入队”窗口。

### 7.3 驳回

```text
POST /api/research-runs/[id]/dismiss
```

只允许 `awaiting-approval → dismissed`，原子标记全部 pending candidate 为 rejected 并 version + 1。已批准或已导入的 run 不能通过 dismiss 撤销。

### 7.4 响应语义

| 场景 | HTTP | code/结果 |
|---|---:|---|
| 首次批准 | 202 | run view + coordinatorJobId |
| 同 key 同 payload | 200/202 | 幂等返回现有结果 |
| 同 key 不同 payload | 409 | `RESEARCH_IDEMPOTENCY_CONFLICT` |
| version 陈旧 | 409 | `RESEARCH_RUN_STALE` + 最新 run view |
| 已批准不同 selection | 409 | `RESEARCH_ALREADY_APPROVED` |
| 空选择/未知 candidate | 400 | `RESEARCH_SELECTION_INVALID` |
| 跨 Subject/不存在 | 404 | `RESEARCH_RUN_NOT_FOUND` |

## 八、导入协调与恢复

### 8.1 `research-import` coordinator

新增固定 job 类型 `research-import`，不加入 LLM task router：

1. 按 approvalId 从服务端读取不可变 selection；
2. 对每条可 claim delivery 执行候选级 token/lease CAS，成功者再独立执行 SSRF-safe `fetchUrlSource`；
3. 抓取完成后调用 token-aware 原子 source/job repo：在 token 仍有效时才 get-or-create source、写入 sourceId、创建 child `ingest` job并转为 `queued`；
4. child job params 加入服务端生成的 `researchProvenance: { runId, approvalId, candidateId }`；
5. 单条抓取失败只把该 delivery 标记 failed，继续其他候选；
6. 返回每条 candidate/source/ingestJob 的脱敏调度结果。

重复执行 coordinator 时：

- `completed/queued/running` delivery 不重复抓取或入队；
- 已有 sourceId 但缺 ingestJobId 时从 source 继续原子入队；
- pending/租约过期的 fetching 才可用新 token 重新抓取；旧 token 的任何迟到回写都失败；
- token-aware source repo 复用现有 filename/hash/sidecar 规则，并依赖 source 组合唯一约束收敛并发；
- 已明确 failed 的候选本阶段不自动重试，用户可重新发起 Research，避免绕过原 selection 语义。

coordinator job 在 worker 自动重试耗尽时，终态 hook 把仍处于 `pending/fetching` 的 delivery 标记 failed；已经 queued/running/completed 的 child 继续对账，run 不得永久停留 importing。pending/running coordinator 被 cancel API 原子落为 failed 后，cancel route 立即调用同一终态原语；维护 reconciler 仍扫描 terminal coordinator 作为崩溃补偿。通用 job retry API 对携带 `researchProvenance` 的 failed child Ingest 返回 409，避免验证已开始后重开已终结 delivery；worker 内部终态前的自动 retry 仍按既有策略工作。

### 8.2 delivery 对账

新增幂等 reconciler，在以下时机执行：

- coordinator 结束后；
- 任意 Ingest job 进入终态后；
- worker 启动与基础维护 tick。

`GET /api/research-runs/[id]` 严格只读，只返回已经持久化的 view，不推进状态、不入队、不产生 LLM 成本。若未来需要人工恢复，必须另建 `requireAuth + requireCsrf` 的 POST command；本阶段由 worker 终态 hook 与维护 tick 覆盖恢复。

对账规则：

1. `queued` child job 为 running 时同步为 `running`；
2. child job failed 时物化脱敏错误并标记 delivery failed；
3. child job completed 时物化 source、operation IDs、touched pages 和 commit SHA，再标记 completed；
4. 所有 delivery 终态后：
   - finding run 且至少一条 completed：原子创建一次验证 lint，run → `verifying`；
   - topic run：直接按 delivery 聚合为 `completed/partial/failed`；
   - 全部 failed：run → `failed`，不创建 lint；
5. verification lint 终态后按“精确 ID 或稳定 remediation locus”逐个匹配原 finding，并在同一事务中物化 `verification_status/verified_at/verification_snapshot_json`：
   - 全部消失且无 delivery failure → `completed`；
   - 至少一条成功，但有残留 finding 或 delivery failure → `partial`；
   - lint 失败 → 原 findings 为 `unverifiable`、run `failed`，保留已完成 delivery provenance。

稳定 remediation locus 定义为 `(subjectId, type, pageSlug, sourceId ?? sourceFilename ?? '')`。新 lint 中 exact ID 存在或同 locus 出现改写后的 finding 都视为 residual；只有两者均不存在才视为 fixed。该策略在可能误报时保守保留问题，不能仅因 LLM 改写 description 就误判 fixed。

验证 lint 的创建与 `verification_lint_job_id` 回写必须由专用 repo CAS 完成：在单个 `IMMEDIATE` transaction 内重新检查所有 delivery 终态、确认 `verification_lint_job_id IS NULL`、插入 lint job 并回写其 ID/状态。所有 coordinator、job 终态 hook 与维护 tick 只能调用这一原语；普通 `queue.enqueue` 不能用于该步骤。worker 崩溃后，维护 tick 可以从 delivery/job 终态继续推进，不重复创建 lint。worker 的基础维护顺序固定为：先对账并物化 completed Ingest，再执行 `pruneOldOperations`。

## 九、Health 与 UI

### 9.1 候选对话框

- `ResearchCandidatesDialog` 使用 candidate ID 作为选择键，不再使用 URL；
- 默认勾选规则保持 `score=3`，但提交的是 `{candidateIds, expectedVersion, idempotencyKey}`；
- 确认按钮调用专用 approve API，不再调用通用 `/api/ingest`；
- dismiss 按钮明确调用 dismiss API；普通关闭只关闭 UI，不改变 run；
- 批准成功后显示 coordinator 与每条 child job 状态；部分失败保留成功项和错误摘要；
- run 在 `importing/verifying` 时禁用重复批准；
- 页面刷新后通过 run ID 或 researchJobId 恢复同一 dialog/view。

### 9.2 Health remediation 状态

`remediation-status` 对 Research 改为读取持久化 run：

| run 状态 | `RemediationStatus` |
|---|---|
| `awaiting-approval` | `awaiting-approval` |
| `importing / verifying` | `queued` |
| `completed` | `fixed` |
| `partial / failed` | `failed` |
| `dismissed / empty` | `skipped` |

finding run 的最终状态仍逐 finding 判断：同一 run 可出现某些 finding fixed、另一些 residual；run 级 `partial` 只是批次汇总。旧 Research job 没有 run 时继续使用既有 `resultJson` 兼容判定。

### 9.3 Job 可见性

- `research-import` 注册事件标签和进度展示；
- child Ingest 继续进入全局 JobsPanel；
- run view 返回 coordinator 与 child job ID，UI 不需要猜测任务关系；
- 不新增隐藏的前端轮询协议，复用既有 job stream，并在终态/重连后 GET run 对账。

## 十、错误、幂等与一致性边界

- 批准是批次级不可变事实；导入是候选级独立 delivery，允许部分成功；
- 幂等重放必须先匹配既有 approval 的 key/hash，再检查当前 run version，保证首次批准后的重放仍能返回原结果；
- SQLite transaction 只覆盖 approval claim 与 job 入队等本地原子步骤，网络抓取、文件保存和多个 Ingest Saga 不伪装成 ACID；
- coordinator/对账均以持久化状态推进，任何一步重复执行不得重复批准、重复 child job 或重复验证 lint；
- candidate set hash 防止 Research 重试静默替换已展示候选；
- touched pages 在 child job 完成时尽快物化，避免 operations 保留清理造成链路断裂；
- 若 source 已保存但 child job 入队失败，delivery 保留 sourceId 并由恢复逻辑继续；
- 若 Ingest Git 已提交但 job result 回写不完整，优先从 applied operation 恢复 touched pages 与 postHead；
- 若验证 lint 的 finding ID 算法或快照损坏，对应 finding 为 `unverifiable`，run 为 failed/partial，不凭页面数量推断 fixed。

## 十一、测试策略

严格执行 RED → GREEN → REFACTOR。

### 11.1 纯函数与 repo

- URL 规范化、稳定 candidate ID、candidate set hash、approval payload hash；
- SSRF 守卫：私网/保留地址、混合 DNS、userinfo、DNS pinned connection、public→private redirect、跳数、流式超限；
- selection 排序/去重/未知 ID/空选择；
- run/candidate 原子创建、Research job 崩溃后直接复用完整快照且不重复 LLM/search，以及异常 hash 冲突；
- approval 的 expectedVersion、幂等重放、不同 payload 冲突和并发唯一 claim；
- coordinator job 与 approval/delivery 同事务创建；
- candidate delivery 状态转换、单条失败隔离；
- candidate token/lease claim、续租、过期 reclaim、旧 token 迟到回写拒绝、ingestJobId 唯一；
- touched pages 从 result 与 applied operations 两条路径物化；
- verification lint 唯一入队与终态聚合；
- finding 原始/验证 snapshot 与逐 finding verification 状态在 lint job 不存在后仍可解释；
- Subject 隔离、CHECK、索引、active job 删除/reset 409 与终态清理。

### 11.2 Service 与 worker

- Research 成功先持久化 run/candidates 再完成 job；无候选进入 empty；持久化失败使 job 失败；
- coordinator 只能消费服务端 selection，不接受 job params URL；
- 抓取成功/失败混合、source 去重、崩溃恢复和重复 handler；
- child Ingest 完成/失败触发对账；operations fallback；
- finding run 成功后恰好创建一次 lint；topic run 不创建 lint；
- verification clean/residual/failed 映射；
- worker retry 不产生重复 source/job/approval/lint；coordinator 最终失败能终结未调度 delivery；research child 手动 retry 返回 409。

### 11.3 API

- auth、CSRF、subject required；
- GET/approve/dismiss 正常路径；
- 跨 Subject 统一 404；
- 客户端 URL、错误 candidate、重复 ID、空 selection、陈旧 version 被拒绝；
- 同 idempotency key 同 payload 幂等，不同 payload 409；
- 错误响应不暴露绝对路径、候选正文或配置秘密。

### 11.4 UI 与 remediation

- candidate ID 选择和默认勾选；
- approve body 不含 URL；关闭不 dismiss；
- 刷新恢复 run；批准后不重复提交；
- importing/verifying/completed/partial/failed/empty/dismissed 展示；
- remediation status 新链路与旧 job fallback；
- Subject 切换取消旧请求且不串批次。

### 11.5 全量验收

```bash
npx vitest run
npx tsc --noEmit
npm run lint
npm run build
```

同时确认：

- `llm-config.example.json` 与阶段基线无差异；
- 通用 URL/file/text Ingest 回归通过；
- Research queries/triage 既有测试与配置路由不变；
- 新建库、旧库升级、Subject 删除和 reset 均通过；
- worktree 无意外文件，提交信息为中文一句话。

## 十二、文档同步

实现完成后更新：

- `src/server/services/CLAUDE.md`：Research 持久化、coordinator、对账与验证闭环；
- `src/server/db/CLAUDE.md`：五张 provenance 表、索引与清理顺序；
- `src/server/jobs/CLAUDE.md`：`research-import` 与终态对账；
- `src/app/CLAUDE.md`：Research run 读取/批准/dismiss API；
- `src/components/CLAUDE.md`：候选 ID 审批与刷新恢复；
- `src/lib/CLAUDE.md`：Research run/candidate/approval view 契约；
- 根 `CLAUDE.md`：架构导航、任务类型和测试计数。
