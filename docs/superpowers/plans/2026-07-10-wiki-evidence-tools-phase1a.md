# Wiki 证据工具与分页 Phase 1A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 `wiki.inspect`、`source.search`、`source.read` 与可继续分页的 `wiki.list`，让 Query/Fix/Curate 在不扩大写权限的前提下获得 subject-scoped 证据能力。

**Architecture:** builtin 工具只声明 Zod Schema 并调用 `ToolContext`；`evidence-reader.ts` 复用 pages/sources repos 与 source sidecar，`compileToolSet` 继续强制 subject、allowed page scope 与审计脱敏。来源过期判定下沉到 `sources/source-staleness.ts`，供 lint 与 inspect 共用。

**Tech Stack:** TypeScript 5、Zod、Vitest、Next.js 15、Drizzle/SQLite、Vercel AI SDK 5、Node.js 文件系统 API。

## Global Constraints

- 所有工具访问必须保持 current-subject 隔离；不得新增跨 Subject 任意搜索或写入。
- builtin ToolDef 不得直接 import DB、vault 或 source store，数据访问必须经 ToolContext。
- 来源工具只返回解析后的 sidecar chunks，不返回原始 HTML、PDF 二进制或整份超长来源。
- `wiki.inspect` 不返回页面正文；scope 外与不存在页面统一返回 `found:false`。
- `source.search` 单 excerpt 最多 2,000 字符，总 excerpt 最多 12,000 字符，limit 范围 1..10、默认 5。
- `source.read` limit 默认 8,000、最大 20,000 字符。
- `wiki.list` limit 默认 50、最大 100，使用版本化 base64url keyset cursor。
- Phase 1A 不实现 PendingAction、审批 API/UI、plan/apply 或 Fix/Curate 后置验证。
- 不新增 LLM task；ToolProfile ID 不写入 `llm-config.example.json::tasks`。
- 代码注释、任务、计划与 Spec 使用中文；commit message 使用 Conventional Commits 前缀和中文一句话摘要。

---

## 文件结构

- 新建 `src/server/sources/source-staleness.ts`：来源文件缺失/哈希变化的单一真实源。
- 新建 `src/server/agents/tools/evidence-reader.ts`：inspect、source search/read、page list 的确定性数据读取层。
- 新建 `src/server/agents/tools/builtin/wiki-inspect.ts`：页面证据 ToolDef。
- 新建 `src/server/agents/tools/builtin/source-search.ts`：来源检索 ToolDef。
- 新建 `src/server/agents/tools/builtin/source-read.ts`：来源窗口读取 ToolDef。
- 修改 `src/lib/contracts.ts`：共享证据与分页结果类型。
- 修改 `src/server/agents/tools/tool-context.ts`：可选证据方法、分页签名、source 审计回调。
- 修改 `src/server/agents/tools/compile.ts`：inspect/source/list scope 包装。
- 修改 Query/Fix/Curate context：注入 subject evidence reader。
- 修改 builtin registry/Profile/runner 测试：保证 active Profile 的声明与实际工具一致。
- 修改 LLM 示例、JSON Schema 和模块文档：同步 adaptive thinking 与当前 route。

---

### Task 1: 抽取来源过期判定单一真实源

**Files:**
- Create: `src/server/sources/source-staleness.ts`
- Create: `src/server/sources/__tests__/source-staleness.test.ts`
- Modify: `src/server/services/lint-deterministic.ts:170-225`
- Test: `src/server/services/__tests__/lint-deterministic.test.ts`

**Interfaces:**
- Consumes: `vaultPath(...segments)`、`Source.filename`、`Source.contentHash`。
- Produces: `isSourceStale(subjectSlug, source): boolean`，Task 2 的 inspect 直接复用。

- [x] **Step 1: 写来源缺失与哈希变化的失败测试**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let vaultDir: string;
vi.mock('../../config/env', () => ({
  vaultPath: (...parts: string[]) => join(vaultDir, ...parts),
}));

beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), 'source-stale-'));
  vi.resetModules();
});

afterEach(() => rmSync(vaultDir, { recursive: true, force: true }));

