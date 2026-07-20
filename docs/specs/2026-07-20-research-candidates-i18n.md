# Research 候选弹窗国际化

- 日期：2026-07-20
- 状态：已定稿
- 关联计划：[docs/plans/2026-07-20-research-candidates-i18n.md](../plans/2026-07-20-research-candidates-i18n.md)

## 一、背景与现状

应用已经通过 `I18nProvider`、`useI18n()` 和 `src/lib/i18n/messages/*` 支持英文与简体中文，但 `research-candidates-dialog.tsx` 仍直接渲染英文文案。切换为简体中文后，弹窗标题、run 状态、候选标签、底部计数与操作按钮仍显示英文，形成同一 Health 页面内的语言断层。

弹窗中的候选标题、URL、摘要、推荐理由和导入错误来自 Research 数据，不属于界面固定文案，应保留原文；需要国际化的是围绕这些数据的 UI 标签和操作。

## 二、目的与成功标准

**目的**：使 Research 候选弹窗完整响应当前界面语言，同时保持既有审批、忽略、关闭和失败重试行为不变。

**成功标准**：

1. 标题、8 类 run 状态、空状态、score 标签、候选 decision、delivery 状态、选择计数和全部按钮均通过统一翻译目录渲染。
2. 英文界面保持当前文案语义；简体中文界面不再出现上述硬编码英文 UI 文案。
3. 候选原始内容与后端错误消息不翻译，避免篡改来源信息或掩盖诊断细节。
4. 中英文组件渲染测试覆盖等待批准、持久化状态、delivery、失败重试和不可重试分支；翻译目录完整性继续通过。

## 三、方案对比

### 方案 A：在 `health.researchCandidates.*` 下补齐消息键（推荐）

- 组件继续直接消费领域状态，但通过类型安全的映射把 run、decision、delivery 枚举映射到 `MessageKey`。
- 标题、计数和按钮使用带占位符的消息键。
- 优点：沿用现有 i18n 架构；编译期约束键名；新增状态时映射会提示补齐；改动范围小。
- 缺点：英文与中文目录各增加一组消息键。

### 方案 B：复用 `jobs.*`、`chat.action.*` 等相似消息键

- 优点：新增键较少。
- 缺点：Research 的 `dismissed`、`partial`、candidate decision 和 delivery 状态与其他模块语义并不完全相同；跨业务复用会使后续文案调整互相牵连。

### 方案 C：组件内部按 locale 保存两套对象

- 优点：实现直接。
- 缺点：绕过翻译目录的类型和完整性校验，继续制造局部国际化孤岛。

**结论**：采用方案 A。

## 四、文案边界

需要翻译：

- 弹窗标题与 run 状态；
- 空状态；
- `score` / 未评分标签；
- candidate decision 与 delivery 状态标签；
- 已选择数量；
- 忽略、取消、批准、重试失败导入、关闭按钮。

保持原文：

- candidate title、URL、snippet、reason；
- ingest job ID；
- delivery error message。

## 五、落点

| 文件 | 职责 |
|------|------|
| `src/lib/i18n/messages/en.ts` | Research 候选弹窗英文消息键（类型单一来源） |
| `src/lib/i18n/messages/zh-CN.ts` | 同键简体中文翻译 |
| `src/components/health/research-candidates-dialog.tsx` | 移除固定英文 UI 文案，按当前 locale 渲染 |
| `src/components/health/__tests__/research-candidates-dialog.test.ts` | 锁定英文回归与简体中文覆盖 |

