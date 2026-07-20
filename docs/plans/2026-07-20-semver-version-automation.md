# 实现计划：SemVer 版本号自动化（beta 阶段）

- 日期：2026-07-20
- 设计稿：[docs/specs/2026-07-20-semver-version-automation.md](../specs/2026-07-20-semver-version-automation.md)

## 任务 1：纯函数 `computeNextVersion`（TDD）

**涉及文件**：

- `scripts/version/compute-next-version.ts`（新增）
- `scripts/version/__tests__/compute-next-version.test.ts`（新增）
- `vitest.config.ts`（include 增加 `scripts/**/__tests__/**/*.test.ts`）

**行为**：`computeNextVersion(currentVersion, commitMessage) → string | null`

测试用例（先写失败测试再实现）：

- beta：`feat:` 0.1.0 → 0.2.0（patch 归零：0.1.3 → 0.2.0）；`fix:` 0.2.0 → 0.2.1
- beta：`feat!:` 与 body 含 `BREAKING CHANGE` → 仍是 minor +1（不动 major）
- stable：`feat!:` 1.2.3 → 2.0.0；`feat:` 1.2.3 → 1.3.0；`fix:` 1.2.3 → 1.2.4
- 带 scope：`feat(search): …` 正常识别
- 不 bump：`docs:` / `merge:` / `revert:` / `chore:` / 无前缀消息 → null
- 防御：当前版本非纯 `x.y.z`（如 `0.1.0-beta.1`、空串）→ null

**验证**：`npm test -- scripts/version`（先红后绿），`npx tsc --noEmit`

## 任务 2：post-commit hook 接线

> 首版采用 commit-msg hook，实测发现 git 在该阶段前已锁定提交树、hook 内 `git add` 不进入本次提交，遂改为 post-commit + 自我 amend（见 spec 四、方案 A）。

**涉及文件**：

- `scripts/version/post-commit-bump.ts`（新增，hook 入口）
- `.githooks/post-commit`（新增，可执行 shell shim）
- `package.json`（新增 `prepare` script）

**hook 入口逻辑**（薄 IO 层，按 spec 五的守卫顺序）：

1. 守卫：`SKIP_VERSION_BUMP=1`（逃生舱 + amend 防递归）；merge/rebase/cherry-pick 状态文件存在（`git rev-parse --git-dir` 定位，worktree-aware）；`HEAD` 与 `HEAD^` 的 package.json version 不一致（本提交已带版本变更）。
2. `computeNextVersion(HEAD version, git log -1 --format=%B)` 返回 null → 静默退出。
3. 安全检查：暂存区与 `HEAD` 一致且 `package.json` 无未暂存改动，否则打印提示跳过（防止 amend 卷入无关内容）。
4. 改写 `package.json`（`JSON.parse` → 改 version → 2 空格缩进 stringify + 换行）→ `git add` → `SKIP_VERSION_BUMP=1 git commit --amend --no-edit --no-verify --quiet`，stderr 打一行 `version: a.b.c → x.y.z`。
5. 任何意外错误只打印警告——版本号自动化不应影响提交流程。

**验证**（真实环境，worktree 内）：

- `git config core.hooksPath .githooks` 后依次做临时提交：`feat:` 自增 minor 且变更在同一提交内、`fix:` 自增 patch、`docs:` 不变、amend --no-edit 不重复自增、`SKIP_VERSION_BUMP=1` 跳过、暂存区不干净时安全跳过；验证后 `reset --hard` 清理临时提交。

## 任务 3：文档与收尾

**涉及文件**：`AGENTS.md`（九、Git 协作约定补充版本管理小节）

**验证**：`npx tsc --noEmit` + `npm test` 全绿；本特性自身的 `feat:` 提交应被 hook 自增到 `0.2.0`（自举验证）。

**提交序列**：`docs:`（spec + plan）→ `feat:`（实现 + AGENTS.md）→ 回 main `--no-ff` 合并。
