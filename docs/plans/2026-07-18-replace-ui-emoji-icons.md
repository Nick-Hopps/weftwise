# 用户界面 Emoji 图标替换实现计划

## 约束与策略

- 按 TDD 推进：每项行为先写失败测试并确认失败原因，再做最小实现。
- 工具活动的服务端纯文本、语义键与客户端 Lucide 渲染分层，不让 `src/lib/tool-activity.ts` 引入 React。
- callout 只在渲染期兼容历史 emoji，不改写 vault。
- 任务表面优先消费事件已有的 `data.tool`，不从英文文案反推工具类型。

## 任务 1：锁定工具活动纯文本与语义图标契约

涉及文件：

- `src/lib/tool-activity.ts`
- `src/lib/__tests__/tool-activity.test.ts`

步骤：

1. 将既有 emoji 断言改为稳定的语义图标键。
2. 新增 `toolActivityLine` 不含 emoji 的失败测试。
3. 运行聚焦测试确认按预期失败。
4. 最小修改纯逻辑并转绿。

验证命令：

```bash
npx vitest run src/lib/__tests__/tool-activity.test.ts
```

## 任务 2：统一 Ask AI 与任务表面的 Lucide 工具图标

涉及文件：

- `src/components/shared/tool-activity-icon.tsx`（新增）
- `src/components/chat/message-list.tsx`
- `src/components/shared/progress-toast.tsx`
- `src/components/shared/jobs-panel.tsx`
- `src/components/shared/job-detail-dialog.tsx`
- `src/lib/job-log.ts`
- 对应 `__tests__` 文件

步骤：

1. 为工具名到 Lucide 组件的映射写组件/纯 helper 测试。
2. 为历史事件前导 emoji 清理与 `data.tool` 透传写失败测试。
3. 实现共享图标适配组件与事件展示模型。
4. 接入聊天、当前任务摘要和详情日志；装饰图标统一 `aria-hidden`。

验证命令：

```bash
npx vitest run src/lib/__tests__/tool-activity.test.ts src/lib/__tests__/job-log.test.ts src/components/shared/__tests__/tool-activity-icon.test.tsx
```

## 任务 3：替换 Wiki callout 的历史与未来 emoji

涉及文件：

- `src/lib/markdown-client.ts`
- `src/components/wiki/callout-icon.tsx`（新增）
- `src/lib/__tests__/markdown-client.test.ts`
- `src/app/globals.css`
- `src/components/wiki/page-renderer.tsx`

步骤：

1. 添加失败测试：已知 callout 的前导 emoji 被剥离，正文内 emoji 保留，自定义图标节点存在。
2. 在 remark callout 转换中注入类型图标节点并只清理标题首部已知 emoji。
3. 在 rehype-react 中映射 Lucide callout 图标并调整首行基线样式。
4. 覆盖全部已知类型与未知类型回退。

验证命令：

```bash
npx vitest run src/lib/__tests__/markdown-client.test.ts
```

## 任务 4：清理固定 UI emoji 并更新架构说明

涉及文件：

- `src/components/chat/chat-interface.tsx`
- `src/server/llm/prompts/ingest-prompt.ts`
- `src/components/CLAUDE.md`
- `src/lib/CLAUDE.md`

步骤：

1. 移除程序生成状态文案和 prompt 固定格式中的 emoji。
2. 更新组件与共享逻辑文档，说明图标边界和历史内容兼容方式。
3. 重新扫描运行时代码，确认没有固定 UI emoji 残留。

验证命令：

```bash
rg -n --glob '*.{ts,tsx}' --glob '!**/__tests__/**' '[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}]' src
```

## 任务 5：整体验证与真实页面检查

验证命令：

```bash
npm test -- --run
npm run lint
npx tsc --noEmit
npm run build
git diff --check
```

真实页面检查：

- Ask AI：触发搜索、读取、workflow 等工具活动，检查语义、基线与流式状态。
- Tasks：触发 Fix/Curate 工具调用，检查展开摘要、折叠态与详情日志。
- Wiki：用包含六种 callout 与历史前导 emoji 的样例页检查亮色、暗色和窄屏。

