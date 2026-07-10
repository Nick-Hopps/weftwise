# Wiki 工具面与工作流治理 Phase 0 实施计划

> **供执行代理：** 必须使用 `superpowers:executing-plans` 或 `superpowers:subagent-driven-development` 按任务执行；本计划使用复选框跟踪步骤。

**目标：** 完成交付 Phase 0「清理与硬边界」：删除不可达模型工具，把 `ToolDef.sideEffect` 变成运行时策略输入，收缩 Ask AI、Fix 与 Auto Curate 的能力面，并安全退役遗留内置 skill。

**架构：** 新增集中式 `ToolProfile`，所有 runner 先解析 profile，再把必传 `ToolExecutionPolicy` 交给 `compileToolSet`。编译层过滤未授权工具、拒绝非法副作用并包装 page scope；worker 的 Guard 继续作为写操作的第二道确定性边界。`commitPending` 迁到 runtime 内部函数，skill tombstone 通过历史模板 SHA-256 区分原版与用户改版。

**技术栈：** TypeScript 5、Vercel AI SDK 5、Vitest 2、Node.js `crypto/fs`、Next.js 15、现有 Saga/SQLite/vault/git 基础设施。

## 全局约束

- 不改变 Saga 顺序、subject 隔离、vault mutex、SQLite 索引和 git History 不变式。
- Query 普通问答只允许只读工具；Phase 0 不提前实现 PendingAction 或 preview/apply。
- Auto Curate 的可读写 page scope 必须由运行时与 Guard 共同强制，不能只写在 Prompt。
- 模型不再获得 `dispatch.skill` 或 `commit_changeset`；`finish` 仍只作为 provider 协议适配器。
- `ingest-indexer` 原版残留可删除；用户改版必须归档到 `.llm-wiki/skills-retired/`，不得丢失。
- 新增或修改的 task、plan、spec、代码注释和 commit message 使用中文。
- 每个行为变更遵循 RED → GREEN → REFACTOR；每个任务结束时运行其定向测试并提交。

## 文件结构

- 新建 `src/server/agents/tools/profiles.ts`：profile 定义、联网过滤、ingest skill 映射和 policy 构造。
- 修改 `src/server/agents/tools/compile.ts`：强制消费 policy，过滤工具、校验副作用、包装 page scope、扩展审计信息。
- 修改 `src/server/agents/types.ts`：删除 `dispatch/commit` 类型，加入 `propose`，保持领域类型单向依赖。
- 新建 `src/server/agents/runtime/commit-pending.ts`：唯一的 service-level 暂存提交函数。
- 修改 query/fix/curate/agent-loop 调用点：每次编译工具都提供明确 profile 与 policy。
- 修改 `src/server/wiki/curate-plan.ts`：`allowedSet`、Auto 禁删以及读写目标判定。
- 新建 `src/server/agents/skills/builtin-manifest.ts`：当前内置 skill 清单、retired 清单与历史内容 hash。
- 修改 `src/server/agents/skills/{loader,registry}.ts`：跳过 retired ID，原版删除、改版归档并告警。
- 同步 agents/services/wiki 模块文档与 `CHANGELOG.md`。

---

### 任务 1：引入 ToolProfile 与强制编译策略

**文件：**

- 新建：`src/server/agents/tools/profiles.ts`
- 新建：`src/server/agents/tools/__tests__/profiles.test.ts`
- 修改：`src/server/agents/types.ts`
- 修改：`src/server/agents/tools/compile.ts`
- 修改：`src/server/agents/tools/__tests__/compile.test.ts`
- 修改：`src/server/agents/runtime/agent-loop.ts`
- 修改：`src/server/services/query-service.ts`
- 修改：`src/server/services/fix-service.ts`
- 修改：`src/server/services/curate-service.ts`

**接口：**

- 产出：`ToolProfileId`、`ToolProfile`、`ToolExecutionPolicy`、`resolveToolProfile()`、`createToolExecutionPolicy()`、`profileForIngestSkill()`。
- 产出：`compileToolSet(toolDefs, ctx, { policy, chargeStep?, onToolCall? })`；`policy` 必传。
- 消费：现有 `ToolDef`、`ToolContext.subject` 和 runner 的 subject/scope。

- [x] **步骤 1：先写 profile 和 compile policy 的失败测试**

