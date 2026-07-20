# 通用设置新增正文字号 — 实施计划

日期：2026-07-20
关联 spec：`docs/specs/2026-07-20-body-font-size-setting.md`
分支：`feat/body-font-size`

## T1 设置契约与仓储

- 先在 `src/server/db/repos/__tests__/settings-repo.test.ts` 增加默认值、往返、越界和历史脏值回退测试，并确认按预期失败。
- 在 `src/lib/contracts.ts` 增加 `BodyFontSizeSchema`、默认值及 `AppSettings.bodyFontSize`。
- 在 `src/server/db/repos/settings-repo.ts` 增加 getter/setter，读取时用 schema 校验历史值。
- 验证：`npx vitest run src/server/db/repos/__tests__/settings-repo.test.ts`。
- 提交：`feat: 新增正文字号设置契约与持久化`

## T2 设置 API

- 先扩展 API 测试，锁定 GET 默认值、PUT 往返和非法请求 400，并确认失败。
- 在 `src/app/api/settings/route.ts` 接入读取、校验和写入。
- 验证：设置 API 定向测试。
- 与 T1 合并为同一后端配置链路提交，避免产生不能独立工作的中间提交。

## T3 通用设置界面与即时生效

- 先在 `settings-categories.test.ts` / `settings-content.test.ts` 增加「阅读」分区、默认 `16` 与保存 patch 断言，并确认失败。
- `settings-categories.ts` 为 General 增加 `reading` section。
- `settings-content.tsx` 使用现有 `NumberRow` 渲染 `14–22` 字号设置。
- `messages/{zh-CN,en}.ts` 增加分区、标签和说明文案。
- `settings-dialog.tsx` 保存成功后同步根元素 CSS 变量。
- 验证：`npx vitest run src/components/layout src/lib/__tests__/i18n*.test.ts`。

## T4 首屏注入与正文消费

- 先增加渲染测试，锁定根布局使用服务端设置、正文不再固定 `16px` 且消费 CSS 变量，并确认失败。
- `src/app/layout.tsx` 服务端读取正文字号并注入 `--wiki-body-font-size`。
- `src/components/wiki/page-renderer.tsx` 使用变量字号与 `1.75` 相对行高，默认视觉保持 `16px / 28px`。
- 验证：对应组件测试与 `npx tsc --noEmit`。
- 提交：`feat: 接入正文字号设置与阅读页渲染`

## T5 完整验证

- `npx vitest run <本功能定向测试>`。
- `npx tsc --noEmit`。
- `npm run lint`。
- `npx vitest run`。
- `npm run build`。
- 启动开发服务器，使用真实浏览器在桌面与移动视口检查默认值、最小值、最大值和刷新持久化。
- 核对 `git diff --check`、提交落点与 worktree 清洁度；完成后等待是否用 `--no-ff` 回合 `main` 的指示。
