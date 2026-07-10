# Wiki 证据工具与分页 Phase 1A 设计 Spec

日期：2026-07-10  
状态：已批准

## 一、目标

Phase 1A 把现有 ToolProfile 中已经声明、但尚未注册的证据能力落成可执行工具：

1. `wiki.inspect`：读取页面关系、来源与轻量健康摘要；
2. `source.search`：在当前 Subject 的解析后来源块中做确定性检索；
3. `source.read`：按 chunk 或受限窗口读取解析后来源；
4. `wiki.list`：由固定 200 页截断升级为可筛选、可排序、可继续的 keyset 分页；
5. 同步修正 `llm-config.example.json`、JSON Schema 与 LLM 模块文档中已确认的配置漂移。

本阶段不实现 PendingAction、审批 API/UI、页面操作 plan/apply，也不实现 Fix/Curate 后置验证；它们分别进入 Phase 1B 和 Phase 1C。

## 二、当前差距

- `query:read`、`fix:*`、`curate:*` Profile 已列出 `wiki.inspect`、`source.search`、`source.read`，但 builtin registry 没有对应 ToolDef；`registry.resolve()` 会静默忽略这些名称。
- `wiki.list` 仍无输入参数，Query context 固定最多返回 200 页，无法继续读取。
- 来源内容已存在于 `vault/.llm-wiki/sources/<subject>/*.json::chunks`，但模型工具没有 subject-scoped 读取入口。
- 单页 stale-source 判断位于 `lint-deterministic.ts`，inspect 若自行复制会造成语义漂移。
- LLM 示例的 task key 集合完整，但 Query 仍为 Sonnet 4.6 配置已弃用的手动 thinking；Schema 与文档仍提到已退役的 `ingest:indexer`。

## 三、设计原则

1. builtin 工具只声明 Zod Schema 并转发 ToolContext，不直接 import DB、vault 或 source store。
2. Subject、allowed page scope 与访问审计继续由 ToolContext 和 `compileToolSet` 强制。
3. 来源检索只使用解析后的 sidecar chunks；不新增来源 embedding 表，不向模型返回原始 HTML 或 PDF 二进制。
4. 分页 cursor 不暴露数据库 offset，使用可校验的版本化 keyset。
5. 所有字符上限在返回模型前确定性执行，不能依赖提示词节制。
6. 不新增 LLM task；ToolProfile ID 与 LLM task route 保持正交。

## 四、架构与组件

```text
ToolProfile
    ↓
compileToolSet + subject/page policy
    ↓
wiki.inspect / source.search / source.read / wiki.list
    ↓
ToolContext evidence methods
    ↓
evidence-reader
    ↓
pagesRepo / subjectsRepo / sourcesRepo / source sidecar / source-staleness
```

### 4.1 `evidence-reader.ts`

新增 `src/server/agents/tools/evidence-reader.ts`，提供当前 Subject 的确定性证据读取函数。它可以 import server repos 与 source 模块，但不依赖 AI SDK，也不包含 ToolDef。

主要接口：

```ts
export function createSubjectEvidenceReader(
  subject: Subject,
): SubjectEvidenceReader;

export interface SubjectEvidenceReader {
  inspectPage(slug: string, include?: InspectSection[]): WikiInspection;
  searchSources(input: SourceSearchInput): SourceSearchResult;
  readSource(input: SourceReadInput): SourceReadResult;
  listPages(
    input?: PageListInput,
    options?: { allowedPageSlugs?: ReadonlySet<string> },
  ): PageListResult;
}
```

共享结果类型放入 `src/lib/contracts.ts`；各工具的 Zod 输入 Schema 保留在 builtin 文件中。

### 4.2 ToolContext

`src/server/agents/tools/tool-context.ts` 增加：

```ts
inspectPage?(
  slug: string,
  include?: InspectSection[],
): Promise<WikiInspection>;

searchSources?(input: SourceSearchInput): Promise<SourceSearchResult>;
readSource?(input: SourceReadInput): Promise<SourceReadResult>;
listPages(
  input?: PageListInput,
  options?: { allowedPageSlugs?: ReadonlySet<string> },
): Promise<PageListResult>;

onSourceAccess?(access: { sourceId: string; chunkId?: string }): void;
```

