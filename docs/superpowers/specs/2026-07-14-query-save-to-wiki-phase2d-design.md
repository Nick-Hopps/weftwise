# Query Save-to-Wiki Phase 2D 设计

## 一、背景

工具与工作流治理总设计的 Phase 2 第 5 项要求统一 Ask AI 的“保存到 Wiki”与 `wiki.create` 页面创建路径。当前两条路径已经出现可观察漂移：

- `wiki.create` 通过 `page-operation-plan::planPageCreate` 生成唯一 slug，再通过 `applyPlannedPageOperation` 执行；
- `saveQueryAsPage` 自行派生 slug、拼 frontmatter、构造 changeset 并 apply；
- 同名页面存在时，`wiki.create` 使用数字后缀，`save-to-wiki` 直接失败；
- `save-to-wiki` 把页面 citation slug 写入 `frontmatter.sources`，混淆页面引用与 raw source ID；
- `wiki.create` 的 service command 在写后入队 embedding，`save-to-wiki` 没有回填；
- `save-to-wiki` 的 operation 必须继续关联真实 job ID，不能因为复用同步 command 而退化为随机 ID。

Phase 2D 只收敛创建内核和 Query 保存语义，不改变 Query 工具授权边界，也不把按钮动作改造成模型发起的 PendingAction。

## 二、目标

1. `save-to-wiki` 与 `wiki.create` 共用同一个 service create command，以及同一套 create plan/apply 内核。
2. 两条路径统一使用 `deriveUniqueSlug` 的数字后缀冲突策略。
3. Query 保存继续保留 `query-answer` 标签和正文 `References` 模板。
4. 页面 citation 只存在于正文 wikilink，不写入 raw source 专用的 `frontmatter.sources`。
5. 创建成功后统一入队一次 embedding 回填。
6. `save-to-wiki` changeset/operation 继续记录真实 job ID，History 仍能显示正确 job 类型。
7. worker 重试时，如果同一 job 已经完成 create operation，则恢复既有结果，不再创建后缀重复页，并补做 embedding 入队。

## 三、非目标

- 不新增或修改 LLM task、prompt、模型路由。
- 不改变 `wiki.create` 的 ToolProfile、Guard 或 Query read/propose 工具面。
- 不把 Save to Wiki 按钮改为 PendingAction；按钮点击已经是用户对确定内容的显式保存命令。
- 不给 page create 输入增加任意 raw source ID 写权限。
- 不改变 References 的展示文案或 Chat 主交互。
- 不为全部 job 类型建立通用幂等执行框架；只补齐本阶段触达的 save-to-wiki 恢复窗口。

## 四、授权与语义边界

### 4.1 Query 写权限边界不变

模型驱动的 Query 仍只能持有 read/propose 工具。模型请求 `wiki.create` 时仍必须生成 PendingAction，并由批准 API 重算 plan 后 apply。

Save to Wiki 按钮由用户在现有回答下直接点击，保存 payload 是当前回答、标题和服务端已经返回的 citations。该动作可以继续入队 `save-to-wiki` job，不需要再套一层 PendingAction；服务端仍必须执行 auth、CSRF、Subject 解析和 job capability 约束。

### 4.2 citation 与 raw source 分离

- 页面 citation：`{ pageSlug, excerpt }`，写入正文 `## References`，形成普通 wikilink。
- raw source：由 Ingest provenance 建立的 source 实体与 `page_sources` 关系；其 ID 才能进入 raw source 语义。
- Phase 2D 的 create planner 保持 `sources: []`，Query 保存不得把页面 slug 填入该字段。

## 五、设计

### 5.1 共享 create command

`src/server/services/page-write.ts::createPageInSubject` 扩展可选执行上下文：

```ts
interface CreatePageCommandOptions {
  jobId?: string;
}
```

command 的固定流程：

```text
校验并 trim title
  → executePageCreate(jobId ?? crypto.randomUUID(), subject, input)
  → planPageCreate
  → applyPlannedPageOperation
  → enqueueEmbedIndex(subject.id)
  → 返回真实 createdSlug
```

同步工具调用不传 `jobId`，保持现有行为；worker 调用传真实 job ID，使 operation 与 jobs 表正确关联。

`page-operation-plan::planPageCreate` 仍是唯一 slug/frontmatter/changeset 规划源。Query service 不再 import `pages-repo`、`wiki-transaction`、`page-identity` 或 `frontmatter` 来创建页面。

