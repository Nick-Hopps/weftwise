# 中英双语国际化设计

## 背景

weftwise 当前的产品界面文案直接散落在 Server Component、Client Component 与少量纯函数中，根布局固定输出 `lang="en"`，日期格式则跟随运行环境或写死为 `en-US`。设置中的 `wikiLanguage` 只控制 LLM 生成的知识内容，不应承担产品界面语言职责。

这会带来四个问题：

1. 中文用户无法把产品界面切换为中文；
2. 服务端首屏与客户端若各自判断语言，容易产生 hydration 不一致或可见闪烁；
3. 界面语言与 Wiki 内容语言语义混淆，切换 UI 可能意外改变后续知识内容；
4. 新增文案没有统一入口，后续继续扩展语言时无法检查翻译完整性。

## 目标

- 首版支持 `en`（English）和 `zh-CN`（简体中文）两种产品界面语言。
- 首次访问根据 `Accept-Language` 选择语言；用户手动选择后以 `wiki_locale` cookie 为准。
- 服务端首屏、客户端交互、`<html lang>`、页面 metadata 与日期/数字格式使用同一 locale。
- 在 Settings → General 中提供独立的 “Interface language / 界面语言” 切换，不改变现有 `wikiLanguage`。
- 产品自有的导航、设置、空状态、按钮、辅助说明、无障碍标签和主要工作流文案纳入字典；用户内容、Subject 名称、模型输出与服务端原始错误不翻译。
- 英文字典作为消息键契约，中文词典在编译期必须覆盖完全相同的键。

## 约束与成功标准

### 约束

- 保持现有 URL，不增加 `/en`、`/zh-CN` 路由前缀。
- 不新增数据库字段或迁移；界面语言是浏览器偏好，不是全应用共享配置。
- 不引入新的第三方国际化运行时；首版只实现当前需要的查词、参数插值和 Intl 格式化。
- `wikiLanguage` 仍由 `app_settings` 持久化，并继续只影响 LLM 生成内容。
- locale cookie 不包含敏感信息，使用 `Path=/; SameSite=Lax; Max-Age=31536000`。

### 成功标准

1. 无 cookie 时，`Accept-Language` 中优先级最高的受支持语言决定首屏语言，其他语言回落英文。
2. 有合法 cookie 时 cookie 覆盖请求头；非法 cookie 安全回落请求头或英文。
3. 设置中切换语言后，当前页面立即更新，并刷新 Server Component；刷新浏览器后保持选择。
4. `document.documentElement.lang`、服务端 HTML 与客户端 Provider 的 locale 一致，不产生 hydration 警告。
5. 英中消息键、插值占位符完全一致；缺失翻译在测试或类型检查阶段暴露。
6. 受影响的定向测试、全量测试、类型检查、lint 与生产构建通过。

## 方案比较

### 方案 A：引入 `next-intl` 并使用 locale 路由

优点是生态成熟，支持复数、命名空间和路由级静态生成；缺点是需要重构所有现有链接和路由，增加依赖与中间件，对只有中英双语、无多语言 URL/SEO 诉求的个人知识应用明显过重。

### 方案 B：应用内类型安全字典 + cookie locale（采用）

根布局读取 cookie 和 `Accept-Language`，将 locale 同时传给客户端 Provider 并写入 `<html lang>`；Server Component 通过 server helper 读取同一来源。客户端 `useI18n()` 提供翻译、日期与数字格式化，并负责切换 cookie 后 `router.refresh()`。

优点是保持现有 URL、依赖为零、首屏一致，且界面语言与内容语言边界清晰；代价是首版需要维护少量自有基础设施，复杂复数规则需在未来按需增强。

### 方案 C：把界面语言写入 `app_settings`

优点是可复用现有设置 API；缺点是 `app_settings` 是全 app 单实例，同一部署中一个浏览器切换会影响其他用户，并且根布局读取数据库会把展示偏好耦合到服务端配置。界面语言更适合作为浏览器级 cookie，因此不采用。

## 设计

### Locale 解析

- `SUPPORTED_LOCALES = ['en', 'zh-CN']`，默认 `en`。
- cookie 接受规范值，并兼容大小写与 `zh`、`zh-CN`、`zh-Hans` 归一为 `zh-CN`。
- `Accept-Language` 按 `q` 权重与原始顺序解析；任意简体/通用中文映射到 `zh-CN`，英文映射到 `en`，不支持的语言跳过。
- 合法 cookie 的优先级高于请求头。

### 消息契约

- 消息使用稳定的点分键，例如 `settings.title`、`common.cancel`、`health.empty.title`。
- 英文字典定义 `MessageKey`；中文字典使用 `satisfies Record<MessageKey, string>` 保证无缺失键和无额外漂移键。
- `t(key, params)` 只支持 `{name}` 形式的具名插值；测试检查两种语言占位符集合一致。
- 用户数据和任意服务端错误保持原文，产品提供的错误前缀、动作建议与状态名称进入字典。

### 服务端与客户端边界

- 根布局调用 `getServerLocale()`，设置 `<html lang>`、localized metadata，并以 `initialLocale` 初始化 `I18nProvider`。
- Client Component 使用 `useI18n()`；Provider 暴露 `locale`、`setLocale`、`t`、`formatDate`、`formatNumber`。
- Server Component 使用 `getServerI18n()`，返回相同的 `t` 和 Intl formatter。
- 切换语言时先更新 Provider 状态与 `<html lang>`，再写 cookie 并 `router.refresh()`，使 Client 与 Server Component 一次交互内收敛。

### 设置交互

- General / 通用设置的 Appearance / 外观区域新增界面语言分段选择。
- Content language / 内容语言保留原位置，并明确说明它只影响 LLM 新生成的 Wiki 内容。
- 界面语言保存不走 `/api/settings`，不会显示数据库保存状态；cookie 写入是同步、可恢复操作。

### 翻译覆盖范围

首版覆盖当前产品自有 UI：

- 根 metadata、Header、Sidebar、Subject、Search、Settings、Context Panel；
- Dashboard、Ingest、Source、Wiki 阅读/编辑、Ask AI、任务进度；
- Tags、Health、History、Graph 与共享空/错状态；
- 按钮 title、placeholder、`aria-label`、状态标签以及产品生成的日期/数字。

以下内容明确不翻译：

- Wiki 正文、标题、标签、Subject 名称与 source 原文；
- LLM 回答、agent 日志、git diff 和后端返回的原始错误详情；
- API JSON 字段名、数据库枚举、路由段与快捷键字符。

## 风险与缓解

- **遗漏硬编码文案**：按模块迁移，最后使用文本扫描清单复核，并以真实中英文页面进行冒烟验证。
- **Server/Client locale 不一致**：根布局只传服务端解析结果，Provider 首次渲染不再次自行探测。
- **格式化导致测试不稳定**：纯函数测试固定 locale 与 UTC 时间，组件只消费封装后的 formatter。
- **大范围 diff 难评审**：基础设施、应用骨架、知识工作流、运维工作区分任务提交，每个任务保持可运行。

## 非目标

- Wiki 内容自动翻译或已有页面批量翻译。
- 根据界面语言自动改写 `wikiLanguage`。
- 多语言 slug、locale URL、SEO alternate links。
- 账号级/跨设备偏好同步。
- 首版加入第三种语言、ICU MessageFormat 或翻译管理平台。
