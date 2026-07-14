# Wiki 跨 Subject 只读工具 Phase 3A 执行计划

**目标：** 让 Ask AI 在运行时最小授权边界内完成跨 Subject 的列出、搜索、正文读取和可点击引用，同时保持所有写入严格绑定 active Subject。

**分支：** `feat/cross-subject-read-phase3a`  
**Worktree：** `.worktrees/cross-subject-read-phase3a`

## Task 1：锁定共享契约与 profile

1. 在 `contracts.ts` 增加 `WikiCitation`、Subject 工具和跨 Subject 搜索/读取结果契约；
2. 用 `WikiCitation` 替换 Query、Conversation、API 和聊天组件中的重复内联类型；
3. 先补 profile/registry 失败测试；
4. 注册 `subject.list`、`wiki.search_cross_subject`、`wiki.read_cross_subject`，只加入 Query profile；
5. 运行 agents tools 定向测试。

## Task 2：实现跨 Subject 读取上下文

1. 扩展 `ToolContext` 的 list/search/read cross-subject 只读接缝；
2. 在 `query-tools.ts` 解析 Subject slug，过滤 active/meta/空正文；
3. 复用 `hybridRankSlugs`，按 Subject 内排名轮询合并结果；
4. `subject.list` 的 pageCount 只计非 meta 页面；
5. 先写 builtin handler 与 query context 的红测，再实现至通过。

## Task 3：升级访问身份与确定性引用

1. 将访问页身份扩展为 `subjectSlug + slug`；
2. active Subject 引用保持旧 JSON，跨 Subject 引用携带 `subjectSlug`；
3. `citation-extract.ts` 校验答案 wikilink 的 Subject 与真实已读页面一致；
4. 覆盖同名 slug、未读页、伪造 Subject、标题解析和去重测试。

## Task 4：接入 Query prompt、API 与 UI

1. 更新工具说明、调用策略和 `[[subject:slug]]` 引用纪律；
2. 移除 active Subject 空库提前短路，让模型可显式跨 Subject 查找；
3. API schema 与会话持久化透传可选 `subjectSlug`；
4. 聊天 citation 点击带 `?s=`；
5. Save-to-Wiki References 对跨 Subject 使用带前缀 wikilink；
6. 补 route、prompt、组件纯逻辑与保存页面测试。

## Task 5：文档与配置审计

1. 更新根、agents、services、lib、components 模块文档和工具数量；
2. 更新治理总 spec 状态，标记 Phase 3A 已实现；
3. 确认没有新增 `LLMTaskSchema` 或 provider route；
4. 运行 `git diff -- llm-config.example.json`，预期为空。

## Task 6：验证、提交、合回与清理

1. 运行定向 Vitest；
2. 运行全量 Vitest、`npm run lint`、`npm run build`；
3. 检查 `git diff --check` 与工作树状态；
4. 使用中文一句话提交各逻辑批次；
5. 回到 main 执行：

   ```bash
   git merge --no-ff feat/cross-subject-read-phase3a -m "合并 feat/cross-subject-read-phase3a：完成跨主题只读工具 Phase 3A"
   ```

6. 删除 worktree 与特性分支，确认 main 干净。

## 完成判据

- Query 可在其他 Subject 搜索并读取正文；
- 跨 Subject 同名 slug 不碰撞；
- 引用列表和保存页面能精确回到目标 Subject；
- 任何跨 Subject 写入仍不可达；
- `llm-config.example.json` 无差异；
- 全部验证通过并以 `--no-ff` 合回 main。