function writeRaw(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

describe('isSourceStale', () => {
  it('subject 文件匹配 hash 时不 stale，内容变化或文件缺失时 stale', async () => {
    const hash = writeRaw(join(vaultDir, 'raw', 'general', 'a.md'), 'alpha');
    const { isSourceStale } = await import('../source-staleness');
    expect(isSourceStale('general', { filename: 'a.md', contentHash: hash })).toBe(false);
    writeFileSync(join(vaultDir, 'raw', 'general', 'a.md'), 'changed');
    expect(isSourceStale('general', { filename: 'a.md', contentHash: hash })).toBe(true);
    expect(isSourceStale('general', { filename: 'missing.md', contentHash: hash })).toBe(true);
  });

  it('subject 文件不存在时回落 legacy raw 文件', async () => {
    const hash = writeRaw(join(vaultDir, 'raw', 'legacy.md'), 'legacy');
    const { isSourceStale } = await import('../source-staleness');
    expect(isSourceStale('general', { filename: 'legacy.md', contentHash: hash })).toBe(false);
  });
});
```

- [x] **Step 2: 运行测试确认 RED**

Run:

```bash
npx vitest run src/server/sources/__tests__/source-staleness.test.ts
```

Expected: FAIL，提示无法解析 `../source-staleness`。

- [x] **Step 3: 实现共享 stale 判定并替换 lint 内联逻辑**

```ts
// src/server/sources/source-staleness.ts
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { vaultPath } from '../config/env';
import type { Source } from '@/lib/contracts';

export function sourcePathsToCheck(subjectSlug: string, filename: string): string[] {
  return [vaultPath('raw', subjectSlug, filename), vaultPath('raw', filename)];
}

export function isSourceStale(
  subjectSlug: string,
  source: Pick<Source, 'filename' | 'contentHash'>,
): boolean {
  const path = sourcePathsToCheck(subjectSlug, source.filename).find(existsSync);
  if (!path) return true;
  const diskHash = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
  return diskHash !== source.contentHash;
}
```

在 `lint-deterministic.ts` 删除 `rawSourcePathsToCheck` 与本地 hash 计算，改为：

```ts
import { isSourceStale } from '../sources/source-staleness';

for (const source of sourcesRepo.getSourcesForPage(subject.id, page.slug)) {
  if (!isSourceStale(subject.slug, source)) continue;
  findings.push({
    type: 'stale-source',
    severity: 'info',
    pageSlug: page.slug,
    description: `Source file "${source.filename}" linked to "${page.slug}" (subject: ${subject.slug}) is missing or changed on disk.`,
    suggestedFix: 'Re-ingest the source file to update the wiki page content.',
  });
}
```

- [x] **Step 4: 运行来源与 lint 测试确认 GREEN**

Run:

```bash
npx vitest run src/server/sources/__tests__/source-staleness.test.ts src/server/services/__tests__/lint-deterministic.test.ts
```

Expected: PASS，现有 stale-source 行为保持通过。

- [x] **Step 5: 提交**

```bash
git add src/server/sources/source-staleness.ts src/server/sources/__tests__/source-staleness.test.ts src/server/services/lint-deterministic.ts
git commit -m "refactor: 统一来源过期判定"
```

---

### Task 2: 实现 `wiki.inspect` 证据读取

**Files:**
- Create: `src/server/agents/tools/evidence-reader.ts`
- Create: `src/server/agents/tools/__tests__/evidence-inspect.test.ts`
- Modify: `src/lib/contracts.ts`

**Interfaces:**
- Consumes: `pagesRepo.getPageBySlug/getAllLinks/getBacklinks`、`subjectsRepo.getById`、`sourcesRepo.getSourcesForPage`、`isSourceStale`。
- Produces: `inspectPageEvidence(subject, slug, include): WikiInspection` 与 `emptyWikiInspection()`。

- [x] **Step 1: 在 contracts 中声明 inspect 类型并写失败测试**

```ts
// src/lib/contracts.ts
export type InspectSection = 'links' | 'backlinks' | 'sources' | 'health';

export interface WikiInspection {
  found: boolean;
  page: null | { slug: string; title: string; summary: string; tags: string[]; updatedAt: string };
  outgoing: Array<{ subjectSlug: string; slug: string; title: string | null; context: string; resolved: boolean }>;
  backlinks: Array<{ subjectSlug: string; slug: string; title: string }>;
  sources: Array<{ id: string; filename: string; originUrl: string | null; parsedAt: string | null; stale: boolean }>;
  health: { brokenLinks: number; inboundCount: number; outboundCount: number; sourceCount: number };
}
```

```ts
// src/server/agents/tools/__tests__/evidence-inspect.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pages = vi.hoisted(() => ({
  getPageBySlug: vi.fn(), getAllLinks: vi.fn(), getBacklinks: vi.fn(),
}));
const subjects = vi.hoisted(() => ({ getById: vi.fn() }));
const sources = vi.hoisted(() => ({ getSourcesForPage: vi.fn() }));
vi.mock('@/server/db/repos/pages-repo', () => pages);
vi.mock('@/server/db/repos/subjects-repo', () => subjects);
vi.mock('@/server/db/repos/sources-repo', () => sources);
vi.mock('@/server/sources/source-store', () => ({ getSourceMetadata: vi.fn(() => ({ originUrl: 'https://example.test/a' })) }));
vi.mock('@/server/sources/source-staleness', () => ({ isSourceStale: vi.fn(() => false) }));

import { inspectPageEvidence } from '../evidence-reader';

const subject = { id: 's1', slug: 'general', name: 'General', description: '' } as never;

describe('inspectPageEvidence', () => {
  beforeEach(() => {
    pages.getPageBySlug.mockReset(); pages.getAllLinks.mockReset(); pages.getBacklinks.mockReset();
    subjects.getById.mockReset(); sources.getSourcesForPage.mockReset();
  });

  it('返回出链、反链、来源和健康计数，不返回正文', () => {
    pages.getPageBySlug.mockImplementation((sid: string, slug: string) =>
      sid === 's1' && slug === 'a'
        ? { subjectId: 's1', slug: 'a', title: 'A', summary: 'SA', tags: ['t'], updatedAt: '2026-01-01' }
        : sid === 's1' && slug === 'b'
          ? { subjectId: 's1', slug: 'b', title: 'B', summary: '', tags: [], updatedAt: '2026-01-01' }
          : null,
    );
    pages.getAllLinks.mockReturnValue([
      { subjectId: 's1', sourceSlug: 'a', targetSubjectId: 's1', targetSlug: 'b', context: 'ctx' },
      { subjectId: 's1', sourceSlug: 'a', targetSubjectId: 's1', targetSlug: 'ghost', context: 'broken' },
    ]);
    pages.getBacklinks.mockReturnValue([{ subjectId: 's1', slug: 'b', title: 'B' }]);
    subjects.getById.mockReturnValue({ id: 's1', slug: 'general' });
    sources.getSourcesForPage.mockReturnValue([{ id: 'src1', filename: 'a.md', parsedAt: '2026-01-01', contentHash: 'h' }]);

    const result = inspectPageEvidence(subject, 'a');
    expect(result.found).toBe(true);
    expect(result.outgoing).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'b', resolved: true, title: 'B' }),
      expect.objectContaining({ slug: 'ghost', resolved: false, title: null }),
    ]));
    expect(result.health).toEqual({ brokenLinks: 1, inboundCount: 1, outboundCount: 2, sourceCount: 1 });
    expect(result.page).not.toHaveProperty('markdown');
  });

  it('不存在页返回统一空结果', () => {
    pages.getPageBySlug.mockReturnValue(null);
    expect(inspectPageEvidence(subject, 'missing')).toEqual({
      found: false, page: null, outgoing: [], backlinks: [], sources: [],
      health: { brokenLinks: 0, inboundCount: 0, outboundCount: 0, sourceCount: 0 },
    });
  });
});
```

- [x] **Step 2: 运行 inspect 测试确认 RED**

Run:

```bash
npx vitest run src/server/agents/tools/__tests__/evidence-inspect.test.ts
```

Expected: FAIL，`evidence-reader.ts` 尚不存在。

- [x] **Step 3: 实现 inspect reader**

`evidence-reader.ts` 必须实现：

```ts
export function emptyWikiInspection(): WikiInspection {
  return {
    found: false, page: null, outgoing: [], backlinks: [], sources: [],
    health: { brokenLinks: 0, inboundCount: 0, outboundCount: 0, sourceCount: 0 },
  };
}

