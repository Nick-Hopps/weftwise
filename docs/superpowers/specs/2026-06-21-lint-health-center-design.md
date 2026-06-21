# Lint 体检中心（Wiki Health Center）设计

> 日期：2026-06-21
> 状态：已确认，待写实现计划
> 关联：特性序列第 ① 项（共 9 项，按价值逐一实现）

---

## 一、背景与动机

后端已有一条完整的两阶段 lint 引擎，但前端**完全没有入口**消费它：

- `POST /api/lint`：入队 `lint` job（默认当前 subject，`{ allSubjects: true }` 全量），结果以 `{ findings: [...] }` 写进 job 的 `result_json`。
- `lint-service.ts` 两阶段：
  - **deterministic**（无 LLM）：`broken-link` / `orphan` / `missing-frontmatter` / `stale-source`
  - **semantic**（LLM）：`contradiction` / `missing-crossref` / `coverage-gap`
- SSE 事件（`lint:scope` / `lint:deterministic:*` / `lint:semantic:*` / `lint:complete`）**已**在 `src/hooks/use-job-stream.ts` 注册，`progress-toast.tsx` 也识别 "Linting"。

对一个由 LLM **自动生成**的 wiki 而言，质量漂移是头号风险。缺的纯粹是「触发 + 展示 + 跳转」这一层 UI。

`LintFinding` 结构（`src/lib/contracts.ts:138`）：

```ts
interface LintFinding {
  type: 'broken-link' | 'orphan' | 'missing-frontmatter' | 'stale-source'
      | 'contradiction' | 'missing-crossref' | 'coverage-gap';
  severity: 'critical' | 'warning' | 'info';
  pageSlug: string;
  description: string;
  suggestedFix: string | null;
}
```

`lint-service.ts` 在返回时给每条 finding 附加了 `subjectId` / `subjectSlug`（用于跨 subject 展示与深链）。

---

## 二、范围（v1）

**只读三联表 + 跳转**。明确**不做**自动修复（自动修复将在特性 ②「页面在线编辑」落地后，以深链进编辑态的方式自然衔接）。

### 已定决策

1. **修复深度**：仅体检 + 跳转。点击 finding 跳到对应页，`suggestedFix` 作为提示文本展示，不提供任何写操作。
2. **入口形态**：新增独立路由 `(app)/health` + 侧边栏入口（带 critical 计数徽标）。
3. **作用域**：默认 = 当前 subject（与全 app 主题模型一致）；页面提供「Scan all subjects」入口（走 `{ allSubjects: true }`，findings 用 subject 标签区分）。
4. **运行策略**：默认展示**上次缓存结果**（读最近一次 completed lint job 的 `result_json`），顶部显示「上次体检时间」+ 手动「Run health check」按钮。**不在进入页面时自动跑**——语义阶段消耗 LLM token。

### 明确不做（YAGNI）

- 自动修复（确定性或 agent）——留到特性 ② 之后。
- findings 历史趋势/对比。
- findings 的忽略/标记已处理状态（无持久化需求）。

---

## 三、架构与数据流

```
[Run health check] ──POST /api/lint──▶ { jobId }
        │                                  │
        │      use-job-stream(SSE) ◀───────┘  lint:deterministic/semantic/complete
        │              │
        ▼              ▼ job:completed
  进度/阶段提示    refetch ──GET /api/lint/latest?subjectId=──▶ { jobId, ranAt, bySeverity, findings[] }
        │                                                              │
        └──────────────────────── 渲染 findings 列表 ◀─────────────────┘
```

- 触发：复用现有 `POST /api/lint`（不改）。
- 进度：复用 `use-job-stream` 已注册的 lint 事件，渲染阶段提示。
- 读取：新增 `GET /api/lint/latest`，返回最近一次结果。
- 侧边栏徽标：复用同一接口的 `bySeverity.critical`。

---

## 四、新增接口

### `GET /api/lint/latest`

唯一新接口。返回当前 subject（或 all）最近一次 **completed** lint job 的结果。

**请求**：
- `?subjectId=<uuid>`（由 `useApiFetch` 自动注入）或 `?s=<slug>`；缺失走 `resolveSubjectFromRequest` 兜底。
- `?allSubjects=1`：取最近一次「全量」lint job（`subjectId === null` 的 job）。

**响应**：

```ts
{
  jobId: string | null;            // 从未跑过为 null
  ranAt: string | null;            // 该 job 的 completedAt
  bySeverity: { critical: number; warning: number; info: number };
  findings: (LintFinding & { subjectId: string; subjectSlug: string })[];
}
```

**实现要点**：
- 读 `GET` 用 `requireAuth`，无需 CSRF（只读）。
- 通过 jobs-repo 查 `type='lint' AND status='completed'`，按 `completedAt` 倒序取第一条；subject-scoped 时 `subjectId = 解析出的 subject.id`，all 时 `subjectId IS NULL`。
- 解析其 `resultJson.findings`；为空/无 job 返回空结构。
- `bySeverity` 由 findings 即时统计（不依赖 emit 时的快照）。

> 选型理由：相比客户端「`GET /api/jobs?type=lint` 列表 + `GET /api/jobs/[id]` 取详情」两连发，薄接口把「取最近 findings」逻辑收口服务端，并让侧边栏徽标与页面共用同一数据源。

