# Ingest 支持 URL 作为输入 — 设计文档

- 日期：2026-07-03
- 状态：已确认

## 目标

用户在 ingest 入口粘贴一个或多个网页 URL，系统抓取网页正文并走现有 ingest 流水线生成/合并 wiki 页面。

## 已确认的决策

| 决策点 | 结论 |
|--------|------|
| 抓取方式 | 服务端直接 `fetch` + 复用现有 turndown html-parser；不依赖 Tavily 配置 |
| 抓取时机 | `POST /api/ingest` 路由内同步抓取，抓完落盘再入队；用户立刻得到可达性反馈 |
| 范围 | 支持多行批量 URL；每个成功 URL 独立入队一个 ingest job |
| 不做 | JS 渲染 SPA 抓取、登录态抓取、SSRF 私网黑名单（单租户本地应用） |

## 架构

核心取巧点：抓到的 HTML 存成 `.html` 后缀的 raw source，现有 `parser-registry`（turndown html-parser）自动接管，**ingest 流水线（planner/writer/enricher/verify/indexer）零改动**。

```
前端 URL textarea（每行一个）
  → POST /api/ingest { urls: string[] }
      → 逐 URL fetchUrlSource()（Promise.allSettled）
      → 成功：saveRawSource(subject, filename, content)（hash 去重幂等）
              + queue.enqueue('ingest', { sourceId, filename, subjectId })
      → 202 + results: [{ url, jobId?, sourceId?, error? }]
  → 前端对每个 jobId 用现有 SSE toast 追踪
```

## 组件

### 1. `src/server/sources/url-fetcher.ts`（新）

```ts
fetchUrlSource(url: string): Promise<{ filename: string; content: string }>
```

- 守卫：仅允许 `http:`/`https:` 协议；超时 10s（AbortController）；响应体 ≤ 5MB（超限报错）；跟随重定向。
- Content-Type 分派：`text/html` → 保存为 `.html`（原样 HTML，交给现有 html-parser）；`text/markdown` → `.md`；其他 `text/*` 与 `application/json` 之外的文本 → `.txt`；非文本类型报错拒绝。
- 文件名从 URL 派生（复用/对齐 ⑨ `ingest-service.ts` 已有的 `filenameFromUrl` 纯函数，含长度截断与非法字符清洗）。
- 可测纯逻辑（协议校验、content-type 分派、文件名派生）与 fetch 壳分离。

### 2. `POST /api/ingest` 扩展

JSON 分支新增 `urls?: string[]`，与 `text` 互斥（同时给报 400）：

- 校验：非空数组、每项为合法 `http(s)` URL、去重、上限 20 条。
- 逐 URL `Promise.allSettled(fetchUrlSource)`；每个成功项 `saveRawSource` + 独立 `enqueue('ingest', ...)`。原始 URL 记入 source metadata（与 ⑨ 网页源导入的溯源方式一致）。
- 响应：至少一个成功 → 202 + `results` 数组（成功项含 `jobId`/`sourceId`，失败项含 `error`）；全部失败 → 422 + `results`。
- 既有 file/text 分支行为完全不变（响应形状保持向后兼容：单文件仍返回 `{ jobId, sourceId, ... }` 顶层字段）。

### 3. 前端：Dashboard ingest panel

- 加 "URL" 输入模式（与现有 file/text 并列）：多行 textarea，每行一个 URL；提交前 trim/去空行/去重/校验 `https?://` 前缀。
- 提交后按返回 `results` 渲染：成功项各自挂现有 SSE job 追踪（ProgressToast）；失败项内联列出 `url + error`。

## 错误处理

| 场景 | 行为 |
|------|------|
| URL 不可达 / 超时 / 非 2xx | 该 URL 在 `results` 中标记 error，不影响其他 URL |
| 非文本 Content-Type（图片/二进制） | 拒绝并报错说明类型 |
| 响应体超 5MB | 拒绝并报错 |
| 同一 URL 内容重复提交 | `saveRawSource` hash 去重幂等，仍入队（与现有同文件重传行为一致） |
| 全部 URL 失败 | 422，前端整体报错并列明细 |

## 测试

- `url-fetcher`：协议守卫、content-type → 扩展名分派、文件名派生、超时/超限错误路径（fetch 打桩）。
- `/api/ingest` urls 分支：校验（空数组/非法 URL/与 text 互斥/超上限）、部分失败 202、全部失败 422（fetchUrlSource 打桩）。