export function inspectPageEvidence(
  subject: Subject,
  slug: string,
  include: InspectSection[] = ['links', 'backlinks', 'sources', 'health'],
): WikiInspection {
  const page = pagesRepo.getPageBySlug(subject.id, slug);
  if (!page || pagesRepo.isMetaPage(page)) return emptyWikiInspection();
  const requested = new Set(include);
  const links = pagesRepo.getAllLinks(subject.id).filter((link) => link.sourceSlug === slug);
  const outgoing = requested.has('links') || requested.has('health')
    ? links.map((link) => {
        const targetSubject = subjectsRepo.getById(link.targetSubjectId);
        const target = pagesRepo.getPageBySlug(link.targetSubjectId, link.targetSlug);
        return {
          subjectSlug: targetSubject?.slug ?? '', slug: link.targetSlug,
          title: target?.title ?? null, context: link.context, resolved: target !== null,
        };
      })
    : [];
  const backlinkPages = requested.has('backlinks') || requested.has('health')
    ? pagesRepo.getBacklinks(subject.id, slug)
    : [];
  const backlinks = requested.has('backlinks')
    ? backlinkPages.map((item) => ({
        subjectSlug: subjectsRepo.getById(item.subjectId)?.slug ?? '',
        slug: item.slug, title: item.title,
      }))
    : [];
  const linkedSources = requested.has('sources') || requested.has('health')
    ? sourcesRepo.getSourcesForPage(subject.id, slug)
    : [];
  const sourceEvidence = requested.has('sources')
    ? linkedSources.map((source) => ({
        id: source.id, filename: source.filename,
        originUrl: readOriginUrl(
          getSourceMetadata(source.id) ?? parseMetadataJson(source.metadataJson),
        ),
        parsedAt: source.parsedAt,
        stale: isSourceStale(subject.slug, source),
      }))
    : [];
  return {
    found: true,
    page: { slug, title: page.title, summary: page.summary ?? '', tags: page.tags ?? [], updatedAt: page.updatedAt },
    outgoing: requested.has('links') ? outgoing : [],
    backlinks,
    sources: sourceEvidence,
    health: requested.has('health')
      ? {
          brokenLinks: outgoing.filter((link) => !link.resolved).length,
          inboundCount: backlinkPages.length,
          outboundCount: links.length,
          sourceCount: linkedSources.length,
        }
      : { brokenLinks: 0, inboundCount: 0, outboundCount: 0, sourceCount: 0 },
  };
}
```

`readOriginUrl` 只接受 metadata 中非空字符串：

```ts
function readOriginUrl(meta: Record<string, unknown> | null): string | null {
  return typeof meta?.originUrl === 'string' && meta.originUrl.length > 0 ? meta.originUrl : null;
}

