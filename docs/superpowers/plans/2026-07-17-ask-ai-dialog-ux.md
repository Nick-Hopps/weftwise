# Ask AI 弹窗尺寸、功能区与渲染性能优化实施计划

## 任务 1：锁定 resize 与滚动跟随纯逻辑

- 文件：`src/lib/ask-ai-floating-panel.ts`、`src/lib/__tests__/ask-ai-floating-panel.test.ts`、`src/components/chat/message-scroll.ts`、`src/components/chat/__tests__/message-scroll.test.ts`。
- 失败测试：宽/高/双轴 resize 的最小值、当前位置对应最大值、视口缩小时矩形回收；贴底阈值内外判断。
- 实现：新增尺寸约束和视口适配纯函数；新增消息贴底判断纯函数。
- 验证：`npx vitest run src/lib/__tests__/ask-ai-floating-panel.test.ts src/components/chat/__tests__/message-scroll.test.ts`。
- 提交：`test: 锁定 Ask AI 尺寸与滚动跟随契约`。

## 任务 2：实现桌面受控 resize

- 文件：`src/components/layout/ask-ai-floating-panel.tsx`。
- 失败测试来源：任务 1 的纯逻辑契约。
- 实现：面板本地尺寸状态；右边、下边、右下角命中区；pointer capture/全局清理；窗口变化同时适配尺寸与位置；移动端保持原行为。
- 验证：任务 1 定向测试、`npm run lint`。
- 提交：`feat: 支持 Ask AI 弹窗自由调整尺寸`。

## 任务 3：合并会话与回答动作区

- 文件：`src/components/layout/context-panel-chat-tab.tsx`、`src/components/chat/chat-interface.tsx`、`src/components/chat/conversation-switcher.tsx`、`src/components/chat/save-to-wiki-button.tsx`、相关渲染测试。
- 失败测试：ConversationSwitcher 不再重复提供 New；统一工具区稳定渲染 New/Clear/Save；无回答/生成中禁用 Save；新回答重置旧保存状态。
- 实现：把 ConversationSwitcher 移入 ChatInterface 工具区；动作改为 icon-only + tooltip；补全 New/Clear 的流中止与状态清理；Save 使用锚定浮层和回答变化重置。
- 验证：相关组件 Vitest、`npm run lint`。
- 提交：`feat: 统一 Ask AI 会话与回答功能区`。

## 任务 4：修复流式消息滚动与 Markdown 渲染性能

- 文件：`src/components/chat/chat-interface.tsx`、`src/components/chat/message-list.tsx`、`src/components/chat/message-stream-batcher.ts`、相关测试。
- 失败测试：同步 delta 合并为一次提交；flush 保留最后内容；cancel 不再提交；贴底时更新滚动、离底后不抢滚动位置；完成消息行使用稳定身份。
- 实现：动画帧批处理 answer delta；消息区显式维护 stick-to-bottom；取消 smooth scroll；memo 化 MessageRow；表格使用固定列布局、单元格换行与消息宽度约束。
- 验证：定向 Vitest；浏览器中用长消息与 GFM 表格检查滚动拖动、表格渲染和 resize。
- 提交：`perf: 优化 Ask AI 流式消息滚动与表格渲染`。

## 任务 5：同步文档并完成全量验证

- 文件：`src/components/CLAUDE.md`、`src/lib/CLAUDE.md`，必要时修正设计/计划中的实现落点。
- 内容：记录桌面 resize、统一工具区、流式批处理与贴底滚动契约。
- 验证：定向测试、`npm test`、`npm run lint`、`npm run build`、真实浏览器桌面与移动端回归、`git diff --check`、`git status --short`。
- 提交：`docs: 同步 Ask AI 弹窗交互与性能说明`。
