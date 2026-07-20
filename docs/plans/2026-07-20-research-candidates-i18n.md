# 实现计划：Research 候选弹窗国际化

- 日期：2026-07-20
- 设计稿：[docs/specs/2026-07-20-research-candidates-i18n.md](../specs/2026-07-20-research-candidates-i18n.md)

## 任务 1：用失败测试锁定中英文渲染契约

**涉及文件**：

- `src/components/health/__tests__/research-candidates-dialog.test.ts`

**步骤**：

1. 为 `useI18n()` 注入可切换的英文/简体中文测试实现。
2. 保留英文既有行为断言，并补齐 score、decision、delivery 与计数覆盖。
3. 新增简体中文等待批准、状态、失败重试渲染断言。
4. 先运行目标测试，确认因中文界面仍输出英文而失败。

**验证**：`npm test -- src/components/health/__tests__/research-candidates-dialog.test.ts`

## 任务 2：补齐消息目录并替换硬编码文案

**涉及文件**：

- `src/lib/i18n/messages/en.ts`
- `src/lib/i18n/messages/zh-CN.ts`
- `src/components/health/research-candidates-dialog.tsx`

**步骤**：

1. 在英文目录定义 Research 候选消息键、状态键与占位符，中文目录逐键对齐。
2. 用类型安全映射覆盖 run status、candidate decision 和 delivery status。
3. 将标题、计数、标签与按钮统一改为 `t()` 调用，保留来源内容与错误原文。
4. 运行目标测试转绿，再运行 i18n 目录测试、TypeScript、lint 和完整测试。

**验证**：

- `npm test -- src/components/health/__tests__/research-candidates-dialog.test.ts src/lib/i18n`
- `npx tsc --noEmit`
- `npm run lint`
- `npm test`

## 提交序列

1. `docs: 设计 Research 候选弹窗国际化`
2. `feat: 完善 Research 候选弹窗国际化`