### 5.2 Query 保存正文

`saveQueryAsPage` 只保留 Query 专属的确定性组装：

```text
answer

## References

- [[page-slug]]: excerpt
```

然后调用共享 command：

```ts
createPageInSubject(
  subject,
  { title, body, tags: ['query-answer'] },
  { jobId },
)
```

共享 planner 负责：

- title 派生唯一 slug；
- 系统时间戳；
- `sources: []`；
- wikilink 校验；
- mutation epoch、vault HEAD 与 Saga；
- embedding 入队。

### 5.3 save-to-wiki 重试恢复

worker 可能在页面 commit 后、job complete 前退出。若直接重跑 create planner，会因为唯一 slug 规则创建第二页。

`saveQueryAsPage` 在新建前按 `(jobId, subjectId)` 查询已应用 operations：

1. 没有 applied operation：正常调用共享 create command。
2. 恰有一个符合当前 Subject 的 create entry：解析其 path，确认页面仍存在，返回该 slug，并补入队 embedding。
3. operation 数据损坏、包含不明确的多个 create，或目标页已经不存在：拒绝猜测，抛出稳定错误，由 job 失败并保留审计证据。

恢复逻辑必须只相信服务端 operation 记录和 canonical wiki path，不能从客户端 title 推断 slug。

### 5.4 API 与 UI

`POST /api/query` 两个既有保存入口保持兼容：

- 仅保存已有回答：返回 202 + `jobId`；
- 一次性 query + 保存：先得到回答，再返回 `saveJobId`。

Route 继续只入队，不同步写 vault。`save:complete` 和 job result 返回 planner 生成的真实 slug。Chat 的 Save to Wiki 按钮继续派发 `wiki:job-started`，全局任务面板在完成后失效页面查询。

本阶段不再让客户端以 `normalizeSlug(title)` 作为权威结果；没有实际消费者的 `onSaved` 猜测接口应删除，避免后缀冲突时传播错误 slug。

## 六、失败与恢复

- title 为空：共享 command 在任何写入前拒绝。
- References 含不存在 wikilink：沿用 create planner 的 unresolved link 校验，job 失败且不落盘。
- Subject reset/delete 与 plan 并发：沿用 mutation epoch 和 vault mutex 拒绝旧计划。
- apply 失败：沿用 Saga rollback。
- apply 成功、embedding 入队失败：job 重试从 applied operation 恢复真实 slug，并再次入队 embedding，不重复创建页面。
- operation 恢复证据不唯一：失败，不根据 title 或最新页面猜测。

## 七、测试策略

### 7.1 Shared create command

- 默认调用生成随机 operation job ID；
- 显式 `jobId` 原样传入 `executePageCreate`；
- title trim、body 默认值、tags 保持；
- 成功后 embedding 恰入队一次；失败不入队。

### 7.2 Query save

- 正文保留 answer 和 References；
- 调用 shared command 时含 `query-answer`，不传 `sources`；
- shared command 返回冲突后缀 slug 时原样返回；
- 新建路径不再直接调用 changeset/frontmatter API；
- 已应用 job 从 operation 恢复 slug，不重复调用 create command，并补入队 embedding；
- 损坏或歧义 operation 明确失败。

### 7.3 Route 与回归

- save-only 与 query+save 都仅入队 subject-scoped `save-to-wiki` job；
- auth、CSRF、Subject 与输入校验回归；
- `wiki.create`、PendingAction create、History、embedding 回归；
- 全量 Vitest、TypeScript、ESLint、Next build 通过。

## 八、配置影响

Phase 2D 没有新增 LLM 调用，也没有改变 `query` 或 `embedding` 的路由方式。`llm-config.example.json` 必须与基线无差异。

## 九、验收标准

1. `saveQueryAsPage` 不再自行构造 frontmatter、changeset 或 slug。
2. 同名保存返回与 `wiki.create` 一致的数字后缀 slug。
3. 保存页含 `query-answer` 和 References，且 `frontmatter.sources` 为空。
4. 保存成功入队 embedding；写失败不入队。
5. operation 的 `job_id` 是真实 `save-to-wiki` job ID。
6. 已提交但未 complete 的 job 重试不会创建重复页面。
7. Query profile 仍不包含真实写工具，PendingAction create 行为不变。
8. `llm-config.example.json` 无变更。
