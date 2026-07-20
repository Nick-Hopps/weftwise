# Spec：URL Source 阅读模式回退

日期：2026-07-20
状态：已定稿

## 背景与问题

URL Source 当前在阅读页 Sources 分栏和独立 Source 页中直接用 sandbox iframe 加载
原网页。这样能保留原站资源基址和样式，但目标站点若通过 CSP `frame-ancestors` 或
`X-Frame-Options` 禁止第三方嵌入，浏览器会直接拦截；应用自身无法放宽目标站策略。

现有“打开原网页”适合需要原站交互的场景，但会离开当前阅读上下文。URL ingest 已经
把网页转换成清洗后的 Markdown 并持久化 chunks，因此应用具备提供本地只读回退的基础。

## 目的

- URL Source 提供“实时网页 / 阅读模式”两个视图，默认保持实时网页。
- 阅读模式完全使用摄入时持久化的清洗正文，不在预览请求中重新联网。
- 新 URL Source 保存无 chunk overlap 的有界阅读正文；旧 Source 无需重摄入即可从已有
  chunks 回退重建。
- 两个 Source 入口复用同一个视图组件，交互和渲染保持一致。

## 约束与成功标准

- 不绕过或代理目标站的 CSP / `X-Frame-Options`。
- 不把远程 HTML、脚本或样式注入应用；阅读模式只渲染 Turndown 生成的 Markdown。
- 客户端正文上限沿用 Source 预览的 120K 字符限制，并明确提示截断。
- iframe 不可嵌入时用户可在原位置切换到阅读模式；“打开原网页”继续保留。
- 本地上传 HTML、PDF、Markdown、Text 的既有预览行为不变。

## 方案取舍

### 方案 A：直接拼接既有 chunks

改动最小，但 chunks 含约 120 token overlap，段落会重复；展示质量不可接受。

### 方案 B：持久化阅读正文 + 旧 chunks 去重回退（推荐）

worker 抓取并解析 URL 后，在 sidecar 额外写入最多 120K 字符的 `readerText` 与截断标记；
读取旧 sidecar 时，对相邻 chunks 的“前缀 = 已有正文后缀”重叠做有界去重后重建。

优点：新数据无重复、旧数据立即可用、预览不联网；缺点：sidecar 会多保存一份有界正文，
旧数据重建只能 best-effort。

### 方案 C：切换阅读模式时服务端重新抓取网页

可取得最新正文，但会让只读预览产生网络副作用，并重新引入 SSRF、登录态、超时和内容漂移，
不采用。

## 数据与服务端设计

URL Source sidecar 新增可选字段：

```ts
interface UrlSourceReaderMetadata {
  readerText?: string;
  readerTextTruncated?: boolean;
}
```

- `updateUrlSourceReaderText(sourceId, cleanText)` 在 URL 解析成功后 best-effort 写 sidecar；
  只保存前 120K 字符，不同步到 SQLite metadata cache，避免扩大数据库记录。
- `readUrlSourceReaderContent(sourceId)` 优先读取 `readerText`；旧 sidecar 回退到 chunks。
- chunks 回退只消除至少 24 字符、最多 4K 字符的精确相邻重叠，避免把普通短词重复误判
  为 chunk overlap；结果再次执行 120K 上限。
- `PageSourceDoc.text` 扩展为 URL 阅读模式正文，新增 `readerTextTruncated?`。

## 客户端设计

新增共享 `UrlSourcePreview`：

- 顶部使用既有 Tabs 原语展示“实时网页 / 阅读模式”，默认选中实时网页。
- 实时网页继续复用 `HtmlSourceFrame`，保留 sandbox、`no-referrer` 和脚本确认边界。
- 阅读模式用既有 Markdown renderer 渲染本地正文；无正文时展示明确空态。
- 独立 Source 页和 Wiki Sources 分栏都复用该组件。
- 浏览器不会稳定暴露跨域 iframe 的 CSP 加载失败，因此不做不可靠的自动切换；用户显式
  切换，且两个入口始终可见。

## 非目标

- 自动识别所有 iframe 嵌入失败。
- 保存原始 HTML 快照或递归下载网页资源。
- 还原原站视觉、脚本、表单、登录态或其他交互。
