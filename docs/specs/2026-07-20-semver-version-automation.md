# SemVer 版本号自动化（beta 阶段）

- 日期：2026-07-20
- 状态：已定稿
- 关联计划：[docs/plans/2026-07-20-semver-version-automation.md](../plans/2026-07-20-semver-version-automation.md)

## 一、背景与现状

- `package.json` 的 `version` 长期停留在 `0.1.0`，从未随功能演进更新。
- 仓库已有稳定的提交约定（见 `AGENTS.md` 九）：英文 Conventional Commit 前缀 + 中文摘要（`feat:` / `fix:` / `docs:` / `revert:` / `merge:`）。
- 仓库无 husky、无自定义 git hooks（`.git/hooks` 全是 sample），无 remote，不发 npm 包。
- 工作流特点：特性分支 `--no-ff` 合回 main；迭代提交会用 `reset --soft` 压缩重建；偶尔 `--amend`。

## 二、目的与成功标准

**目的**：每次提交代码时，根据提交类型自动自增 `package.json` 版本号，遵循 SemVer；当前处于 beta 阶段（major 固定为 0）。

**成功标准**：

1. `feat:` 提交自动使 minor +1（patch 归零）；`fix:` 提交自动使 patch +1；版本变更包含在**同一个提交**内。
2. `docs:` / `merge:` / `revert:` 等其他类型提交不改动版本。
3. 压缩重建（`reset --soft` 后重提交）、merge、rebase、amend 场景不会重复自增。
4. 纯逻辑有单元测试锁定；hook 经真实提交验证。
5. 机制随仓库版本控制，`npm install` 后自动生效，无需手工装 hook。

## 三、约束

- 无 remote、单人开发，不需要考虑 CI 发布联动。
- hook 必须可跳过（escape hatch），避免特殊操作被卡死。
- 不引入与需求不成比例的依赖（YAGNI）。

## 四、方案对比

### 方案 A：`core.hooksPath` + 版本控制的 `post-commit` hook（推荐）

- 仓库内落 `.githooks/post-commit`，提交完成后脚本解析提交信息前缀，计算新版本写回 `package.json`，`git commit --amend --no-verify` 并回同一提交。
- 为何不用 `commit-msg` hook：实测证明 git 在 commit-msg 阶段前已锁定本次提交的树，hook 内 `git add` 的内容只会留在暂存区、不会进入本次提交；post-commit + 自我 amend 是此类工具的标准做法（amend 时带 `SKIP_VERSION_BUMP=1` 防递归）。
- `package.json` 增加 `"prepare": "git config core.hooksPath .githooks || true"`，`npm install` 时自动接线；`core.hooksPath` 是仓库级配置，所有 worktree 共享。
- 纯逻辑（解析提交类型 → 计算下一版本）下沉为纯函数，vitest 单测；hook 只做 IO 与守卫。
- 优点：零新依赖、与仓库 scripts/ 既有 tsx 风格一致、逻辑可测。
- 缺点：hooksPath 指向后 `.git/hooks` 下的本地 hook 不再生效（当前没有，无影响）。

### 方案 B：husky + 同样的脚本

- 与方案 A 等价的效果，多一个依赖与 `.husky/` 目录。husky 的价值在团队协作与多 hook 管理，本仓库单人使用收益为零。

### 方案 C：发布工具（changesets / release-it / standard-version）

- 这些工具是「按 release 批量结算版本 + changelog + tag」的模型，与「每次提交即时自增」的需求不匹配；standard-version 已弃权维护。

**结论**：采用方案 A。

## 五、版本规则

### beta 阶段（major = 0，当前状态）

| 提交类型 | 动作 | 示例 |
|----------|------|------|
| `feat:`（含 `feat!:` / BREAKING CHANGE） | minor +1，patch 归零 | 0.1.0 → 0.2.0 |
| `fix:` | patch +1 | 0.2.0 → 0.2.1 |
| 其他（`docs:` / `merge:` / `revert:` / `chore:` …） | 不变 | — |

> SemVer 规范中 0.y.z 阶段 API 不承诺稳定，破坏性变更也落在 minor；major 停留在 0。

### 稳定阶段（major ≥ 1，预留）

| 提交类型 | 动作 |
|----------|------|
| `feat!:` / BREAKING CHANGE | major +1 |
| `feat:` | minor +1 |
| `fix:` | patch +1 |

**升级到 1.0.0 是人工决策**：手动改 `package.json` 后以 `chore:` 提交，自动化不参与。此后上表规则由同一纯函数自动生效，无需改代码。

### 防重复自增守卫（按序判断，命中即跳过）

1. `SKIP_VERSION_BUMP=1` 环境变量 —— 显式逃生舱，同时是自我 amend 的防递归标记。
2. merge / rebase / cherry-pick 进行中（`MERGE_HEAD` / `rebase-merge` / `rebase-apply` / `CHERRY_PICK_HEAD` 存在）。
3. `HEAD` 与父提交的 version 已不同 —— 本提交已带版本变更（天然覆盖**所有** amend 重触发与 `reset --soft` 压缩重建场景，hook 幂等）。
4. 提交类型不是 `feat` / `fix`。
5. 暂存区与 `HEAD` 不一致（partial commit 的遗留暂存）或 `package.json` 有未暂存改动 —— amend 会卷入不属于本提交的内容，打印提示后跳过。

**已知限制**：feat / fix 提交完成后 SHA 会被 amend 重写一次（终端先打印原 SHA，`git log` 以 amend 后为准）；本仓库无 remote、单人开发，无实际影响。

## 六、落点

| 文件 | 职责 |
|------|------|
| `scripts/version/compute-next-version.ts` | 纯函数：`(当前版本, 提交信息) → 新版本 \| null`，含 SemVer 解析与 beta/stable 规则 |
| `scripts/version/__tests__/compute-next-version.test.ts` | 纯函数单测 |
| `scripts/version/post-commit-bump.ts` | hook 入口：守卫 → 改写 `package.json` → `git add` → `--amend --no-verify` 并回原提交 |
| `.githooks/post-commit` | shell shim，经 `npx --no-install tsx` 调用上面的入口 |
| `package.json` | `version` 起点不变；新增 `prepare` script |
| `vitest.config.ts` | include 扩展 `scripts/**/__tests__/**/*.test.ts` |
| `AGENTS.md` | 九、Git 协作约定补充版本管理规则 |
