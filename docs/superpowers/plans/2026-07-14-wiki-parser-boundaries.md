# Wiki 解析边界执行计划

**目标：** 补齐 frontmatter 与 wikilink 的解析边界，并修复跨 Subject 重名标题错误套用本地 resolver 的问题。

**分支：** `feat/wiki-parser-boundaries`  
**Worktree：** `.worktrees/wiki-parser-boundaries`  
**状态：** 已完成

## Task 1：Frontmatter 边界红测

1. 覆盖 emoji/CJK 的结构化字段与正文语义往返；
2. 覆盖正文 fenced code 内的 `---`、YAML 与 wikilink 原样保留；
3. 覆盖 CRLF frontmatter 解析及正文行尾往返；
4. 确认全角冒号修复不越过首个 frontmatter。

## Task 2：Subject-aware 标题解析红测

1. 为 resolver 增加目标 Subject 上下文断言；
2. 覆盖大小写 title 命中 canonical slug；
3. 覆盖当前与跨 Subject 同名 title 分别解析；
4. 覆盖 citation/indexer 不发生跨 Subject 串线。

## Task 3：最小实现

1. 扩展 `TitleResolver` 的可选 Subject 参数；
2. `extractWikiLinks` 在确定 Subject 后调用 resolver；
3. 逐一收紧仓库内生产 resolver 的 Subject 作用域；
4. 保留单参数回调与 normalize fallback 兼容行为。

## Task 4：文档与验证

1. 更新 Wiki 模块测试说明和变更记录；
2. 运行定向 Vitest；
3. 运行全量 Vitest、`npx tsc --noEmit`、`npm run lint`、`npm run build`；
4. 确认 `git diff --check` 与 `llm-config.example.json` 无差异；
5. 使用中文单句提交；
6. 以 `--no-ff` 合并回 main，删除 worktree 和特性分支。

## 执行结果

- Task 1–4 均已完成；frontmatter 实现无需修改，新增边界测试直接通过；
- 修复 `TitleResolver` 缺少目标 Subject 上下文导致的跨主题同名 title 串线；
- 定向 Vitest：4 个文件、54 个用例通过；
- 全量 Vitest：239 个文件、2110 个用例通过；
- TypeScript、ESLint 与生产构建通过；ESLint 仅保留仓库既有 warning；
- `llm-config.example.json` 无差异；
- Git 合并与 worktree 清理在本计划提交后执行。
