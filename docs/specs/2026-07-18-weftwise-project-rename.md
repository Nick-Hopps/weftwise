# weftwise 全仓库项目标识迁移设计

## 背景

产品界面与品牌资产已经使用 `weftwise 织识`，GitHub 仓库也以 `weftwise` 发布，但仓库内仍保留旧项目标识。残留分布在 npm 包名、LLM 配置 schema、HTTP User-Agent、vault 初始化文案、架构导航、变更记录、历史设计文档、品牌提案与两个文件名中。

这会造成三个问题：

1. 新开发者从 GitHub、包元数据和内部文档看到不同项目名；
2. 运行时对外标识仍暴露旧品牌；
3. 后续搜索旧名时无法判断命中是历史记录还是尚未完成的迁移。

## 目标

- 当前 Git HEAD 的全部可追踪文件统一使用小写品牌名 `weftwise`。
- npm 包名、schema 标题、User-Agent 与 vault 初始化文案同步迁移。
- 重命名文件名中包含旧标识的设计与计划文档，并更新全部引用。
- 保留 Git 历史，不对既有 commit 做历史重写。
- 不强制重命名开发者本机已有 checkout 目录；GitHub 仓库名与新 clone 目录自然使用 `weftwise`。

## 方案比较

### 方案 A：只改运行时与用户可见位置

优点是 diff 小、风险低；缺点是架构文档、历史计划和文件名仍保留旧标识，不符合“全部改名”的明确要求。

### 方案 B：迁移当前 HEAD 的全部文本与文件名（采用）

对当前可追踪树做完整迁移，同时保留 commit 历史。优点是当前仓库搜索结果干净，品牌与工程标识一致；代价是历史文档会产生较大的机械替换 diff。

### 方案 C：连同 Git 历史一起重写

可以让所有历史 commit 也不再出现旧标识，但会改变全部 commit SHA、破坏已推送分支与 PR，风险远高于收益，不采用。

## 迁移规则

- 品牌正文统一写作 `weftwise`；中文组合名称仍写作 `weftwise 织识`。
- npm package name 使用 `weftwise`。
- HTTP User-Agent 使用 `weftwise/1.0`。
- 内部 client name 与 vault 初始化来源使用 `weftwise`。
- 文件名中的旧 slug 改为 `weftwise`，所有 Markdown 引用同步更新。
- 历史绝对路径示例按新 clone 目录名同步更新，但不移动当前本机 checkout。

## 成功标准

1. 当前可追踪文本中不再出现旧项目标识的连字符、空格或下划线变体。
2. 可追踪文件名中不再包含旧项目标识。
3. `package.json` 与 `package-lock.json` 的根包名一致为 `weftwise`。
4. 运行时标识变化由相关测试或现有测试覆盖。
5. 类型检查、全量测试、lint、生产构建和 diff 格式检查通过。

## 非目标

- 不重写 Git 历史。
- 不改变 `wiki` 领域术语、API 路由、数据库结构或 vault 数据格式。
- 不重命名本机现有工作目录。
