# Plan · 全站主题色切换到 weftwise 品牌色系

> 前置：品牌落地（docs/plans/2026-07-17-brand-weftwise.md，merge 4258f68）。
> 本轮把 UI 主题从「Linear violet」强调色系整体切换为 weftwise 双色语法。

## 设计原则：双色职责

沿用标志的语义——**经线＝结构，纬线＝动作**：

- **weft 纬线朱（动作）**→ 语义槽 `accent-*`：按钮、开关、活跃态、焦点环、选区、进度、border-accent。
- **warp 经线靛（连接/结构）**→ 新语义槽 `link-*` 与 `graph-*`：正文 wikilink、图谱节点、mermaid secondary、callout-quiz。
- 图谱 hover/选中节点用 weft（被触碰的节点「亮成纬线」）。

## 色值（BASE 层，`R G B` 三元组）

- weft：50 `FCF0EC` / 100 `F9E0D8` / 200 `F2C3B5` / 300 `FF8A70`(暗悬停) / 400 `FF6B4D`(暗主) / **500 `CC3F27`(亮主，白字 4.87:1)** / 600 `B23520` / 700 `912C1B`
- warp：50 `EEF1F7` / 100 `DFE4F0` / 200 `BEC8DF` / 400 `93A3CF`(暗主) / 500 `3E4A6D`(亮主，白底 8.7:1) / 600 `323C5A` / 700 `283049`
- `--brand-warp`/`--brand-weft`（标志专用）维持 logo 原色 `#3E4A6D`/`#D9482F`（暗 `#93A3CF`/`#FF6B4D`）不动；UI accent 用略深的 weft-500 以满足 AA。
- danger 移向绯红拉开与 weft 的色相：500 `DB374F` / 600 `C42843` / 50 `FDF1F4`。
- 底色贴品牌纸/墨：亮 canvas `F6F5F2`；暗面板整体带品牌蓝调（canvas `131315`、surface `1A1A1D`、subtle/elevated/borders 同步微调）。
- 暗色按钮前景改深墨（`FF6B4D` 上白字仅 2.6:1，改 `111111` 得 6.7:1）。

## 任务清单

1. `globals.css`：BASE violet 家族 → weft/warp 家族；SEMANTIC accent/focus/selection/input-focus → weft；新增 `--color-link(-hover)` → warp；graph 槽位 → warp（active→weft）；danger 三值；亮暗底色微调；`.callout-quiz::before` → brand-warp。
2. `tailwind.config.ts`：新增 `link` 色族映射。
3. `wiki-link.tsx`：正文链接 `text-accent` → `text-link`。
4. `page-renderer.tsx`：callout-quiz `border-violet-400` → brand-warp。
5. `mermaid-theme.ts`：secondary 家族（亮/暗）violet → warp；背景灰对齐新暗底。
6. 模块 CLAUDE.md changelog + `docs/brand/README.md` 增补 UI 主题 token 表。

## 验证

- `npx tsc --noEmit`（仅允许既有 reenrich 测试错误）；`npx vitest run src/components src/app`。
- 真实运行：scratch vault 植入含 wikilink/mermaid/callout 的样例页 → `db:rebuild` → `next dev` → Playwright 截图亮/暗双态：Dashboard（按钮/胶囊）、Wiki 阅读页（链接/callout/mermaid）、Context 面板迷你图谱、Settings（开关）。
- 对比度以脚本核算：白字@weft500 4.87、墨字@weft400 6.71、warp 链接亮/暗 8.0/7.4、danger600 白底 5.63。

## 明确不做

- 不逐组件把 `text-accent` 重分类为 link（仅 wikilink 与 graph 属结构色）；info token 无使用方，保持原值。
- 不动 favicon/OG/logo 资产（已是品牌色）。
