# HTML source 预览脚本放行 + 危险检测 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让已摄入的 HTML source 预览能运行页面自带脚本（`sandbox="allow-scripts"`），用服务端启发式扫描标记可疑页面并回落到锁死静态预览 + 警告条 + 「仍然运行」按钮，raw 路由对 HTML 响应加 CSP 作为运行期硬边界。

**Architecture:** 服务端纯函数 `analyzeHtmlSafety()` 扫描 HTML 高危信号产出 `HtmlSafety`，在组装 source doc / 页面渲染时算好随数据下发；客户端共享组件 `HtmlSourceFrame` 据此决定 iframe 的 `sandbox`（safe 直接 `allow-scripts`，suspicious 锁死 + 可手动放行）。真正的安全边界是 iframe 的 opaque origin（绝不加 `allow-same-origin`）+ raw 路由 CSP，扫描器仅作 UX 提示。

**Tech Stack:** Next.js 15 App Router、React 19、TypeScript、Tailwind（CSS 变量主题）、vitest。零新运行时依赖。

## Global Constraints

- Route Handler 文件顶部必须 `export const runtime = 'nodejs'`（已有，勿删）。
- 客户端组件**禁止**直接 import `@/server/*`；safety 一律服务端算好下发。
- 领域类型集中在 `src/lib/contracts.ts`，不在 server 私有处定义共享类型。
- 任何 iframe 的 `sandbox` **绝不**包含 `allow-same-origin`（否则 opaque origin 失效、沙箱被击穿）。
- 样式走 Tailwind + `cn()`（`@/lib/cn`），颜色用现有 token：`text-danger` / `bg-danger-bg` / `border-danger-border` / `border-danger/40` / `bg-danger/12` / `focus-ring`。
- vitest 配置 `globals: false` —— 测试文件必须显式 `import { describe, expect, it } from 'vitest'`。
- 不引入新依赖；不做 sanitize（不改写页面内容）；不改 PDF/markdown/text 渲染；零 DB 迁移。
- commit message 用中文、一句话总结，不加任何 AI 署名 / Co-Authored-By。

---

### Task 1: `HtmlSafety` 契约 + `analyzeHtmlSafety` 纯函数

**Files:**
- Modify: `src/lib/contracts.ts`（在 `PageSourceDoc` 附近新增类型与字段）
- Create: `src/server/sources/html-safety.ts`
- Test: `src/server/sources/__tests__/html-safety.test.ts`

**Interfaces:**
- Consumes: 无（叶子任务）。
- Produces:
  - `type HtmlRisk = 'safe' | 'suspicious'`
  - `interface HtmlSafety { risk: HtmlRisk; signals: string[] }`
  - `PageSourceDoc.htmlSafety?: HtmlSafety`
  - `analyzeHtmlSafety(html: string): HtmlSafety`（`src/server/sources/html-safety.ts`）

- [ ] **Step 1: 在 contracts 中新增类型与字段**

在 `src/lib/contracts.ts` 中，`export type PageSourceFormat = ...` 这一行之后、`PageSourceDoc` 接口之前，加入：

```ts
export type HtmlRisk = 'safe' | 'suspicious';

export interface HtmlSafety {
  risk: HtmlRisk;
  /** 命中的高危信号的中文人读说明；safe 时为空数组。 */
  signals: string[];
}
```

并在 `PageSourceDoc` 接口内（`text?` 字段之后）加入一行：

```ts
  /** 仅 html 有意义：服务端启发式扫描结论，驱动 iframe sandbox 决策与警告条。 */
  htmlSafety?: HtmlSafety;
```

- [ ] **Step 2: 写失败测试**

