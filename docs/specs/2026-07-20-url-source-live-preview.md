# Spec：URL Source 链接化与远程沙箱预览

日期：2026-07-20
状态：已定稿

## 背景与问题

当前 URL Ingest 在 `POST /api/ingest` 内同步抓取网页主 HTML，把响应正文作为
`vault/raw/<subject>/*.html` 保存；Source 查看器再从
`/api/sources/<id>/raw` 读取这份单文件快照。

这种快照没有原站点的资源基址，也没有下载相对 CSS、字体、图片和脚本。浏览器会把
`../../styles.css` 错误解析到 weftwise 的 `/api/...` 路径；raw 路由的 CSP 又会拦截
外部脚本和运行期网络访问。因此页面虽然保留 HTML 结构，却经常失去原网页样式。

## 目的

- URL 类型 Source 只持久化经过校验的原始网页链接，不再保存 HTML 文件。
- Source 预览在 iframe 沙箱中直接加载该网页链接，让浏览器按原站资源基址加载样式。
- URL 正文抓取仍走既有 SSRF-safe 边界，但移入 ingest worker，Route 只创建 Source
  引用并入队。
- 上传的 `.html` / `.htm` 文件继续作为本地文件快照处理，不改变现有行为。

## 约束

- URL 必须继续经过 `validateHttpUrl` 与 worker 抓取时的逐跳 DNS/IP 公网校验；客户端
  不能自行覆盖持久化的 `originUrl`。
- iframe 永远不获得 weftwise 同源权限；远程网页默认禁用脚本，只保留 HTML/CSS/
  图片等静态加载，用户显式确认后才允许脚本。
- URL Source 是“实时指针”，不再是不可变 HTML 证据。网页内容可变化或下线；Source
  侧车里仍保留 ingest 后的文本 chunks，供 Wiki 证据读取与数据库重建使用。
- 部分站点通过 `X-Frame-Options` 或 CSP `frame-ancestors` 禁止嵌入，应用无法绕过；
  两个 Source 入口都必须提供“Open original”回退链接。
- 旧 URL Source 通过已有 `metadataJson.originUrl` 自动识别并切换到远程预览；旧 raw
  HTML 不主动删除。普通上传 HTML 没有 `originUrl`，继续走本地 raw 预览。

## 方案取舍

### 方案 A：URL 引用实体 + worker 按需抓取 + 远程 iframe（推荐）

- Source 侧车/SQLite 保存 `kind: "url"`、`originUrl` 与基于规范化 URL 的身份 hash；
  不创建 `vault/raw/*.html`。
- URL API 立即创建引用并入队；worker 开始 ingest 时抓取 HTML、转 Markdown cleanText、
  切块并把 chunks 写回侧车。
- 预览直接把 `originUrl` 作为 iframe `src`。

优点：真正解决相对资源基址问题；Route 恢复“只入队”；存储语义与用户看到的网页一致。
缺点：网页内容会漂移；worker 重试可能看到新内容；站点可拒绝 iframe。

为避免断点混用不同版本网页，URL Source 每次 worker attempt 抓取后若发现旧 checkpoint，
先清除再从 planner 重新开始。普通文件 Source 继续保留既有断点续传。

### 方案 B：继续保存 HTML，注入 `<base href>`

可以修复多数相对 CSS/图片，但仍不是完整网页归档；CSP、登录态和 JS 运行期请求仍会导致
差异，也不满足“不下载 HTML 文件”。不采用。

### 方案 C：服务端代理网页及全部子资源

兼容性最好，但需要递归资源抓取、HTML/CSS URL 重写、缓存、内容类型和 SSRF 防护，实际
上是在实现浏览器级 Web Archive/代理。安全面和维护成本过高，违反 YAGNI，不采用。

## 数据模型与身份

不新增 SQLite 列；`sources.metadata_json` 与权威 sidecar 使用以下可选字段：

```ts
interface UrlSourceMetadata {
  kind: 'url';
  originUrl: string;
  title?: string;
  description?: string;
}
```

- 新 URL Source 的 `filename` 继续用 `deriveUrlFilename(url, '.html')`，保持日志、LLM
  source 名称与现有 UI 标签兼容。
- `contentHash` 对 URL Source 表示规范化 URL 的身份 hash，而不是远程正文 hash；同一
  Subject 重复提交同一 URL 复用 canonical Source。
