# Plan · 品牌落地 weftwise（织识）

> 设计定稿见品牌规格书（Claude Artifact「weftwise · 品牌定稿 v1」，2026-07-17）。
> 命名结论：**weftwise**（weft 纬线·织 ＋ wise 智·识），中文名**织识**，tagline "Knowledge, woven." / 「让读过的一切，织成一张布」。

## 目的

把定稿品牌落进 app 的用户可见面：浏览器标签（title/favicon）、社交分享（OG）、Header 标识、Settings About、README。**不改**仓库名、内部代号（agentic-wiki）、架构文档与 vault 内部文案。

## 约束

- 复用既有 `font-display`（Space Grotesk，next/font 自托管、OFL）作 wordmark 字体，不新增字体依赖。
- 品牌色按 globals.css 既有三层 token 规范落 BASE 层 `R G B` 三元组，暗色在 `.dark` 覆盖。
- 标志织纹的上下层级（纬线压 2、4 经线，穿 1、3 之下）不得改变。

## 任务清单

1. **设计 token**：`globals.css` 增加 `--brand-warp`（#3E4A6D / 暗 #93A3CF）与 `--brand-weft`（#D9482F / 暗 #FF6B4D）。
2. **标志组件**：新增 `src/components/shared/weftwise-mark.tsx`（`<WeftwiseMark size />`，Tailwind 任意值引用品牌 token，自动亮暗）。
3. **Header lockup**：`layout/header.tsx` 换 mark + `weftwise`（font-display）+ 「织识」（lg 以上显示），替换占位网络图形与 "Agentic Wiki"。
4. **Metadata**：根 `layout.tsx` → `title: { default: 'weftwise 织识', template: '%s · weftwise' }` + 品牌 description；子页 title 去掉手写后缀（ingest、wiki not-found）。
5. **图标与 OG**：新增 `src/app/icon.svg`（内嵌 prefers-color-scheme 自适应 favicon）、`src/app/apple-icon.png`（180×180）、`src/app/opengraph-image.png`（1200×630）+ `opengraph-image.alt.txt`。
6. **Settings About**：`settings-nav.tsx` / `settings-content.tsx` 的 "Agentic Wiki" → "weftwise 织识"。
7. **README 与品牌档案**：README H1/引言接品牌；新增 `docs/brand/`（mark SVG 源文件 + 简版品牌说明）。
8. **模块文档**：`src/app/CLAUDE.md`、`src/components/CLAUDE.md` 补 changelog。

## 验证

- `npx tsc --noEmit` 退出码 0。
- `npx vitest run src/components src/app` 相关用例通过（无既有用例引用 "Agentic Wiki" 字符串，已 grep 确认）。
- 真实运行：worktree 内 `next dev`（独立 scratch DB/vault env）→ Playwright 检查：Header lockup 亮/暗两态截图、`<head>` 内 icon/OG meta 标签、`/icon.svg` 可访问。

## 明确不做（YAGNI）

- 不重命名仓库/包名/内部代号；不触碰 vault git-service 的初始化文案（非用户品牌面）。
- 不引入新字体包；wordmark 矢量定稿（授权/开源字体转曲）留到需要对外输出物料时再做。
