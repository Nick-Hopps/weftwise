# Commit Decision History

> 此文件是 `commits.jsonl` 的人类可读视图，可由工具重生成。
> Canonical store: `commits.jsonl` (JSONL, append-only)

| Date | Context-Id | Commit | Summary | Decisions | Bugs | Risk |
|------|-----------|--------|---------|-----------|------|------|
| 2026-04-21 | `019db0f6` | `ebed0b9` | chore(context): 初始化 .context/ 决策审计链 | 引入 .context/ 审计基础设施；current/ 与 session.log 入 gitignore；commits.jsonl 启用 merge=union | — | low |
| 2026-04-21 | `0000019d` | `b06d602` | refactor(ui): 左侧边栏改为可调整宽度 + Graph 卡片体验升级 | 左右栏 resize 行为翻转；Graph 卡片去通用卡片容器、加 stats+controls；cytoscape 按模式独立 cose 布局；Backlinks truncate 结构修复 | 右栏 aside 缺 w-full 导致内容溢出 + Backlinks truncate 失效 | medium |
| 2026-04-21 | `e5b7117b` | `a21fb43` | refactor(ui): Graph 组件首次加载/高亮/全屏切换体验三连优化 | animate:false + fade-in 消除布局跳变；class+z-index 三级高亮；全屏切换保留节点位置、zoom 快照机制；SimulationHandle.freeze() 防 gravity 漂移；a11y 与 motion-safe 全覆盖 | — | low |
| 2026-04-21 | `4328cb95` | _pending_ | fix(chat): wiki 页面提问时注入当前页上下文，修复误判"无相关内容" | 端到端打通 pageSlug 而非扩大 FTS 命中；user prompt 增加 currently open page hint；命令面板与 save-to-wiki 保持旧行为 | 打开的 wiki 页面问短/代词/CJK 问题时被误判无相关内容，根因是前端从未传当前 slug + 默认 FTS tokenizer 不分词 CJK | low |
| 2026-04-25 | `019dc47b` | _pending_ | feat(subjects): 引入 first-class Subject 主题，知识库支持多工作区隔离 | Subject 提升为一等实体（subjects 表 + pages 复合 PK）；middleware/subject.ts 作为单一解析源；[[other-subject:Page]] 跨主题语法；db:migrate-subjects 一次性脚本；删除非空 subject 直接 409；前端 useApiFetch + cookie + store 三层冗余同步当前主题 | — | medium |
| 2026-04-26 | `db4d224c` | `dc2ed6d` | fix(db): 修复 pages 表 subject 迁移半执行场景下的幂等检测 | 迁移跳过条件加上 PK 形状校验；中间状态通过 COALESCE 回填 generalId | 已含 subject_id 列但 PK 仍是单列 slug 时，迁移被静默跳过，跨主题同名 slug 仍冲突 | low |
| 2026-04-26 | `45547c40` | `f3203b6` | docs(plan): 归档 wiki language config 实施计划 | 计划纳入 docs/superpowers/plans/，作为 feat/wiki-language-config 分支已交付特性的可追溯参照 | — | low |
| 2026-04-26 | `1ba9468b` | _pending_ | fix(wiki): 中文 wiki 页面 backlinks 丢失，indexer 改两遍 + slug 保留 Unicode | indexTouchedPages 改两遍：先 upsert pages+FTS 再用完整 titleMap 解 link；normalizeSlug 用 \p{L}\p{N} 保留 CJK；rebuild-cache.ts 一次性修复历史数据 | 同批新页之间用 title 互引时 resolver 命中不到，fallback 又把中文压空，wiki_links 写错目标 slug 导致 backlinks 全空 | low |
