# weftwise 全仓库项目标识迁移实现计划

## 基线与范围

- 基线分支：`agent/rewrite-readme`
- 特性分支：`feat/rename-project-to-weftwise`
- 设计文档：`docs/specs/2026-07-18-weftwise-project-rename.md`
- 范围：当前 Git HEAD 的可追踪文本、运行时标识、包元数据与文件名

## Task 1：提交设计与计划

涉及文件：

- `docs/specs/2026-07-18-weftwise-project-rename.md`
- `docs/plans/2026-07-18-weftwise-project-rename.md`

验证：

```bash
git diff --check
```

提交：`docs: 设计 weftwise 全仓库项目标识迁移`

## Task 2：迁移运行时与包元数据

涉及文件：

- `package.json`
- `package-lock.json`
- `llm-config.schema.json`
- `src/server/git/git-service.ts`
- `src/server/sources/url-fetcher.ts`
- 对应测试文件

步骤：

1. 先运行相关测试或字符串守卫，确认因旧标识存在而失败。
2. 将包名、schema 标题、User-Agent、vault 初始化文案统一为 `weftwise`。
3. 运行定向测试与类型检查。

验证：

```bash
npx vitest run <相关测试文件>
npx tsc --noEmit
```

提交：`refactor: 统一 weftwise 运行时与包标识`

## Task 3：迁移全部文档与文件名

涉及文件：

- `AGENTS.md`
- `CLAUDE.md` 与各模块 `CLAUDE.md`
- `CHANGELOG.md`
- `docs/**`
- `examples/**`
- 文件名中包含旧项目 slug 的设计与计划文档

步骤：

1. 对 Git 可追踪文本做大小写敏感的品牌替换。
2. 重命名两个历史设计/计划文件。
3. 更新指向新文件名的全部引用。
4. 检查当前树与文件名中不再存在旧标识的三种分隔形式。

验证：

```bash
old_a=agentic
old_b=wiki
! git grep -n -i -E "${old_a}[-_ ]${old_b}"
! git ls-files | rg -i "${old_a}[-_ ]${old_b}"
git diff --check
```

提交：`docs: 迁移 weftwise 全仓库文档标识`

## Task 4：全量验证与回合

验证：

```bash
npx tsc --noEmit
npm test
npm run lint
npm run build
git diff --check
```

完成后检查特性分支相对基线的完整 diff，以 `--no-ff` 合回 `agent/rewrite-readme`，推送现有 README PR，并清理 worktree 与特性分支。
