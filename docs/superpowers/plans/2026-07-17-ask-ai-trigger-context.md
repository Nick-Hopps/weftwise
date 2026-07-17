# Ask AI 触发定位、新会话与用户引用实施计划

## 任务 1：锁定定位与触发状态契约

- 文件：`src/lib/ask-ai-floating-panel.ts`、`src/lib/__tests__/ask-ai-floating-panel.test.ts`、`src/stores/ui-store.ts`、`src/stores/__tests__/ui-store.test.ts`。
- 失败测试：双击点直接作为候选左上角、首次无坐标入口居中、每次打开递增触发代次并清空会话、选区打开保留独立锚点模式。
- 实现：新增触发点定位/居中纯函数；扩展 store 的 anchor mode 与 invocation 状态。
- 验证：`npx vitest run src/lib/__tests__/ask-ai-floating-panel.test.ts src/stores/__tests__/ui-store.test.ts`。

## 任务 2：接入悬浮面板三路定位与新聊天实例

- 文件：`src/components/layout/ask-ai-floating-panel.tsx`。
- 失败测试来源：任务 1 的纯逻辑与 store 契约。
- 实现：按 trigger/selection/no-anchor 选择定位函数；无历史位置时居中；用 invocation 作为 `ContextPanelChatTab` 的 key。
- 验证：定向 Vitest + `npm run lint`。

## 任务 3：定义并持久化用户消息引用

- 文件：`src/lib/contracts.ts`、`src/lib/chat-reference.ts`、`src/lib/__tests__/chat-reference.test.ts`、`src/server/db/repos/conversations-repo.ts`、`src/server/db/repos/__tests__/conversations-repo.test.ts`、`src/app/api/query/route.ts`、`src/app/api/query/__tests__/route.test.ts`。
- 失败测试：Passage 到用户引用的映射；repo 按 role 恢复 references/citations；route 用服务端 Subject/page 补全并持久化用户引用；缺 pageSlug 时拒绝。
- 实现：新增 `UserMessageReference`；API 接收有界 `messageReferences`；复用 `citations_json` 保存角色相关消息证据。
- 验证：`npx vitest run src/lib/__tests__/chat-reference.test.ts src/server/db/repos/__tests__/conversations-repo.test.ts src/app/api/query/__tests__/route.test.ts`。

## 任务 4：展示用户引用关系

- 文件：`src/components/chat/chat-interface.tsx`、`src/components/chat/message-list.tsx`。
- 内容：发送时把引用及页面标题快照附到本地用户消息；服务端从可信页面仓库补全标题并持久化；重载时从 `ConversationMessage.references` 恢复；用户消息只渲染一个“页面标题 · 章节/短摘要”胶囊，不展示完整选中文字或数量，Assistant Sources 保持不变。
- 验证：渲染测试锁定单胶囊、真实标题、章节优先、36 字符摘要兜底、首个引用跳转与完整原文隐藏；类型检查、相关 Vitest、生产构建；在可用真实浏览器中检查双击坐标、Header 首次居中、拖动后复用、选区引用发送与历史恢复。

## 任务 5：同步模块文档并完成验证

- 文件：`src/components/CLAUDE.md`、`src/lib/CLAUDE.md`、`src/app/CLAUDE.md`、`src/server/db/CLAUDE.md`。
- 内容：记录触发代次、定位语义、用户引用 API/存储与展示。
- 验证：依次运行定向测试、`npm test`、`npm run lint`、`npm run build`；检查 `git diff --check` 与工作树状态。
