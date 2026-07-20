# Research 导入失败后重新选择候选实现计划

## 任务 1：建立审批尝试归档与重新选择原语

涉及文件：

- `src/server/db/schema.ts`
- `src/server/db/client.ts`
- `drizzle/*`
- `src/server/db/repos/research-provenance-repo.ts`
- `src/server/db/repos/__tests__/research-provenance-repo.test.ts`
- `src/lib/contracts.ts`

步骤：

1. 先写 repo 失败测试，覆盖成功归档/解冻、版本冲突、verification 守卫和非终态 delivery 守卫。
2. 确认测试因缺少重新选择原语失败。
3. 新增归档表与迁移，并实现 `reselectResearchRunAtomic()`。
4. 运行 repo 与迁移测试转绿。

验证命令：

```bash
VAULT_PATH=/tmp/agentic-wiki-research-reselect-vault npm exec vitest -- run src/server/db/repos/__tests__/research-provenance-repo.test.ts src/server/db/__tests__/research-provenance-migration.test.ts src/server/db/__tests__/research-provenance-drizzle-migration.test.ts
```

## 任务 2：接入 service 与受治理 API

涉及文件：

- `src/server/services/research-approval-service.ts`
- `src/server/services/__tests__/research-approval-service.test.ts`
- `src/app/api/research-runs/[id]/reselect/route.ts`
- `src/app/api/research-runs/[id]/reselect/__tests__/route.test.ts`
- `src/app/CLAUDE.md`

步骤：

1. 先写 service 与 route 失败测试，锁定 subject、expectedVersion、auth/CSRF 和错误映射。
2. 确认测试以接口不存在或导出缺失失败。
3. 实现 service wrapper 和 `POST /reselect` Route Handler。
4. 更新 App API 文档并运行定向测试。

验证命令：

```bash
VAULT_PATH=/tmp/agentic-wiki-research-reselect-vault npm exec vitest -- run src/server/services/__tests__/research-approval-service.test.ts src/app/api/research-runs/'[id]'/reselect/__tests__/route.test.ts src/app/api/research-runs/'[id]'/approve/__tests__/route.test.ts src/app/api/research-runs/'[id]'/retry/__tests__/route.test.ts
```

## 任务 3：修正 Health 投影并接入重新选择交互

涉及文件：

- `src/server/services/remediation-status.ts`
- `src/server/services/__tests__/remediation-status.test.ts`
- `src/components/health/research-candidates-dialog.tsx`
- `src/components/health/health-view.tsx`
- `src/components/health/__tests__/research-candidates-dialog.test.ts`
- `src/components/health/__tests__/remediation-ui.test.ts`
- `src/lib/i18n/messages/{en,zh-CN}.ts`
- `src/components/CLAUDE.md`

步骤：

1. 先写失败测试：导入前 failed run 不隐藏 finding；失败弹窗展示重新选择；恢复后候选重新可勾选。
2. 确认测试按预期失败。
3. 收窄 Research handled outcome 终态，并调用 `/reselect` 更新同一 `candidateResult`。
4. 清理旧批准幂等尝试，补充中英文文案与组件文档。
5. 运行 Health 定向测试转绿。

验证命令：

```bash
VAULT_PATH=/tmp/agentic-wiki-research-reselect-vault npm exec vitest -- run src/server/services/__tests__/remediation-status.test.ts src/components/health/__tests__/research-candidates-dialog.test.ts src/components/health/__tests__/remediation-ui.test.ts
```

## 任务 4：回归验证

1. 运行 Research/Health 相关测试集。
2. 运行 TypeScript、lint、全量 Vitest 与生产构建。
3. 检查 diff、worktree 分支和提交落点。

验证命令：

```bash
npm exec tsc -- --noEmit --incremental false
npm run lint
VAULT_PATH=/tmp/agentic-wiki-research-reselect-vault npm test -- --run
npm run build
git diff main...HEAD --check
```
