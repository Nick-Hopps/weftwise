# Spec：URL Ingest 登录态凭证授权

日期：2026-07-20
状态：已定稿

## 背景与问题

URL Source 已是链接型实体：提交时只保存 URL，真正抓取发生在 ingest worker。
当目标网页需要登录时，服务端抓取会收到 HTTP 401/403；用户即使在自己的浏览器中打开
原网页并完成登录，worker 也无法读取受浏览器同源策略与 HttpOnly 保护的 Cookie，因此普通
Retry 只会再次失败。

本需求需要一条明确、最小且可审计的凭证交付路径，让用户把已经登录的短期会话授权给当前
URL ingest 任务，同时不把凭证明文写进 vault、SQLite、job event 或日志。

## 目的

- 将 URL 抓取的 401/403 分类为可恢复的 `url-auth-required`，而不是普通未知失败。
- Ingest 失败页提供认证入口：打开原站登录页，并为当前失败任务提交 Cookie；对使用 HTTP
  `Authorization` 的站点提供可选输入。
- 凭证只对认证失败响应所在的精确 origin 生效；跨 origin 重定向自动移除敏感请求头。
- 凭证以短期 AES-256-GCM 密文保存在数据库目录旁，不进入 vault/Git 或明文 SQLite；任务
  成功后立即删除，失败授权由 TTL 清理。
- 提交凭证后原子更新失败 job 的授权引用并重新排队，复用同一 job ID、SSE 与 ingest
  断点语义。

## 约束

- Web 与 worker 是独立进程，授权介质必须能在两个进程间共享，不能只放内存。
- Docker Alpine 生产镜像不包含 Chromium；本期不能依赖本机 GUI、Playwright、VNC 或
  浏览器 profile。
- 应用页面不能通过跨域脚本读取目标站 Cookie；“打开新标签登录后自动取 Cookie”在 Web
  安全模型下不可实现。
- SSRF 防护保持不变：认证请求的每一跳仍必须重新执行 DNS/IP 公网校验和 IP pinning。
- Cookie 与 Authorization 均视为秘密：不得出现在异常 message、job params、event data、
  source sidecar、日志或 API 响应中。
- Research child ingest 仍由 provenance 状态机管理；本期不允许通用认证 API 绕过它的专用
  retry 契约。

## 方案取舍

### 方案 A：短期加密凭证授权（推荐）

用户在原站完成登录，从浏览器开发者工具复制当前会话的 Cookie；weftwise 为当前失败 job
创建加密 grant，并立即重排该 job。worker 解密后仅在精确 origin 请求上加 Cookie/可选
Authorization。

优点：兼容本地与 Docker 部署；复用当前 HTTP 抓取、SSRF 和 retry 链路；凭证面小且可
过期。缺点：用户需要从开发者工具复制 Cookie，体验不如受控浏览器。

### 方案 B：服务端受控浏览器 + 远程交互登录

在服务端运行 Chromium，把交互画面暴露给用户，登录后复用 browser context 抓取。

优点：用户不需要接触 Cookie。缺点：当前 Alpine 镜像、Next/worker 双进程与远程部署都
需要新增 Chromium、VNC/WebRTC、会话隔离、资源配额和长期 profile 清理；登录密码会经过
应用控制的浏览器，安全与运维面显著扩大。本期不采用。

### 方案 C：浏览器扩展或认证后页面快照上传

由扩展/书签脚本把登录后 DOM 交给 weftwise，不传 Cookie。

优点：凭证不离开浏览器。缺点：需要安装扩展，且只得到单页快照，无法复用现有 URL 重试、
重定向与资源请求语义。本期不采用，未来可作为无凭证导入模式。

## 数据与文件模型

job params 只新增不敏感引用：

```ts
interface IngestParams {
  sourceAuthGrantId?: string;
}
```

临时授权目录位于 `dirname(DATABASE_PATH)/source-auth/`，不在 vault 内：

```text
data/
├── .source-auth-key             # 32-byte 随机主密钥，mode 0600
└── source-auth/
    └── <grant-id>.json          # AES-256-GCM envelope，mode 0600
```

密文明文载荷包含：版本、job ID、source ID、认证 origin、Cookie、可选 Authorization、
创建时间和过期时间。grant 默认 2 小时过期；创建和读取时 best-effort 清理过期文件。

