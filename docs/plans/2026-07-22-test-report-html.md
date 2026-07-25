# 实现计划：本地测试用例 HTML 报告工具

- 日期：2026-07-22
- 设计稿：[docs/specs/2026-07-22-test-report-html-design.md](../specs/2026-07-22-test-report-html-design.md)

## 任务 1：测试清单与结果模型（TDD）

**涉及文件**：`scripts/test-report.ts`、`scripts/test-report/__tests__/report-model.test.ts`

1. 先为路径分组、`@feature` 覆盖、Vitest JSON 归一化、通过率/用例覆盖率和 coverage-summary 聚合写失败测试。
2. 实现无 IO 的纯函数，保持动态测试和缺失 coverage 的降级行为可测。

验证：`npx vitest run scripts/test-report/__tests__/report-model.test.ts`

## 任务 2：扫描器与 HTML 渲染

**涉及文件**：`scripts/test-report.ts`、`scripts/test-report/__tests__/html-renderer.test.ts`

1. 用 TypeScript AST 扫描 `describe`/`it`/`test` 静态调用，保留祖先标题和源位置。
2. 调用本地 Vitest JSON reporter，合并执行结果和静态清单。
3. 输出内联 CSS 的 HTML，包含汇总指标、功能表、可展开测试明细和失败错误。

验证：定向测试以及对一个临时 fixture 的脚本实跑。

## 任务 3：命令入口与文档

**涉及文件**：`package.json`、`scripts/test-report.ts`

1. 增加 `npm run test:report`，支持 `--output`、`--results`、`--coverage-summary`、`--coverage`、`--no-run`。
2. 在脚本头部写明用法和退出码语义。

## 任务 4：完成验证

- `npx vitest run scripts/test-report/__tests__`
- `npm run test:report -- --output /tmp/weftwise-test-report.html`
- `npx tsc --noEmit`
- `git diff --check`