证据方法保持可选，使 ingest overlay context 不必伪造来源能力；只有解析到对应工具的 runner 必须注入它们。

Query/Fix/Curate context 复用 `createSubjectEvidenceReader(subject)`：

- Query 继续保留现有 `onAccess` 引用收集；新增 `onSourceAccess` 只记录来源标识，不把完整 chunk 塞入引用正文。
- Fix 获得来源证据工具，为 contradiction 后续要求提供真实入口。
- Curate 获得 `wiki.inspect`；Auto Curate 的 allowedSet 仍由 compile policy 包装。
- Ingest planner/writer 继续只使用 overlay-backed `wiki.read/search`。

### 4.3 staleness 单一真实源

新增 `src/server/sources/source-staleness.ts`：

```ts
export function isSourceStale(
  subjectSlug: string,
  source: Pick<Source, 'filename' | 'contentHash'>,
): boolean;
```

它复用 subject-scoped raw 路径和 legacy flat 路径，比较磁盘 SHA-256 前 16 位。`lint-deterministic.ts::checkStaleSourcesForPage()` 改为调用该函数，`wiki.inspect` 同样调用它，避免两份 stale 规则。

## 五、工具契约

### 5.1 `wiki.inspect`

输入：

```ts
{
  slug: string;
  include?: Array<'links' | 'backlinks' | 'sources' | 'health'>;
}
```

`include` 缺省为四项全部。输出：

```ts
interface WikiInspection {
  found: boolean;
  page: null | {
    slug: string;
    title: string;
    summary: string;
    tags: string[];
    updatedAt: string;
  };
  outgoing: Array<{
    subjectSlug: string;
    slug: string;
    title: string | null;
    context: string;
    resolved: boolean;
  }>;
  backlinks: Array<{
    subjectSlug: string;
    slug: string;
    title: string;
  }>;
  sources: Array<{
    id: string;
    filename: string;
    originUrl: string | null;
    parsedAt: string | null;
    stale: boolean;
  }>;
  health: {
    brokenLinks: number;
    inboundCount: number;
    outboundCount: number;
    sourceCount: number;
  };
}
```

规则：

- 不存在页与 allowedSet 外页都返回统一空结果 `{ found:false, page:null, ...空数组/零计数 }`。
- 不返回页面正文。
- 同 Subject 出链解析目标标题；断链 `title:null, resolved:false`。
- 跨 Subject 只返回显式目标的 subject slug、slug、标题和链接上下文。
- backlinks 复用 `pagesRepo.getBacklinks()`，不返回 meta 页。
- sources 复用 `sourcesRepo.getSourcesForPage()`；`originUrl` 从 metadata JSON/sidecar 读取。

### 5.2 `source.search`

输入：

```ts
{
  query: string;
  pageSlug?: string;
  sourceIds?: string[];
  limit?: number; // 1..10，默认 5
}
```

过滤：

- 只有 `pageSlug`：搜索该页面关联 sources；
- 只有 `sourceIds`：逐个校验均属于当前 Subject；
- 两者都有：取页面关联 sources 与显式 sourceIds 的交集；
- 两者都没有：搜索当前 Subject 全部 sources；
- `pageSlug` 位于 allowedSet 外时抛 `PAGE_OUT_OF_SCOPE`；
- 不存在或属于其他 Subject 的 sourceId 统一抛 `SOURCE_OUT_OF_SCOPE`。

确定性词项评分：

```text
score = heading 中词项命中次数 × 2 + chunk text 中词项命中次数
```

查询按 Unicode 字母/数字切词并转小写；空查询在 Schema 层拒绝。同分按 `filename → sourceId → chunkId` 排序。

输出：

```ts
interface SourceSearchResult {
  hits: Array<{
    sourceId: string;
    filename: string;
    chunkId: string;
    heading: string;
    excerpt: string;
    score: number;
  }>;
}
```

excerpt 围绕首次命中截取，单条最多 2,000 字符；从高分结果开始累加，总 excerpt 最多 12,000 字符。损坏或无 chunks 的单个 sidecar 跳过，不阻断其他 source。
工具返回 hits 前逐条调用 `onSourceAccess({ sourceId, chunkId })`，审计只记录标识。

