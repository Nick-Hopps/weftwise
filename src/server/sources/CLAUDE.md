[根目录](../../../CLAUDE.md) > [src](../../) > [server](../) > **sources**

# `src/server/sources/` — 文件与 URL Source 摄入

## 模块职责

1. 把用户上传的文件（md / html / pdf / txt）解析为统一的 `ParsedSource`。
2. 将上传文件持久化到 `vault/raw/<subject>/`，并在 `vault/.llm-wiki/sources/<subject>/*.json` 记录元数据。
3. 将网页保存为只含规范化地址的 URL 引用实体，不下载或持久化 raw HTML。
4. 在 ingest worker 执行时按 Source 类型加载内容；URL 通过统一 SSRF-safe 边界临时抓取并解析。

## 入口与启动

被 `/api/ingest` Route Handler 和 `services/ingest-service.ts` 调用，无独立进程。

## 对外接口

### `parser-registry.ts`

```ts
interface ParsedSource {
  title: string;                    // 文件首行 / H1 / PDF metadata
  cleanText: string;                // 经清洗的纯文本（用于喂 LLM）
  metadata: Record<string, unknown>;
}

parseSource(filename, content): ParsedSource         // 同步；md/html/txt
parseSourceAsync(filename, content, buffer?): Promise<ParsedSource>
                                                     // pdf 需要 buffer
requiresBuffer(filename): boolean                    // 是否 PDF
```

扩展名分发：

| 扩展名 | 解析器 |
|--------|--------|
| `.md` / `.mdx` | `parsers/markdown-parser.ts`（remark + gray-matter 提取首 H1 与纯文本） |
| `.html` / `.htm` | `parsers/html-parser.ts`（turndown 转 md + 抽 title/description，含 OG/Twitter 回退与 entity 解码）|
| `.pdf` | `parsers/pdf-parser.ts`（pdf-parse 提取文本 + metadata） |
| `.txt` / 其它 | 默认分支（首行为 title） |

### `source-cleaner.ts`

```ts
cleanSourceText(raw: string, kind: CleanerKind): string   // kind: 'markdown' | 'text' | 'pdf'
cleanerKindFor(filename: string): CleanerKind
```

### `source-chunker.ts`

```ts
chunkText(cleanText: string, kind: SourceKind, opts?): SourceChunk[]   // kind: 'markdown' | 'plain'
countTokens(text: string): number
sourceKindFor(filename: string): SourceKind
```

### `source-store.ts`

```ts
saveRawSource(filename, content: string | Buffer): { id: string }
  // 1. 按内容 hash 去重（命中则直接返回已有 id）
  // 2. 写 vault/sources/<id>-<filename>
  // 3. upsert sources 表（见 db/repos/sources-repo）
  // 4. 写 vault/.llm-wiki/sources/<id>.json

saveUrlSource(url): { id: string; filename: string; originUrl: string }
  // 1. 校验并规范化 http(s) URL
  // 2. 按 subject + URL 身份去重
  // 3. upsert sources 表并只写 kind=url/originUrl sidecar
  // 4. 不创建 vault/raw 下的 HTML 文件

getRawSourceContent(sourceId): string | null
getRawSourceBuffer(sourceId): Buffer | null
updateSourcePageLinks(sourceId, pageSlugs)    // 写 page_sources 多对多
updateSourceChunks(sourceId, chunks)          // chunk 持久化到 metadata sidecar
updateUrlSourcePresentation(sourceId, metadata) // 网页标题/描述写回 sidecar + SQLite cache
```

### `url-source.ts` / `source-loader.ts`

- `url-source.ts` 是 URL Source 身份与兼容读取的唯一入口；新 sidecar 写 `kind:'url' + originUrl`，历史仅有 `originUrl` 的 sidecar 仍按 URL Source 读取。
- `source-loader.ts` 是 Ingest 内容加载边界：raw Source 读 vault 文件；URL Source 调 `fetchUrlSource()`，将响应只保留在 worker 内存中并交给 HTML parser 生成 `cleanText`。
- URL loader 同时返回真实网页标题与描述；Ingest handler 通过 `updateUrlSourcePresentation` 写回 sidecar 与 SQLite。左侧列表只读取已持久化字段，不因渲染列表额外联网。
- URL 身份按规范化地址确定，不按抓取内容 hash；同一 Subject 重复提交同一地址复用 source。

### `url-safety.ts` / `url-fetcher.ts`

- 仅允许无 userinfo 的 `http:` / `https:`；拒绝 localhost、`.local`、`.internal`、非公网 IPv4、非 `2000::/3` 公网 IPv6及特殊/文档保留段。
- 每次请求及每一跳重定向都解析全部 DNS 答案；任一地址非公网即拒绝。socket 固定连接首个已验证 IP，HTTPS 仍使用原 hostname 做 SNI 与证书校验，关闭 DNS rebinding 窗口。
- 重定向手动处理，最多 5 跳；全链路共享 10 秒超时，只接受 identity 编码的文本响应，并同时用 `Content-Length` 和流式累计限制 5MB。
- 通用 URL Ingest 与 Research coordinator 只保存服务端校验后的 URL 引用；Research 客户端批准请求不能提交或覆盖 URL。
- 真正出网只发生在 child Ingest worker 的 `source-loader`，复用 `fetchUrlSource()` 的逐跳 SSRF 防护。
- Source 预览直接在浏览器 sandbox iframe 中加载原地址，因此可能被目标站点的 `X-Frame-Options` / CSP `frame-ancestors`、混合内容策略或登录态限制拦截；默认脚本关闭，显式开启后也不授予 `allow-same-origin`。