- `title` / `description` 来自 worker 已抓取的 HTML：标题按 `<title>` → `og:title` →
  首个 `<h1>` 回退，描述按 `meta[name=description]` → `og:description` →
  `twitter:description` 回退；统一解码 HTML entity、折叠空白并分别限制为 300 / 1000
  字符。抓取前标题暂以 hostname 展示，不在列表 API 中再次联网。
- `PageSourceDoc` 新增 `sourceUrl?: string`。有该字段的 Source 一律按 Web Source 渲染，
  不从 filename 扩展名猜测本地 raw 文件。

## 数据流

```text
POST /api/ingest { urls }
  -> validateUrlList
  -> persist URL metadata sidecar + sources row + ingest job（无网络、无 raw HTML）
  -> 202

worker ingest
  -> 读取 source.metadataJson.originUrl
  -> fetchUrlSource（逐跳 SSRF 防护）
  -> parseHtml -> cleanText + title/description
  -> title/description 写回 sidecar + SQLite metadata cache
  -> prepareIngest -> chunks 写 sidecar
  -> 既有 planner/writer/enricher/verifier/Saga

GET /api/sources（左侧 Sources 列表）
  -> 仅读取已持久化 metadata，不现场抓取
  -> URL Source 返回 title + description；无 title 时回退 hostname
  -> 普通文件继续以 filename 展示

Source preview
  -> source.metadataJson.originUrl
  -> <iframe src="https://原站/..." sandbox="">
  -> 用户显式确认后 sandbox="allow-scripts"
```

Research 批准导入复用同一个 URL 引用创建路径：coordinator 不再预下载 HTML，child
ingest job 负责抓取。这样手工 URL Ingest 与 Research delivery 不会产生两套网页 Source
语义。

## 安全设计

- 远程 iframe 默认 `sandbox=""`：脚本、表单、弹窗、顶层导航和同源能力均禁用；CSS、
  图片等静态子资源仍可加载。
- 网页标题和描述按纯文本处理；React 不注入 HTML。超长元数据在写入前截断，避免恶意
  页面放大 sidecar/API/侧栏渲染负担。
- 用户点击“run scripts anyway”后仅增加 `allow-scripts`，仍不增加
  `allow-same-origin`，远程页面保持 opaque origin，无法访问父页面、app cookie 或
  localStorage。
- iframe 增加 `referrerPolicy="no-referrer"`。
- 远程网页不经过 `/api/sources/<id>/raw` 的 HTML CSP；安全边界由 iframe sandbox
  承担。raw 路由遇到 URL Source 返回到原 URL 的临时重定向，仅用于旧书签兼容。
- 直接远程预览会让用户浏览器访问该站点，这是用户要求的行为；站点能够看到用户 IP，
  且浏览器可能按自身第三方 Cookie 策略携带站点 Cookie。UI 的 Open original 是同类显式
  出站行为，不把远程内容伪装为本地可信内容。

## 非目标

- 不代理或绕过站点的 `X-Frame-Options` / `frame-ancestors`。
- 不保证 SPA、登录态网页或依赖同源 XHR 的应用完整可交互。
- 不迁移或删除既有 raw HTML 文件。
- 不把 verifier 自动采集的 Markdown 证据快照改成实时网页；它们属于一次核查的证据
  产物，不是用户提交的 URL Source。

## 成功标准

- 新增 URL Source 后，`vault/raw/<subject>/` 不产生对应 `.html` 文件，sidecar 与
  SQLite 中保留规范化 `originUrl`。
- URL Route 不执行网页抓取并在 202 后由 worker 抓取；抓取失败表现为异步 job failed。
- URL worker 能完成 HTML 解析并把 chunks 写入 sidecar；URL 重试不会复用旧 checkpoint。
- 手工 URL Ingest 与 Research 导入都使用同一链接型 Source。
- 阅读页 Sources 面板和独立 Source 页都直接 iframe 原 URL，并提供 Open original。
- 上传 HTML 仍走 `/api/sources/<id>/raw`，其 CSP/危险扫描行为不变。
- URL Source 不因缺少 raw 文件被 lint 误报为 `stale-source`。
- 定向测试、`npx tsc --noEmit`、`npm run lint`、`npx vitest run` 与 `npm run build` 通过。