function parseMetadataJson(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
```

同一测试文件补齐：跨 Subject 出链显示目标 subject/title、meta 页面统一空结果、
`include` 子集不泄露未请求数组、sidecar 缺失时从 `metadataJson` 回落 originUrl，
以及每个关联 source 独立计算 stale。

- [x] **Step 4: 运行 inspect 与 repo 测试确认 GREEN**

Run:

```bash
npx vitest run src/server/agents/tools/__tests__/evidence-inspect.test.ts src/server/db/repos/__tests__/pages-repo.test.ts src/server/db/repos/__tests__/sources-repo.test.ts
```

Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/lib/contracts.ts src/server/agents/tools/evidence-reader.ts src/server/agents/tools/__tests__/evidence-inspect.test.ts
git commit -m "feat: 增加页面证据读取内核"
```

---

### Task 3: 实现来源检索与窗口读取

**Files:**
- Modify: `src/lib/contracts.ts`
- Modify: `src/server/agents/tools/evidence-reader.ts`
- Create: `src/server/agents/tools/__tests__/evidence-sources.test.ts`

**Interfaces:**
- Consumes: `sourcesRepo.listSourcesForSubject/getSourcesForPage/getSource`、`getSourceMetadata()`。
- Produces: `searchSourceEvidence(subject, input)`、`readSourceEvidence(subject, input)`。

- [x] **Step 1: 增加来源结果类型并写失败测试**

在 `contracts.ts` 增加：

```ts
export interface SourceSearchInput { query: string; pageSlug?: string; sourceIds?: string[]; limit?: number }
export interface SourceSearchResult {
  hits: Array<{ sourceId: string; filename: string; chunkId: string; heading: string; excerpt: string; score: number }>;
}
export interface SourceReadInput { sourceId: string; chunkId?: string; offset?: number; limit?: number }
export interface SourceReadResult {
  sourceId: string; filename: string; chunkId: string | null;
  content: string; nextOffset: number | null; truncated: boolean;
}
```

测试用固定 mocks 构造两个 Subject、三个 source 与 chunks：

```ts
it('按 heading×2 + text 评分并确定性排序', () => {
  sources.listSourcesForSubject.mockReturnValue([
    { id: 's-a', subjectId: 'sub1', filename: 'a.md' },
    { id: 's-b', subjectId: 'sub1', filename: 'b.md' },
  ]);
  sourceStore.getSourceMetadata.mockImplementation((id: string) => id === 's-a'
    ? { chunks: [{ id: 'c0', heading: 'Alpha Alpha', text: 'alpha body' }] }
    : { chunks: [{ id: 'c1', heading: '', text: 'alpha alpha' }] });
  const result = searchSourceEvidence(subject, { query: 'alpha', limit: 10 });
  expect(result.hits.map((hit) => [hit.sourceId, hit.score])).toEqual([
    ['s-a', 5], ['s-b', 2],
  ]);
});

it('sourceIds 越过 Subject 时统一拒绝', () => {
  sources.getSource.mockReturnValue({ id: 'foreign', subjectId: 'sub2' });
  expect(() => searchSourceEvidence(subject, { query: 'alpha', sourceIds: ['foreign'] }))
    .toThrow(/SOURCE_OUT_OF_SCOPE/);
});

it('按 chunk 和 offset/limit 返回窗口', () => {
  sources.getSource.mockReturnValue({ id: 's-a', subjectId: 'sub1', filename: 'a.md' });
  sourceStore.getSourceMetadata.mockReturnValue({
    chunks: [{ id: 'c0', heading: 'H', text: '0123456789' }],
  });
  expect(readSourceEvidence(subject, { sourceId: 's-a', chunkId: 'c0', offset: 3, limit: 4 }))
    .toEqual({ sourceId: 's-a', filename: 'a.md', chunkId: 'c0', content: '3456', nextOffset: 7, truncated: true });
});
```

同一测试文件必须继续覆盖：

- 无过滤搜索 subject 全量、仅 `pageSlug`、仅 `sourceIds`、两者交集四种组合；
- source 不存在与跨 Subject 使用同一个 `SOURCE_OUT_OF_SCOPE`；
- 同分时按 filename/sourceId/chunkId 排序；单 excerpt 2,000 与总 12,000 字符双重上限；
- 损坏或无 chunks 的单个 sidecar 被跳过，不影响其他命中；
- 未指定 chunk 时按原顺序用两个换行拼接，offset 超过末尾返回空 content；
- read 缺失/损坏 chunks 与未知 chunkId 均返回 `SOURCE_CONTENT_UNAVAILABLE`，limit 被限制到 20,000。

- [x] **Step 2: 运行来源证据测试确认 RED**

Run:

```bash
npx vitest run src/server/agents/tools/__tests__/evidence-sources.test.ts
```

Expected: FAIL，两个导出函数尚不存在。

- [x] **Step 3: 实现过滤、评分、限长和读取**

实现常量与纯辅助函数：

```ts
const SOURCE_SEARCH_LIMIT = 5;
const SOURCE_SEARCH_MAX = 10;
const EXCERPT_MAX = 2_000;
const EXCERPT_TOTAL_MAX = 12_000;
const SOURCE_READ_DEFAULT = 8_000;
const SOURCE_READ_MAX = 20_000;

function termsOf(query: string): string[] {
  return query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  const text = haystack.toLocaleLowerCase();
  while ((index = text.indexOf(needle, index)) >= 0) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function sourceError(code: 'SOURCE_OUT_OF_SCOPE' | 'SOURCE_CONTENT_UNAVAILABLE', message: string): Error {
  return new Error(`[${code}] ${message}`);
}
```

`searchSourceEvidence()` 必须：

1. 解析 subject 全量、page 关联与显式 IDs；
2. 对显式 ID 逐个调用 `getSource()` 验证 subject；
3. 两种过滤同时存在时取交集；
4. 遍历有效 sidecar chunks，计算 score，score=0 不返回；
5. excerpt 以首次命中为中心截取最多 2,000 字符；
6. 按 score 降序、filename/sourceId/chunkId 升序排序；
7. 同时执行 limit 与 12,000 总字符上限。

`readValidChunks()` 只接受 `id/heading/text` 均为字符串的 chunk，并保持 sidecar 原顺序；
读取 `getSourceMetadata()` 返回 `null`、JSON 损坏或 chunks 为空时统一按“无有效 chunks”处理。

`readSourceEvidence()` 必须使用：

```ts
const source = sourcesRepo.getSource(input.sourceId);
if (!source || source.subjectId !== subject.id) {
  throw sourceError('SOURCE_OUT_OF_SCOPE', 'Source is not available in the current subject.');
}
const chunks = readValidChunks(getSourceMetadata(source.id));
if (chunks.length === 0) {
  throw sourceError('SOURCE_CONTENT_UNAVAILABLE', `Source "${source.id}" has no parsed chunks.`);
}
const selected = input.chunkId
  ? chunks.find((chunk) => chunk.id === input.chunkId)?.text
  : chunks.map((chunk) => chunk.text).join('\n\n');
if (selected === undefined) {
  throw sourceError('SOURCE_CONTENT_UNAVAILABLE', `Chunk "${input.chunkId}" is unavailable.`);
}
const offset = Math.max(0, input.offset ?? 0);
const limit = Math.min(SOURCE_READ_MAX, Math.max(1, input.limit ?? SOURCE_READ_DEFAULT));
const content = selected.slice(offset, offset + limit);
const end = offset + content.length;
return {
  sourceId: source.id, filename: source.filename, chunkId: input.chunkId ?? null,
  content, nextOffset: end < selected.length ? end : null, truncated: end < selected.length,
};
```

- [x] **Step 4: 运行来源测试确认 GREEN**

Run:

```bash
npx vitest run src/server/agents/tools/__tests__/evidence-sources.test.ts src/server/sources/__tests__/source-store.test.ts
```

Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/lib/contracts.ts src/server/agents/tools/evidence-reader.ts src/server/agents/tools/__tests__/evidence-sources.test.ts
git commit -m "feat: 增加来源证据检索与读取"
```

---

### Task 4: 实现页面 keyset 分页

**Files:**
- Modify: `src/lib/contracts.ts`
- Modify: `src/server/agents/tools/evidence-reader.ts`
- Create: `src/server/agents/tools/__tests__/evidence-list.test.ts`

**Interfaces:**
- Consumes: `pagesRepo.getAllPages(subject.id)`。
- Produces: `listPageEvidence(subject, input, options)`、`createSubjectEvidenceReader(subject)`。

- [x] **Step 1: 增加分页类型并写 cursor 失败测试**

```ts
export interface PageListInput { cursor?: string; limit?: number; tag?: string; sort?: 'title' | 'updated' }
export interface PageListResult {
  pages: Array<{ slug: string; title: string; summary: string; tags: string[]; updatedAt: string }>;
  nextCursor: string | null;
}
```

```ts
it('title 排序稳定续页且不会重复', () => {
  pages.getAllPages.mockReturnValue([
    page('c', 'Beta', '2026-01-03'), page('a', 'Alpha', '2026-01-01'), page('b', 'Alpha', '2026-01-02'),
  ]);
  const first = listPageEvidence(subject, { limit: 2, sort: 'title' });
  expect(first.pages.map((item) => item.slug)).toEqual(['a', 'b']);
  expect(first.nextCursor).not.toBeNull();
  const second = listPageEvidence(subject, { limit: 2, sort: 'title', cursor: first.nextCursor! });
  expect(second.pages.map((item) => item.slug)).toEqual(['c']);
  expect(second.nextCursor).toBeNull();
});

it('cursor 与 tag 或 sort 不匹配时拒绝', () => {
  pages.getAllPages.mockReturnValue([page('a', 'A', '2026-01-01'), page('b', 'B', '2026-01-02')]);
  const first = listPageEvidence(subject, { limit: 1, tag: 'x', sort: 'title' });
  expect(() => listPageEvidence(subject, { cursor: first.nextCursor!, tag: 'y', sort: 'title' }))
    .toThrow(/INVALID_CURSOR/);
});

it('allowedPageSlugs 在分页前过滤', () => {
  pages.getAllPages.mockReturnValue([page('a', 'A', '2026-01-01'), page('b', 'B', '2026-01-02')]);
  const result = listPageEvidence(subject, { limit: 1 }, { allowedPageSlugs: new Set(['b']) });
  expect(result.pages.map((item) => item.slug)).toEqual(['b']);
  expect(result.nextCursor).toBeNull();
});
```

同一测试文件补齐 updatedAt 降序 + slug 升序、tag 精确筛选、meta 过滤、默认
`limit=50/sort=title`、`limit>100` 截到 100，以及非 base64url JSON、版本错误、字段缺失
三类 `INVALID_CURSOR`。

- [x] **Step 2: 运行分页测试确认 RED**

Run:

```bash
npx vitest run src/server/agents/tools/__tests__/evidence-list.test.ts
```

Expected: FAIL，分页函数尚不存在。

- [x] **Step 3: 实现 cursor 编解码、排序、筛选和 factory**

```ts
interface PageCursor {
  version: 1; sort: 'title' | 'updated'; tag: string | null; lastValue: string; lastSlug: string;
}

function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(raw: string, sort: 'title' | 'updated', tag: string | null): PageCursor {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as PageCursor;
    if (value.version !== 1 || value.sort !== sort || value.tag !== tag || !value.lastValue || !value.lastSlug) {
      throw new Error('mismatch');
    }
    return value;
  } catch {
    throw new Error('[INVALID_CURSOR] Cursor is invalid or does not match the requested filters.');
  }
}
```

`listPageEvidence()` 执行顺序必须固定为：meta 过滤 → tag 过滤 → allowedSet 过滤 → sort → cursor keyset 过滤 → `limit + 1` 截取 → nextCursor。

入口先规范化 `limit = Math.min(100, Math.max(1, input.limit ?? 50))`、
`sort = input.sort ?? 'title'`、`tag = input.tag ?? null`；输出 tags 必须过滤系统 `meta` 标签。

keyset 判定：

```ts
const afterCursor = (page: WikiPage, cursor: PageCursor): boolean => {
  const value = cursor.sort === 'title' ? page.title : page.updatedAt;
  if (cursor.sort === 'title') {
    return value > cursor.lastValue || (value === cursor.lastValue && page.slug > cursor.lastSlug);
  }
  return value < cursor.lastValue || (value === cursor.lastValue && page.slug > cursor.lastSlug);
};
```

最后导出 factory：

```ts
export function createSubjectEvidenceReader(subject: Subject): SubjectEvidenceReader {
  return {
    inspectPage: (slug, include) => inspectPageEvidence(subject, slug, include),
    searchSources: (input) => searchSourceEvidence(subject, input),
    readSource: (input) => readSourceEvidence(subject, input),
    listPages: (input, options) => listPageEvidence(subject, input, options),
  };
}
```

- [x] **Step 4: 运行全部 evidence reader 测试确认 GREEN**

Run:

```bash
npx vitest run src/server/agents/tools/__tests__/evidence-inspect.test.ts src/server/agents/tools/__tests__/evidence-sources.test.ts src/server/agents/tools/__tests__/evidence-list.test.ts
```

Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/lib/contracts.ts src/server/agents/tools/evidence-reader.ts src/server/agents/tools/__tests__/evidence-list.test.ts
git commit -m "feat: 增加 Wiki 页面游标分页"
```