```ts
it('query:read 不暴露实际写工具，并按联网配置移除 web.search', () => {
  expect(resolveToolProfile('query:read', { webSearchConfigured: false }).tools)
    .toEqual(['wiki.list', 'wiki.search', 'wiki.read', 'wiki.inspect', 'source.search', 'source.read']);
});

it('过滤 profile allowlist 外工具', () => {
  const set = compileToolSet([readTool, deleteTool], ctx, {
    policy: createToolExecutionPolicy(resolveToolProfile('query:read'), 's1'),
  });
  expect(Object.keys(set)).toEqual(['wiki_read']);
});

it('profile 允许但 runner policy 禁止的副作用在编译期报错', () => {
  const profile = resolveToolProfile('curate:manual');
  expect(() => compileToolSet([deleteTool], ctx, {
    policy: { ...createToolExecutionPolicy(profile, 's1'), allowedSideEffects: new Set(['none']) },
  })).toThrow(/SIDE_EFFECT_NOT_ALLOWED/);
});
```

- [x] **步骤 2：运行测试，确认因模块/接口尚不存在而失败**

运行：

```bash
npx vitest run src/server/agents/tools/__tests__/profiles.test.ts src/server/agents/tools/__tests__/compile.test.ts
```

预期：FAIL，错误包含无法解析 `../profiles`，或 `compileToolSet` 尚未要求 `policy`。

- [x] **步骤 3：实现 profile、policy 与 scope 包装**

`profiles.ts` 必须定义八个 profile，并保留后续阶段的工具名：

```ts
export type ToolProfileId =
  | 'query:read' | 'query:propose'
  | 'fix:links' | 'fix:contradiction'
  | 'curate:auto' | 'curate:manual'
  | 'ingest:planner' | 'ingest:writer';

export interface ToolProfile {
  id: ToolProfileId;
  tools: readonly string[];
  allowedSideEffects: readonly ToolSideEffect[];
  requiresApproval: boolean;
}

export interface ToolExecutionPolicy {
  profileId: ToolProfileId;
  allowedSideEffects: ReadonlySet<ToolSideEffect>;
  subjectId: string;
  allowedPageSlugs?: ReadonlySet<string>;
  jobCapability?: { jobId: string; jobType: Job['type'] };
}
```

`compileToolSet` 按以下固定顺序处理：

1. `ctx.subject.id !== policy.subjectId` 时抛 `TOOL_NOT_ALLOWED` 配置错误；
2. 不在 profile allowlist 的 `ToolDef` 直接不编译；
3. profile 内工具的 `sideEffect` 不在 policy set 时抛 `SIDE_EFFECT_NOT_ALLOWED`；
4. 有 `allowedPageSlugs` 时包装 `readPage/search/listPages/mergePages/splitPage/deletePage/updatePage/patchPage`：读侧 scope 外返回 missing/过滤，写侧 scope 外抛 `PAGE_OUT_OF_SCOPE`；
5. `onToolCall` 追加 `profileId/sideEffect/subjectId/pageSlugs`，但不记录正文。

`ToolSideEffect` 改为：

```ts
export type ToolSideEffect =
  | 'none' | 'propose' | 'enqueue' | 'destructive'
  | 'create' | 'update' | 'merge' | 'split';
```

- [x] **步骤 4：更新全部 compile 调用点，保证 policy 必传**

```ts
const profile = resolveToolProfile('query:read', {
  webSearchConfigured: isWebSearchConfigured(),
});
const policy = createToolExecutionPolicy(profile, subject.id);
const tools = compileToolSet(registry.resolve([...profile.tools]), ctx, { policy });
```

规则：agent-loop 用 `profileForIngestSkill(skill.id)`；Fix 暂按 findings 选择 `fix:links` 或 `fix:contradiction`；Curate 按 `seedSet === null` 选择 manual/auto，并把 `scopeSlugs` 作为 `allowedPageSlugs`。

- [x] **步骤 5：运行定向测试与类型检查**

运行：

```bash
npx vitest run src/server/agents/tools/__tests__/profiles.test.ts src/server/agents/tools/__tests__/compile.test.ts src/server/agents/runtime/__tests__/agent-loop.test.ts src/server/services/__tests__/resolve-query-tools.test.ts src/server/services/__tests__/fix-service.test.ts src/server/services/__tests__/curate-service.test.ts
./node_modules/.bin/tsc --noEmit
```

