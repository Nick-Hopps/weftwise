# Ask AI 召唤式悬浮面板实施计划

## 任务 1：抽离定位与手势纯函数

- 文件：`src/components/layout/ask-ai-floating-panel.tsx`、`src/lib/ask-ai-floating-panel.ts`、对应 `__tests__`。
- 内容：实现视口约束、选区末端锚点、桌面拖动位移和移动端下滑判定。
- 验证：`npx vitest run src/lib/__tests__/ask-ai-floating-panel.test.ts`。

## 任务 2：接入桌面双击与 Header 入口

- 文件：`src/components/layout/shell.tsx`、`src/components/layout/header.tsx`、`src/stores/ui-store.ts`。
- 内容：增加悬浮面板状态（打开方式、锚点、选区引用、桌面位置），过滤交互元素双击，保留 Sparkles 与快捷键入口。
- 验证：组件类型检查与相关 store 测试。

## 任务 3：实现响应式面板容器

- 文件：`src/components/layout/ask-ai-floating-panel.tsx`、`src/components/layout/context-panel-chat-tab.tsx`。
- 内容：桌面 fixed 可拖动面板；移动端 Bottom Sheet、手柄下滑关闭；复用现有 `ChatInterface` 和会话切换器。
- 验证：`npm run lint`、生产构建。

## 任务 4：验证关键交互

- 内容：检查双击过滤、选区引用、拖动边界、Escape 关闭、移动端下滑阈值及流式请求保活。
- 验证：定向 Vitest；若环境可用，再运行 Playwright UI 冒烟。
