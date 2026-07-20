# 通用设置新增正文字号

日期：2026-07-20
状态：已定稿
关联 plan：`docs/plans/2026-07-20-body-font-size-setting.md`

## 背景

Wiki 阅读页正文当前固定使用 `16px / 28px` 排版。不同屏幕距离和阅读习惯需要不同字号，但当前只能依赖浏览器全局缩放，同时放大导航、按钮和代码等非正文界面。

## 目标

- 在「设置 → 通用」新增全局「正文字号」配置。
- 默认值严格保持当前 `16px` 样式，未保存过配置的现有用户视觉不变。
- 配置只影响 Wiki canonical / reshape 阅读正文；不改变页面标题、导航、编辑器、来源预览和代码字体。
- 保存后当前页面立即生效，刷新后仍在首屏绘制前生效，避免字号闪动。
- `app_settings` 继续作为服务端唯一真实源，不把配置镜像到 Zustand。

## 非目标

- 不新增字体家族、字重、行宽或标题字号配置。
- 不按 Subject 或用户画像分别存储。
- 不改变浏览器缩放和无障碍缩放行为。
- 不调整来源文档、编辑器预览或 Ask AI 消息排版。

## 方案对比

### 方案 A：全局 CSS 变量 + `app_settings`（推荐）

在 `app_settings` 增加 `bodyFontSize`，范围为 `14–22` 的整数，默认 `16`。根布局服务端读取该值并在 `<html>` 注入 `--wiki-body-font-size`；正文容器用该变量设置字号，并用 `1.75` 的相对行高保持当前 `16px / 28px` 基线。设置保存成功后客户端同步更新根元素变量。

优点：首屏无闪动、刷新后稳定、当前页即时生效；数据仍以服务端为准；正文消费点单一。代价：根布局需要读取一次轻量 SQLite key。

### 方案 B：阅读页客户端请求设置

`WikiReadingView` 挂载后请求 `/api/settings` 再传给正文。

优点：不改根布局。缺点：首屏先显示默认字号再跳变；通用 settings 响应包含与阅读无关的字段；每次进入阅读页增加请求。否决。

### 方案 C：仅存 localStorage

设置页直接写浏览器本地状态和 CSS 变量。

优点：实现最小。缺点：违背全局设置由 `app_settings` 管理的约定，跨浏览器不一致，也形成第二真实源。否决。

## 详细设计

### 契约与持久化

- `DEFAULT_BODY_FONT_SIZE = 16`。
- `BodyFontSizeSchema = z.number().int().min(14).max(22)`。
- `AppSettings.bodyFontSize: number`，`AppSettingsSchema` 与 `PUT /api/settings` 同步扩展。
- `settings-repo` 提供 `getBodyFontSize()` / `setBodyFontSize()`；缺失或历史脏值均回退默认值。
- 不增加数据库迁移，复用 `app_settings` key/value 表。

### 设置界面

- `General` 增加 `reading` section，标题为「阅读 / Reading」。
- 使用现有 `NumberRow`，范围 `14–22`，以 `px` 描述单位；行级即时保存与既有设置一致。
- 保存成功后把服务端返回的规范值写入 `document.documentElement.style`，保证已打开文章立即更新。

### 阅读渲染

- 根布局读取 `getBodyFontSize()`，在 `<html>` 写入 `--wiki-body-font-size: 16px` 形式的内联变量。
- `PageRenderer` 正文从固定 `text-[16px] leading-7` 改为变量字号和 `1.75` 相对行高。
- 代码块继续使用既有 `text-sm` / `0.875em` 规则；页面标题与各级 heading 保持固定字号。

## 成功标准

- 无配置时 API 返回 `16`，阅读正文计算字号为 `16px`、行高仍为 `28px`。
- 设置 `14` 或 `22` 后 API 往返一致，当前页面立即更新；刷新后首屏保持该值。
- 越界值、非整数及数据库历史脏值不会进入渲染。
- 中英文设置文案完整。
- 定向测试、TypeScript、lint、全量 Vitest 与生产构建通过，并在桌面/移动视口完成真实页面检查。
