# Research Job：缺口 → 联网研究 → ingest（T3.1）— 设计文档

- 日期：2026-07-07
- 状态：已确认（Nick 批准）
- 范围：新任务类型 `research`（只发现不写入）+ Health 页触发与候选确认 UI + 复用现有 URL ingest 收口

## 背景与问题

lint 能检出 `coverage-gap`（知识覆盖缺口），但 fix 明确不修它——系统能看见"这里缺一块知识"，然后什么也不做；资料获取完全依赖人工投喂。而主动收集所需的零件全部现成：Tavily 搜索/抓取（verifier 在用）、URL 批量 ingest（`POST /api/ingest` urls[] 分支）、缺口检测（lint）。缺的只是一条串联链路。

## 核心决策：research 只发现、不写入，确认后走现成 ingest

```
lint coverage-gap findings（或手动主题）
        │ Health 页 "Research" 按钮 → POST /api/research → 202 jobId
        ▼
  research job（worker）
  1. LLM 生成检索 query（generateObject，无 tools；每 gap 1-2 条，全 job 去重后 ≤3 条）
  2. Tavily 搜索（web-search.ts 现成封装；每 query top-5，全 job 候选去重 ≤12）
  3. LLM 相关性/质量 triage（generateObject：每候选 {score 0-3, reason}；score≥2 保留，最多 6 条）
  4. 候选清单写入 job resultJson.candidates —— 全程零 vault 写入
        ▼
  完成后 Health 页弹候选确认面板（勾选 URL）
        │ 用户确认
        ▼
  POST /api/ingest { urls: 选中项 }   ←— 现有端点零改动
  之后走全部既有流水线与护栏（抓取守卫/保真/curate/embed）
```

**为什么这样切**：
- research job 零写入 → 无需任何新护栏，最坏情况只是浪费几次搜索；
- 确认环节落在"URL 清单"这个天然接缝上，下游复用 `POST /api/ingest` urls[] 批量分支与多任务进度面板，前后端增量都最小；
- 全自动模式（跳过确认）留待后续——等确认模式的候选质量被观察一段时间后再谈。

## 组件明细

### 1. 服务端

- **`services/research-service.ts`**：`runResearchJob(job)`——三阶段如上；两次 LLM 调用均为 `generateObject` 无 tools（沿用 verify triage 的形状与降级思路：query 生成失败→job 失败；单条搜索失败→跳过该 query（`Promise.allSettled`）；triage 失败→降级按搜索排名取前 3 并标注未评分）。
- **LLM 路由**：新增 task key `research:queries`、`research:triage`（`LLMTaskSchema` 的 `<pipeline>:<stage>` 正则已兼容），llm-config.example 加示例路由。prompt 注入 `wikiLanguage` 与 subject 上下文（沿用 PromptContext）。
- **输入**：`POST /api/research`（requireAuth + requireCsrf + resolveSubjectFromRequest required）body：`{ gapIds?: string[], topic?: string }`——二选一；gapIds 引用最近 lint 快照的 coverage-gap findings（服务端重新读取快照校验），topic 为手动自由文本。无 web search 配置 → 422 提示先去设置。入队后 202 + jobId。
- **上限（代码常量，非设置项）**：query ≤3 / 候选 ≤12 / 产出 ≤6；域名黑名单沿用现有 web search 设置（若有），不新增设置项。
- **jobs**：`type:'research'` 注册进 worker（非 ingest 类型 → 独占执行，符合现有调度规则）；事件 `research:queries` / `research:search` / `research:triage`，`use-job-stream` 与 `tool-activity` 注册（图标 🔍）。

### 2. 前端（Health 页）

- coverage-gap 分组处加 "Research this gap"（单条）与顶部 "Research gaps"（全部勾选）入口 → 入队 + 现有 JobsPanel 追踪。
- job 完成后（`GET /api/jobs/[id]` 读 resultJson.candidates）弹 `ResearchCandidatesDialog`：每行 URL/标题/摘要/评分/理由 + 复选框（默认全选 score=3，score=2 不勾）；确认 → 调现有 `POST /api/ingest { urls }` → 复用 URL 模式的逐条结果面板。
- 手动主题入口：Health 页顶部小输入框（"Research a topic…"）——同一 API 的 topic 分支。

### 3. 测试

- 纯函数：query 去重/截断、候选去重（按归一化 URL）、triage 降级排序——抽 `research-plan.ts` 纯函数模块 + 单测。
- service：mock LLM + mock web-search 的三阶段编排测试（含单 query 失败跳过、triage 失败降级）。
- 前端纯函数：候选默认勾选派生。

## 已知取舍

- **确认制而非全自动**：首版人工把关候选质量；全自动（含每日预算/静默入队）等观察数据后另立任务。
- **research 与 lint 快照的时效**：gapIds 引用的快照可能过期（wiki 已变），服务端仅校验 finding 存在即可——研究的是"主题"，轻微过期无害。
- **不做 research_backlog 表**（那是 T3.2 的事）：本任务的候选只活在 job resultJson 里，不落新表、零迁移。
