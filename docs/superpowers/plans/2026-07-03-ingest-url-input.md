# Ingest 支持 URL 输入 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /api/ingest` 支持批量 URL 输入：路由内同步抓取网页 → 存为 raw source（`.html/.md/.txt`）→ 每个成功 URL 独立入队一个 ingest job；ingest workbench 加 URL 输入模式。

**Architecture:** 抓到的 HTML 存成 `.html` 后缀 raw source，现有 `parser-registry`（turndown html-parser）自动接管，ingest 流水线零改动。新增 `url-fetcher.ts`（fetch + 守卫 + content-type 分派，纯逻辑与 IO 分离）与 `url-ingest.ts`（批量编排，依赖注入便于测试）；路由只做校验 + 组装。

**Tech Stack:** Next.js 15 Route Handler（nodejs runtime）、原生 fetch、vitest。

**Spec:** `docs/superpowers/specs/2026-07-03-ingest-url-input-design.md`

## Global Constraints

- 仅允许 `http:`/`https:` 协议；抓取超时 10s；响应体 ≤ 5MB；批量上限 20 条 URL。
- `urls` 与 `text` 互斥（同时给 → 400）；至少一个成功 → 202；全部失败 → 422。
- 既有 file/text 分支的请求/响应形状完全不变。
- 生成代码用中文注释；commit message 用中文一句话。
- 测试命令：`npx vitest run <path>`；类型检查 `npx tsc --noEmit`（不要用 `npm run lint`，已知不可用）。

---

### Task 1: `url-fetcher.ts` — 抓取器（纯逻辑 + fetch 壳）

**Files:**
- Create: `src/server/sources/url-fetcher.ts`
- Create: `src/server/sources/__tests__/url-fetcher.test.ts`
- Modify: `src/server/services/ingest-service.ts:355-369`（`filenameFromUrl` 改为薄包装，DRY）

**Interfaces:**
- Produces:
  - `validateHttpUrl(raw: string): URL` — 非法/非 http(s) 抛 `Error`
  - `extensionForContentType(contentType: string): '.html' | '.md' | '.txt' | null` — null 表示拒绝的非文本类型
  - `deriveUrlFilename(url: string, ext: string): string` — `web-<host>-<末段>-<hash8><ext>`
  - `fetchUrlSource(url: string, fetchImpl?: typeof fetch): Promise<{ filename: string; content: string }>`
  - 常量 `URL_FETCH_TIMEOUT_MS = 10_000`、`MAX_URL_BYTES = 5 * 1024 * 1024`

- [ ] **Step 1: 写失败测试**