预期：所有定向测试 PASS，TypeScript 退出码 0。

- [x] **步骤 6：提交**

```bash
git add src/server/agents src/server/services
git commit -m "功能：引入工具配置与运行时策略"
```

---

### 任务 2：删除不可达工具并迁移 commitPending

**文件：**

- 新建：`src/server/agents/tools/builtin/__tests__/registry.test.ts`
- 新建：`src/server/agents/runtime/commit-pending.ts`
- 新建：`src/server/agents/runtime/__tests__/commit-pending.test.ts`
- 删除：`src/server/agents/tools/builtin/dispatch-skill.ts`
- 删除：`src/server/agents/tools/builtin/commit-changeset.ts`
- 删除：`src/server/agents/tools/builtin/__tests__/commit-changeset.test.ts`
- 修改：`src/server/agents/tools/builtin/index.ts`
- 修改：`src/server/agents/types.ts`
- 修改：`src/server/agents/tools/tool-context.ts`
- 修改：`src/server/services/ingest-service.ts`
- 修改：`src/server/services/reenrich-service.ts`

**接口：**

- 产出：`commitPending(ctx, supplied, sourceOps?) => Promise<IngestResult>`，签名与行为保持不变。
- 删除：`commitChangesetTool`、`dispatchSkillTool`、`ToolContext.agent`、`ToolSource` 的 `'dispatch'`、`ToolSideEffect` 的 `'commit'`。

- [x] **步骤 1：写 registry 与新导入路径的失败测试**

```ts
it('builtin registry 不注册不可达工具', () => {
  const registry = createBuiltinToolRegistry();
  expect(registry.get('dispatch.skill')).toBeUndefined();
  expect(registry.get('commit_changeset')).toBeUndefined();
});
```

把原 `commitPending` 行为测试复制到 runtime 测试，并改为：

```ts
import { commitPending } from '../commit-pending';
```

- [x] **步骤 2：运行测试，确认 RED**

运行：

```bash
npx vitest run src/server/agents/tools/builtin/__tests__/registry.test.ts src/server/agents/runtime/__tests__/commit-pending.test.ts
```

预期：registry 测试因两个工具仍存在而 FAIL；runtime 测试因 `commit-pending.ts` 不存在而 FAIL。

- [x] **步骤 3：迁移纯函数并删除 ToolDef 包装**

移动 `commitPending` 及其内部 helpers 到 `runtime/commit-pending.ts`，保留：pending/supplied 按 path 合并、system frontmatter、changeset validate/apply、source links、extra stage paths、`committed` 幂等守卫。删除两个 ToolDef 文件与 registry 注册。

服务层导入统一改为：

```ts
import { commitPending } from '../agents/runtime/commit-pending';
```

`ToolContext` 删除 `agent?: AgentContext`，`agentToolContext()` 不再暴露 AgentContext 逃生舱。

- [x] **步骤 4：运行定向测试与死代码扫描**

运行：

```bash
npx vitest run src/server/agents/tools/builtin/__tests__/registry.test.ts src/server/agents/runtime/__tests__/commit-pending.test.ts src/server/services/__tests__/ingest-service.test.ts src/server/services/__tests__/reenrich-input.test.ts
rg -n "dispatch\.skill|dispatch_skill|commit_changeset|commitChangesetTool|tools/builtin/commit-changeset|source: 'dispatch'|sideEffect: 'commit'" src
./node_modules/.bin/tsc --noEmit
```

预期：测试 PASS；`rg` 无匹配并以 1 退出；TypeScript 退出码 0。

- [x] **步骤 5：提交**

```bash
git add -A src/server/agents src/server/services
git commit -m "重构：移除不可达工具并迁移提交入口"
```

---

### 任务 3：把 Ask AI 收缩为只读 runner

**文件：**

- 修改：`src/server/services/query-service.ts`
- 修改：`src/server/services/query-tools.ts`
- 修改：`src/server/services/__tests__/resolve-query-tools.test.ts`
- 修改：`src/server/services/__tests__/query-tools.test.ts`
- 修改：`src/server/llm/prompts/query-prompt.ts`
- 修改：`src/server/llm/prompts/__tests__/query-prompt.test.ts`
- 修改：`src/server/agents/tools/builtin/wiki-reenrich.ts`
- 修改：`src/server/agents/tools/builtin/wiki-create.ts`
- 修改：`src/server/agents/tools/builtin/wiki-update.ts`
- 修改：`src/server/agents/tools/builtin/wiki-patch.ts`
- 修改：`src/server/agents/tools/builtin/wiki-delete.ts`