创建 `src/server/sources/__tests__/html-safety.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { analyzeHtmlSafety } from '../html-safety';

describe('analyzeHtmlSafety', () => {
  it('纯静态 HTML 判为 safe', () => {
    const html =
      '<!doctype html><html><head><title>Hi</title><style>p{color:red}</style></head>' +
      '<body><h1>标题</h1><p>正文段落</p><a href="https://example.com">链接</a></body></html>';
    const res = analyzeHtmlSafety(html);
    expect(res.risk).toBe('safe');
    expect(res.signals).toEqual([]);
  });

  it('含 eval() 判为 suspicious 并给出说明', () => {
    const res = analyzeHtmlSafety('<script>eval("alert(1)")</script>');
    expect(res.risk).toBe('suspicious');
    expect(res.signals.some((s) => s.includes('eval'))).toBe(true);
  });

  it('含外部脚本判为 suspicious', () => {
    const res = analyzeHtmlSafety('<script src="https://cdn.example.com/a.js"></script>');
    expect(res.risk).toBe('suspicious');
    expect(res.signals.some((s) => s.includes('外部脚本'))).toBe(true);
  });

  it('含 fetch / XHR 判为 suspicious', () => {
    expect(analyzeHtmlSafety('<script>fetch("/x")</script>').risk).toBe('suspicious');
    expect(analyzeHtmlSafety('<script>new XMLHttpRequest()</script>').risk).toBe('suspicious');
  });

  it('含 base64 + atob 混淆判为 suspicious', () => {
    const res = analyzeHtmlSafety('<script>eval(atob("YWxlcnQoMSk="))</script>');
    expect(res.risk).toBe('suspicious');
  });

  it('空串 / 纯空白判为 safe', () => {
    expect(analyzeHtmlSafety('').risk).toBe('safe');
    expect(analyzeHtmlSafety('   \n\t ').risk).toBe('safe');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run src/server/sources/__tests__/html-safety.test.ts`
Expected: FAIL —— 报 `analyzeHtmlSafety` 无法从 `../html-safety` 解析（模块不存在）。

- [ ] **Step 4: 实现 `analyzeHtmlSafety`**

创建 `src/server/sources/html-safety.ts`：

```ts
import type { HtmlSafety } from '@/lib/contracts';

/** 高危信号规则：正则命中即记一条中文说明（大小写不敏感，未用 /g 故无状态问题）。 */
const RULES: { test: RegExp; signal: string }[] = [
  { test: /\beval\s*\(/i, signal: '使用了 eval() 动态执行代码' },
  { test: /\bnew\s+Function\s*\(|\bFunction\s*\(\s*['"]/i, signal: '使用了 Function() 构造动态代码' },
  { test: /document\s*\.\s*write(ln)?\s*\(/i, signal: '使用了 document.write 动态写入' },
  { test: /<script\b[^>]*\bsrc\s*=/i, signal: '引入了外部脚本 <script src>' },
  {
    test: /\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket\s*\(|navigator\s*\.\s*sendBeacon/i,
    signal: '含网络请求（可能外发数据）',
  },
  {
    test: /\batob\s*\(|\bunescape\s*\(|String\s*\.\s*fromCharCode\s*\(/i,
    signal: '含编码/混淆代码（atob / fromCharCode）',
  },
  { test: /<meta\b[^>]*http-equiv\s*=\s*['"]?\s*refresh/i, signal: '含自动跳转 meta refresh' },
  { test: /<(iframe|object|embed)\b/i, signal: '内嵌了其它框架/对象（iframe/object/embed）' },
  {
    test: /location\s*\.\s*(href|replace)\b|window\s*\.\s*open\s*\(|top\s*\.\s*location/i,
    signal: '含页面跳转 / 弹窗',
  },
  { test: /document\s*\.\s*cookie|localStorage|sessionStorage/i, signal: '访问了 cookie / 本地存储' },
];

/** <script> 块内出现超长无空白串视为混淆。 */
const OBFUSCATION = /<script\b[^>]*>[^]*?[^\s'"<>]{1000,}[^]*?<\/script>/i;

/**
 * 启发式扫描 HTML 原文，判断是否含可疑脚本。
 *
 * 注意：这不是安全保证——可被绕过、会误报漏报。真正的边界是 iframe 的
 * opaque origin（sandbox 不含 allow-same-origin）+ raw 路由 CSP。此函数仅作
 * 「是否自动放行脚本」的保守判据与 UX 警告文案来源。
 */
export function analyzeHtmlSafety(html: string): HtmlSafety {
  const signals: string[] = [];
  for (const rule of RULES) {
    if (rule.test.test(html)) signals.push(rule.signal);
  }
  if (OBFUSCATION.test(html)) signals.push('含超长无空白脚本串（疑似混淆）');
  return { risk: signals.length > 0 ? 'suspicious' : 'safe', signals };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/server/sources/__tests__/html-safety.test.ts`
