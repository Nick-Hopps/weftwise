# HTML source 预览脚本放行 + 危险检测 — 设计

> 让已摄入的 HTML source 在预览时能运行脚本（`sandbox="allow-scripts"`），同时用启发式扫描标记可疑页面；可疑时回落到锁死静态预览 + 警告条 + 「仍然运行」按钮。真正的安全边界是 sandbox（opaque origin）+ CSP，而非扫描器。

日期：2026-06-23
状态：设计已确认

---

## 一、背景与目标

当前两处 HTML source 预览都用 `<iframe src={rawUrl} sandbox="" />`（`source-viewer.tsx:81`、`wiki-reading-view.tsx` 的 `SourceBody`）。`sandbox=""` 完全锁死——脚本、表单、弹窗、同源全禁，所以带 JS 的网页存档渲染不出交互内容。

**目标**：
- HTML 预览能运行页面自带脚本（放行 `allow-scripts`），让网页存档接近原貌。
- 服务端启发式扫描 HTML，标记 `safe` / `suspicious`。
- 命中 `suspicious` 时不自动跑脚本，而是回落到锁死静态预览（`sandbox=""`，脚本被浏览器弱化），顶部红色警告条列出命中信号，并提供「我了解风险，仍然运行脚本」按钮按需放行。
- raw 路由对 HTML 响应统一加 CSP 作为运行期硬边界。

**非目标**：
- 不覆盖"实时网页 URL"预览（本期只针对已摄入的 HTML source 文件）。
- 不做 sanitize（不剥离/改写页面内容，保持忠实预览）。
- 不引入新的运行时依赖（无 parse5 / DOMPurify）。
- 不引入全局开关设置（保守默认 + run-anyway 已足够）。
- 不改 PDF / markdown / text 三类 source 的渲染。

---

## 二、安全模型（两层，缺一不可）

| 层 | 机制 | 作用 |
|---|---|---|
| **真边界**（兜底） | `sandbox="allow-scripts"`，**绝不**加 `allow-same-origin` → iframe 拿到 opaque（null）origin：访问不到父页 DOM、读不到 app 的 HttpOnly `wiki_session` cookie、发出的请求不带 app 凭据。raw 路由对 HTML 响应加 **CSP**，核心 `connect-src 'none'` 切断 fetch/XHR/WebSocket/sendBeacon 外发通道。 | 即便脚本是恶意的，也跑不出 iframe、偷不到东西、发不出去 |
| **提示层**（启发式） | 服务端纯函数 `analyzeHtmlSafety()` 扫一组高危信号 → `safe` / `suspicious` + 命中说明 | 给用户"这页有可疑脚本"的判断，决定是否自动放行脚本 |

> **诚实声明**：静态扫描 JS "危险代码" 本质不可靠（`eval` / `atob` / 字符串拼接 / 动态注入可绕过任何关键字黑名单），既会误报也会漏报。扫描器**不是**安全保证；真正拦住坏事的是 sandbox + CSP。扫描器仅作 UX 提示与"是否自动信任到可放行脚本"的保守判据。

**为什么 same-origin 仍安全**：iframe 的 `src` 是 `/api/sources/[id]/raw`，与 app 同源。但只要 sandbox **不含** `allow-same-origin`，浏览器即赋予该文档 opaque origin，按跨源处理——拿不到父页、拿不到 app 同源的 cookie/localStorage。这是放行脚本的安全前提，方案中任何 iframe **都不得**出现 `allow-same-origin`。

---

## 三、数据流

```
服务端组装 source doc 时读 HTML 原文 → analyzeHtmlSafety() → htmlSafety {risk, signals[]}
   ├─ readPageSources()  →  PageSourceDoc.htmlSafety  →  GET /api/sources?slug=  →  wiki-reading-view SourceBody
   └─ (app)/sources/[id]/page.tsx  →  prop htmlSafety  →  SourceViewer
                                                              ↓
                                          <HtmlSourceFrame>（新建共享客户端组件）
   risk === 'safe'       → <iframe sandbox="allow-scripts">（直接放行脚本）
   risk === 'suspicious' → 顶部红色警告条（列出命中信号）
                           + <iframe sandbox="">（锁死静态预览）
                           + 「我了解风险，仍然运行脚本」按钮 → setForceRun(true) → 重挂为 allow-scripts
```

