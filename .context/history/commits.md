# Commit Decision History

> 此文件是 `commits.jsonl` 的人类可读视图，可由工具重生成。
> Canonical store: `commits.jsonl` (JSONL, append-only)

| Date | Context-Id | Commit | Summary | Decisions | Bugs | Risk |
|------|-----------|--------|---------|-----------|------|------|
| 2026-04-21 | `019db0f6` | `ebed0b9` | chore(context): 初始化 .context/ 决策审计链 | 引入 .context/ 审计基础设施；current/ 与 session.log 入 gitignore；commits.jsonl 启用 merge=union | — | low |
| 2026-04-21 | `0000019d` | _pending_ | refactor(ui): 左侧边栏改为可调整宽度 + Graph 卡片体验升级 | 左右栏 resize 行为翻转；Graph 卡片去通用卡片容器、加 stats+controls；cytoscape 按模式独立 cose 布局；Backlinks truncate 结构修复 | 右栏 aside 缺 w-full 导致内容溢出 + Backlinks truncate 失效 | medium |