### 5.3 `source.read`

输入：

```ts
{
  sourceId: string;
  chunkId?: string;
  offset?: number; // 默认 0
  limit?: number;  // 默认 8,000，最大 20,000
}
```

输出：

```ts
interface SourceReadResult {
  sourceId: string;
  filename: string;
  chunkId: string | null;
  content: string;
  nextOffset: number | null;
  truncated: boolean;
}
```

规则：

- source 不存在或不属于当前 Subject，统一抛 `SOURCE_OUT_OF_SCOPE`；
- 指定 chunkId 时只读取该 chunk，offset/limit 作用于 chunk text；
- 未指定时按 sidecar chunks 原顺序以两个换行拼成逻辑文本，offset/limit 作用于该逻辑文本；
- source 存在但没有有效 chunks，抛 `SOURCE_CONTENT_UNAVAILABLE`；
- HTML、PDF、Markdown、纯文本均只读取解析后的 chunks；
- 成功读取后调用 `onSourceAccess({ sourceId, chunkId })`。
### 5.4 `wiki.list`

输入：

```ts
interface PageListInput {
  cursor?: string;
  limit?: number; // 默认 50，最大 100
  tag?: string;
  sort?: 'title' | 'updated'; // 默认 title
}
```

输出：

```ts
interface PageListResult {
  pages: Array<{
    slug: string;
    title: string;
    summary: string;
    tags: string[];
    updatedAt: string;
  }>;
  nextCursor: string | null;
}
```

cursor 是 base64url 编码的 canonical JSON：

```ts
{
  version: 1;
  sort: 'title' | 'updated';
  tag: string | null;
  lastValue: string;
  lastSlug: string;
}
```

排序：

- `title`：title 升序，再按 slug 升序；
- `updated`：updatedAt 降序，再按 slug 升序。

cursor 解码失败、版本不支持、sort/tag 与当前请求不一致时抛 `INVALID_CURSOR`。meta 页始终过滤。compile policy 把 allowedSet 作为内部 options 传入 reader，使 scope 过滤发生在分页与 cursor 计算之前；Auto Curate 仍不注入 `wiki.list`。

## 六、运行时边界与审计

`compile.ts::scopeToolContext()` 增加包装：

- `inspectPage`：scope 外返回 `found:false`；
- `searchSources`：带 pageSlug 时先检查 allowedSet；
- `listPages`：把 policy 的 allowed slug 集合作为内部 options 传给底层 reader；reader 必须先过滤候选、再截取 limit 和计算 cursor，避免先分页后过滤造成空页或错误结束；
- `readSource`：Subject 所属校验由 evidence reader 强制。

工具事件继续使用现有审计字段。`content`、`excerpt` 等字段会被 `sanitizeAuditValue()` 替换为 `[REDACTED]`，job_events 不保存来源全文。

稳定错误码沿用 `[CODE] message`：

- `PAGE_OUT_OF_SCOPE`
- `SOURCE_OUT_OF_SCOPE`
- `SOURCE_CONTENT_UNAVAILABLE`
- `INVALID_CURSOR`

## 七、配置与文档同步

Phase 1A 不新增 LLM task route。`query:read`、`fix:links`、`curate:auto` 是工具 Profile，不得加入 `llm-config.example.json::tasks`。

同批修正：

1. `llm-config.example.json`
   - 删除 `defaults.temperature`，避免 thinking task 继承无效采样值；
   - 为需要固定温度但当前依赖 defaults 的 ingest 阶段显式补温度；
   - Query 删除 `topP/presencePenalty/frequencyPenalty`；
   - Query 改为 `thinking:{ type:'adaptive' } + effort:'medium'`。
2. `llm-config.schema.json`
   - `thinking` 支持 `adaptive/enabled/disabled` 三种结构；
   - Anthropic options 显式支持 `effort: low|medium|high|xhigh|max`；
   - 删除 `ingest:indexer` 描述；
   - 显式列出 Research、Re-enrich、Reshape 与现有 ingest stages。
3. `src/server/llm/CLAUDE.md`
   - 已知 task 表补齐 `research:*`、`reenrich:supplement`、`reshape:*`；
   - ingest 阶段数量改为 7；
   - 删除 indexer 与旧手动 thinking 示例。

