# 设置界面视觉重设计 — 实施计划

日期：2026-07-20
关联 spec：`docs/specs/2026-07-20-settings-ui-redesign.md`
分支：`feat/settings-ui-redesign`（本仓库无 remote，手动 `git worktree add` 后进入）

## 任务拆分

### T1 信息架构与 i18n 收敛

- `src/components/layout/settings-categories.ts`
  - `SettingsSectionId`：删 `'appearance'`；`SETTINGS_SECTIONS.general` → `['language']`。
- `src/lib/i18n/messages/{zh-CN,en}.ts`
  - 新增 `settings.section.language`（语言 / Language）。
  - 删除 `settings.section.appearance`、`settings.section.contentLanguage`、`settings.web.provider`、`settings.web.providerDescription`。
  - `settings.web.apiKeyDescription` 文案并入提供方信息（Tavily）。
- `src/components/layout/__tests__/settings-categories.test.ts` 同步断言。
- 验证：`npx tsc --noEmit`（缺 key 使用处会在 T3 一并清理，本任务结束时允许 content 暂时红，T3 后必须全绿）→ 因此 T1 与 T3 同一提交完成前不单独提交；如需独立提交则保留旧 key 到 T3 再删。**采用：T1 只做新增与 sections 收敛并提交；删除 key 放 T3。**

### T2 行原语重构（settings-rows.tsx）

- `SettingRow`：行自持 `px-4 py-3`；label 行内渲染 `SaveIndicator`（新 prop 或组合方式），控件区去掉 `w-4` 占位。
- 错误/校验文案纳入行内（`px-4 pb-3` 区域），不再悬挂在卡片外。
- 控件宽度：`NumberRow w-24`（不变）、`TextRow w-56`、`SelectRow min-w-36`。
- `TextareaRow` 改上下布局：label+描述在上、`w-full` textarea 在下。
- `MultiSelectRow` 弹出列表对齐新 padding。
- 验证：`npx tsc --noEmit`；`npx vitest run src/components/layout src/lib`。

### T3 内容区重排（settings-content.tsx）

- `SettingsSection` 改为「`SectionLabel` 风格小标签 + 可选组描述 + `rounded-lg border divide-y` 卡片」。
- General：语言 section 一卡两行（界面语言 + Wiki 内容语言）。
- Personalization：透镜机制说明移到组描述；背景行用新 TextareaRow。
- Automation：三卡片；联网说明移到组描述；删「提供方」静态行。
- Usage：筛选改为卡片上方工具栏（segmented 左 + 裸 `Select` 右，不用 SelectRow）；表格进卡片、表头 `bg-subtle`、总计行强调；保留脚注。
- 删除 T1 保留的废弃 i18n key。
- 验证：`npx tsc --noEmit`；`npx vitest run src/components/layout`。

### T4 测试补充

- `settings-content.test.ts`：既有断言保持；补「Usage 不渲染项目筛选描述行原语」与卡片结构（`divide-y`）冒烟断言。
- 验证：`npx vitest run src/components/layout src/lib`。

### T5 端到端视觉验证与回合

- dev 服务器（3001）+ Playwright：zh/en × 4 分类截图，另加 375px 宽移动端 General/Automation。
- 核对 spec 成功标准；`--no-ff` 回合 main，清理 worktree。

## 验证命令汇总

```bash
npx tsc --noEmit
npx vitest run src/components/layout src/lib/__tests__/settings-validation.test.ts
# 视觉：Playwright MCP 打开 http://localhost:3001 逐分类截图
```
