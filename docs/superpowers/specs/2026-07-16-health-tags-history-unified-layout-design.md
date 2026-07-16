# Health、Tags 与 History 页面统一布局设计

日期：2026-07-16
状态：已确认

## 一、背景

`/health`、`/tags` 与 `/history` 都是面向当前 Subject 的知识运维页面，但由不同阶段分别演进：

- Health 已形成宽版工作台，含摘要带、sticky 筛选与批量动作；
- Tags 是目录式维护页，宽度、标题尺寸和统计带与 Health 不一致；
- History 在桌面端另起全高左右分栏，页头被塞进左侧栏，脱离其他工作台的阅读秩序。

三页的业务能力没有问题，当前缺口是页面级视觉语法不一致：内容宽度、页头、范围信息、摘要、工具栏、列表边界、加载/空态和移动端退化各自为政。

## 二、目标与成功标准

### 目标

建立一套可复用的知识运维页面骨架，在不改 API、领域契约和审批边界的前提下统一三页布局与风格。

### 成功标准

1. 三页使用相同的最大内容宽度、横向留白、顶部节奏、标题字号和 Subject 上下文表达。
2. 摘要数据统一为无卡片的边界式指标带；没有指标的 History 使用同一位置承载记录范围与数量。
3. 搜索、筛选、范围切换和批量动作统一进入同一种 sticky 工具栏。
4. 主列表统一使用细分隔线、稳定行高、克制 hover 和明确选中态，不堆叠装饰卡片。
5. History 保留主从浏览，但位于标准页面框架内；窄屏继续使用内联展开。
6. 三页的 loading、empty、error 状态使用同一尺寸和信息层级。
7. 桌面与 390x844 移动端无横向溢出、文本遮挡或按钮挤压。

## 三、方案比较

| 方案 | 收益 | 代价与风险 | 结论 |
|------|------|------------|------|
| A. 共享页面原语 + 各页组合 | 从源头统一宽度、页头、摘要、工具栏和状态；保留业务差异；后续页面可复用 | 需要新增一个轻量 UI 原语并迁移三页 | **采用** |
| B. 三页各自复制统一类名 | 初期改动少 | Tailwind 类名会继续漂移；加载/空态仍重复 | 不采用 |
| C. 抽象通用数据表/工作台框架 | 统一程度最高 | Health、Tags、History 的内容与动作差异过大，抽象会携带大量条件分支 | 不采用 |

方案 A 符合 YAGNI：只抽取页面级视觉结构，不抽象领域列表与数据行为。

## 四、视觉与交互原则

### 视觉 thesis

安静的知识运维台：中性表面、细分隔线、稳定密度和单一强调色；让范围、状态与动作先于装饰被看见。

### 内容计划

1. 身份与范围：统一图标、20px 标题、Subject/检查时间等上下文及主动作。
2. 摘要：边界式指标带，数字使用 tabular nums，状态色只用于真实语义。
3. 控件：sticky 工具栏承载搜索、筛选、分段选择和批量动作。
4. 主工作区：Health 分组 finding、Tags 目录/Review 队列、History 主从列表。
5. 次级队列：Health Research backlog 保持在主 finding 之后，以顶部细分隔线降级呈现。

### 交互 thesis

- 工具栏滚动吸附并保留轻微 backdrop blur，维持操作上下文。
- 列表行只用背景色渐变表达 hover、选中和可点击性，不改变尺寸。
- 详情展开、分段切换和 History 选中使用现有短时 transition；不新增装饰动画。

## 五、共享原语

新增 `src/components/ui/workspace-page.tsx`，只承载视觉结构：

- `WorkspacePage`：统一 `max-w-[1080px]`、响应式 gutter 与纵向节奏；
- `WorkspacePageHeader`：统一 icon/title/description/meta/actions 排版；
- `WorkspaceSummary` / `WorkspaceMetric`：无卡片指标带；
- `WorkspaceToolbar`：统一 sticky 边界、背景与响应式容器；
- `WorkspaceState`：统一 loading 之外的空态/错误态高度、图标和操作位。

原语不读取 Subject、不请求 API、不认识 Health/Tags/History 类型。

## 六、页面适配

### Health

- 维持现有业务顺序与所有修复、整理、Research 行为。
- 页头、摘要带、sticky 工具栏和空态迁移到共享原语。
- 指标固定为 Open findings / Critical / Warning / Info / Recently verified。
- finding 分组列表保留业务结构，去掉外层阴影，使用与 Tags 相同的列表边界语言。

### Tags

- 页头与 Health 同宽同高；Subject 名作为上下文，不使用 monospace 强调。
- 四项统计迁移到共享指标带。
- 搜索、All/Review 和排序进入共享 sticky 工具栏。
- All 与 Review 的列表边界、分区标题和尾部计数保持紧凑。

### History

- 整页进入共享 `WorkspacePage`，页头不再放在左侧栏。
- 页头右侧显示当前记录数；摘要带位置用简洁范围信息，避免制造无意义 KPI。
- 桌面主工作区为有明确边界的 `320px + 1fr` 两栏，整体最小高度稳定；列表栏内部滚动，详情栏自适应。
- 默认选择最新一条记录，减少进入页面后的空白状态；若列表为空则显示统一空态。
- 移动端继续单列，但行改为无卡片分隔列表，展开详情位于原行下方。

## 七、边界与非目标

- 不改 `/api/health*`、`/api/pages`、`/api/history*`、PendingAction 或缓存 key。
- 不改变 Health 批量处置与 Subject scope 语义。
- 不改变 Tags URL 参数、Review 分区和治理审批流程。
- 不改变 diff 内容、回滚确认与 Saga 语义。
- 不新增图表、插图、渐变、卡片矩阵或新的颜色 token。

## 八、验证

- TDD：先为共享页面原语的结构契约写失败测试，再实现最小原语。
- 定向测试：共享原语、Tags 纯逻辑、Health UI helper 与 History 现有相关测试。
- 静态验证：`npm run lint`、`npx tsc --noEmit`、`npm run build`、`git diff --check`。
- 浏览器：桌面 1440x900 与移动端 390x844；逐页核验页头、摘要、sticky、列表/详情、空态、筛选与无横向溢出。

