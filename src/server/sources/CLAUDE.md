[根目录](../../../CLAUDE.md) > [src](../../) > [server](../) > **sources**

# `src/server/sources/` — 原始文档摄入

## 模块职责

1. 把用户上传的文件（md / html / pdf / txt）解析为统一的 `ParsedSource`。
2. 将原始内容持久化到 `vault/sources/` 并在 `vault/.llm-wiki/sources/*.json` 记录元数据。
3. 向 ingest 任务提供 `content + 缓冲区` 的访问接口。
4. 为通用 URL Ingest 与 Research 候选导入提供同一套 SSRF-safe 抓取边界。

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
| `.html` / `.htm` | `parsers/html-parser.ts`（turndown 转 md + 抽 title）|
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

getRawSourceContent(sourceId): string | null
getRawSourceBuffer(sourceId): Buffer | null
updateSourcePageLinks(sourceId, pageSlugs)    // 写 page_sources 多对多
updateSourceChunks(sourceId, chunks)          // chunk 持久化到 metadata sidecar
```

### `url-safety.ts` / `url-fetcher.ts`

- 仅允许无 userinfo 的 `http:` / `https:`；拒绝 localhost、`.local`、`.internal`、非公网 IPv4、非 `2000::/3` 公网 IPv6及特殊/文档保留段。
- 每次请求及每一跳重定向都解析全部 DNS 答案；任一地址非公网即拒绝。socket 固定连接首个已验证 IP，HTTPS 仍使用原 hostname 做 SNI 与证书校验，关闭 DNS rebinding 窗口。
- 重定向手动处理，最多 5 跳；全链路共享 10 秒超时，只接受 identity 编码的文本响应，并同时用 `Content-Length` 和流式累计限制 5MB。
- Research coordinator 只从服务端候选快照读取 URL，复用 `fetchUrlSource()`；客户端批准请求不能提交或覆盖 URL。

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

## 常见问题 (FAQ)

- **为什么 sources 要同时存 `.json` 和 SQLite？**
  SQLite 是**可重建缓存**；`vault/.llm-wiki/sources/*.json` 是权威来源，便于 `rebuild.ts` 在数据库丢失后从纯文件恢复。
- **`sourceId` 怎么来？**
  `saveRawSource` 里用 UUID（见 `source-store.ts`），不是 hash。hash 只用来做内容去重。

## 相关文件清单

```
src/server/sources/
├── parser-registry.ts               # 扩展名分发 + ParsedSource 契约
├── source-cleaner.ts                # 按来源预清洗（PDF 清洗链）
├── source-chunker.ts                # 结构感知递归切分器（token 计长）
├── source-store.ts                  # 持久化 + 去重 + page_sources
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
| 2026-07-14 | Phase 2C 收紧 URL 出网边界：逐跳手动重定向、每跳全 DNS 公网校验、固定已验证 IP、防 DNS rebinding，并由通用 URL Ingest 与 Research 候选导入共用；总超时/5MB/文本类型守卫保留 |
| 2026-04-22 | 初始化 |
| 2026-07-03 | Ingest 支持 URL 输入：新增 `url-fetcher.ts`（fetch + 协议/超时10s/5MB 守卫）+ `url-ingest.ts`（validateUrlList≤20 + ingestUrlBatch allSettled 编排）；`src/lib/url-list.ts` 工具（URL 格式化与校验）；`POST /api/ingest` route 加 urls 分支；workbench 加 URL tab；parser-registry / source-store 零改动。|

---

_生成时间：2026-04-22 00:25:29_
