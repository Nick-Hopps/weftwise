# Research 导入 Fake-IP 兼容实现计划

## 目标

在不放宽 IP literal 与私网 SSRF 边界的前提下，让 URL 抓取器识别系统代理的 `198.18.0.0/15` Fake-IP 映射，修复 Research 导入批量失败。

## Task 1：用失败测试锁定 Fake-IP 边界

**涉及文件：**

- 修改 `src/server/sources/__tests__/url-safety.test.ts`
- 修改 `src/server/sources/__tests__/url-fetcher.test.ts`

**步骤：**

1. 增加“已标记、同质 Fake-IP DNS 结果可用”的测试。
2. 增加“未标记、literal、Fake-IP/私网混合仍拒绝”的测试。
3. 增加 fetcher 把 Fake-IP 固定地址交给 transport 的测试。
4. 运行目标测试，确认因尚无 Fake-IP provenance 支持而按预期失败。

**验证命令：**

```bash
npx vitest run src/server/sources/__tests__/url-safety.test.ts src/server/sources/__tests__/url-fetcher.test.ts
```

## Task 2：最小实现系统 Fake-IP 探测与同质校验

**涉及文件：**

- 修改 `src/server/sources/url-safety.ts`

**步骤：**

1. 增加 `198.18.0.0/15` 精确分类函数，但不改变公网地址分类结果。
2. 默认 resolver 仅在目标全部落入该网段时查询固定公网哨兵。
3. 目标与哨兵均满足时，为目标 DNS 结果附加 `system-fake-ip` provenance。
4. `resolvePublicHttpTarget()` 只接受“全公网”或“全标记 Fake-IP”两类同质结果。
5. 运行目标测试转绿并检查 diff。

**验证命令：**

```bash
npx vitest run src/server/sources/__tests__/url-safety.test.ts src/server/sources/__tests__/url-fetcher.test.ts
git diff --check
```

## Task 3：同步架构说明并完成回归验证

**涉及文件：**

- 修改 `src/server/sources/CLAUDE.md`

**步骤：**

1. 记录 Fake-IP 探测条件与保留的安全不变量。
2. 运行 sources、Research import 和 source loader 相关测试。
3. 运行 lint 与生产构建。
4. 核对分支、提交与工作树状态。

**验证命令：**

```bash
npx vitest run src/server/sources/__tests__/url-safety.test.ts src/server/sources/__tests__/url-fetcher.test.ts src/server/sources/__tests__/source-loader.test.ts src/server/services/__tests__/research-import-service.test.ts
npm run lint
npm run build
git diff --check
git status --short --branch
```