---

### Task 5: 注册证据工具并接入运行时策略

**Files:**
- Create: `src/server/agents/tools/builtin/wiki-inspect.ts`
- Create: `src/server/agents/tools/builtin/source-search.ts`
- Create: `src/server/agents/tools/builtin/source-read.ts`
- Modify: `src/server/agents/tools/builtin/wiki-list.ts`
- Modify: `src/server/agents/tools/builtin/index.ts`
- Modify: `src/server/agents/tools/tool-context.ts`
- Modify: `src/server/agents/tools/compile.ts`
- Modify: `src/server/services/query-tools.ts`
- Modify: `src/server/services/fix-tools.ts`
- Modify: `src/server/services/curate-tools.ts`
- Modify: `src/server/agents/tools/builtin/__tests__/wiki-tools.test.ts`
- Modify: `src/server/agents/tools/builtin/__tests__/registry.test.ts`
- Modify: `src/server/agents/tools/__tests__/compile.test.ts`
- Modify: `src/server/agents/tools/__tests__/tool-context.test.ts`
- Modify: `src/server/services/__tests__/query-tools.test.ts`
- Modify: `src/server/services/__tests__/fix-tools.test.ts`
- Modify: `src/server/services/__tests__/curate-tools.test.ts`
- Modify: `src/server/services/__tests__/fix-service.test.ts`
- Modify: `src/server/services/__tests__/curate-service.test.ts`

**Interfaces:**
- Consumes: `createSubjectEvidenceReader(subject)` 与 Task 2-4 的 contracts。
- Produces: Profile 声明与实际 provider ToolSet 一致的 Query/Fix/Curate 工具面。

- [x] **Step 1: 写 builtin、scope 与 runner 装配失败测试**

registry 测试：

```ts
it('注册 Phase 1A 证据工具', () => {
  const registry = createBuiltinToolRegistry();
  expect(registry.get('wiki.inspect')).toBeDefined();
  expect(registry.get('source.search')).toBeDefined();
  expect(registry.get('source.read')).toBeDefined();
});
```

builtin 测试：

```ts
it('source.search 对每个返回 chunk 记录 source 访问', async () => {
  const onSourceAccess = vi.fn();
  const ctx = fakeCtx({
    searchSources: vi.fn(async () => ({
      hits: [{ sourceId: 'src1', filename: 'a.md', chunkId: 'c0', heading: 'H', excerpt: 'secret', score: 2 }],
    })),
    onSourceAccess,
  });
  await sourceSearchTool.handler({ query: 'secret' }, ctx);
  expect(onSourceAccess).toHaveBeenCalledWith({ sourceId: 'src1', chunkId: 'c0' });
});
```

compile 测试通过已编译工具执行 scope（`ai.tool` mock 会把 `execute` 暴露在 ToolSet）：

```ts
const allowed = new Set(['inside']);
const scopedCtx = { ...ctx, inspectPage, searchSources, listPages } as ToolContext;

const curateSet = compileToolSet([wikiInspectTool], scopedCtx, {
  policy: createToolExecutionPolicy(resolveToolProfile('curate:auto'), 's', {
    allowedPageSlugs: allowed,
  }),
});
expect(await (curateSet.wiki_inspect as any).execute({ slug: 'outside' }))
  .toEqual(emptyWikiInspection());

const fixSet = compileToolSet([sourceSearchTool], scopedCtx, {
  policy: createToolExecutionPolicy(resolveToolProfile('fix:links'), 's', {
    allowedPageSlugs: allowed,
    jobCapability: { jobId: 'j1', jobType: 'fix' },
  }),
});
await expect((fixSet.source_search as any).execute({ query: 'q', pageSlug: 'outside' }))
  .rejects.toThrow(/PAGE_OUT_OF_SCOPE/);

const querySet = compileToolSet([wikiListTool], scopedCtx, {
  policy: createToolExecutionPolicy(resolveToolProfile('query:read'), 's', {
    allowedPageSlugs: allowed,
  }),
});
await (querySet.wiki_list as any).execute({ limit: 1 });
expect(listPages).toHaveBeenCalledWith({ limit: 1 }, { allowedPageSlugs: allowed });
```

