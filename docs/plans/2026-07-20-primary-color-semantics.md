# 全站主色语义调整实现计划

## 基线与范围

- 基线分支：`main`（`32dc9304`）
- 特性分支：`feat/primary-color-semantics`
- worktree：`.worktrees/primary-color-semantics`
- 设计文档：`docs/specs/2026-07-20-primary-color-semantics.md`
- 范围：将正常操作主色从纬线朱切换为经线靛，保留品牌资产与危险状态语义

## Task 1：提交设计与计划

涉及文件：

- `docs/specs/2026-07-20-primary-color-semantics.md`
- `docs/plans/2026-07-20-primary-color-semantics.md`

验证：

```bash
git diff --check
```

提交：`docs: 设计全站主色语义调整`

## Task 2：以 TDD 锁定主题语义边界

涉及文件：

- `src/lib/theme/__tests__/theme-token-contract.test.ts`

步骤：

1. 增加读取 `globals.css` 的主题契约测试。
2. 断言 `accent`、焦点、选区与图谱激活态引用 warp，品牌纬线与 danger 仍保持独立。
3. 运行测试并确认当前实现因 `accent` 引用 weft 而失败。

验证：

```bash
npx vitest run src/lib/theme/__tests__/theme-token-contract.test.ts
```

提交：与 Task 3 的最小实现一并提交，避免留下永久红灯提交。

## Task 3：切换全局操作主色并同步品牌说明

涉及文件：

- `src/app/globals.css`
- `docs/brand/README.md`
- `src/components/CLAUDE.md`

步骤：

1. 将亮暗主题的 accent、focus、selection、input focus 与 graph active 映射改为 warp 色阶。
2. 保持 `--brand-weft`、weft 基础色阶与 danger 语义不变。
3. 更新品牌 UI 色彩职责和组件模块变更记录。
4. 运行契约测试，确认由红转绿。

验证：

```bash
npx vitest run src/lib/theme/__tests__/theme-token-contract.test.ts
npx tsc --noEmit
```

提交：`feat: 调整全站主色与状态语义`

## Task 4：视觉冒烟、对比度与全量验证

步骤：

1. 计算亮暗主按钮、链接与危险文字的 WCAG 对比度。
2. 启动真实应用，检查 Dashboard、Sidebar、Settings、Wiki 与 Tasks 的亮暗主题。
3. 扫描残留红色，确认只用于危险、失败与 diff 删除语义。
4. 执行全量验证并复核相对基线 diff。

验证：

```bash
npx tsc --noEmit
npm test
npm run lint
npm run build
git diff --check
git status --short
```

仅在视觉冒烟或全量验证产生修正时新增提交：`fix: 补全主色语义覆盖`

完成后提醒是否按 `--no-ff` 回合 `main`，并在获得确认后删除 worktree 与特性分支。
