# weftwise 品牌资产

> **weftwise**（weft 纬线·织 ＋ wise 智·识），中文名**织识**（谐音「知识」）。
> Tagline：*"Knowledge, woven."* ／ 「让读过的一切，织成一张布。」
> 定稿 2026-07-17；实现计划见 [`docs/plans/2026-07-17-brand-weftwise.md`](../plans/2026-07-17-brand-weftwise.md)。

## 文件

| 文件 | 用途 |
|------|------|
| `weftwise-mark.svg` | 标志源文件 · 浅底版 |
| `weftwise-mark-dark.svg` | 标志源文件 · 深底版 |
| `../../src/app/icon.svg` | 生效中的自适应 favicon（内嵌 `prefers-color-scheme`）|
| `../../src/app/apple-icon.png` | 180×180 Apple touch icon |
| `../../src/app/opengraph-image.png` | 1200×630 分享图（Next.js 文件约定自动挂 meta）|

## 色板（app 内为 `--brand-warp` / `--brand-weft` token，见 `globals.css`）

| Token | Light | Dark | 用途 |
|-------|-------|------|------|
| warp 经线靛 | `#3E4A6D` | `#93A3CF` | 标志经线 |
| weft 纬线朱 | `#D9482F` | `#FF6B4D` | 标志纬线、品牌强调 |

## 使用要点

- 织纹层级是标志的灵魂：**纬线压第 2、4 根经线、穿第 1、3 根之下**，不得改层级/改色/加投影/斜置。
- 最小使用尺寸 16px；小于 24px 只用 mark 不带 wordmark。
- App 内 wordmark 用 `font-display`（Space Grotesk，OFL）小写 `weftwise`；「织识」并排时约为 wordmark 字号 55%，次级前景色。
- 标志组件：`src/components/shared/weftwise-mark.tsx`（`<WeftwiseMark size />`，自动亮暗）。