`src/server/sources/__tests__/url-fetcher.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  validateHttpUrl,
  extensionForContentType,
  deriveUrlFilename,
  fetchUrlSource,
  MAX_URL_BYTES,
} from '../url-fetcher';

function fakeFetch(opts: { status?: number; contentType?: string; body?: string; bytes?: number }) {
  const body = opts.body ?? '<html><body>hi</body></html>';
  const buf = opts.bytes ? Buffer.alloc(opts.bytes, 'a') : Buffer.from(body, 'utf-8');
  return vi.fn(async () =>
    new Response(new Uint8Array(buf), {
      status: opts.status ?? 200,
      headers: { 'content-type': opts.contentType ?? 'text/html; charset=utf-8' },
    }),
  ) as unknown as typeof fetch;
}

describe('validateHttpUrl', () => {
  it('接受 http/https', () => {
    expect(validateHttpUrl('https://example.com/a').hostname).toBe('example.com');
  });
  it('拒绝非 http(s) 协议与非法 URL', () => {
    expect(() => validateHttpUrl('ftp://example.com')).toThrow();
    expect(() => validateHttpUrl('not-a-url')).toThrow();
  });
});

describe('extensionForContentType', () => {
  it('按 content-type 分派扩展名', () => {
    expect(extensionForContentType('text/html; charset=utf-8')).toBe('.html');
    expect(extensionForContentType('application/xhtml+xml')).toBe('.html');
    expect(extensionForContentType('text/markdown')).toBe('.md');
    expect(extensionForContentType('text/plain')).toBe('.txt');
    expect(extensionForContentType('')).toBe('.html'); // 未声明按 html 处理
    expect(extensionForContentType('image/png')).toBeNull();
    expect(extensionForContentType('application/pdf')).toBeNull();
  });
});

describe('deriveUrlFilename', () => {
  it('派生 web-<host>-<末段>-<hash><ext>，同 URL 稳定', () => {
    const a = deriveUrlFilename('https://www.example.com/docs/Intro?x=1', '.html');
    expect(a).toMatch(/^web-example\.com-intro-[0-9a-f]{8}\.html$/);
    expect(deriveUrlFilename('https://www.example.com/docs/Intro?x=1', '.html')).toBe(a);
  });
  it('无路径/非法输入回落 page 兜底', () => {
    expect(deriveUrlFilename('::::', '.txt')).toMatch(/^web-page-[0-9a-f]{8}\.txt$/);
  });
});

describe('fetchUrlSource', () => {
  it('HTML 页面存为 .html，正文原样返回', async () => {
    const f = fakeFetch({ body: '<h1>Doc</h1>' });
    const out = await fetchUrlSource('https://example.com/doc', f);
    expect(out.filename).toMatch(/\.html$/);
    expect(out.content).toBe('<h1>Doc</h1>');
  });
  it('markdown content-type 存为 .md', async () => {
    const f = fakeFetch({ contentType: 'text/markdown', body: '# hi' });
    const out = await fetchUrlSource('https://example.com/readme', f);
    expect(out.filename).toMatch(/\.md$/);
  });
  it('非 2xx 报错', async () => {
    const f = fakeFetch({ status: 404 });
    await expect(fetchUrlSource('https://example.com/x', f)).rejects.toThrow(/404/);
  });
  it('非文本 content-type 拒绝', async () => {
    const f = fakeFetch({ contentType: 'image/png' });
    await expect(fetchUrlSource('https://example.com/x', f)).rejects.toThrow(/content-type/i);
  });
  it('响应体超 5MB 拒绝', async () => {
    const f = fakeFetch({ bytes: MAX_URL_BYTES + 1 });
    await expect(fetchUrlSource('https://example.com/x', f)).rejects.toThrow(/too large/i);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/sources/__tests__/url-fetcher.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/server/sources/url-fetcher.ts`**

```ts
import { createHash } from 'crypto';

/** URL 抓取守卫常量：超时 10s、响应体上限 5MB。 */
export const URL_FETCH_TIMEOUT_MS = 10_000;
export const MAX_URL_BYTES = 5 * 1024 * 1024;

/** 校验并解析 http(s) URL；非法或非 http(s) 协议抛错。 */
export function validateHttpUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${u.protocol}`);
  }
  return u;
}

/**
 * content-type → 保存扩展名分派。存 .html 让现有 turndown html-parser 接管；
 * null 表示非文本类型，调用方应拒绝。未声明 content-type 的按 html 处理（多数网页）。
 */
export function extensionForContentType(contentType: string): '.html' | '.md' | '.txt' | null {
  const ct = contentType.split(';')[0].trim().toLowerCase();
  if (ct === '' || ct === 'text/html' || ct === 'application/xhtml+xml') return '.html';
  if (ct === 'text/markdown' || ct === 'text/x-markdown') return '.md';
  if (ct.startsWith('text/')) return '.txt';
  return null;
}

/** 从 URL 派生安全文件名（host + 末段 + 短 hash + 指定扩展名）。 */
export function deriveUrlFilename(url: string, ext: string): string {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 8);
  let base = 'page';
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    base = `${host}-${last}`
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    base = base.slice(0, 80) || 'page';
  } catch {
    base = 'page';
  }
  return `web-${base}-${hash}${ext}`;
}

/**
 * 抓取网页并按 content-type 决定保存格式。
 * 守卫：http(s) 协议、超时、content-length/实际体积 ≤ 5MB、仅文本类型。
 */