**接口：**

- `resolveQueryTools()` 只返回 `query:read` 当前已注册工具：`wiki.list/search/read` 与可选 `web.search`。
- `buildQueryToolContext()` 不再注入 `reenrich/create/update/patch/delete` 能力。

- [ ] **步骤 1：先把 query 工具断言改成只读并观察失败**

```ts
expect(names).toEqual(['wiki.read', 'wiki.search', 'wiki.list']);
for (const name of ['wiki.reenrich', 'wiki.create', 'wiki.update', 'wiki.patch', 'wiki.delete']) {
  expect(names).not.toContain(name);
}
```

联网配置测试仅额外允许 `web.search`。

- [ ] **步骤 2：运行 query 定向测试，确认 RED**

运行：

```bash
npx vitest run src/server/services/__tests__/resolve-query-tools.test.ts src/server/services/__tests__/query-tools.test.ts src/server/llm/prompts/__tests__/query-prompt.test.ts
```

预期：FAIL，现有结果仍包含实际写工具，Prompt 仍承诺确认后写入。

- [ ] **步骤 3：删除 Query 写能力与 Prompt 级授权文本**

`query-service.ts` 只从 `query:read` profile 解析工具；`query-tools.ts` 删除 page-write/reenrich 导入及五个写方法。Query 系统提示删除“用户口头确认后调用写工具”的章节，明确 Phase 0 的 Ask AI 只能读取与回答，写请求不能被本轮模型直接执行。

共享写工具 description 只描述能力、输入与结果，例如：

```ts
description: 'Create a page in the current subject through the guarded page operation service.'
```

不得再包含 “Only call after the user confirmed” 等 query-specific 授权规则。

- [ ] **步骤 4：运行 query、路由和类型测试**

运行：

```bash
npx vitest run src/server/services/__tests__/resolve-query-tools.test.ts src/server/services/__tests__/query-tools.test.ts src/server/services/__tests__/query-service-agentic.test.ts src/server/llm/prompts/__tests__/query-prompt.test.ts src/app/api/query/__tests__/route.test.ts
./node_modules/.bin/tsc --noEmit
```

预期：全部 PASS，TypeScript 退出码 0。

- [ ] **步骤 5：提交**

```bash
git add src/server/services src/server/llm/prompts src/server/agents/tools/builtin src/app/api/query
git commit -m "安全：收缩 Ask AI 为只读工具"
```

---

### 任务 4：强化 Fix 与 Auto Curate 的运行时边界

**文件：**

- 修改：`src/server/wiki/curate-plan.ts`
- 修改：`src/server/wiki/__tests__/curate-plan.test.ts`
- 修改：`src/server/services/curate-tools.ts`
- 修改：`src/server/services/curate-service.ts`
- 修改：`src/server/services/__tests__/curate-tools.test.ts`
- 修改：`src/server/services/__tests__/curate-service.test.ts`
- 修改：`src/server/services/fix-service.ts`
- 修改：`src/server/services/__tests__/fix-service.test.ts`

**接口：**

- `createCurateGuard({ seedSet, allowedSet, caps })`：manual 与 auto 都有 allowedSet。
- `CurateGuard.isAllowed(slug)`：供 read/search context 确定性过滤。
- Auto profile：无 `wiki.list/create/delete`；merge 两端在 allowedSet 且至少一端在 seedSet；split 目标同时在 allowedSet 和 seedSet。
- Fix：工作清单无 contradiction 时使用 `fix:links`，否则使用 `fix:contradiction`；两者都无 `wiki.list`。

- [ ] **步骤 1：写 Guard、context 和工具面的失败测试**

```ts
it('auto merge 要求两端都在 allowedSet 且至少一端是 seed', () => {
  const g = createCurateGuard({
    seedSet: new Set(['seed']),
    allowedSet: new Set(['seed', 'neighbor']),
    caps,
  });
  expect(g.canMerge('seed', 'neighbor').ok).toBe(true);
  expect(g.canMerge('seed', 'outside').reason).toMatch(/allowed scope/);
});

it('auto 工具面没有 list/create/delete', () => {
  expect(toolKeys).not.toEqual(expect.arrayContaining(['wiki_list', 'wiki_create', 'wiki_delete']));
});
```

