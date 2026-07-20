# Research 导入 Fake-IP 兼容设计

## 背景

Research 批准后的 URL Source 由子 Ingest 在 worker 中调用 `fetchUrlSource()` 抓取。当前 SSRF 守卫会解析 hostname 的全部 DNS 结果，并要求每个地址都是公网地址；`198.18.0.0/15` 作为 RFC 2544 基准测试保留网段会被正确拒绝。

本机代理启用 Fake-IP 模式后，`unity.com`、`dev.epicgames.com`、`docs.godotengine.org` 与 `zhuanlan.zhihu.com` 等正常公网域名都被系统 DNS 映射到 `198.18.0.0/15`。worker 因而在发起 HTTP 请求前统一报错：

```text
URL hostname must resolve exclusively to public addresses
```

这是网络代理表示方式与 SSRF 地址分类之间的冲突，不是 Research 审批、provenance 或 Ingest 入队错误。

## 目标

- 让使用 `198.18.0.0/15` Fake-IP 池的系统代理环境可以正常抓取公网 URL。
- 保留逐跳 DNS 校验、地址固定、Host/SNI 校验和手动重定向边界。
- 保持 IP literal、私网、其他保留地址及混合可信度 DNS 结果 fail-closed。
- 通用 URL Ingest 与 Research 导入继续共用同一个抓取边界。

## 非目标

- 不增加通用的“允许私网抓取”开关。
- 不代理 HTTP 请求，也不管理 Clash、Mihomo 或其他代理软件配置。
- 不通过公共 DoH 服务绕过用户的系统 DNS。
- 不改变 Research 审批、Source 持久化或 child Ingest 重试语义。

## 方案比较

### 方案 A：无条件允许 `198.18.0.0/15`

实现最小，但会把保留地址永久扩充为可信目标。没有 Fake-IP 代理时，恶意 hostname 可能借此访问本地基准测试网络，违反现有 SSRF 设计。

### 方案 B：环境变量显式放行

默认安全且行为明确，但每个 worker 部署都需要额外配置；代理模式切换后配置可能陈旧。错误表象来自运行网络，要求应用操作者理解并同步底层代理细节，运维摩擦较大。

### 方案 C：系统 Fake-IP 一致性探测（推荐）

先按现状解析目标 hostname。只有目标的全部答案都属于 `198.18.0.0/15` 时，再解析固定公网哨兵 `example.com`；哨兵也全部落入同一网段，才把目标结果标记为系统 Fake-IP 映射。`resolvePublicHttpTarget()` 只接受以下两种同质结果：

1. 全部地址均为公开可路由地址；
2. 全部地址均为经过系统 Fake-IP 一致性探测标记的 `198.18.0.0/15` 地址。

任一非法 family、地址文本、未标记保留地址、公私混合或 Fake-IP/公网混合结果仍整体拒绝。URL 直接写 `198.18.x.x` 时不经过 DNS，继续在 `validateHttpUrl()` 阶段拒绝。

该方案不把保留网段提升为公网，只承认系统 DNS 已进入全局 Fake-IP 表示模式。worker 随后仍固定连接已验证的映射地址，并使用原 hostname 做 Host、SNI 与证书校验。

## 数据流

```text
Research candidate URL
  -> validateHttpUrl
  -> system lookup(target hostname)
  -> public answers? ----------> mark public
  -> all 198.18/15?
       -> system lookup(example.com)
       -> all 198.18/15? ------> mark system-fake-ip
       -> otherwise -----------> untrusted reserved addresses
  -> resolvePublicHttpTarget 同质性校验
  -> pinned socket + original Host/SNI
  -> redirect 时重新执行完整流程
```

## 安全不变量

- `isPublicIpAddress('198.18.x.x')` 始终返回 `false`。
- Fake-IP 兼容只适用于 DNS hostname，不适用于 IP literal。
- 目标与哨兵都必须非空，且各自全部落在 `198.18.0.0/15`。
- Fake-IP 标记是 resolver 产生的 provenance；未标记的同网段答案继续拒绝。
- 一组 DNS 答案必须全部公开，或全部为已标记 Fake-IP；不接受混合结果。
- 每次重定向重新解析和校验，连接仍固定到本次校验得到的地址。

## 成功标准

- 模拟系统 Fake-IP 的 hostname 可通过 `resolvePublicHttpTarget()` 并传给 transport。
- `198.18.x.x` literal、未标记 `198.18.x.x`、Fake-IP 混合私网、公开地址混合私网仍被拒绝。
- 既有 URL safety/fetcher、Research import 与 source loader 测试通过。
- lint 与生产构建通过。