## 八、测试策略

严格执行 RED → GREEN → REFACTOR。

### 8.1 Evidence reader

- inspect：正常页、断链、同主题/跨主题出链、反链、meta 过滤、来源、originUrl、逐 source stale；
- source search：四种过滤组合、Subject 越界、确定性评分、同分排序、单条/总长度、损坏 sidecar；
- source read：chunk/window、offset/limit、nextOffset、HTML/PDF 只读 chunks、无内容错误；
- list：title/updated 排序、tag、cursor 续页、筛选不匹配、非法 cursor、meta 过滤。

### 8.2 Builtin 与 policy

- 三个新工具的输入边界和输出形状；
- `onSourceAccess` 只记录 ID；
- scope 外 inspect 不泄露；
- scope 外 source page filter 抛错；
- 审计 output 不包含 excerpt/content 原文。

### 8.3 Runner 装配

- Query 实际工具：`wiki.list/search/read/inspect`、`source.search/read`、可选 `web.search`；
- Fix links：`wiki.search/read/inspect`、`source.search/read`、`wiki.patch`；
- Fix contradiction 额外 `wiki.update`；
- Curate Auto：`wiki.search/read/inspect/merge/split`；
- Curate Manual 额外 `wiki.create/delete`；
- Ingest planner/writer 保持 `wiki.read/search`。

### 8.4 配置

- `llm-config.example.json` 可通过 `LLMConfigFileSchema`；
- task key 与当前内置调用集合一致；
- Query Anthropic options 使用 adaptive/medium 且无无效采样字段；
- JSON Schema 不再包含 `ingest:indexer`，并接受 adaptive thinking。

### 8.5 完整验证

```bash
npm test
./node_modules/.bin/tsc --noEmit
npm run build
```

## 九、文件范围

新增：

- `src/server/agents/tools/evidence-reader.ts`
- `src/server/agents/tools/builtin/wiki-inspect.ts`
- `src/server/agents/tools/builtin/source-search.ts`
- `src/server/agents/tools/builtin/source-read.ts`
- `src/server/sources/source-staleness.ts`
- 对应 `__tests__` 文件

修改：

- `src/lib/contracts.ts`
- `src/server/agents/tools/tool-context.ts`
- `src/server/agents/tools/compile.ts`
- `src/server/agents/tools/profiles.ts`
- `src/server/agents/tools/builtin/index.ts`
- `src/server/agents/tools/builtin/wiki-list.ts`
- `src/server/services/query-tools.ts`
- `src/server/services/fix-tools.ts`
- `src/server/services/curate-tools.ts`
- `src/server/services/lint-deterministic.ts`
- `llm-config.example.json`
- `llm-config.schema.json`
- `src/server/agents/CLAUDE.md`
- `src/server/llm/CLAUDE.md`
- `src/server/services/CLAUDE.md`
- `CHANGELOG.md`

不新增数据库迁移，不改 API Route，不改客户端 UI。

## 十、验收标准

1. Active Profile 声明的 `wiki.inspect/source.search/source.read` 都有实际注册 ToolDef；
2. Query、Fix、Curate 能获得各自 Profile 允许的证据工具；
3. Subject 与 allowed page scope 无法通过 inspect/source/list 绕过；
4. 来源工具不返回原始 HTML/PDF，不把 content/excerpt 写入审计事件；
5. `wiki.list` 可稳定续页，非法或条件不匹配 cursor 被拒绝；
6. stale-source 判定由 lint 与 inspect 共用同一实现；
7. `llm-config.example.json` 覆盖全部当前 LLM route，且 Sonnet 4.6 使用 adaptive thinking；
8. 无 PendingAction、审批 UI/API 或 postcondition verification 的提前实现；
9. 全量测试、TypeScript 和生产构建通过。

## 十一、非目标

- PendingAction、preview/approve/reject；
- create/update/patch/delete/reenrich 的 Query 提案与审批；
- Fix/Curate targeted postcondition verification；
- 来源向量检索；
- 跨 Subject 任意搜索或写入；
- History 工具与 workflow command；
- `wiki.metadata.patch`、`wiki.link.ensure`；
- `wiki.move`。