runner 测试把工具集合精确更新为：

```ts
expect(queryKeys).toEqual(expect.arrayContaining([
  'wiki_list', 'wiki_search', 'wiki_read', 'wiki_inspect', 'source_search', 'source_read',
]));
expect(fixLinkKeys).toEqual(expect.arrayContaining([
  'wiki_search', 'wiki_read', 'wiki_inspect', 'source_search', 'source_read', 'wiki_patch',
]));
expect(curateAutoKeys).toEqual(expect.arrayContaining([
  'wiki_search', 'wiki_read', 'wiki_inspect', 'wiki_merge', 'wiki_split',
]));
```

`query-tools.test.ts` 还要断言 `createAccessedPages()` 对相同 source/chunk 去重记录；
`tool-context.test.ts` 则断言 ingest context 的新 `listPages()` 签名返回
`{ pages, nextCursor }`，确保 ToolContext 改签没有破坏 ingest runner。

- [x] **Step 2: 运行集成定向测试确认 RED**

Run:

```bash
npx vitest run src/server/agents/tools/builtin/__tests__/registry.test.ts src/server/agents/tools/builtin/__tests__/wiki-tools.test.ts src/server/agents/tools/__tests__/compile.test.ts src/server/agents/tools/__tests__/tool-context.test.ts src/server/services/__tests__/query-tools.test.ts src/server/services/__tests__/fix-tools.test.ts src/server/services/__tests__/curate-tools.test.ts src/server/services/__tests__/fix-service.test.ts src/server/services/__tests__/curate-service.test.ts
```

Expected: FAIL，证据 ToolDef 未注册，ToolContext 仍使用旧 list 签名。

- [x] **Step 3: 实现三个 ToolDef 与分页 `wiki.list`**

每个 builtin 在本文件本地声明与 contracts 同形的 output Zod Schema；数组元素字段、
nullable 字段和 `nextCursor` 必须完整校验，不以 `z.unknown()` 绕过输出契约。

`wiki-inspect.ts`：

```ts
const InputSchema = z.object({
  slug: z.string().min(1),
  include: z.array(z.enum(['links', 'backlinks', 'sources', 'health'])).optional(),
});
export const wikiInspectTool: ToolDef = {
  name: 'wiki.inspect', source: 'builtin', sideEffect: 'none',
  description: 'Inspect page metadata, links, backlinks, sources, and health without returning page body.',
  inputSchema: InputSchema, outputSchema: WikiInspectionSchema,
  async handler(input, ctx) {
    return ctx.inspectPage ? ctx.inspectPage(input.slug, input.include) : emptyWikiInspection();
  },
};
```

`source-search.ts`：

```ts
const InputSchema = z.object({
  query: z.string().trim().min(1), pageSlug: z.string().min(1).optional(),
  sourceIds: z.array(z.string().min(1)).optional(), limit: z.number().int().min(1).max(10).optional(),
});
export const sourceSearchTool: ToolDef = {
  name: 'source.search', source: 'builtin', sideEffect: 'none',
  description: 'Search parsed source chunks in the current subject and return bounded excerpts.',
  inputSchema: InputSchema, outputSchema: SourceSearchResultSchema,
  async handler(input, ctx) {
    if (!ctx.searchSources) throw new Error('[TOOL_NOT_ALLOWED] source.search is unavailable in this runner.');
    const result = await ctx.searchSources(input);
    for (const hit of result.hits) ctx.onSourceAccess?.({ sourceId: hit.sourceId, chunkId: hit.chunkId });
    return result;
  },
};
```

`source-read.ts`：

```ts
const InputSchema = z.object({
  sourceId: z.string().min(1), chunkId: z.string().min(1).optional(),
  offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(20_000).optional(),
});
export const sourceReadTool: ToolDef = {
  name: 'source.read', source: 'builtin', sideEffect: 'none',
  description: 'Read a bounded parsed source chunk or window in the current subject.',
  inputSchema: InputSchema, outputSchema: SourceReadResultSchema,
  async handler(input, ctx) {
    if (!ctx.readSource) throw new Error('[TOOL_NOT_ALLOWED] source.read is unavailable in this runner.');
    const result = await ctx.readSource(input);
    ctx.onSourceAccess?.({ sourceId: result.sourceId, chunkId: result.chunkId ?? undefined });
    return result;
  },
};
```

`wiki-list.ts` 输入改为 cursor/limit/tag/sort，handler 返回 `PageListResult` 并对每页调用 `onAccess`，不再返回 `total`。

`wiki-tools.test.ts` 对三个 input 边界、四个稳定错误码的透传和输出 shape 做断言；
`compile.test.ts` 从已编译工具实际执行一次 `source.search` 与 `source.read`，断言
`onToolCall.output` 的 `excerpt/content` 为 `[REDACTED]` 且 sourceId/chunkId 保留。

- [x] **Step 4: 注入 evidence reader 并扩展 scope wrapper**

`ToolContext` 从 `contracts.ts` import 新类型，改为：

```ts
inspectPage?(slug: string, include?: InspectSection[]): Promise<WikiInspection>;
searchSources?(input: SourceSearchInput): Promise<SourceSearchResult>;
readSource?(input: SourceReadInput): Promise<SourceReadResult>;
listPages(
  input?: PageListInput,
  options?: { allowedPageSlugs?: ReadonlySet<string> },
): Promise<PageListResult>;
onSourceAccess?(access: { sourceId: string; chunkId?: string }): void;
```

`agentToolContext()` 构造一次 `createSubjectEvidenceReader(agentCtx.subject)`，仅把
`listPages(input, options)` 委托给 reader；`wiki.read/search` 继续走 overlay，且不注入
三个可选来源证据方法。

Query/Fix/Curate context 各自构造 `const evidence = createSubjectEvidenceReader(subject)`，
并用以下方法替换旧的固定 200 页 list：