---

## 五、新增 / 改动文件

| 文件 | 类型 | 职责 |
|------|------|------|
| `src/app/api/lint/latest/route.ts` | 新增 | GET 最近 findings（含 bySeverity 计数） |
| `src/app/(app)/health/page.tsx` | 新增 | Server Component 壳，渲染 `<HealthView/>` |
| `src/components/health/health-view.tsx` | 新增 | client：顶栏（subject / 上次时间 / Run 按钮 / all-subjects 切换）+ 概要计数条 + findings 列表 + 空态 + 运行态 |
| `src/components/health/finding-row.tsx` | 新增 | 单条 finding：类型图标 + severity chip + 页面深链 + description + suggestedFix（弱化展示） |
| `src/components/health/lint-findings.ts` | 新增 | **纯函数**：`sortFindings` / `groupBySeverity` / `findingHref` —— TDD 目标 |
| `src/hooks/use-lint-summary.ts` | 新增 | React Query 包 `/api/lint/latest`，供侧边栏徽标 + 页面共用 |
| `src/components/layout/sidebar.tsx` | 改动 | footer 加「Health」入口（`<Link href="/health">` + critical 计数徽标） |

---

## 六、纯函数契约（`lint-findings.ts`）

```ts
type EnrichedFinding = LintFinding & { subjectId: string; subjectSlug: string };

// 排序：severity 优先级 critical(0) < warning(1) < info(2)，同级按 type 字母序，再按 pageSlug
function sortFindings(findings: EnrichedFinding[]): EnrichedFinding[];

// 按 severity 分组，返回固定顺序 [critical, warning, info]，每组内已排序
function groupBySeverity(findings: EnrichedFinding[]): {
  severity: 'critical' | 'warning' | 'info';
  findings: EnrichedFinding[];
}[];

// 深链：可点击页面返回 /wiki/<pageSlug>?s=<subjectSlug>；
// coverage-gap（建议的新页，尚不存在）返回 null —— 不可点击，UI 标「suggested page」
function findingHref(f: EnrichedFinding): string | null;
```

---

## 七、UI 行为与状态

`health-view.tsx` 的状态机：

- **never-run**（`jobId === null` 且未在跑）：空态卡片「Never run a health check for this subject.」+ 「Run now」按钮。
- **idle-with-results**：展示概要计数条 + 分组 findings 列表；顶部「Last checked: <ranAt>」+ 「Re-run」按钮。
- **running**（已触发、job 未完成）：禁用 Run 按钮，展示阶段进度（来自 use-job-stream 的 deterministic/semantic 事件）。
- **completed → refetch**：job 完成后失效 `/api/lint/latest` query 并重取，回到 idle-with-results。

finding 列表：
- 按 severity 分组（critical → warning → info），组内 `sortFindings`。
- 顶部 type 过滤 chips（7 类）+ severity 过滤；纯客户端过滤。
- 每条：类型图标 + severity chip + 页面链接（`findingHref` 为 null 时纯文本 + 「suggested page」标签）+ description + suggestedFix（弱化）。
- all-subjects 视图额外显示 subjectSlug 标签。

---

## 八、边界处理

- **coverage-gap 的 pageSlug** 可能是建议的新页（尚不存在）→ `findingHref` 返回 null，不可点击。
- **语义阶段失败**（无 LLM / LLM 报错）：service 已 emit `lint:semantic:error` 并继续返回 deterministic findings，job 仍 completed → 页面顶部显示黄条「语义检查未完成，仅展示确定性结果」，照常展示确定性 findings。
- **作用域切换**：current ↔ all-subjects 切换时，分别读各自最近一次 job；徽标始终基于当前 subject。
- **首次进入**：从未跑过任何 lint → never-run 空态。

---

## 九、测试（node-only，无 RTL）

TDD 目标限定在路由 handler 与纯函数：

1. **`lint-findings.ts` 纯函数**
   - `sortFindings`：critical→warning→info 顺序；同级按 type→pageSlug。
   - `groupBySeverity`：固定三组顺序；空输入；某 severity 缺失时该组为空数组。
   - `findingHref`：常规 finding 返回 `/wiki/<slug>?s=<subjectSlug>`；coverage-gap 返回 null。
2. **`GET /api/lint/latest`**
   - 无历史 job → `{ jobId:null, findings:[] }`。
   - 多次 completed job → 取 `completedAt` 最近一条。
   - `bySeverity` 计数与 findings 一致。
   - subject-scoped vs `allSubjects=1`（`subjectId IS NULL`）取不同 job。
   - 忽略非 completed（running/failed）job。

React 组件不写单测（项目无 DOM 测试环境）；交互正确性通过实跑验收（启动 dev:all → 触发体检 → 观察列表/跳转）。

---

## 十、不变量与依赖

- 不改 `POST /api/lint`、`lint-service` 及其两阶段实现。
- 复用 `resolveSubjectFromRequest`、`useApiFetch`、`use-job-stream`、`components/ui/*` 设计系统原语。
- 深链遵循既有跨主题风格 `/wiki/<slug>?s=<subjectSlug>`（见 `markdown-client.ts:87`）。
- 侧边栏徽标只读，不引入新 Zustand 状态。