- safety 在**服务端**算好随 doc / prop 下发，客户端不再二次请求 HTML 原文。
- raw 路由对**所有** HTML 响应统一加 CSP（无论客户端最终用哪种 sandbox），因此也顺带硬化了 header 里 `Open raw` 直开新标签页的路径（CSP 在那个 top-level 文档同样生效）。
- `getRawSourceContent` 读不到文件时，`analyzeHtmlSafety` 收到空串 → `safe`（无信号）；iframe 自身 404 由浏览器处理。

---

## 四、组件与文件改动（聚焦、零新依赖）

### 新增

| 文件 | 职责 |
|---|---|
| `src/server/sources/html-safety.ts` | 纯函数 `analyzeHtmlSafety(html: string): HtmlSafety`，正则/字符串扫描高危信号 |
| `src/server/sources/__tests__/html-safety.test.ts` | 单测：clean→safe；eval / 外部脚本 / fetch / 混淆 base64→suspicious；空串→safe |
| `src/components/wiki/html-source-frame.tsx` | 共享客户端组件：iframe + 警告条 + run-anyway 状态，封装 sandbox 决策，两处复用 |

### 改造

| 文件 | 改动 |
|---|---|
| `src/lib/contracts.ts` | 新增 `HtmlSafety` 类型 + `PageSourceDoc.htmlSafety?` 字段 |
| `src/server/sources/source-reader.ts` | `readPageSources` 的 HTML 分支读原文算 safety 挂到 doc（**只下发 verdict，仍不下发正文 payload**，与 2418f0e 的精简不冲突） |
| `src/app/(app)/sources/[id]/page.tsx` | HTML 时读原文算 safety，作为 `htmlSafety` prop 传给 `SourceViewer` |
| `src/app/(app)/_components/source-viewer.tsx` | HTML 分支换成 `<HtmlSourceFrame>`；props 增加 `htmlSafety?` |
| `src/components/wiki/wiki-reading-view.tsx` | `SourceBody` 的 HTML 分支换成 `<HtmlSourceFrame source.htmlSafety>` |
| `src/app/api/sources/[id]/raw/route.ts` | HTML（`.html`/`.htm`）响应加 CSP header |

### 不动

- PDF / markdown / text 渲染分支。
- `/api/sources` 路由签名（仅多带一个字段）、subject 解析、鉴权链。
- source-store / 摄入流水线 / DB schema（零迁移）。

---

## 五、契约定义（`contracts.ts`）

```ts
export type HtmlRisk = 'safe' | 'suspicious';

export interface HtmlSafety {
  risk: HtmlRisk;
  /** 命中的高危信号的中文人读说明；safe 时为空数组。 */
  signals: string[];
}

export interface PageSourceDoc {
  // ……既有字段……
  /** 仅 html 有意义：服务端启发式扫描结论，驱动 iframe 的 sandbox 决策与警告条。 */
  htmlSafety?: HtmlSafety;
}
```

---

## 六、检测信号（启发式，命中任一 → `suspicious`）

对 HTML 原文做大小写不敏感的正则/字符串匹配，每条命中 push 一句中文说明：

| 信号 | 匹配（示意） | 中文说明 |
|---|---|---|
| 动态执行 | `eval(`、`new Function(` / `Function(` 构造 | 使用了 `eval()` / `Function()` 动态执行代码 |
| 文档注入 | `document.write` / `document.writeln` | 使用了 `document.write` 动态写入 |
| 外部脚本 | `<script ... src=` 指向外部 | 引入了外部脚本 `<script src>` |
| 网络外发 | `fetch(`、`XMLHttpRequest`、`WebSocket(`、`navigator.sendBeacon` | 含网络请求（可能外发数据） |
| 编码/混淆 | `atob(`、`unescape(`、`String.fromCharCode(`、`<script>` 内超长无空白串 | 含编码/混淆代码 |
| 自动跳转 | `<meta http-equiv="refresh"` | 含自动跳转 meta refresh |
| 嵌套内容 | `<iframe`、`<object`、`<embed` | 内嵌了其它框架/对象 |
| 导航/弹窗 | `location.href =`、`location.replace`、`window.open(`、`top.location` | 含页面跳转/弹窗 |
| 存储/凭据 | `document.cookie`、`localStorage`、`sessionStorage` | 访问了 cookie / 本地存储 |

