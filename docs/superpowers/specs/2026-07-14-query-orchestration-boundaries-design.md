# Query 编排边界设计

日期：2026-07-14  
状态：已完成

## 一、目标

补齐 Query agentic 流式与非流式路径的失败/空结果边界，使一次请求只能以“成功回答”或“错误”之一收口，不能同时发出错误事件又持久化为成功会话。

## 二、现状问题

`POST /api/query` 当前遍历 `answerStream.fullStream` 时，遇到 `part.type === 'error'` 只发送 SSE `error`，随后仍会：

1. 把空文本回落为 `NO_QUERY_CONTEXT_ANSWER`；
2. 提取并发送 citations；
3. 持久化 user/assistant 会话；
4. 发送 `done`；
5. 触发 coverage assessment。

这使同一次流同时呈现失败与成功两个终态，并可能把工具基础设施故障误记录成知识库 coverage gap。

## 三、终态契约

### 3.1 成功

- active Subject 为空不短路，仍允许工具循环执行跨 Subject 检索；
- 流正常结束且有文本：发送 answer delta → citations → done，持久化会话并异步评估 coverage；
- 流正常结束但文本为空：使用 `NO_QUERY_CONTEXT_ANSWER` 作为成功回落，再执行同一成功收口；
- 非流式 `runQuery` 同样只在模型调用成功后执行空答案回落、citation 与 coverage。

### 3.2 失败

- `fullStream` 产生 `error` part、迭代器抛错或 `streamAgenticQuery` 初始化抛错，统一只发送一次 SSE `error`；
- 失败后不发送 fallback answer、citations 或 `done`；
- 不持久化 user/assistant turn，不 touch conversation；
- 不触发 coverage assessment；
- 已经发送到客户端的 partial text 不回滚，但不得作为完整回答落库；
- 非流式 `runQuery` 的工具/模型失败原样抛出，并跳过 citation 与 coverage。

客户端仍以连接关闭结束本次 SSE；本期不新增独立 `failed` 事件，保持既有协议兼容。

## 四、范围

- 修改 `src/app/api/query/route.ts` 的流错误收口；
- 补充 Route 与 `query-service` 编排测试；
- 更新 App/Services 模块文档与测试基线；
- 不修改工具 profile、prompt、数据库、LLM task 或 `llm-config.example.json`。

## 五、验收

1. 空库仍进入工具循环；
2. 正常空流只产生 fallback 成功终态；
3. `error` part 与迭代器异常只产生错误终态；
4. 失败路径没有 citations/done/持久化/coverage；
5. 非流式工具调用失败不被转成空答案；
6. 全量 Vitest、TypeScript、ESLint 与生产构建通过。
