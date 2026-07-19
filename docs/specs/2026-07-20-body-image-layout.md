# 正文插图展示优化设计

**日期：** 2026-07-20
**状态：** 待实现

## 背景与问题

Ask AI 选区配图当前把生成图片包进 `[!diagram]` callout。该 callout 没有标题文本，阅读页仍会渲染图标与容器留白，导致图片上方出现一段无意义空白。

正文 Markdown 图片目前也没有稳定的阅读尺寸策略。大尺寸或纵向图片只受正文宽度约束，可能占据过多纵向空间，打断阅读节奏。

## 目标与成功标准

1. 选区配图只插入标准 Markdown 图片，不再生成 `[!diagram]` 标记。
2. 阅读页中的正文图片保持原始宽高比，不拉伸、不放大小图。
3. 大图同时受正文宽度和可视高度约束，并在正文中居中展示。
4. Mermaid 与真正承担语义提示的 `[!diagram]` callout 保持现有行为。
5. 图片资产与页面正文仍通过同一个 Changeset 原子提交，锚点、审批和恢复流程不变。

## 方案比较

### 方案 A：只移除 `[!diagram]`

改动最小，可以消除空白，但无法解决大图占据过多空间的问题。

### 方案 B：移除 `[!diagram]`，并在阅读页统一约束 Markdown 图片（推荐）

插图落盘保持标准 Markdown；渲染层为所有正文位图统一增加居中、最大宽度、最大高度与等比缩放规则。Ask AI 与 enrich 生成的图片都能获得一致效果，且不需要扩展 Markdown 语法。

### 方案 C：在图片 Markdown 中写入宽高或自定义属性

可以逐图控制，但 CommonMark 图片语法不原生支持尺寸，需要引入 HTML 或私有语法与解析插件，扩大存储契约和编辑器兼容面，本次不采用。

## 设计

### 插入格式

`image-insert-service` 在可信锚点后的插入内容从：

```markdown
> [!diagram]
> ![说明](/api/assets/general/example.png)
```

改为：

```markdown
![说明](/api/assets/general/example.png)
```

纯函数同步更名为表达真实行为的 `insertImageAfterAnchor`。换行归一、alt 转义与锚点重定位逻辑保持不变。

### 阅读页尺寸规则

`PageRenderer` 对正文内所有 `img` 使用统一样式：

- `max-width: 100%`，不能溢出正文；
- `max-height: min(32rem, 70vh)`，避免大图长期占满视口；
- `width: auto; height: auto`，保持原比例且不主动放大小图；
- `object-fit: contain`，在双重边界内完整展示；
- 水平居中，并保留与正文一致的上下间距和圆角。

尺寸策略仅属于 canonical 阅读页排版，不改变 Markdown 的通用渲染结果，也不影响编辑器、聊天消息或 Mermaid SVG。

## 非目标

- 不增加图片点击放大、灯箱、裁剪或逐图尺寸编辑。
- 不迁移历史正文中的 `[!diagram]` 内容；已有语义 callout 继续正常展示。
- 不改变生成模型、图片比例参数、资产格式、URL 或 Saga 写入流程。

## 测试策略

1. 先修改插图纯函数测试，使其期望标准 Markdown 图片，并确认旧实现失败。
2. 覆盖 job Changeset 与 applied operation 恢复，确保不再依赖 `[!diagram]` 包装。
3. 为 `PageRenderer` 增加静态渲染测试，锁定正文图片的等比、最大宽高与居中样式。
4. 运行相关 Vitest、TypeScript、lint、build 与 `git diff --check`。