主密钥首次使用时在数据库目录原子生成。并发 Web/worker 进程通过原子 hard-link 发布同一
最终 key，避免两个进程各自覆盖导致既有密文无法解密。

## 数据流

```text
worker fetch URL
  -> SSRF-safe redirect loop
  -> HTTP 401/403
  -> emit ingest:auth-required { code, status, authOrigin, sourceId }
  -> job failed（不包含凭证）

Ingest UI
  -> 显示 Sign in 按钮
  -> 用户在原站完成登录
  -> POST /api/jobs/:id/url-auth { cookie, authorization? }

认证 API
  -> auth + CSRF + subject/job/source 校验
  -> 必须是普通 failed URL ingest，且最后一次失败为 url-auth-required
  -> 验证 header 长度与 CR/LF/NUL
  -> 加密写 grant
  -> requeueJobWithParams(jobId, { sourceAuthGrantId })
  -> 若 DB CAS 失败则删除刚创建的 grant

worker retry
  -> 按 grant ID 解密并校验 job/source/TTL
  -> fetchUrlSource(url, { credentials: { origin, cookie, authorization } })
  -> 仅 current.origin === grant.origin 时携带敏感头
  -> 跨 origin redirect 不带敏感头
  -> ingest 完成后删除 grant
```

## API 契约

### `POST /api/jobs/[id]/url-auth`

请求：

```json
{
  "cookie": "session=...",
  "authorization": "Bearer ..."
}
```

- `cookie` / `authorization` 至少一项非空；允许用户粘贴可选的 `Cookie:` / `Authorization:`
  前缀，服务端规范化后再加密。
- Cookie 最大 16 KiB，Authorization 最大 8 KiB；拒绝 CR/LF/NUL，避免 header injection。
- 202：返回脱敏的 `{ jobId, status: "pending", expiresAt }`。
- 400：输入无效；401/403：应用自身 auth/CSRF；404：job/source/subject 不匹配；409：job
  已非 failed、不是 URL 认证失败或 CAS 冲突；422：Research child ingest。

## 安全设计

- grant origin 来自 worker 实际收到 401/403 的最终 URL，不信任客户端提交 origin。
- `fetchUrlSource` 的 transport 只接收已经筛选过的请求头；Cookie/Authorization 不进入
  `PublicHttpTarget`、错误对象、事件或日志。
- 精确 origin 包含 scheme、hostname 和有效端口。HTTP→HTTPS、子域、端口变化都不自动
  继承凭证；用户必须对新的认证 origin 再授权。
- 401/403 响应体不读取，避免把登录页/错误页误当正文。
- API 不回显 header 内容、长度或 grant 密文路径；grant ID 使用随机 UUID。
- 新授权替换旧 grant 时先完成新 grant + job CAS，再 best-effort 删除旧 grant，避免失败
  窗口让任务失去已有授权。
- 用户终止任务或任务成功时删除 grant；异常终态最多保留到 TTL。

## 非目标

- 不保存用户名或密码，不提供表单代填。
- 不模拟验证码、MFA、OAuth 或 SSO 回调。
- 不实现跨域 Cookie jar、浏览器 profile、受控 Chromium 或长期站点凭证库。
- 不保证 Cloudflare 等绑定浏览器指纹/TLS 指纹的会话 Cookie 可被 Node HTTP 客户端复用。
- 不把凭证自动推广到同一站点的其他 Source 或 Research candidate。

## 成功标准

- URL 抓取 401/403 产生结构化 `ingest:auth-required`，UI 显示认证动作而非盲目 Retry。
- 提交有效 Cookie 后，同一 job 自动重排并在精确 origin 请求上携带 Cookie。
- 跨 origin redirect 的 transport 请求不含 Cookie/Authorization。
- grant 在磁盘上不含凭证明文，job params/result/events/source sidecar 均不含凭证。
- 无效、过期、错 job/source grant 被拒绝且不泄露密文内容。
- 任务成功后 grant 删除；未完成授权超过 TTL 后不可再读。
- 普通公开 URL、raw file ingest、Research provenance retry 与既有 SSRF 测试不回归。
- 定向测试、`npx tsc --noEmit`、`npm run lint`、`npx vitest run` 与 `npm run build` 通过。