```ts
inspectPage: async (slug, include) => evidence.inspectPage(slug, include),
searchSources: async (input) => evidence.searchSources(input),
readSource: async (input) => evidence.readSource(input),
listPages: async (input, options) => evidence.listPages(input, options),
```

Query 保留现有 `readPage/search/onAccess/webSearch`，并把 `AccessedPages` 扩展为：

```ts
sourceRefs: Map<string, { sourceId: string; chunkId?: string }>;
```

`onSourceAccess()` 以 `${sourceId}\u0000${chunkId ?? ''}` 为 key 去重，只保存标识；
`accessedToContext()` 仍只处理 Wiki 页面，不读取或注入 source chunk 正文。Fix 保留
`readPage/search/emit/updatePage/patchPage`，Curate 保留
`readPage/search/emit/mergePages/splitPage/deletePage/createPage`，不改变既有 guard 与 Saga 写路径。

`scopeToolContext()` 增加：

```ts
inspectPage: ctx.inspectPage && (async (slug, include) => {
  if (!allowed.has(slug)) return emptyWikiInspection();
  return ctx.inspectPage!(slug, include);
}),
searchSources: ctx.searchSources && (async (input) => {
  if (input.pageSlug && !allowed.has(input.pageSlug)) {
    throw new Error(`[PAGE_OUT_OF_SCOPE] ${input.pageSlug} is outside ${policy.profileId}`);
  }
  return ctx.searchSources!(input);
}),
listPages: async (input) => ctx.listPages(input, { allowedPageSlugs: allowed }),
```

注册三个 ToolDef；保留 `wiki.reenrich` 现状，本阶段不提前实施 workflow command 迁移。

runner 测试还要覆盖 `fix:contradiction` 比 `fix:links` 多 `wiki_update`、
`curate:manual` 比 `curate:auto` 多 `wiki_create/wiki_delete`、ingest planner/writer 仍只有
`wiki_read/wiki_search`；Query 的 `web_search` 仅在配置可用时出现。

- [x] **Step 5: 运行集成测试与类型检查确认 GREEN**

Run:

```bash
npx vitest run src/server/agents/tools/builtin/__tests__/registry.test.ts src/server/agents/tools/builtin/__tests__/wiki-tools.test.ts src/server/agents/tools/__tests__/compile.test.ts src/server/agents/tools/__tests__/tool-context.test.ts src/server/services/__tests__/query-tools.test.ts src/server/services/__tests__/query-service-agentic.test.ts src/server/services/__tests__/fix-tools.test.ts src/server/services/__tests__/curate-tools.test.ts src/server/services/__tests__/fix-service.test.ts src/server/services/__tests__/curate-service.test.ts
./node_modules/.bin/tsc --noEmit
```

Expected: 全部 PASS，TypeScript 退出码 0。

- [x] **Step 6: 提交**

```bash
git add src/server/agents/tools src/server/services/query-tools.ts src/server/services/fix-tools.ts src/server/services/curate-tools.ts src/server/services/__tests__/query-tools.test.ts src/server/services/__tests__/fix-tools.test.ts src/server/services/__tests__/curate-tools.test.ts src/server/services/__tests__/query-service-agentic.test.ts src/server/services/__tests__/fix-service.test.ts src/server/services/__tests__/curate-service.test.ts
git commit -m "feat: 接入 Wiki 证据工具运行时"
```

---

### Task 6: 同步 LLM 示例配置与 Schema

**Files:**
- Modify: `llm-config.example.json`
- Modify: `llm-config.schema.json`
- Create: `src/server/llm/__tests__/config-example.test.ts`
- Modify: `src/server/llm/CLAUDE.md`

**Interfaces:**
- Consumes: `LLMConfigFileSchema` 与当前 19 个已知 task key。
- Produces: Sonnet 4.6 adaptive thinking 示例和与 runtime 一致的编辑器 Schema。

- [x] **Step 1: 写配置一致性失败测试**

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LLMConfigFileSchema } from '../config-schema';

const example = JSON.parse(readFileSync(resolve('llm-config.example.json'), 'utf8'));
const jsonSchemaText = readFileSync(resolve('llm-config.schema.json'), 'utf8');