- 单一 `suspicious` 等级（不分级），命中即警告 + 锁死 + 始终提供 run-anyway。
- 信号清单的最终权威在代码；本表为代表性集合，实现时可微调表述与匹配，但语义一致。
- 真实网页存档常含分析脚本，会**经常**判 `suspicious`——这正符合"保守默认、按需放行"，回落体验平滑（仍能静态阅读 + 一键放行）。

---

## 七、`HtmlSourceFrame` 组件契约

```ts
interface HtmlSourceFrameProps {
  src: string;            // /api/sources/<id>/raw
  title: string;
  safety?: HtmlSafety;    // 缺省按 safe 处理（向后兼容）
  className?: string;     // 沿用各调用点既有 iframe 类名
}
```

内部逻辑：
- `runScripts = safety?.risk !== 'suspicious' || forceRun`（`forceRun` 为本地 state）。
- `sandbox = runScripts ? 'allow-scripts' : ''`（**永不** `allow-same-origin`）。
- `suspicious && !forceRun` 时，在 iframe 上方渲染红色警告条：图标 + "检测到潜在危险脚本，已禁用交互" + `signals` 列表 + 「我了解风险，仍然运行脚本」按钮（点击 `setForceRun(true)`）。
- `<iframe>` 用 `key={runScripts ? 'run' : 'safe'}` 强制在切换时重挂，确保 sandbox 变更生效。
- 样式复用各调用点既有类名（`source-viewer` 的 `min-h-0 flex-1 ...`、`SourceBody` 的 `h-[80vh] w-full ... lg:h-full`）。

---

## 八、CSP（HTML raw 响应）

`raw/route.ts` 在 `.html`/`.htm` 分支返回的响应头加：

```
Content-Security-Policy:
  default-src 'none';
  script-src 'unsafe-inline' 'unsafe-eval';
  style-src 'unsafe-inline' https: http:;
  img-src 'self' data: https: http:;
  font-src https: http: data:;
  connect-src 'none';
  frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
```

要点：
- 允许页面**自带的内联**脚本/样式/图片渲染，便于忠实预览。
- **禁止外部脚本**（`script-src` 无外部源）——杜绝远程代码。
- **禁止任何对外连接**（`connect-src 'none'`）——这是单条最有价值的硬化，切断数据外发，无论脚本是否被放行。
- 不在 CSP 里写 `sandbox` 指令（避免与 iframe 的 `sandbox` 属性叠加/冲突；opaque origin 已由 iframe 属性保证）。
- PDF 分支不加该 CSP（PDF 由浏览器原生阅读器渲染，不涉及脚本）。

---

## 九、不变的约束（沿用项目规范）

- Route Handler 顶部 `export const runtime = 'nodejs'`、`requireAuth` 链不变。
- 客户端组件不直接 import `@/server/*`；safety 一律服务端算好下发。
- `HtmlSafety` 类型进 `contracts.ts`（领域类型单一真实源），不在 server 私有处定义。
- 数据请求仍走既有 `/api/sources`，不新增端点。

---

## 十、测试与验收

**单测**（vitest，`src/server/sources/__tests__/html-safety.test.ts`）：
1. 纯静态 HTML（仅文本/标题/样式）→ `risk: 'safe'`，`signals: []`。
2. 含 `eval(` → `suspicious`，signals 含动态执行说明。
3. 含外部 `<script src>` → `suspicious`。
4. 含 `fetch(` / `XMLHttpRequest` → `suspicious`。
5. 含 base64 + `atob(` / 超长混淆串 → `suspicious`。
6. 空串 / 纯空白 → `safe`。

**手动验收**（无组件测试，与项目现状一致）：
- 摄入一个纯静态 HTML → 预览直接以 `allow-scripts` 渲染，无警告条。
- 摄入一个带可疑脚本的 HTML → 预览显示警告条 + 锁死静态视图；点「仍然运行」后脚本生效。
- 两个入口（`(app)/sources/[id]` 独立页 + 阅读页 split 的 Sources 面板）行为一致。
- 浏览器 DevTools 确认 raw HTML 响应带 CSP 头；iframe 内 `fetch` 被 `connect-src 'none'` 拦截。

---

## 十一、已知限制

- 启发式扫描会对含分析脚本的真实网页存档频繁判 `suspicious`（设计上接受，回落平滑）。
- CSP 禁外部脚本/连接会让依赖 CDN 脚本或运行时拉数据的页面即使 run-anyway 也无法完全复现（为安全做的取舍；忠实预览的下限是静态渲染）。
- 本期不覆盖实时网页 URL 预览。
