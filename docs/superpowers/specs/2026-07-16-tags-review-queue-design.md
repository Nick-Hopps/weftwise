# Tags Review 清理队列设计

日期：2026-07-16
状态：已确认

## 一、背景

`/tags` 已完成两阶段升级：

- 标签目录、覆盖率统计、搜索、排序和组合浏览；
- Rename / Merge / Delete 的服务端预览与 PendingAction 审批。

当前 `Review` 仍只是把“单次标签”和“格式变体”混在普通目录中过滤出来。用户看不到标签为什么需要处理、格式变体应合并到哪个目标，也无法发现完全未标记的内容页。因此它更像筛选器，不像可逐项清空的维护工作台。

## 二、目标与成功标准

### 目标

把 `Review` 升级为可解释、可操作、无需新增持久化状态的清理队列。

### 成功标准

1. Review 入口显示当前待处理项数量。
2. Review 视图分开呈现格式变体、单次标签、未标记页面，不再复用普通标签表格。
3. 每个格式变体都有确定性的推荐目标，可直接打开预填 Merge 的既有治理弹窗。
4. 同一格式变体不重复出现在“单次标签”区。
5. 搜索同时过滤三个 Review 分区，并保留格式变体组的上下文。
6. 没有待处理项时出现明确的清洁状态，而不是空白列表。
7. All 目录、标签详情页、PendingAction API 与 Saga 语义保持不变。

## 三、方案比较

| 方案 | 收益 | 代价与风险 | 结论 |
|------|------|------------|------|
| A. 可解释清理队列 | 直接提升现有 Review；纯前端分析；复用已有治理审批；风险低 | 一次仍只处理一个标签，不能一键全自动清理 | **采用** |
| B. 多选批量治理 | 大型知识库清理更快 | 需要扩展 TagBatch payload、跨组预览、失败语义和并发约束；审批面显著扩大 | 后续独立阶段 |
| C. 持久化标签层级/别名 | 能表达正式 taxonomy | 需要新增 Vault/DB 模型、解析规则、导航与迁移；远超当前问题 | 暂不采用 |

方案 A 符合 YAGNI：先把已经存在的诊断信号转成清晰工作流，不新增后端能力。

## 四、信息架构

### 视觉 thesis

安静、紧凑的维护队列：用分区标题、细分隔线和稳定行布局表达优先级，不增加卡片矩阵或装饰色。

### 内容计划

1. 顶部保留 Tags 标题与覆盖率摘要。
2. 工具栏保留搜索和 All / Review 切换；Review 标签携带待处理数量。
3. All 继续展示完整标签目录与排序。
4. Review 依次展示：Format variants、Single-use tags、Untagged pages。
5. 无问题时展示 Review clear 终态。

### 交互 thesis

- All / Review 切换只改变主工作区，不改变顶部统计和审批卡片位置。
- 格式变体的主动作是 `Preview merge`，打开现有治理弹窗并预填源标签与推荐目标。
- 单次标签保留“查看标签详情”和省略号治理；未标记页面只导航到页面，不绕过页面写入边界。

## 五、纯分析模型

在 `src/lib/tags.ts` 新增：

```ts
interface TagVariantReviewGroup {
  canonical: TagSummary;
  variants: TagSummary[];
}

interface TagReviewQueue {
  variantGroups: TagVariantReviewGroup[];
  singletonTags: TagSummary[];
  untaggedPages: WikiPage[];
  issueCount: number;
}

buildTagReviewQueue(pages, summaries?): TagReviewQueue
filterTagReviewQueue(queue, query): TagReviewQueue
```

### 推荐目标规则

每个格式变体组按以下顺序选 canonical：

1. 使用页数更多者优先，减少需要改写的页面；
2. 数量相同时，优先选择已经是小写 kebab-case 的标准形式；
3. 再按标签名稳定排序。

其余成员均为可合并 variant。推荐只影响弹窗初始值，用户仍可在预览前修改目标。

### 去重与排序

- 属于格式变体组的标签不再进入 singletonTags。
- singletonTags 按标签名排序，保证队列稳定。
- untaggedPages 只包含非 `meta` 内容页，按最近更新时间倒序、标题次序排序。
- `issueCount = variants 总数 + singletonTags 数量 + untaggedPages 数量`。

## 六、组件边界

新增 `src/components/tags/tag-review-queue.tsx`，只负责渲染分析结果和抛出治理意图：

```ts
onManageTag(sourceTag, suggestedTarget?)
```

`TagsIndexView` 继续拥有：

- URL scope/search 状态；
- PendingAction 恢复、批准与缓存刷新；
- 治理弹窗的开关和预填值。

新组件不请求 API、不创建审批、不持有 Subject 全局状态。

## 七、边界与非目标

- 不新增数据库表、迁移、Route Handler 或 PendingAction operation。
- 不自动执行批量清理，不把多个建议打包为一个审批。
- 不为未标记页面直接补标签；只导航到页面，避免在 Tags UI 复制 metadata 写入能力。
- 不改变格式变体判定规则：仍只忽略大小写并统一空格、下划线和连字符。
- 不把单次标签等同于错误；UI 使用“Review”而非“Fix”。

## 八、验证

- TDD：纯函数先写失败测试，覆盖 canonical 选择、分区去重、meta 排除、稳定排序、搜索。
- 定向测试：`npm test -- src/lib/__tests__/tags.test.ts src/components/tags/__tests__/tag-governance-state.test.ts`。
- 完整验证：`npm test`、`npm run lint`、`npm run build`、`git diff --check`。
- 浏览器：桌面与 390x844 移动端，覆盖三分区、空态、搜索、预填 Merge 弹窗和无水平溢出。
