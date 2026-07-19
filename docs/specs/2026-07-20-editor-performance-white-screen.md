# 编辑模式性能与白屏修复设计

## 背景

当前页面编辑入口使用 `@uiw/react-md-editor`，默认以 `live` 模式同时挂载源码编辑区和阅读页级预览。真实浏览器复现显示：

- 动态编辑器加载期间没有任何 fallback，chunk 未完成或开发态 HMR 缓存异常时，编辑区会持续空白；
- 默认入口包含 Prism 全量 Markdown 高亮，编辑器每次受控值变化都会同步处理整篇源码；
- 自定义预览立即把整篇源码交给 `PageRenderer`，同时启用 Markdown、KaTeX、Mermaid、wikilink 和 selection block；
- 中等页面进入编辑模式后 JS heap 由约 86 MB 增至约 199 MB，并额外加载 Mermaid 相关 chunk 和大量字体资源；连续输入会重复触发全文处理。

因此，白屏不是页面 API 失败；卡顿与崩溃来自“进入即加载重型编辑器 + 全文同步高亮 + 全文富预览”，且动态加载缺少可见失败前状态。

## 目标

- 页面数据成功后，编辑区域必须立即显示明确的加载占位，不出现无反馈白屏。
- 编辑器挂载后默认只显示源码编辑区，不自动执行全文富预览。
- 输入过程中不运行 Prism 全文同步高亮。
- 用户仍可通过编辑器工具栏切换到分屏或纯预览。
- 用户打开预览后，连续输入只在短暂停顿后更新富预览，避免逐键重渲染。
- 保持现有保存、取消、dirty 守卫、Subject 隔离和阅读页一致预览语义不变。

## 非目标

- 不替换编辑器库，不引入 Monaco、CodeMirror 或新的依赖。
- 不改变页面 PUT/Saga、缓存失效或路由协议。
- 不修改阅读页渲染管线或降低阅读页展示能力。
- 不为编辑器新增独立预览路由、Web Worker 或虚拟化系统。

## 方案比较

### 方案 A：只增加动态加载占位

优点是改动最小，可消除无反馈白屏。缺点是进入后仍立即执行全文高亮和富预览，不能解决卡顿与崩溃。

### 方案 B：编辑优先 + 轻量入口 + 延迟预览（推荐）

- 动态组件提供占满编辑区的 loading fallback；
- 使用 `@uiw/react-md-editor/nohighlight`，并显式关闭 `highlightEnable`；
- 默认 `preview="edit"`，保留库内置 Edit / Live / Preview 工具栏切换；
- 自定义富预览通过延迟值更新，连续输入合并为一次预览刷新。

优点是保留现有产品能力和库内交互，只移除进入编辑与逐键输入时不必要的重活；修改面小，可测试、可回退。缺点是源码不再有 Prism 语法着色，且预览内容会在短暂停顿后更新。

### 方案 C：替换为新编辑器内核

Monaco/CodeMirror 可提供更成熟的大文档编辑能力，但会扩大依赖、样式、快捷键、受控状态和移动端适配范围，超出本次缺陷修复。

## 设计

### 动态加载状态

`md-editor.tsx` 提供语义化加载组件，保持与现有编辑页 skeleton 一致的边框、工具栏和正文占位。加载组件覆盖完整可用高度，并带 `role="status"` 与本地化无关的视觉占位；页面标题和 Cancel/Save 始终保持可见。

### 编辑器运行模式

动态 import 改到官方 `nohighlight` 子入口。编辑器传入：

- `preview="edit"`：首次挂载只创建 textarea；
- `highlightEnable={false}`：明确禁止全文 Prism 高亮；
- 现有 `components.preview`：用户选择 Live/Preview 后继续使用 `EditorPreview`。

### 预览更新

新增小型 `DeferredEditorPreview` 客户端组件：

- 首次真正挂载预览时立即显示当前内容；
- 后续 `source` 变化先清理旧计时器；
- 用户停止输入 400ms 后再更新传给 `EditorPreview` 的源码；
- unmount 时清理计时器，避免离开编辑页后更新。

这只延迟预览，不延迟受控 textarea、dirty 判断或保存内容。

## 成功标准

- 单测锁定动态加载 fallback、`preview="edit"`、`highlightEnable={false}` 和 `nohighlight` 入口。
- 浏览器进入编辑页后可见 textarea，默认无 `.w-md-editor-preview`。
- 初始页面不加载 Mermaid chunk；切换 Live 后才加载并显示阅读页一致预览。
- 连续输入立即更新 textarea；预览在停顿后更新；保存仍提交最新源码。
- 针对性测试、全量测试、lint 和 build 均通过。

