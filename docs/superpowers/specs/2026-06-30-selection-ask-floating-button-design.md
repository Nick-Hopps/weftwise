# 设计：选中正文文本 → 悬浮「追问」按钮

> 日期：2026-06-30
> 状态：已批准，待落实施计划

## 一、目标

用户在阅读页正文里**选中一段文字**后，选区附近浮出一个 **Ask AI** 小按钮；点击后：

1. 把选中文本作为「引用片段」pin 进 Ask AI 对话的输入区；
2. 打开右侧上下文面板并切到 **Ask AI** tab；
3. 聚焦输入框，等用户输入针对这段文字的追问。

随后追问走现成的 `POST /api/query`——选中文本作为上下文随问题发出，基于**当前 subject**（project）作答。

## 二、动机

- `IDEAS.md` 既有条目：「选中文本后弹出『追问』悬浮按钮，支持基于当前 project 对选中文本进行问答」。
- 现状要追问正文里的某句话，用户得手动打开 Ask AI tab、再用 **Reference** 选择器从预切的段落里挑——选择器只能选 `parsePassages` 预切的整段，无法精确对应任意选区。悬浮按钮把「选中即追问」收敛成一次点击。

## 三、方案选择

三个维度，均已与用户确认：

### 维度 1：问答界面在哪里打开

| 方案 | 取舍 |
|------|------|
| **A：复用右侧面板 Ask AI tab**（采纳）| 改动最小、能力最全——多轮记忆 / 引用 / 保存到 wiki / SSE 流式全部白拿，且不离开当前阅读页 |
| B：独立 `/ask` 全屏页 | 沉浸但要新建路由 + 跨页状态传递，工作量大 |
| C：选区就地浮层做问答 | 最贴近阅读位置，但要重做一套迷你聊天 UI，与现有 chat 能力重复 |

### 维度 2：选中文本如何进入对话

| 方案 | 取舍 |
|------|------|
| **A：Pin 为引用 chip + 聚焦输入框**（采纳）| 复用现有 Reference 机制，与现有 UX 一致；用户自己打追问问题，最灵活 |
| B：预填一个模板问题 | 快但不灵活 |
| C：立即发送默认追问 | 点击最少但控制力最差 |

### 维度 3：触发范围

选区监听**仅限阅读页正文容器**（`PageRenderer` 渲染的 `<article>`）。侧栏、Sources 面板、chat 内选字不触发。

## 四、关键决策

1. **跨组件通信走 ui-store 当信箱**：悬浮按钮在正文组件树、chat 在右侧面板组件树，两端用 Zustand 的一个**瞬态**字段对接（仿现有 `subjectDialog`，不持久化）。
2. **面板原本关着也成立**：点击按钮一次 `set` 同时写入 pending + 打开 chat tab；面板首次打开才挂载 `ChatInterface`（现有 `chatEverMounted` 机制），挂载后它的 effect 读到 store 里仍在的 pending 值再消费。pending 值留在 store 等组件挂上来取，**消费即清空**保证只 pin 一次。
3. **文案英文**：按钮用 **「Ask AI」**（配 lucide 图标），与近期阅读页英文化 + 右面板 "Ask AI" tab 命名一致。
4. **移动端尽力而为**：桌面优先；触屏选字按钮仍会出现，点击打开抽屉版面板 chat tab，但不作为主要目标、不为它做额外适配。
5. **零后端/DB/API 改动**：纯前端。

## 五、架构与改动单元

### ① 新增 hook：`src/hooks/use-text-selection.ts`

给定一个容器 ref，追踪容器内的文本选区。

- 监听 `document` 的 `selectionchange` + `pointerup`（拖拽中不弹，松手/选区稳定后才计算）。
- 输出 `{ text, rect, section } | null`：
  - `text`：选区文本（`selection.toString()`）；trim 后为空 / 纯空白 → 返回 `null`（不弹按钮）。
  - `rect`：`range.getBoundingClientRect()`（viewport 坐标，供 fixed 定位）。
  - `section`：从选区起点向上找最近的 `h1~h4` 标题文本，找不到回退 `null`。
- 守卫：选区必须**完全落在容器内**（`container.contains(range.commonAncestorContainer)`），否则返回 `null`。
- 折叠 / 失焦 / 滚动时输出 `null`（滚动监听见 §七）。
- 把"会变的 DOM 计算"与"纯逻辑"分离：纯逻辑（最小长度过滤、文本截断到上限、nearest-heading 文本提取）抽成可单测的纯函数（`lib/selection-text.ts` 或 hook 同文件内导出）。

### ② 新增组件：`src/components/wiki/selection-ask-button.tsx`

