# 实现计划：Subject 导出 / 导入

对应 spec：`docs/specs/2026-07-17-subject-export-import.md`

## 任务拆分

### T1 归档纯内核 `src/server/subjects/subject-archive-core.ts` + 单测

纯函数（零 IO）：
- `SUBJECT_ARCHIVE_FORMAT_VERSION = 1`、`ARCHIVE_DIRS = ['wiki','raw','assets','sources']`
- `buildManifest(subject, exportedAt)`
- `parseManifest(json: string)` → manifest 或抛 `ArchiveError('invalid-manifest' | 'unsupported-version')`
- `validateEntryPath(entryName)` → 归一化安全相对路径或 null（拒绝 `..`、绝对路径、白名单外目录、`manifest.json` 之外的根文件）
- `mapEntryToVaultRelPath(entryName, slug)` → `wiki/<slug>/...` 等 vault 相对路径

测试：`src/server/subjects/__tests__/subject-archive-core.test.ts`（TDD：先写失败用例）。
验证：`npx vitest run src/server/subjects`

### T2 归档服务 `src/server/subjects/subject-archive.ts` + 集成测试

- 依赖 `adm-zip`（新增 dependency + @types）
- `exportSubjectArchive(subject): Buffer` — 遍历四目录（不存在则跳过）打 zip + manifest
- `importSubjectArchive(buffer, { slugOverride? })` — 解包校验 → `subjectsRepo.create` → 写 vault → `indexTouchedPages` → 侧车恢复（复用 rebuild 的 upsertSource/linkPageSource 模式）→ commit；失败清理（rm 目录 + deleteWithContents）
- 集成测试仿 `rebuild.test.ts`：临时 vault + 临时 SQLite，导出→导入 round-trip 断言页面/来源/FTS 一致，恶意 zip 拒绝
验证：`npx vitest run src/server/subjects`

### T3 API 路由

- `src/app/api/subjects/[id]/export/route.ts`（GET，requireAuth，vault 锁）
- `src/app/api/subjects/import/route.ts`（POST，requireAuth+requireCsrf，multipart，200MB 上限，SubjectError→409/400 映射）
验证：`tsc --noEmit`；dev 环境手动 curl round-trip

### T4 前端

- `subjects-api.ts` 加 `importSubject(file, slug?)`（apiFetch multipart）与导出 URL helper
- `(app)/subjects/page.tsx` 页头加 Import 按钮（file input + 409 换 slug 重试 + invalidate）
- `subject-dialog.tsx` edit 模式加 Export 入口
验证：`tsc --noEmit` + Playwright 手验

### T5 文档与收尾

- 更新 `src/app/CLAUDE.md` / `src/server/CLAUDE.md` changelog
- 全量 `tsc --noEmit` + `vitest run`
- 提交、回合 main（--no-ff）、清理 worktree

每完成一个任务提交一次。