Expected: PASS（6 个用例全绿）。

- [ ] **Step 6: 提交**

```bash
git add src/lib/contracts.ts src/server/sources/html-safety.ts src/server/sources/__tests__/html-safety.test.ts
git commit -m "feat(sources): 新增 HTML 启发式危险扫描 analyzeHtmlSafety + HtmlSafety 契约"
```

---

### Task 2: raw 路由对 HTML 响应加 CSP

**Files:**
- Modify: `src/app/api/sources/[id]/raw/route.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `.html`/`.htm` 的 raw 响应带 `Content-Security-Policy` 头（运行期硬边界，独立于客户端 sandbox 决策）。

- [ ] **Step 1: 加入 CSP 常量**

在 `src/app/api/sources/[id]/raw/route.ts` 顶部、`const CONTENT_TYPES = {...}` 之后加入：

```ts
/**
 * HTML 预览的运行期硬边界：允许页面自带的内联脚本/样式/图片渲染，但禁止外部脚本与
 * 一切对外连接（connect-src 'none' 切断 fetch/XHR/WebSocket/sendBeacon 外发）。
 * 配合 iframe sandbox 的 opaque origin，恶意脚本即便运行也偷不到、发不出。
 */
const HTML_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline' https: http:",
  "img-src 'self' data: https: http:",
  "font-src https: http: data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
```

- [ ] **Step 2: 在非 PDF 分支按扩展名附加 CSP 头**

把文件末尾的非 PDF 返回块：

```ts
  const content = getRawSourceContent(subject.slug, source.filename);
  if (content == null) return NextResponse.json({ error: 'Source file missing' }, { status: 404 });
  return new NextResponse(content, {
    headers: { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=300' },
  });
```

替换为：

```ts
  const content = getRawSourceContent(subject.slug, source.filename);
  if (content == null) return NextResponse.json({ error: 'Source file missing' }, { status: 404 });

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': 'private, max-age=300',
  };
  if (ext === '.html' || ext === '.htm') {
    headers['Content-Security-Policy'] = HTML_CSP;
  }
  return new NextResponse(content, { headers });
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误。

- [ ] **Step 4: 手动验证（运行中开发服务器，需有一个 HTML source 的 id）**

启动 `npm run dev:all`，在浏览器 DevTools Network 中打开任一 HTML source 的 `/api/sources/<id>/raw` 请求，确认响应头含 `content-security-policy: default-src 'none'; ...; connect-src 'none'; ...`；PDF source 的 raw 响应**不含**该头。

- [ ] **Step 5: 提交**

```bash
git add "src/app/api/sources/[id]/raw/route.ts"
git commit -m "feat(sources): HTML raw 响应加 CSP（禁外部脚本与对外连接）"
```

---

### Task 3: `readPageSources` 为 HTML doc 附加 `htmlSafety`

**Files:**
- Modify: `src/server/sources/source-reader.ts`

**Interfaces:**
- Consumes: `analyzeHtmlSafety(html)`（Task 1）；`PageSourceDoc.htmlSafety`（Task 1）。
- Produces: `GET /api/sources?slug=` 返回的 html doc 带 `htmlSafety` 字段（供 Task 5 的 `SourceBody` 消费）。

- [ ] **Step 1: 引入分析函数**

在 `src/server/sources/source-reader.ts` 顶部 import 区，`import { getSourceMetadata, getRawSourceContent } from './source-store';` 之后加入：

```ts
import { analyzeHtmlSafety } from './html-safety';
```

- [ ] **Step 2: 拆分 pdf/html 分支，为 html 算 safety**

把现有合并分支：

