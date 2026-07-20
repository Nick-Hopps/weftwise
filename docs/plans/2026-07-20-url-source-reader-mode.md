# Plan：URL Source 阅读模式回退

日期：2026-07-20

## Task 1：锁定阅读正文持久化与旧数据回退

涉及文件：

- `src/server/sources/__tests__/source-store.test.ts`
- `src/server/sources/__tests__/source-reader.test.ts`
- `src/server/sources/source-store.ts`
- `src/server/sources/source-reader.ts`
- `src/server/services/ingest-service.ts`
- `src/lib/contracts.ts`

步骤：

1. 先写失败测试：URL readerText 有界写入、截断标记、旧 chunks overlap 去重。
2. 运行定向测试，确认因缺少新行为而失败。
3. 实现 sidecar 写入、读取与旧数据回退，并把 URL ingest 的 cleanText 接入。
4. 运行定向测试转绿。

验证：

```bash
npx vitest run src/server/sources/__tests__/source-store.test.ts src/server/sources/__tests__/source-reader.test.ts
```

## Task 2：实现两个入口共用的阅读模式视图

涉及文件：

- `src/components/wiki/url-source-preview.tsx`
- `src/app/(app)/_components/source-viewer.tsx`
- `src/app/(app)/sources/[id]/page.tsx`
- `src/components/wiki/wiki-reading-view.tsx`
- `src/lib/i18n/messages/{en,zh-CN}.ts`

步骤：

1. 新增共享 Tabs 视图：实时网页保持现有 sandbox iframe，阅读模式渲染 Markdown。
2. 独立 Source 页读取 reader content 并传入共享组件。
3. Wiki Sources API DTO 携带 reader content，分栏入口切换为共享组件。
4. 补齐中英文模式标签、截断和空态文案。

验证：

```bash
npx tsc --noEmit
npm run lint
```

## Task 3：回归与文档同步

涉及文件：

- `src/app/CLAUDE.md`
- `src/components/CLAUDE.md`
- `src/server/sources/CLAUDE.md`

步骤：

1. 同步 URL Source 数据流、预览边界和 FAQ。
2. 运行全量测试和生产构建。
3. 启动开发服务器，用可嵌入 URL 与禁止嵌入 URL 验证两个入口的切换、排版和移动端布局。

验证：

```bash
npx vitest run
npm run build
```