describe('llm-config.example.json', () => {
  it('通过运行时 schema 且使用 Sonnet 4.6 adaptive thinking', () => {
    expect(LLMConfigFileSchema.safeParse(example).success).toBe(true);
    expect(example.tasks.query.providerOptions.anthropic).toEqual({
      thinking: { type: 'adaptive' }, effort: 'medium',
    });
    expect(example.tasks.query).not.toHaveProperty('topP');
    expect(example.tasks.query).not.toHaveProperty('presencePenalty');
    expect(example.tasks.query).not.toHaveProperty('frequencyPenalty');
    expect(example.defaults).not.toHaveProperty('temperature');
  });

  it('不再声明 ingest:indexer，并覆盖当前 route key', () => {
    const expected = [
      'query', 'lint', 'merge', 'split', 'curate', 'fix', 'embedding',
      'research:queries', 'research:triage', 'ingest:planner', 'ingest:chunk-summarizer',
      'ingest:writer', 'ingest:enricher', 'ingest:verifier', 'ingest:verifier-triage',
      'ingest:verifier-apply', 'reenrich:supplement', 'reshape:page', 'reshape:section',
    ];
    expect(new Set(Object.keys(example.tasks))).toEqual(new Set(expected));
    expect(jsonSchemaText).not.toContain('ingest:indexer');
    expect(jsonSchemaText).toContain('"adaptive"');
    expect(jsonSchemaText).toContain('"effort"');
  });
});
```

- [x] **Step 2: 运行配置测试确认 RED**

Run:

```bash
npx vitest run src/server/llm/__tests__/config-example.test.ts
```

Expected: FAIL，Query 仍为 enabled/budgetTokens，JSON Schema 仍包含 indexer。

- [x] **Step 3: 更新示例与 JSON Schema**

Query 配置改为：

```json
"query": {
  "profile": "anthropic-default",
  "model": "claude-sonnet-4-6",
  "maxTokens": 4096,
  "providerOptions": {
    "anthropic": {
      "thinking": { "type": "adaptive" },
      "effort": "medium"
    }
  }
}
```

删除 `defaults.temperature`，并显式补：

```json
"ingest:planner": { "profile": "anthropic-default", "model": "claude-sonnet-4-6", "temperature": 0.2 },
"ingest:chunk-summarizer": { "profile": "openai-default", "model": "gpt-4o-mini", "temperature": 0 },
"ingest:writer": { "profile": "anthropic-default", "model": "claude-sonnet-4-6", "maxTokens": 16384, "temperature": 0.2 },
"ingest:enricher": { "profile": "anthropic-default", "model": "claude-sonnet-4-6", "maxTokens": 16384, "temperature": 0.2 }
```

JSON Schema 的 Anthropic options 使用 `oneOf` 区分：

```json
"thinking": {
  "oneOf": [
    { "type": "object", "required": ["type"], "additionalProperties": false, "properties": { "type": { "const": "adaptive" } } },
    { "type": "object", "required": ["type", "budgetTokens"], "additionalProperties": false, "properties": { "type": { "const": "enabled" }, "budgetTokens": { "type": "number", "minimum": 1024 } } },
    { "type": "object", "required": ["type"], "additionalProperties": false, "properties": { "type": { "const": "disabled" } } }
  ]
},
"effort": { "enum": ["low", "medium", "high", "xhigh", "max"] }
```

task 描述显式列出当前 19 个 route，并把 ingest stages 改为 7 个。

- [x] **Step 4: 更新 LLM 模块文档并运行测试**

`src/server/llm/CLAUDE.md` 的已知 task 表增加：

```markdown
| 阶段 | `research:queries` | Research：生成联网检索 query |
| 阶段 | `research:triage` | Research：候选评分与筛选 |
| 阶段 | `reenrich:supplement` | Re-enrich：补充正文缺口 |
| 阶段 | `reshape:page` | Cognitive Lens：整页读侧重塑 |
| 阶段 | `reshape:section` | Cognitive Lens：段落读侧重塑 |
```

Run:

```bash
npx vitest run src/server/llm/__tests__/config-example.test.ts src/server/llm/__tests__/task-router.test.ts
./node_modules/.bin/tsc --noEmit
```

Expected: PASS，TypeScript 退出码 0。

- [x] **Step 5: 提交**

```bash
git add llm-config.example.json llm-config.schema.json src/server/llm/__tests__/config-example.test.ts src/server/llm/CLAUDE.md
git commit -m "chore: 同步 LLM 示例配置与路由文档"
```

---

### Task 7: 同步架构文档并完成 Phase 1A 验证

**Files:**
- Modify: `src/server/agents/CLAUDE.md`
- Modify: `src/server/services/CLAUDE.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/plans/2026-07-10-wiki-evidence-tools-phase1a.md`

**Interfaces:**
- Consumes: Tasks 1-6 的最终工具矩阵、错误码、配置路由与验证结果。
- Produces: 可恢复的执行记录和完成态文档。

- [x] **Step 1: 更新 Agents 与 Services 文档**

Agents 文档写明：

```markdown
- Phase 1A builtin registry 新增 `wiki.inspect`、`source.search`、`source.read`。
- 证据工具经 ToolContext 注入，subject/page scope 由 compile policy 强制。
- `wiki.list` 使用 title/updated keyset cursor，默认 50、最大 100。
- 来源正文与 excerpt 在审计事件中统一脱敏。
```

Services 文档更新 Query/Fix/Curate 工具矩阵，并记录 stale-source 已迁移到 `sources/source-staleness.ts`。

- [x] **Step 2: 更新 CHANGELOG 并执行静态扫描**

CHANGELOG 增加 Phase 1A 一行，说明三个证据工具、分页、scope 与配置同步。

Run:

```bash
rg -n "wiki\.inspect|source\.search|source\.read" src/server/agents/tools/builtin/index.ts src/server/agents/tools/profiles.ts
rg -n "ingest:indexer" llm-config.example.json llm-config.schema.json src/server/llm/CLAUDE.md
git diff --check
```

Expected: 第一条命中 registry/Profile；第二条无匹配并以 1 退出；`git diff --check` 退出码 0。

- [x] **Step 3: 运行完整测试**

Run:

```bash
npm test
```

Expected: 0 failed test files，0 failed tests。

- [x] **Step 4: 运行类型检查与生产构建**

Run:

```bash
./node_modules/.bin/tsc --noEmit
npm run build
```

Expected: 两条命令退出码均为 0；Next.js 完成 production build。

- [x] **Step 5: 核对范围与提交文档**

Run:

```bash
git status --short
git diff main...HEAD --stat
git log --oneline main..HEAD
```

确认没有 pending_actions 表、pending-actions API/UI、postcondition verifier、metadata.patch、link.ensure 或跨主题搜索实现。

```bash
git add src/server/agents/CLAUDE.md src/server/services/CLAUDE.md CHANGELOG.md docs/superpowers/plans/2026-07-10-wiki-evidence-tools-phase1a.md
git commit -m "docs: 记录 Wiki 证据工具 Phase 1A"
```

---

## 计划自检

- **Spec 覆盖：** Task 1 覆盖 stale 单一真实源；Tasks 2-4 覆盖 inspect/source/list；Task 5 覆盖 ToolDef、policy 与 runner；Task 6 覆盖 LLM 配置；Task 7 覆盖文档和完整验证。
- **范围控制：** PendingAction、审批 UI/API、plan/apply、后置验证、窄写工具、remediation router、跨主题/history/workflow command 均未进入本计划。
- **类型一致性：** `WikiInspection`、`SourceSearchInput/Result`、`SourceReadInput/Result`、`PageListInput/Result` 在 contracts 定义一次；reader、ToolContext、ToolDef 与测试使用同名签名。
- **分页一致性：** allowedSet 在 limit/cursor 前过滤，避免先分页后过滤造成空页或提前结束。
- **TDD：** 每个行为任务都先写测试、运行确认 RED，再实现并确认 GREEN；配置与文档任务也有可执行验证。

## 执行结果

- 状态：2026-07-10 已按 Tasks 1–7 完成。
- TDD：source staleness、inspect、source search/read、page list、builtin/runtime 与配置一致性测试均先观察到预期 RED，再实现 GREEN。
- 全量测试：`npm test` — 174 个测试文件、1162 个用例全部通过。
- 类型检查：`./node_modules/.bin/tsc --noEmit` — 退出码 0。
- 生产构建：`npm run build` — Next.js 15.5.14 构建成功，32 个静态页面生成完成；首次沙箱运行仅因无法访问 Google Fonts 失败，授权联网重跑后通过。
- 范围审计：未新增数据库迁移、API Route 或客户端 UI；未实现 PendingAction、preview/approve/reject、postcondition verifier、`metadata.patch`、`link.ensure` 或跨 Subject 任意搜索。