```ts
    // pdf / html 在客户端由 iframe 加载完整原始文件（见 wiki-reading-view 的 SourceBody），
    // 这里只下发元数据，不再准备分页文本 / HTML 正文 payload。
    if (format === 'pdf' || format === 'html') {
      docs.push({ ...base, meta: FORMAT_LABEL[format] });
      continue;
    }
```

替换为：

```ts
    // pdf 在客户端由浏览器原生阅读器加载，只下发元数据。
    if (format === 'pdf') {
      docs.push({ ...base, meta: FORMAT_LABEL[format] });
      continue;
    }

    // html：读原文做启发式危险扫描，只下发 verdict（仍不下发 HTML 正文 payload，
    // iframe 通过 /api/sources/<id>/raw 自行加载完整文件）。
    if (format === 'html') {
      const html = getRawSourceContent(subject.slug, src.filename) ?? '';
      docs.push({ ...base, meta: FORMAT_LABEL[format], htmlSafety: analyzeHtmlSafety(html) });
      continue;
    }
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误。

- [ ] **Step 4: 提交**

```bash
git add src/server/sources/source-reader.ts
git commit -m "feat(sources): readPageSources 为 HTML doc 附加 htmlSafety 扫描结论"
```

---

### Task 4: `HtmlSourceFrame` 共享客户端组件

**Files:**
- Create: `src/components/wiki/html-source-frame.tsx`

**Interfaces:**
- Consumes: `HtmlSafety`（Task 1）；`cn`（`@/lib/cn`）。
- Produces: `HtmlSourceFrame` 组件，props `{ src: string; title: string; safety?: HtmlSafety; className?: string }`。`className` 施加在**根容器**上控制尺寸/定位；内部 iframe 始终 `min-h-0 w-full flex-1 border-0 bg-white`。

- [ ] **Step 1: 实现组件**

创建 `src/components/wiki/html-source-frame.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { HtmlSafety } from '@/lib/contracts';

interface HtmlSourceFrameProps {
  /** /api/sources/<id>/raw */
  src: string;
  title: string;
  /** 服务端启发式扫描结论；缺省按 safe 处理。 */
  safety?: HtmlSafety;
  /** 施加在根容器上的尺寸/定位类，沿用各调用点原 iframe 的类名。 */
  className?: string;
}

/**
 * HTML source 预览的统一渲染：
 * - safe（或用户点了「仍然运行」）→ sandbox="allow-scripts"，放行页面自带脚本。
 * - suspicious 且未放行 → 顶部警告条 + sandbox=""（锁死，脚本被浏览器弱化）。
 *
 * 安全边界靠 iframe 的 opaque origin（sandbox 永不含 allow-same-origin）+ raw 路由
 * 的 CSP，不依赖此处的启发式判定。
 */