`curate-tools.test.ts` 再覆盖 scope 外 read 返回 null、search 过滤、merge/split/delete 不执行 page-ops。

- [ ] **步骤 2：运行定向测试，确认 RED**

运行：

```bash
npx vitest run src/server/wiki/__tests__/curate-plan.test.ts src/server/services/__tests__/curate-tools.test.ts src/server/services/__tests__/curate-service.test.ts src/server/services/__tests__/fix-service.test.ts
```

预期：FAIL，当前 Guard 不接受 `allowedSet`，Auto 仍暴露 `wiki.delete`，Fix 仍暴露 `wiki.list`。

- [ ] **步骤 3：实现 allowedSet 与最小工具装配**

Guard 判定顺序保持：自操作/保护页 → cap → allowedSet → seed 约束。Auto `canDelete` 固定拒绝；manual 只允许删除 allowedSet 内页。`buildCurateToolContext` 的 read/search 使用 `guard.isAllowed()`，compile policy 同时带同一 `allowedSet` 形成双层边界。

Curate runner 只使用 profile 列表；不再手拼 `toolNames`。Fix runner 从实际 worklist 选择 profile，roster 继续由 Prompt 注入，故移除 `wiki.list` 不损失页面清单。

- [ ] **步骤 4：运行定向测试与类型检查**

运行：

```bash
npx vitest run src/server/wiki/__tests__/curate-plan.test.ts src/server/services/__tests__/curate-tools.test.ts src/server/services/__tests__/curate-service.test.ts src/server/services/__tests__/fix-tools.test.ts src/server/services/__tests__/fix-service.test.ts
./node_modules/.bin/tsc --noEmit
```

预期：全部 PASS，TypeScript 退出码 0。

- [ ] **步骤 5：提交**

```bash
git add src/server/wiki/curate-plan.ts src/server/wiki/__tests__/curate-plan.test.ts src/server/services
git commit -m "安全：强化 Fix 与 Curate 运行时边界"
```

---

### 任务 5：增加 retired builtin skill tombstone

**文件：**

- 新建：`src/server/agents/skills/builtin-manifest.ts`
- 新建：`src/server/agents/skills/__tests__/registry.test.ts`
- 修改：`src/server/agents/skills/loader.ts`
- 修改：`src/server/agents/skills/registry.ts`
- 修改：`src/server/agents/skills/__tests__/loader.test.ts`
- 修改：`src/server/worker-entry.ts`

**接口：**

- `BUILTIN_SKILLS`：当前 `examples/skills/*.md` 的 manifest。
- `RETIRED_BUILTIN_SKILLS = ['ingest-indexer'] as const`。
- `RETIRED_BUILTIN_HASHES['ingest-indexer']` 包含历史原版 SHA-256：`cef3712f6c94035131dfbe005b91b5d5913f6f63ae09889f24c80b5c77238a8c`。
- `retireBuiltinSkillFiles({ vaultDir, now?, onWarning? })`：返回 `{ removed, archived }`。

- [ ] **步骤 1：先写三种 tombstone 失败测试**

```ts
it('删除 hash 匹配的 retired 原版', async () => {
  expect(result.removed).toEqual(['ingest-indexer']);
  expect(existsSync(retiredPath)).toBe(false);
});

it('归档用户改版并告警', async () => {
  expect(result.archived).toEqual(['ingest-indexer']);
  expect(readFileSync(archivePath, 'utf8')).toContain('用户修改');
  expect(onWarning).toHaveBeenCalledOnce();
});

it('loader 永远不注册 retired ID', async () => {
  expect(skills.some((skill) => skill.id === 'ingest-indexer')).toBe(false);
});
```

- [ ] **步骤 2：运行 skill 定向测试，确认 RED**

运行：

```bash
npx vitest run src/server/agents/skills/__tests__/registry.test.ts src/server/agents/skills/__tests__/loader.test.ts
```

预期：FAIL，manifest 与 tombstone 函数尚不存在，loader 仍会接受合法 retired 文件。

- [ ] **步骤 3：实现 manifest、清理、归档与 loader 排除**

