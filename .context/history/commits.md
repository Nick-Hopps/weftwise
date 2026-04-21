# Commit Decision History

> 此文件是 `commits.jsonl` 的人类可读视图，可由工具重生成。
> Canonical store: `commits.jsonl` (JSONL, append-only)

| Date | Context-Id | Commit | Summary | Decisions | Bugs | Risk |
|------|-----------|--------|---------|-----------|------|------|
| 2026-04-21 | `019db0f6` | `ebed0b9` | chore(context): 初始化 .context/ 决策审计链 | 引入 .context/ 审计基础设施；current/ 与 session.log 入 gitignore；commits.jsonl 启用 merge=union | — | low |
| 2026-04-21 | `0000019d` | `b06d602` | refactor(ui): 左侧边栏改为可调整宽度 + Graph 卡片体验升级 | 左右栏 resize 行为翻转；Graph 卡片去通用卡片容器、加 stats+controls；cytoscape 按模式独立 cose 布局；Backlinks truncate 结构修复 | 右栏 aside 缺 w-full 导致内容溢出 + Backlinks truncate 失效 | medium |
| 2026-04-21 | `e5b7117b` | `a21fb43` | refactor(ui): Graph 组件首次加载/高亮/全屏切换体验三连优化 | animate:false + fade-in 消除布局跳变；class+z-index 三级高亮；全屏切换保留节点位置、zoom 快照机制；SimulationHandle.freeze() 防 gravity 漂移；a11y 与 motion-safe 全覆盖 | — | low |
| 2026-04-21 | `4328cb95` | _pending_ | fix(chat): wiki 页面提问时注入当前页上下文，修复误判"无相关内容" | 端到端打通 pageSlug 而非扩大 FTS 命中；user prompt 增加 currently open page hint；命令面板与 save-to-wiki 保持旧行为 | 打开的 wiki 页面问短/代词/CJK 问题时被误判无相关内容，根因是前端从未传当前 slug + 默认 FTS tokenizer 不分词 CJK | low |
