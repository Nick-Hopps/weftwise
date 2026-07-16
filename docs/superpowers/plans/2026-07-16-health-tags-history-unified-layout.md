# Health、Tags 与 History 页面统一布局实现计划

**目标：** 在不改变三页业务能力和服务端契约的前提下，统一知识运维页面的布局、视觉层级和响应式体验。

**架构：** 新增无业务依赖的 `workspace-page` UI 原语，三页组合复用页头、摘要、sticky 工具栏和状态区；各自领域列表只做必要的边界、密度和响应式适配。

**Spec：** `docs/superpowers/specs/2026-07-16-health-tags-history-unified-layout-design.md`

## 全局约束

- task、plan、spec 与代码注释使用中文。
- 严格 TDD：先看到共享原语结构测试因模块缺失而失败，再做最小实现。
- 不改变 API、React Query key、PendingAction、Health remediation、Tags URL 状态或 History 回滚语义。
- 只使用现有 CSS 变量、设计系统原语和 Lucide 图标。
- 页面保持安静、无卡片矩阵、无装饰渐变；移动端不得水平溢出。

## Task 1：共享知识运维页面原语

**文件：**

- 新增：`src/components/ui/workspace-page.tsx`
- 新增：`src/components/ui/__tests__/workspace-page.test.ts`

1. 写失败测试，锁定共享原语导出及其关键结构契约：统一页面宽度、页头 title/description/actions、指标语义、sticky 工具栏和状态区。
2. 运行定向测试，确认因模块不存在而失败。
3. 最小实现五个组合原语，不引入业务状态。
4. 重跑测试转绿并执行 `npx tsc --noEmit`。
5. 提交：`feat: 新增知识运维页面布局原语`

## Task 2：统一 Health 与 Tags

**文件：**

- 修改：`src/components/health/health-view.tsx`
- 修改：`src/components/health/research-backlog-section.tsx`
- 修改：`src/components/tags/tags-index-view.tsx`
- 修改：`src/components/tags/tag-review-queue.tsx`
- 修改：`src/components/tags/tags-route-fallback.tsx`

1. Health 迁移页头、五项摘要、sticky 工具栏、loading/empty/error 容器。
2. 保持现有 finding 分组与处置逻辑，统一列表边界并去掉装饰阴影。
3. Tags 迁移页头、四项摘要、sticky 工具栏和状态区；保持 URL 与治理审批不变。
4. Review 分区标题和列表密度与 Health 对齐。
5. 运行 Health/Tags 定向测试、lint 与类型检查。
6. 提交：`feat: 统一 Health 与 Tags 工作台布局`

## Task 3：统一 History 主从工作区

**文件：**

- 修改：`src/components/history/operation-list.tsx`

1. 将页头移到统一页面框架，显示当前 Subject 与记录数量。
2. 桌面版改为标准内容区内的两栏主从布局；默认选中最新记录。
3. 移动端改为分隔列表 + 行内详情，保留原交互。
4. 统一 loading/empty 状态；API、diff 与回滚组件不变。
5. 运行类型检查、lint 与相关测试。
6. 提交：`feat: 统一 History 主从工作区布局`

## Task 4：文档与完整验证

**文件：**

- 修改：`src/components/CLAUDE.md`

1. 更新 UI 原语及三个页面的模块说明与 changelog。
2. 浏览器核验 1440x900 与 390x844 下的 Health、Tags、History：
   - 页头、宽度、摘要和 sticky 工具栏一致；
   - Tags All/Review 搜索与排序正常；
   - Health scope、筛选和动作区不挤压；
   - History 默认选择、切换、diff 和移动端展开正常；
   - 无 console error、横向溢出或遮挡。
3. 运行：
   - `npm test`
   - `npm run lint`
   - `npx tsc --noEmit`
   - `npm run build`
   - `git diff --check`
4. 提交：`docs: 同步知识运维页面统一布局文档`

## Task 5：合回主分支

1. 亲自检查 worktree diff、提交序列和最终 tree。
2. 回到 `main`，确认基线未漂移且工作区干净。
3. 使用 `git merge --no-ff feat/health-tags-history-unified-layout`，merge message 为 `merge: 合并 feat/health-tags-history-unified-layout：统一知识运维页面布局`。
4. 合并后复跑必要验证并检查目标分支落点。
5. 删除 worktree 与特性分支。
