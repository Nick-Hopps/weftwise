[根目录](../../../CLAUDE.md) > [src](../../) > [server](../) > **sources**

# `src/server/sources/` — 原始文档摄入

## 模块职责

1. 把用户上传的文件（md / html / pdf / txt）解析为统一的 `ParsedSource`。
2. 将原始内容持久化到 `vault/sources/` 并在 `vault/.llm-wiki/sources/*.json` 记录元数据。
3. 向 ingest 任务提供 `content + 缓冲区` 的访问接口。

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
```

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
├── source-store.ts                  # 持久化 + 去重 + page_sources
└── parsers/
    ├── markdown-parser.ts
    ├── html-parser.ts               # turndown
    └── pdf-parser.ts                # pdf-parse
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-04-22 | 初始化 |

---

_生成时间：2026-04-22 00:25:29_
