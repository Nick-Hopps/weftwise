# 阅读偏好、Diagram 预览与 Usage 项目过滤设计

## 背景

当前有三个彼此独立但规模较小的体验缺口：

1. 阅读页只要存在已保存的 Reshape 版本，每次进入都会默认展示 Reshape；用户切换回原文后，换页或刷新不会记住这个选择。
2. Mermaid diagram 被正文宽度限制；节点多时整图会缩到很小，缺少可读的大画布。
3. Settings → Usage 只能按时间窗口查看全局汇总。`llm_usage` 没有 project/subject 归因，现有数据无法可靠按项目过滤。

## 目标与成功标准

- 每个 `subject + page slug` 独立记住“默认看原文”或“默认看 Reshape”；刷新、离开后返回仍生效，不改变没有保存版时的 canonical 回退。
- 每张成功渲染的 Mermaid 图都能打开大尺寸预览；预览支持放大、缩小、复位、滚动查看和 Esc/遮罩关闭。
- Usage 支持“All projects”与单项目筛选；筛选同时影响明细和合计，并由服务端查询真实归因数据。
- 三项功能均保持中英文文案、键盘可达性和现有移动端布局。

## 非目标

- 不把阅读偏好同步到账号或多设备。
- 不实现 diagram 拖拽画布、导出 PNG/SVG 或编辑源码。
- 不尝试按时间或 task 猜测旧 Usage 记录属于哪个项目；历史未归因数据只计入“All projects”。
- 不改变 Usage 的 90 天保留策略和 `(task, model)` 聚合维度。

## 方案比较

### 1. 页面默认版本记忆

#### 方案 A：按页面写 `localStorage`（推荐）

- Key 包含 `subjectSlug + slug`，值为 `canonical | reshape`。
- 优点：符合阅读 UI 偏好的客户端属性；无需 API/迁移；页面间隔离；刷新后可恢复。
- 缺点：不跨浏览器同步。

#### 方案 B：写入 Zustand 持久化 store

- 优点：集中管理客户端状态。
- 缺点：会让全局 UI store 累积页面级条目，并引入 store 版本迁移；此偏好只在阅读页消费，收益有限。

#### 方案 C：新增数据库偏好表

- 优点：未来可跨设备。
- 缺点：需要用户维度 API、数据库迁移和清理生命周期；当前本地单用户场景超出需求。

选择方案 A。读取失败或存储不可用时回退现有行为：有保存版则默认 Reshape。

### 2. Diagram 放大预览

#### 方案 A：全屏预览 + 缩放控件（推荐）

- 正文图右上角提供放大按钮；打开 portal 全屏浮层，重新渲染同一 Mermaid 源码。
- 预览画布保留 SVG 自然尺寸，通过比例变换和双向滚动查看；提供缩小、复位、放大、关闭。
- 优点：不扰动正文排版，复杂图有足够空间，交互边界清晰。
- 缺点：同一图在打开预览时会额外渲染一次 Mermaid。

#### 方案 B：正文内直接缩放

- 优点：实现较少。
- 缺点：会改变文章高度和横向滚动，容易破坏阅读位置。

#### 方案 C：仅点击后用浏览器原生 SVG 新页

- 优点：代码最少。
- 缺点：丢失应用主题与上下文，返回路径和弹窗体验较差。

选择方案 A。缩放限制为 50%–200%，每次 25%，打开时 100%。

### 3. Usage 项目过滤

#### 方案 A：`llm_usage.subject_id` 显式归因（推荐）

- 新增可空 `subject_id`，删除项目时置空以保留历史总量；建立查询索引。
- 所有掌握 Subject 上下文的调用链显式传入 `subjectId`，Usage repo 按时间与项目组合过滤。
- 优点：归因真实、查询直接、不会依赖脆弱的时间关联。
- 缺点：旧数据无法回填，需改动多个 LLM 调用边界。

#### 方案 B：按 job 时间段关联 Usage

- 优点：不改调用签名。
- 缺点：并发 job、前台 Query/Reshape 与重试会产生误归因，不可接受。

#### 方案 C：仅前端按 task 推断项目

- 优点：无迁移。
- 缺点：task 并不唯一属于某项目，无法满足真实过滤。

选择方案 A。API 使用可选 `subjectId` 查询参数；缺省为全部项目，未知项目返回 400。设置页复用现有 subjects 查询，提供单选项目下拉。

## 数据与控制流

### 阅读偏好

```text
进入页面
  -> 读取 localStorage(subjectSlug, slug)
  -> 同时 GET 已保存 Lens
  -> canonical 偏好：即使保存版存在也展示原文
  -> reshape 偏好或无偏好：保存版存在则展示保存版，否则展示原文
  -> 用户切换时立即写回该页面偏好
```

### Diagram

```text
正文 Mermaid 渲染成功
  -> 显示“放大预览”按钮
  -> 打开全屏 portal
  -> 同源 Mermaid 以当前主题重新渲染
  -> 缩放控件改变预览比例；画布负责滚动
  -> Esc / 遮罩 / 关闭按钮退出并恢复 body 滚动
```

### Usage

```text
LLM 调用边界获得 subjectId
  -> recordUsage(..., subjectId)
  -> llm_usage.subject_id
  -> GET /api/usage?window=30d&subjectId=<id>
  -> summarizeUsage({ sinceMs, subjectId })
  -> Settings 明细与合计刷新
```

## 数据迁移与兼容

- `llm_usage.subject_id` 允许 `NULL`，旧行自动保持 `NULL`。
- All projects 查询包含已归因和未归因记录；单项目查询只包含精确 `subject_id`。
- 项目删除使用 `ON DELETE SET NULL`，避免 Usage 历史被删除。
- 读取偏好时兼容缺值和非法值，统一回退 `reshape`。

## 测试策略

- 纯函数测试锁定页面 preference key、非法值回退与存取失败降级。
- Mermaid 预览测试锁定缩放边界和预览动作文案/结构；组件保留失败时源码回退。
- Usage repo 真实 SQLite 测试锁定 subject 写入、按项目过滤、时间+项目组合以及全量兼容。
- API 测试锁定 `subjectId` 解析、未知项目 400 与 repo 参数。
- Provider/agent/image 测试锁定 `subjectId` 确实传入 `recordUsage`。
- 最终运行定向测试、全量测试、lint 与生产 build。
