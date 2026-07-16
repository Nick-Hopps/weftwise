# Tags Review 清理队列实现计划

**目标：** 将 `/tags?scope=review` 从普通目录过滤器升级为可解释、可逐项处理的标签清理队列。

**架构：** `src/lib/tags.ts` 生成纯 `TagReviewQueue`；新的 `TagReviewQueueView` 只负责展示和上抛治理意图；`TagsIndexView` 保留请求、URL 状态和 PendingAction 生命周期。零后端与数据库改动。

**Spec：** `docs/superpowers/specs/2026-07-16-tags-review-queue-design.md`

## 全局约束

- 代码注释、task、plan、spec 使用中文。
- 严格 TDD：先看到目标测试因导出/行为缺失而失败，再写最小实现。
- All 目录、组合标签页和服务端审批契约不变。
- 使用现有 `Button`、`IconButton`、`Tag` 与 Lucide 图标，不新增设计系统原语。
- 分区使用无卡片列表和分隔线；移动端不得水平溢出。

## Task 1：Review 队列纯分析函数

**文件：**

- 修改：`src/lib/tags.ts`
- 测试：`src/lib/__tests__/tags.test.ts`

1. 写失败测试，覆盖：
   - 使用次数优先、标准 kebab-case 次优的 canonical 选择；
   - variant 与 singleton 分区去重；
   - 未标记内容页排序和 meta 页面排除；
   - issueCount 计算；
   - 搜索命中 variant/canonical、singleton 页面文本和 untagged 页面文本。
2. 运行 `npm test -- src/lib/__tests__/tags.test.ts`，确认因 `buildTagReviewQueue` / `filterTagReviewQueue` 不存在而失败。
3. 最小实现类型与纯函数。
4. 重跑同一测试转绿。
5. 提交：`feat: 新增 Tags 清理队列分析`

## Task 2：清理队列展示组件

**文件：**

- 新增：`src/components/tags/tag-review-queue.tsx`
- 修改：`src/components/tags/tags-index-view.tsx`

1. 新建无数据请求的展示组件：
   - Format variants：显示 `source -> canonical`、两侧使用次数和 `Preview merge`；
   - Single-use tags：显示唯一页面、详情入口和省略号治理；
   - Untagged pages：显示页面标题、摘要、更新时间和页面入口；
   - 零问题时显示 `Review clear`。
2. 将治理弹窗状态从单个 tag 扩展为 `{ sourceTag, suggestedTarget? }`。
3. `TagsIndexView`：
   - 动态生成 `Review N` scope 文案；
   - Review 使用 `filterTagReviewQueue` 的结果；
   - Review 隐藏无意义的排序控件；
   - All 保持既有目录和排序；
   - 即使全部页面无标签，Review 仍展示 Untagged pages。
4. 运行定向测试与 `npm run lint`。
5. 提交：`feat: 升级 Tags Review 清理工作流`

## Task 3：文档、浏览器与全量验证

**文件：**

- 修改：`src/components/CLAUDE.md`
- 修改：`src/lib/CLAUDE.md`

1. 更新模块职责与 changelog。
2. 用 `/tmp` 隔离 Vault/SQLite 准备：格式变体、单次标签、未标记页面和 meta 页面。
3. 浏览器验收桌面与 390x844：
   - Review 数量和三个分区；
   - 搜索过滤；
   - `Preview merge` 预填正确；
   - 弹窗、列表、长标签无重叠与水平溢出；
   - All 目录未回归。
4. 运行：
   - `npm test`
   - `npm run lint`
   - `npm run build`
   - `git diff --check`
5. 提交：`docs: 同步 Tags 清理队列文档`

## Task 4：同功能迭代折叠与合并

本轮是在未推送的 `feat/tag-governance` 特性组上继续迭代。完成后：

1. 记录重写前最终 tree hash。
2. 以 `2aa8633^1`（`7f7aa0a`）为基点，把原标签治理和本轮 Review 队列压成一个特性提交。
3. 回到 `main`，确认没有新提交或未提交改动后重置到基点。
4. 用 `--no-ff` 重新合并重建后的 `feat/tag-governance`。
5. 用 `git diff <重写前tree> <重写后tree>` 验证树零差异。
6. 删除临时 worktree 与分支。