export function HtmlSourceFrame({ src, title, safety, className }: HtmlSourceFrameProps) {
  const [forceRun, setForceRun] = useState(false);
  const suspicious = safety?.risk === 'suspicious';
  const runScripts = !suspicious || forceRun;

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {suspicious && !forceRun && (
        <div className="shrink-0 border-b border-danger-border bg-danger-bg px-4 py-3 text-xs text-danger">
          <div className="flex items-center gap-2 font-semibold">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            检测到潜在危险脚本，已禁用页面交互
          </div>
          {safety && safety.signals.length > 0 && (
            <ul className="mt-1.5 ml-6 list-disc space-y-0.5 text-danger/90">
              {safety.signals.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() => setForceRun(true)}
            className="mt-2 inline-flex h-7 items-center rounded-md border border-danger/40 px-2.5 font-medium text-danger transition-colors hover:bg-danger/12 focus-ring"
          >
            我了解风险，仍然运行脚本
          </button>
        </div>
      )}
      <iframe
        key={runScripts ? 'run' : 'safe'}
        src={src}
        title={title}
        sandbox={runScripts ? 'allow-scripts' : ''}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增错误（组件此时尚无消费者，独立编译通过）。

- [ ] **Step 3: 提交**

```bash
git add src/components/wiki/html-source-frame.tsx
git commit -m "feat(wiki): 新增 HtmlSourceFrame（HTML 预览 sandbox 决策 + 危险警告条）"
```

---

### Task 5: 阅读页 `SourceBody` 接入 `HtmlSourceFrame`

**Files:**
- Modify: `src/components/wiki/wiki-reading-view.tsx`

**Interfaces:**
- Consumes: `HtmlSourceFrame`（Task 4）；`PageSourceDoc.htmlSafety`（Task 1，由 Task 3 填充）。
- Produces: 无（终端 UI 接线）。

- [ ] **Step 1: 引入组件**

在 `src/components/wiki/wiki-reading-view.tsx` 的 import 区，`import PageRenderer from './page-renderer';` 之后加入：

```ts
import { HtmlSourceFrame } from './html-source-frame';
```

- [ ] **Step 2: 替换 `SourceBody` 的 HTML 分支**

把 `SourceBody` 函数内的 HTML 分支：

```tsx
  if (source.format === 'html') {
    return (
      <iframe
        src={rawUrl}
        title={source.name}
        sandbox=""
        className="h-[80vh] w-full border-0 bg-white lg:h-full"
      />
    );
  }
```

替换为：

```tsx
  if (source.format === 'html') {
    return (
      <HtmlSourceFrame
        src={rawUrl}
        title={source.name}
        safety={source.htmlSafety}
        className="h-[80vh] lg:h-full"
      />
    );
  }
```

- [ ] **Step 3: 类型检查 + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: 无新增错误 / 警告。

- [ ] **Step 4: 提交**

```bash
git add src/components/wiki/wiki-reading-view.tsx
git commit -m "feat(wiki): 阅读页 Sources 面板 HTML 预览接入 HtmlSourceFrame"
```

---

### Task 6: 独立 source 页接入 `HtmlSourceFrame` + 计算 safety

**Files:**
- Modify: `src/app/(app)/_components/source-viewer.tsx`
- Modify: `src/app/(app)/sources/[id]/page.tsx`

**Interfaces:**
- Consumes: `HtmlSourceFrame`（Task 4）；`analyzeHtmlSafety`（Task 1）；`HtmlSafety`（Task 1）。
- Produces: 无（终端 UI 接线）。

- [ ] **Step 1: `SourceViewer` 增加 `htmlSafety` prop 并引入组件**

在 `src/app/(app)/_components/source-viewer.tsx`：

import 区加入（与现有 import 同组）：

```ts
import { HtmlSourceFrame } from '@/components/wiki/html-source-frame';
import type { PageSourceFormat, HtmlSafety } from '@/lib/contracts';
```

（注意：用此行替换原 `import type { PageSourceFormat } from '@/lib/contracts';`，避免重复 import。）

把 `SourceViewerProps` 接口：

```ts
interface SourceViewerProps {
  id: string;
  filename: string;
  format: PageSourceFormat;
  /** Raw text for markdown/text sources (read server-side). */
  content?: string;
}
```

改为：

```ts
interface SourceViewerProps {
  id: string;
  filename: string;
  format: PageSourceFormat;
  /** Raw text for markdown/text sources (read server-side). */
  content?: string;
  /** 仅 html：服务端启发式扫描结论。 */
  htmlSafety?: HtmlSafety;
}
```

把组件签名：

```ts
export function SourceViewer({ id, filename, format, content }: SourceViewerProps) {
```

改为：

```ts
export function SourceViewer({ id, filename, format, content, htmlSafety }: SourceViewerProps) {
```

- [ ] **Step 2: 替换 body 中的 HTML iframe 分支**

把 `SourceViewer` 渲染中的 HTML 分支：

```tsx
      ) : format === 'html' ? (
        <iframe
          src={rawUrl}
          title={filename}
          sandbox=""
          className="min-h-0 flex-1 border-0 bg-white"
        />
      ) : format === 'markdown' ? (
```

替换为：

```tsx
      ) : format === 'html' ? (
        <HtmlSourceFrame src={rawUrl} title={filename} safety={htmlSafety} className="min-h-0 flex-1" />
      ) : format === 'markdown' ? (
```

- [ ] **Step 3: 页面计算 safety 并透传**

在 `src/app/(app)/sources/[id]/page.tsx`：

import 区加入：

```ts
import { analyzeHtmlSafety } from '@/server/sources/html-safety';
```

把：

```ts
  const format = formatFor(source.filename);
  const content =
    format === 'markdown' || format === 'text'
      ? getRawSourceContent(subject.slug, source.filename) ?? undefined
      : undefined;

  return (
    <SourceViewer id={source.id} filename={source.filename} format={format} content={content} />
  );
```

替换为：

```ts
  const format = formatFor(source.filename);
  const content =
    format === 'markdown' || format === 'text'
      ? getRawSourceContent(subject.slug, source.filename) ?? undefined
      : undefined;
  const htmlSafety =
    format === 'html'
      ? analyzeHtmlSafety(getRawSourceContent(subject.slug, source.filename) ?? '')
      : undefined;

  return (
    <SourceViewer
      id={source.id}
      filename={source.filename}
      format={format}
      content={content}
      htmlSafety={htmlSafety}
    />
  );
```

- [ ] **Step 4: 类型检查 + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: 无新增错误 / 警告。

- [ ] **Step 5: 手动验证（端到端）**

启动 `npm run dev:all`：
1. 摄入一个纯静态 HTML（仅文本/样式）→ 独立 source 页与阅读页 split 面板均直接以脚本渲染、无警告条。
2. 摄入一个带 `<script>fetch(...)</script>` 或 `eval(...)` 的 HTML → 两处均显示红色警告条 + 锁死静态视图 + 信号列表；点「我了解风险，仍然运行脚本」后 iframe 重挂、脚本生效。
3. DevTools 确认 iframe 内 `fetch` 被 `connect-src 'none'` 拦截。

- [ ] **Step 6: 提交**

```bash
git add "src/app/(app)/_components/source-viewer.tsx" "src/app/(app)/sources/[id]/page.tsx"
git commit -m "feat(sources): 独立 source 页 HTML 预览接入 HtmlSourceFrame + 计算 safety"
```

---

## Self-Review

**1. Spec coverage（spec 各节 → 任务映射）：**
- 二（安全模型：sandbox allow-scripts 无 allow-same-origin + CSP）→ Task 4（sandbox 决策）+ Task 2（CSP）。
- 三（数据流：服务端算 safety 随 doc/prop 下发）→ Task 3（readPageSources）+ Task 6（页面 prop）。
- 四（文件改动清单）→ 全部 6 个任务逐一覆盖（contracts/html-safety/test/source-reader/sources page/source-viewer/wiki-reading-view/html-source-frame/raw route）。
- 五（契约 HtmlSafety + PageSourceDoc.htmlSafety）→ Task 1。
- 六（检测信号）→ Task 1 的 `RULES` + `OBFUSCATION`（覆盖 eval/Function/document.write/外部脚本/网络外发/编码混淆/meta refresh/嵌套/导航弹窗/存储凭据）。
- 七（HtmlSourceFrame 契约：runScripts 逻辑、永不 allow-same-origin、key 重挂、className 复用）→ Task 4。
- 八（CSP 具体指令）→ Task 2 的 `HTML_CSP`，逐条对齐。
- 十（测试与验收）→ Task 1 单测 6 项 + Task 2/6 手动验收步骤。

**2. Placeholder scan：** 无 TBD/TODO；每个代码步骤均给出完整可粘贴代码与确切命令/预期。

**3. Type consistency：** `HtmlSafety`/`HtmlRisk` 定义（Task 1）与各处 import 一致；`analyzeHtmlSafety(html: string): HtmlSafety` 在 Task 3/6 调用签名一致；`HtmlSourceFrame` props（Task 4）与 Task 5/6 调用点传参（`src`/`title`/`safety`/`className`）一致；`PageSourceDoc.htmlSafety`（Task 1 定义、Task 3 填充、Task 5 读取）字段名一致。

**4. 顺序无中途类型断裂：** Task 6 把 `SourceViewer` 加 prop 与「页面传 prop」放在同一任务，避免中间态 TS 报错；其余任务新增字段/组件均为可选或无消费者，独立编译通过。