- props：`{ containerRef: RefObject<HTMLElement> }`。
- 消费 ① 的 hook；`selection === null` 时不渲染。
- 用 `position: fixed` 把按钮渲染在 `rect` 上方中点（top = `rect.top - 偏移`，left = `rect.left + rect.width/2`，`translateX(-50%)`；贴近视口上沿时翻到选区下方）。
- z-index 用现有层级标度（介于内容与模态之间，参考 `z-overlay`）。
- `onMouseDown` 阻止默认，避免点击时丢失选区（文本其实已在 hook state 里捕获，这是双保险）。
- 点击 → 调 ui-store `askAboutSelection({ section, text })`（id 在 action 内按文本派生）。

### ③ ui-store 改动：`src/stores/ui-store.ts`

- 新增**瞬态**字段（不进 `partialize`、不持久化）：
  ```ts
  pendingChatReference: { id: string; section: string | null; text: string } | null
  ```
- 新增 action：
  - `askAboutSelection(payload: { section: string | null; text: string })`：派生 `id`（按文本，保证重复选同段去重）→ `set({ pendingChatReference, contextPanelOpen: true, contextPanelTab: 'chat' })`。复用现有 `openContextPanel('chat')` 语义。
  - `consumePendingChatReference(): PendingChatReference | null`：读取当前值并 `set({ pendingChatReference: null })`，返回原值。
- 初始值 `null`；不需要新的持久化迁移版本（瞬态字段不持久化，version 维持 5）。

### ④ ChatInterface 改动：`src/components/chat/chat-interface.tsx`

- 订阅 `pendingChatReference`。
- 新增一个 `useEffect`（仅 `variant === 'embedded'`）：当 `pendingChatReference` 非空时——
  - 调 `consumePendingChatReference()` 取出并清空；
  - 把它作为一个 `Passage`（`{ id, section: section ?? 'Selection', text }`）push 进现有 `refs`（沿用现有去重：`refs.some(x => x.id === p.id) ? prev : [...prev, p]`）；
  - 聚焦 `textareaRef`。
- **不动**发送逻辑：现有 `sendMessage` 已把 `refs` 拼成 `> [section] text` 作为上下文随问题发出，选区 chip 天然复用。

### ⑤ 接入点：`src/components/wiki/wiki-reading-view.tsx`

- 把 `article` JSX 包一层 `<div ref={articleRef} className="relative">`（不破坏现有分栏布局）。
- 在其内渲染 `<SelectionAskButton containerRef={articleRef} />`。
- 选区范围因此限定在正文。

## 六、数据流

```
正文选字
  └─(selectionchange/pointerup)→ use-text-selection 计算 {text,rect,section}
        └─ SelectionAskButton 在 rect 上方渲染「Ask AI」
              └─(click)→ ui-store.askAboutSelection({section,text})
                    ├─ pendingChatReference = {id,section,text}
                    └─ contextPanelOpen=true, contextPanelTab='chat'
                          └─ ContextPanel 挂载 ChatInterface（若未挂）
                                └─ ChatInterface effect 读 pending
                                      ├─ consume() 清空
                                      ├─ refs += {id,section,text}（chip 显示）
                                      └─ 聚焦输入框
                                            └─ 用户打追问 → 现成 sendMessage → /api/query
```

## 七、边界与降级

- **滚动**：`rect` 会失效。滚动时直接隐藏按钮（不做跟随重定位）——监听 `scroll`（容器或 window，capture）置 `null`。
- **重塑（Cognitive Lens）内容**：选区作用在当前 DOM 上，原文 / 重塑文都能选，无需特殊处理；pin 的是用户实际看到的文本。
- **文本上限**：chip 显示靠现有 CSS 截断；作为上下文存储的 `text` 封顶约 **4000 字符**（超出截断 + 省略号），防超长选区撑爆请求体。
- **最小长度**：trim 后空 / 纯空白不弹按钮。
- **空 subject**：现有 `/api/query` 已有空 subject 短路守卫，沿用，不额外处理。
- **换页**：`ChatInterface` 现有 `useEffect(..., [currentPageSlug])` 会清空 `refs`——换页后未发送的选区 chip 自然清掉，符合预期。
- **WikiLink 标记**：nearest-heading 与选区文本沿用正文 DOM 的 `textContent`，不含 markdown/wikilink 语法（已是渲染后纯文本），无需再清洗 `[[...]]`。

## 八、测试

- 纯函数单测（vitest）：
  - 文本最小长度过滤、上限截断（含 4000 边界）。
  - nearest-heading 文本提取（给定模拟 DOM / 节点结构）。
- ui-store 状态流转单测：`askAboutSelection` 写 pending + 开 chat tab；`consumePendingChatReference` 读后清空、去重 id 派生稳定。
- 选区 DOM 监听与 fixed 定位：手动验证（必要时 Playwright），不强求自动化。

## 九、非目标

- 不新建 `/ask` 路由或独立问答页。
- 不在 Sources 面板 / 侧栏 / 其他非正文区域触发。
- 不做选区高亮持久化、不把选区写入 vault。
- 不重做 chat UI（IDEAS.md 第二条「界面重新设计」是独立需求，不在本 spec 范围）。
- 移动端不做超出"按钮可点 + 打开抽屉"的额外适配。