export async function fetchUrlSource(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ filename: string; content: string }> {
  validateHttpUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), URL_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!resp.ok) throw new Error(`Fetch failed: HTTP ${resp.status}`);

    const contentType = resp.headers.get('content-type') ?? '';
    const ext = extensionForContentType(contentType);
    if (!ext) throw new Error(`Unsupported content-type: ${contentType || 'unknown'}`);

    const declared = Number(resp.headers.get('content-length') ?? 0);
    if (declared > MAX_URL_BYTES) throw new Error('Response too large (max 5MB)');
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength > MAX_URL_BYTES) throw new Error('Response too large (max 5MB)');

    return { filename: deriveUrlFilename(url, ext), content: buf.toString('utf-8') };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Fetch timed out after ${URL_FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: DRY — `ingest-service.ts::filenameFromUrl` 改为薄包装**

把 `src/server/services/ingest-service.ts` 的 `filenameFromUrl` 函数体（356-369 行）替换为：

```ts
/** 从 URL 派生安全的 .md 文件名（host + 末段 + 短 hash）。 */
export function filenameFromUrl(url: string): string {
  return deriveUrlFilename(url, '.md');
}
```

并在该文件顶部 import 区加：

```ts
import { deriveUrlFilename } from '../sources/url-fetcher';
```

- [ ] **Step 5: 跑测试与回归**

Run: `npx vitest run src/server/sources/__tests__/url-fetcher.test.ts src/server/services/__tests__/`
Expected: 新测试 PASS；ingest-service 既有测试（含 `filenameFromUrl`）PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/sources/url-fetcher.ts src/server/sources/__tests__/url-fetcher.test.ts src/server/services/ingest-service.ts
git commit -m "feat(sources): 新增 url-fetcher（抓取守卫 + content-type 分派），filenameFromUrl 改薄包装"
```

---

### Task 2: `url-ingest.ts` — 批量编排（校验 + allSettled 落盘入队）+ source 溯源 URL

**Files:**
- Create: `src/server/sources/url-ingest.ts`
- Create: `src/server/sources/__tests__/url-ingest.test.ts`
- Modify: `src/server/sources/source-store.ts:13,37-92`（`saveRawSource` 加可选 `extra` 参，sidecar 记 `originUrl`）

**Interfaces:**
- Consumes: Task 1 的 `fetchUrlSource` / `validateHttpUrl`
- Produces:
  - `MAX_URLS_PER_REQUEST = 20`
  - `validateUrlList(input: unknown): { urls: string[] } | { error: string }` — 去空/trim/去重/逐条协议校验/上限
  - `interface UrlIngestResult { url: string; jobId?: string; sourceId?: string; error?: string }`
  - `ingestUrlBatch(urls: string[], deps): Promise<UrlIngestResult[]>`，其中
    `deps = { fetchSource: (url) => Promise<{filename, content}>; save: (filename, content, url) => { id: string }; enqueue: (sourceId, filename) => { id: string } }`
  - `saveRawSource(subject, filename, content, extra?: { originUrl?: string })` — 第 4 参可选，向后兼容

- [ ] **Step 0: `source-store.ts` 支持 originUrl 溯源**

`src/server/sources/source-store.ts`：

1. `interface SourceMetadataFile`（13 行附近）加可选字段：

```ts
  /** 网页来源的原始 URL（URL ingest 溯源用）。 */
  originUrl?: string;
```

2. `saveRawSource` 签名加第 4 参：

```ts
export function saveRawSource(
  subject: Pick<Subject, 'id' | 'slug'>,
  filename: string,
  content: Buffer | string,
  extra?: { originUrl?: string },
): SavedSourceResult {
```

3. `metaContent` 构造处（72 行附近）在 `savedAt` 之后加：

```ts
    ...(extra?.originUrl ? { originUrl: extra.originUrl } : {}),
```

既有调用方不传第 4 参，行为不变。

- [ ] **Step 1: 写失败测试**

`src/server/sources/__tests__/url-ingest.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { validateUrlList, ingestUrlBatch, MAX_URLS_PER_REQUEST } from '../url-ingest';

describe('validateUrlList', () => {
  it('trim、去空行、去重', () => {
    const r = validateUrlList([' https://a.com ', '', 'https://a.com', 'https://b.com']);
    expect(r).toEqual({ urls: ['https://a.com', 'https://b.com'] });
  });
  it('非数组 / 空数组 / 非字符串项报错', () => {
    expect(validateUrlList('x')).toHaveProperty('error');
    expect(validateUrlList([])).toHaveProperty('error');
    expect(validateUrlList([42])).toHaveProperty('error');
  });
  it('含非法 URL 报错并指明该条', () => {
    const r = validateUrlList(['ftp://a.com']);
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toContain('ftp://a.com');
  });
  it('超上限报错', () => {
    const many = Array.from({ length: MAX_URLS_PER_REQUEST + 1 }, (_, i) => `https://a.com/${i}`);
    expect(validateUrlList(many)).toHaveProperty('error');
  });
});

describe('ingestUrlBatch', () => {
  const okDeps = {
    fetchSource: async (url: string) => ({ filename: `f-${url.slice(-1)}.html`, content: 'x' }),
    save: (filename: string) => ({ id: `src-${filename}` }),
    enqueue: (sourceId: string) => ({ id: `job-${sourceId}` }),
  };
  it('全部成功：每条带 jobId/sourceId', async () => {
    const r = await ingestUrlBatch(['https://a.com/1', 'https://a.com/2'], okDeps);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ url: 'https://a.com/1', sourceId: 'src-f-1.html', jobId: 'job-src-f-1.html' });
  });
  it('部分失败：失败条目带 error，不影响其他', async () => {
    const deps = {
      ...okDeps,
      fetchSource: async (url: string) => {
        if (url.endsWith('bad')) throw new Error('HTTP 404');
        return { filename: 'ok.html', content: 'x' };
      },
    };
    const r = await ingestUrlBatch(['https://a.com/bad', 'https://a.com/ok'], deps);
    expect(r[0]).toEqual({ url: 'https://a.com/bad', error: 'HTTP 404' });
    expect(r[1].jobId).toBeDefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/sources/__tests__/url-ingest.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/server/sources/url-ingest.ts`**

```ts
import { validateHttpUrl } from './url-fetcher';

/** 单次请求 URL 条数上限。 */
export const MAX_URLS_PER_REQUEST = 20;

export interface UrlIngestResult {
  url: string;
  jobId?: string;
  sourceId?: string;
  error?: string;
}

export interface UrlIngestDeps {
  fetchSource: (url: string) => Promise<{ filename: string; content: string }>;
  save: (filename: string, content: string, url: string) => { id: string };
  enqueue: (sourceId: string, filename: string) => { id: string };
}

/** 校验 urls 请求体：trim / 去空 / 去重 / 协议校验 / 上限。 */
export function validateUrlList(input: unknown): { urls: string[] } | { error: string } {
  if (!Array.isArray(input) || input.length === 0) {
    return { error: '"urls" must be a non-empty array of strings' };
  }
  const urls: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') return { error: '"urls" must be a non-empty array of strings' };
    const trimmed = item.trim();
    if (!trimmed) continue;
    try {
      validateHttpUrl(trimmed);
    } catch (err) {
      return { error: `Invalid URL "${trimmed}": ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!urls.includes(trimmed)) urls.push(trimmed);
  }
  if (urls.length === 0) return { error: '"urls" contains no usable URLs' };
  if (urls.length > MAX_URLS_PER_REQUEST) {
    return { error: `Too many URLs (${urls.length}); maximum is ${MAX_URLS_PER_REQUEST}` };
  }
  return { urls };
}

/** 逐 URL 抓取→落盘→入队；单条失败不阻断其余（allSettled 语义）。 */
export async function ingestUrlBatch(urls: string[], deps: UrlIngestDeps): Promise<UrlIngestResult[]> {
  const settled = await Promise.allSettled(
    urls.map(async (url) => {
      const { filename, content } = await deps.fetchSource(url);
      const { id: sourceId } = deps.save(filename, content, url);
      const { id: jobId } = deps.enqueue(sourceId, filename);
      return { url, sourceId, jobId } satisfies UrlIngestResult;
    }),
  );
  return settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { url: urls[i], error: s.reason instanceof Error ? s.reason.message : String(s.reason) },
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/sources/__tests__/url-ingest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/sources/url-ingest.ts src/server/sources/__tests__/url-ingest.test.ts src/server/sources/source-store.ts
git commit -m "feat(sources): 新增 url-ingest 批量编排 + saveRawSource 记 originUrl 溯源"
```

---

### Task 3: `POST /api/ingest` 新增 `urls` 分支

**Files:**
- Modify: `src/app/api/ingest/route.ts`

**Interfaces:**
- Consumes: Task 1 `fetchUrlSource`、Task 2 `validateUrlList` / `ingestUrlBatch`、现有 `saveRawSource` / `queue.enqueue` / `resolveSubjectFromRequest`。
- Produces（前端依赖的响应契约）：
  - `202 { results: UrlIngestResult[], subjectId, subjectSlug }`（≥1 成功）
  - `422 { error: 'All URLs failed', results }`（全部失败）
  - `400 { error }`（校验失败 / 与 `text` 互斥）
  - file/text 分支响应保持 `{ jobId, sourceId, subjectId, subjectSlug }` 不变。

- [ ] **Step 1: 修改路由**

在 `src/app/api/ingest/route.ts` 顶部 import 区加：

```ts
import { fetchUrlSource } from '@/server/sources/url-fetcher';
import { validateUrlList, ingestUrlBatch } from '@/server/sources/url-ingest';
```

把 JSON 分支（原 `const body = await request.json() ...` 之后）改为先处理 urls：

```ts
    } else {
      const body = await request.json() as {
        text?: string;
        filename?: string;
        urls?: unknown;
        subjectId?: string;
        subjectSlug?: string;
      };

      // ── URL 批量分支：与 text 互斥 ──────────────────────────────
      if (body.urls !== undefined) {
        if (body.text !== undefined) {
          return NextResponse.json(
            { error: 'Provide either "urls" or "text", not both' },
            { status: 400 },
          );
        }
        const validated = validateUrlList(body.urls);
        if ('error' in validated) {
          return NextResponse.json({ error: validated.error }, { status: 400 });
        }
        const resolution = resolveSubjectFromRequest(request, { body });
        if (resolution.error) return resolution.error;
        const { subject } = resolution;

        const results = await ingestUrlBatch(validated.urls, {
          fetchSource: (url) => fetchUrlSource(url),
          save: (filename, content, url) => saveRawSource(subject, filename, content, { originUrl: url }),
          enqueue: (sourceId, filename) =>
            queue.enqueue('ingest', { sourceId, filename, subjectId: subject.id }, subject.id),
        });

        const anySuccess = results.some((r) => r.jobId);
        return NextResponse.json(
          anySuccess
            ? { results, subjectId: subject.id, subjectSlug: subject.slug }
            : { error: 'All URLs failed', results },
          { status: anySuccess ? 202 : 422 },
        );
      }

      const { text, filename: jsonFilename } = body;
      // …… 以下原 text 校验逻辑不动 ……
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: 手动冒烟（dev server 已在跑时可选；否则 `npm run dev` 临时起一个）**

```bash
curl -s -X POST http://localhost:3000/api/ingest \
  -H 'Content-Type: application/json' \
  -d '{"urls":["https://example.com/", "ftp://bad"]}' | head -c 400
```

Expected: `400` 且 error 指明 `ftp://bad`；换成仅 `["https://example.com/"]` 时返回 `202` 且 `results[0].jobId` 存在。

- [ ] **Step 4: Commit**

```bash
git add src/app/api/ingest/route.ts
git commit -m "feat(api): POST /api/ingest 支持 urls 批量输入（202 部分成功 / 422 全失败）"
```

---

### Task 4: 前端 — ingest workbench 加 URL 模式

**Files:**
- Create: `src/lib/url-list.ts`
- Create: `src/lib/__tests__/url-list.test.ts`
- Modify: `src/app/(app)/_components/ingest-workbench.tsx`

**Interfaces:**
- Consumes: Task 3 的响应契约（`results: { url, jobId?, sourceId?, error? }[]`）。
- Produces: `parseUrlLines(text: string): { urls: string[]; invalid: string[] }` — 按行拆分、trim、去空、去重、`^https?://` 前缀校验。

- [ ] **Step 1: 写失败测试**

`src/lib/__tests__/url-list.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { parseUrlLines } from '../url-list';

describe('parseUrlLines', () => {
  it('按行拆分、trim、去空、去重', () => {
    const r = parseUrlLines(' https://a.com \n\nhttps://b.com\nhttps://a.com');
    expect(r.urls).toEqual(['https://a.com', 'https://b.com']);
    expect(r.invalid).toEqual([]);
  });
  it('非 https?:// 前缀的行归入 invalid', () => {
    const r = parseUrlLines('https://ok.com\nftp://bad\nnot a url');
    expect(r.urls).toEqual(['https://ok.com']);
    expect(r.invalid).toEqual(['ftp://bad', 'not a url']);
  });
  it('全空输入返回双空数组', () => {
    expect(parseUrlLines('  \n ')).toEqual({ urls: [], invalid: [] });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/__tests__/url-list.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/lib/url-list.ts`**

```ts
/** 多行 URL 输入解析：按行拆分、trim、去空、去重、http(s) 前缀校验。 */
export function parseUrlLines(text: string): { urls: string[]; invalid: string[] } {
  const urls: string[] = [];
  const invalid: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (!/^https?:\/\//i.test(t)) {
      invalid.push(t);
    } else if (!urls.includes(t)) {
      urls.push(t);
    }
  }
  return { urls, invalid };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/__tests__/url-list.test.ts`
Expected: PASS

- [ ] **Step 5: workbench 加 URL 模式**

修改 `src/app/(app)/_components/ingest-workbench.tsx`：

1. import 区加：

```ts
import { Link2 } from 'lucide-react';
import { parseUrlLines } from '@/lib/url-list';
```

2. mode 联合与新状态（`useState` 区）：

```ts
const [mode, setMode] = useState<'file' | 'text' | 'url'>('file');
const [urlInput, setUrlInput] = useState('');
const [urlResults, setUrlResults] = useState<
  Array<{ url: string; jobId?: string; sourceId?: string; error?: string }> | null
>(null);
```

3. `reset` 回调里追加清空：`setUrlInput(''); setUrlResults(null);`

4. `handleStart` 中在 text 分支前插入 url 分支：

```ts
    if (mode === 'url') {
      const { urls, invalid } = parseUrlLines(urlInput);
      if (invalid.length > 0) {
        setError(`Invalid URLs (must start with http:// or https://): ${invalid.join(', ')}`);
        return;
      }
      if (urls.length === 0) {
        setError('Please enter at least one URL.');
        return;
      }
      setError(null);
      setCreatedPages([]);
      setUrlResults(null);
      setUploading(true);
      try {
        const subjectId = useUIStore.getState().currentSubjectId;
        const res = await apiFetch('/api/ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subjectId ? { urls, subjectId } : { urls }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok && res.status !== 422) {
          throw new Error(data.error || `Submit failed (${res.status})`);
        }
        const results = (data.results ?? []) as Array<{ url: string; jobId?: string; error?: string }>;
        const jobIds = results.filter((r) => r.jobId).map((r) => r.jobId!);
        // 通知全局 ProgressToast 追踪每个后台 job
        for (const id of jobIds) {
          window.dispatchEvent(new CustomEvent('wiki:job-started', { detail: { jobId: id } }));
        }
        if (jobIds.length === 1 && results.length === 1) {
          // 单 URL 全成功：直接进入现有 live view
          setSourceName(results[0].url);
          setJobId(jobIds[0]);
        } else {
          // 批量：留在本页展示逐条结果（jobs 在后台跑，toast 追踪）
          setUrlResults(results);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploading(false);
      }
      return;
    }
```

5. Tabs 加第三个选项（`TabsList` 内）：

```tsx
<TabsTrigger value="url">URL</TabsTrigger>
```

并把 `onValueChange` 的断言改为 `(v) => setMode(v as 'file' | 'text' | 'url')`。

6. 输入区：把 `mode === 'file' ? (...) : (...)` 三元改为 file / url / text 三分支，url 分支渲染：

```tsx
) : mode === 'url' ? (
  <div className="flex flex-col gap-3">
    <Textarea
      rows={7}
      autoFocus
      placeholder={'One URL per line, e.g.\nhttps://example.com/article\nhttps://docs.example.com/guide'}
      value={urlInput}
      onChange={(e) => setUrlInput(e.target.value)}
      aria-label="URLs to ingest, one per line"
    />
    <span className="font-mono text-xs text-foreground-tertiary">
      Up to 20 URLs · fetched server-side · 5 MB per page
    </span>
  </div>
) : (
```

7. `canStart` 扩展：

```ts
const canStart =
  mode === 'file' ? !!selectedFile : mode === 'url' ? !!urlInput.trim() : !!textInput.trim();
```

8. 批量结果面板：在 error 段（`{error && ...}`）之后加：

```tsx
{urlResults && (
  <div className="flex flex-col gap-1.5 rounded-md border border-border bg-canvas p-3">
    <span className="text-xs font-semibold text-foreground">
      {urlResults.filter((r) => r.jobId).length}/{urlResults.length} URLs queued
    </span>
    <ul className="flex flex-col gap-1">
      {urlResults.map((r) => (
        <li key={r.url} className="flex items-start gap-2 text-xs">
          <Link2
            className={cn('mt-0.5 h-3 w-3 shrink-0', r.jobId ? 'text-accent' : 'text-danger')}
            aria-hidden
          />
          <span className="min-w-0">
            <span className="break-all font-mono text-foreground-secondary">{r.url}</span>
            {r.error && <span className="text-danger"> — {r.error}</span>}
            {r.jobId && <span className="text-foreground-tertiary"> — queued</span>}
          </span>
        </li>
      ))}
    </ul>
    <span className="text-xs text-foreground-tertiary">
      Jobs run in the background — watch progress in the corner toast.
    </span>
  </div>
)}
```

- [ ] **Step 6: 类型检查 + 手动验证**

Run: `npx tsc --noEmit` → 0 errors。
浏览器打开 `/ingest`：URL tab 可见；粘贴 1 个合法 URL 提交 → 进入 live view；粘贴多个（含一个坏 URL 域名）→ 显示逐条结果面板，成功项 toast 追踪。

- [ ] **Step 7: Commit**

```bash
git add src/lib/url-list.ts src/lib/__tests__/url-list.test.ts 'src/app/(app)/_components/ingest-workbench.tsx'
git commit -m "feat(ui): ingest workbench 新增 URL 输入模式（多行批量 + 逐条结果面板）"
```

---

### Task 5: 全量回归 + 文档

**Files:**
- Modify: `CLAUDE.md`（根，变更记录表加一行）
- Modify: `src/app/CLAUDE.md`（`/api/ingest` 行 + Changelog）
- Modify: `src/server/sources/CLAUDE.md`（文件清单 + Changelog）

- [ ] **Step 1: 全量测试 + 类型检查**

```bash
npx vitest run && npx tsc --noEmit
```

Expected: 全部 PASS、0 type errors。

- [ ] **Step 2: 更新三处 CLAUDE.md**

- 根 `CLAUDE.md` 变更记录表末尾加一行：`| 2026-07-03 | Ingest 支持 URL 输入 | POST /api/ingest 新增 urls[] 批量分支（路由内同步抓取 → .html/.md/.txt raw source → 每 URL 独立 ingest job，202 部分成功/422 全失败）；新增 sources/url-fetcher（协议/超时10s/5MB/content-type 守卫）+ url-ingest（校验+allSettled 编排）+ lib/url-list；workbench 加 URL tab；流水线零改动。spec/plan 见 docs/superpowers/{specs,plans}/2026-07-03-ingest-url-input* |`
- `src/app/CLAUDE.md`：`/api/ingest` 表格行说明追加 "或 JSON `{ urls: string[] }` 批量 URL（≤20，路由内同步抓取）"；Changelog 加对应行。
- `src/server/sources/CLAUDE.md`：文件清单加 `url-fetcher.ts` / `url-ingest.ts` 两行；Changelog 加对应行。

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md src/app/CLAUDE.md src/server/sources/CLAUDE.md
git commit -m "docs: 同步 URL ingest 变更到三级 CLAUDE.md"
```