原版判定必须对文件完整字节计算 SHA-256。hash 匹配时 `unlink`；不匹配时先创建 `.llm-wiki/skills-retired`，再 `rename` 为 `ingest-indexer-<ISO安全时间>.md`，随后调用 `onWarning`。`buildSkillRegistry()` 在 seed/load 前调用 tombstone，并把 worker logger 作为告警回调；loader 对 retired filename ID 直接跳过，不加入 skills 或 degraded。

- [ ] **步骤 4：运行 skill 测试并对当前 vault 执行同一清理函数**

运行：

```bash
npx vitest run src/server/agents/skills/__tests__/registry.test.ts src/server/agents/skills/__tests__/loader.test.ts src/server/agents/skills/__tests__/examples-roundtrip.test.ts
npx tsx -e "import { retireBuiltinSkillFiles } from './src/server/agents/skills/registry.ts'; const result = await retireBuiltinSkillFiles({ vaultDir: '/Users/nickhopps/Documents/playground/agentic-wiki/data/vault' }); console.log(JSON.stringify(result));"
./node_modules/.bin/tsc --noEmit
```

预期：测试 PASS；当前 vault 输出 `removed:["ingest-indexer"]` 或在已清理时输出空数组；TypeScript 退出码 0。

- [ ] **步骤 5：提交**

```bash
git add src/server/agents/skills src/server/worker-entry.ts
git commit -m "维护：安全退役残留内置技能"
```

---

### 任务 6：同步文档并完成 Phase 0 验证

**文件：**

- 修改：`src/server/agents/CLAUDE.md`
- 修改：`src/server/services/CLAUDE.md`
- 修改：`src/server/wiki/CLAUDE.md`
- 修改：`CHANGELOG.md`

**接口：** 无新运行时接口；文档必须准确描述当前 checkout，不提前宣称 Phase 1–3 已实现。

- [ ] **步骤 1：更新模块文档和变更日志**

记录以下已落地事实：

- profile/policy 是工具编译与执行的真实边界；
- Query 为 `query:read`；Fix 按 finding 类型选择 profile；Auto Curate 为 allowedSet 双层硬边界；
- `commitPending` 位于 runtime，builtin registry 无不可达工具；
- retired skill 采用 hash 删除/改版归档；
- PendingAction、证据工具、postcondition、remediation router 仍属于后续 Phase。

- [ ] **步骤 2：做计划覆盖与残留扫描**

运行：

```bash
rg -n "dispatch\.skill|dispatch_skill|commit_changeset|tools/builtin/commit-changeset|source: 'dispatch'|sideEffect: 'commit'" src
rg -n "wiki\.reenrich|wiki\.create|wiki\.update|wiki\.patch|wiki\.delete" src/server/services/query-service.ts
git diff --check
```

预期：前两个 `rg` 均无匹配；`git diff --check` 退出码 0。

- [ ] **步骤 3：运行完整验证**

运行：

```bash
npm test
./node_modules/.bin/tsc --noEmit
npm run build
```

预期：Vitest 0 failures；TypeScript 退出码 0；Next.js production build 退出码 0。

- [ ] **步骤 4：核对验收项**

```bash
git status --short
git diff main...HEAD --stat
git log --oneline main..HEAD
```

验收：registry 无两个死工具；Query 无实际写工具；sideEffect 被 compile policy 消费；Auto Curate 读写均不能越 scope 且无 create/delete/list；retired skill 不可加载；所有写路径仍走原 Saga 内核。

- [ ] **步骤 5：提交文档**

```bash
git add src/server/agents/CLAUDE.md src/server/services/CLAUDE.md src/server/wiki/CLAUDE.md CHANGELOG.md
git commit -m "文档：记录工具治理 Phase 0 变更"
```

---

## 计划自检

- **Spec 覆盖：** Phase 0 六项均有任务：死工具清理（任务 2）、commit 迁移（任务 2）、profile/policy（任务 1）、Query 只读（任务 3）、Auto Curate allowedSet（任务 4）、retired skill（任务 5）。
- **范围控制：** PendingAction、inspect/source、postcondition、remediation、跨主题/history/workflow command 明确保留给后续 Phase，没有在本计划提前实现。
- **类型一致性：** `ToolProfileId`、`ToolExecutionPolicy`、`compileToolSet`、`createCurateGuard` 与 `commitPending` 的名称和签名在所有任务中一致。
- **可执行性扫描：** 所有代码改动都定义了目标接口，所有验证步骤都给出命令和预期结果。
