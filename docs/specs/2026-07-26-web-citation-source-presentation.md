# Spec：Ingest 自主检索网页源的标题与描述展示

日期：2026-07-26
状态：已定稿

## 背景与问题

Ingest 的 verify 阶段（P3 联网核查）会自主检索网页并把被引用的网页导入为 Source
（`ingest-service.ts::buildWebSourceImports` → `saveRawSource`）。这些 Source 落在
`vault/raw/<subject>/web-<host>-<slug>-<hash>.md`，sidecar 只记录 `filename`/`contentHash`。

`GET /api/sources`（左侧 Sources 列表）当前只对**链接型 URL Source**
（sidecar 含 `originUrl`，由 `readUrlSourceReference` 识别）展示网页标题与描述，
其余 Source 一律回退 `filename`。因此自主检索来的网页在侧边栏显示为
`web-news.gmw.cn-content_36241753...` 这类机器文件名，既不可读也无法判断内容。

信息其实已经在手上：`CitedSource` 携带搜索结果标题（`title`）与摘要片段
（`fallbackContent`），只是从未持久化到 Source 元数据。

## 目的

- Ingest 自主检索导入的网页 Source 在侧边栏展示网页标题 + 描述，与链接型 URL Source 一致。
- 展示字段来自摄入时已持久化的数据，渲染列表不触发任何联网或文件解析。
- 存量（本次改动前已导入）的网页 Source 可一次性回填，不需要重新 ingest。

## 约束与成功标准

- 不改变这些 Source 的实体类型：它们仍是带 raw `.md` 文件的普通 Source，
  `/sources/<id>` 继续展示本地 Markdown 正文，不切换为远程 iframe 预览。
- 不新增网络请求；描述来自搜索 snippet 或已抓取正文，不再额外调用 extract/search。
- 标题/描述写入必须随同一次 ingest commit 落地（sidecar 已在 `extraStagePaths` 中）。
- 展示元数据写入失败不得中断知识摄入（沿用 best-effort 语义）。
- 既有链接型 URL Source 的标题/描述/hostname 回退行为完全不变。

## 方案取舍

### 方案 A：把这些 Source 改造成链接型 URL Source

复用现成的 URL Source 展示与预览链路：`saveUrlSource` + presentation + readerText，
不再落 raw `.md`。

优点：只有一套网页 Source 概念；`/sources/<id>` 变为实时网页 + 阅读模式。
缺点：改变了既有实体语义与预览行为（超出本需求）；存量数据要做身份迁移
（filename/contentHash 变化 + 删 raw 文件 + git commit），迁移面与风险明显更大。
不采用。

### 方案 B：把“展示元数据（title/description）”从 URL Source 泛化到所有 Source（推荐）

`title` / `description` 本来就是与实体类型无关的展示字段。把归一化与读取抽成
`source-presentation.ts`，`saveRawSource` 允许在创建时写入展示元数据，
`GET /api/sources` 按 `已持久化展示字段 → URL Source hostname 回退 → filename` 解析。

优点：改动集中在“存与取”两处，不触碰实体语义、预览与 Saga 形状；存量回填只需
补写 sidecar 字段。缺点：网页 Source 仍有两种承载形式（链接型 / raw 快照型），
但这是既有事实，本需求不引入新的第三种。

### 方案 C：列表渲染时现场解析 raw 文件首个 H1

零持久化改动，但把文件 IO 放进侧边栏列表请求（N 个 Source = N 次读盘），
且无法产出描述。不采用。

## 数据设计

Source sidecar（`vault/.llm-wiki/sources/<subject>/<id>.json`）与 SQLite
`sources.metadata_json` 复用 URL Source 已有的两个可选字段，不新增 schema：

```ts
interface SourcePresentation {
  title?: string;        // 归一化空白后最长 300 字符
  description?: string;  // 归一化空白后最长 1000 字符
}
```

新增 `src/server/sources/source-presentation.ts` 作为唯一真实源：

```ts
normalizeSourcePresentation(input: { title?: unknown; description?: unknown }): SourcePresentation
readSourcePresentation(source: Pick<Source, 'metadataJson'>): SourcePresentation
```

`url-source.ts` 的 `normalizeUrlSourcePresentation` 收敛为对它的复用；
`source-store.ts::updateUrlSourcePresentation` 更名为 `updateSourcePresentation`
（行为不变，语义泛化）。

## 服务端设计

1. `saveRawSource(subject, filename, content, extra?)` 的 `extra` 增加
   `presentation?: SourcePresentation`：创建 canonical source 时把归一化结果写进
   sidecar 与 SQLite `metadata_json`。命中内容去重（`existing`）时不覆盖既有展示字段。
2. `buildWebSourceImports`（纯函数）为每个 `CitedSource` 派生展示元数据：
   - 标题：`c.title` → 空则取 URL hostname（去 `www.`）→ 再空则取 URL 原文；
   - 描述：`c.fallbackContent`（搜索 snippet）→ 空则取正文首个非空段落。
   派生结果经 `saveSource(filename, content, url, presentation)` 落库。
3. `GET /api/sources`（无 `slug` 分支）解析顺序：
   - `title`：`readSourcePresentation().title` → URL Source 的 hostname 回退 → `filename`；
   - `description`：`readSourcePresentation().description`（URL Source 走同一字段）。
   `format` 判定不变（仅 URL Source 为 `Web`）。

## 存量回填

`scripts/backfill-source-presentation.ts`（`npm run db:backfill-source-presentation`）：
遍历全部 subject 的 Source，跳过已有 `title` 的行；对 `web-*.md` 且 raw 正文符合
导入格式（首行 `# <title>`、次段 `Source: <url>`）的 Source，确定性解析出标题与
正文首段，调用 `updateSourcePresentation` 补写 sidecar + SQLite。

脚本只写展示字段，不改 filename / contentHash / raw 文件，不做 git commit
（sidecar 变更由用户或下一次 vault commit 携带），因此可安全重复执行。

## 非目标

- 不改变 `/sources/<id>` 与页面 Sources 分栏对这些 Source 的渲染方式。
- 不为普通上传文件（md/pdf/txt）自动生成标题描述。
- 不引入新的 Source `kind`，也不为 raw 快照型网页 Source 记录 `originUrl`
  （记录 `originUrl` 会被 `readUrlSourceReference` 判为链接型，从而改变预览行为）。