## 关键依赖与配置

- `pdf-parse` —— PDF 二进制解析（只能在 Node 环境运行；Route Handler 必须 `runtime='nodejs'`）。
- `turndown` —— HTML → Markdown 转换。
- `gray-matter` —— markdown frontmatter（与 `wiki/frontmatter.ts` 共用）。
- `remark` / `unified` —— markdown AST 解析，用于提取首个 H1 作为 title 兜底。

## 扩展指南

- **支持新格式**（如 `.docx`）：
  1. 在 `parsers/` 新建 `docx-parser.ts`，导出 `parseDocx(filename, buffer): ParsedSource`；
  2. 在 `parser-registry.ts::parseSourceAsync` 的 switch 里加 case；
  3. 若是二进制格式，在 `requiresBuffer` 里返回 `true`；
  4. 在 `/api/ingest` 没有硬编码格式白名单，自动生效。
- **清洗策略**：
  - 全部 parser 都应返回"无 HTML / 无多余空白"的 `cleanText`，方便 LLM 处理。
  - `metadata` 字段用于保留原格式特有信息（PDF 页数、HTML meta、frontmatter tags 等）。

## 测试与质量

建议：

- `parseMarkdown` 对 frontmatter / 无 frontmatter / 无 H1 的三种情况返回正确 title。
- `parseHtml` 去除 `<script>` / `<style>` 后的内容。
- `parsePdfBuffer` 处理损坏/空 PDF 的错误路径。
- `saveRawSource` 的 hash 去重幂等性。
- `saveUrlSource` 不写 raw 文件、同 URL 去重和历史 sidecar 兼容。
- `source-loader` 的 raw/URL 分流与 URL worker 抓取。

## 常见问题 (FAQ)

- **为什么 sources 要同时存 `.json` 和 SQLite？**
  SQLite 是**可重建缓存**；`vault/.llm-wiki/sources/*.json` 是权威来源，便于 `rebuild.ts` 在数据库丢失后从纯文件恢复。
- **`sourceId` 怎么来？**
  上传文件的 `saveRawSource` 使用 UUID，内容 hash 只做去重；URL Source 使用规范化 URL 的确定性身份 hash，避免同一链接重复创建。
- **网页预览为什么可能是空白或报拒绝连接？**
  预览尊重目标站点自己的嵌入策略；站点若设置 `X-Frame-Options` / `frame-ancestors`，或 HTTPS 应用尝试嵌入 HTTP 页面，浏览器会拒绝加载。此时使用 “Open original” 在新标签页打开。

## 相关文件清单

```
src/server/sources/
├── parser-registry.ts               # 扩展名分发 + ParsedSource 契约
├── source-cleaner.ts                # 按来源预清洗（PDF 清洗链）
├── source-chunker.ts                # 结构感知递归切分器（token 计长）
├── source-store.ts                  # 持久化 + 去重 + page_sources
├── source-loader.ts                 # worker 侧 raw/URL 内容加载边界
├── url-source.ts                    # URL 身份、规范化与 sidecar 兼容读取
├── url-safety.ts                    # URL/DNS/IP 公网判定与固定目标解析
├── url-fetcher.ts                   # 逐跳 SSRF 校验 + IP 固定 + 超时/5MB/content-type 守卫
├── url-ingest.ts                    # URL 列表校验 ≤20 + allSettled 编排
└── parsers/
    ├── markdown-parser.ts
    ├── html-parser.ts               # turndown
    └── pdf-parser.ts                # pdf-parse
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-07-20 | URL Source 改为链接型实体：只持久化规范化 URL sidecar，不落 raw HTML；Ingest worker 通过 `source-loader` 临时抓取解析并写回网页标题/描述；历史 `originUrl` sidecar 自动兼容，预览直接加载原网页 sandbox |
| 2026-07-14 | Phase 2C 收紧 URL 出网边界：逐跳手动重定向、每跳全 DNS 公网校验、固定已验证 IP、防 DNS rebinding，并由通用 URL Ingest 与 Research 候选导入共用；总超时/5MB/文本类型守卫保留 |
| 2026-04-22 | 初始化 |
| 2026-07-03 | Ingest 支持 URL 输入：新增 `url-fetcher.ts`（fetch + 协议/超时10s/5MB 守卫）+ `url-ingest.ts`（validateUrlList≤20 + ingestUrlBatch allSettled 编排）；`src/lib/url-list.ts` 工具（URL 格式化与校验）；`POST /api/ingest` route 加 urls 分支；workbench 加 URL tab；parser-registry / source-store 零改动。|

---

_生成时间：2026-04-22 00:25:29_
