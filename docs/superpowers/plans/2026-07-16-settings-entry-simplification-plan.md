# 设置入口精简与体验优化实现计划

日期：2026-07-16

## 任务 1：锁定四分组信息架构

涉及文件：

- `src/components/layout/settings-categories.ts`
- `src/components/layout/__tests__/settings-categories.test.ts`

步骤：

1. 先写测试，断言一级入口顺序、默认入口和 section 映射。
2. 运行定向测试，确认因旧 8 分类结构而失败。
3. 最小修改分类类型与元数据，使测试转绿。

验证：

```bash
npx vitest run src/components/layout/__tests__/settings-categories.test.ts
```

## 任务 2：实现分组内容与响应式导航

涉及文件：

- `src/components/layout/settings-dialog.tsx`
- `src/components/layout/settings-nav.tsx`
- `src/components/layout/settings-content.tsx`

步骤：

1. 导航只渲染四个入口，并增加桌面版本信息与移动横向布局。
2. 将原有 panel 组合为 General、Personalization、Automation、Usage 四个页面。
3. 用 section 标题与分隔线建立内容层级，保留所有设置控件和即时保存逻辑。
4. 优化弹窗在桌面与移动端的尺寸、滚动边界和切换过渡。

验证：

```bash
npx vitest run src/components/layout/__tests__/settings-categories.test.ts src/lib/__tests__/settings-validation.test.ts
npx tsc --noEmit
```

## 任务 3：同步架构文档并完成回归验证

涉及文件：

- `src/components/CLAUDE.md`

步骤：

1. 更新 Settings 组件职责、分类数量与变更记录。
2. 运行全量测试、lint、类型检查与生产构建。
3. 启动开发服务器，用 Playwright 检查桌面/移动、明暗主题和四个入口切换。

验证：

```bash
npm test
npm run lint
npx tsc --noEmit
npm run build
```

## 任务 4：提交、合并与清理

步骤：

1. 保持 `docs:` 与 `feat:` 提交成对。
2. 在 `main` 使用 `--no-ff` 合并 `feat/settings-experience`。
3. 确认 merge commit 与文件落点后，删除 worktree 和特性分支。
