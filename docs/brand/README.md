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

## UI 主题（语义职责，`--base-weft-*` / `--base-warp-*` 家族）

产品交互与错误状态必须快速区分。经线靛承担正常操作、连接和结构；纬线朱收缩为品牌识别，不再作为全局操作色：

| 职责 | 家族 | 亮色主档 | 暗色主档 | 覆盖面 |
|------|------|----------|----------|--------|
| 操作（accent）| warp | `#3E4A6D`（配白字）| `#93A3CF`（配深墨前景）| 按钮、开关、焦点环、选区、活跃态、图谱触碰节点 |
| 连接（link/graph）| warp | `#3E4A6D` | `#93A3CF` | 正文 wikilink、图谱节点、mermaid secondary、quiz callout |
| 品牌识别 | weft | `#D9482F` | `#FF6B4D` | 标志、favicon、OG 品牌资产 |
| 危险 | danger | `#DB374F` | 同 | 删除、失败、错误与校验告警；界面中唯一稳定的红色状态语义 |
| 底色 | paper/ink | canvas `#F6F5F2` | canvas `#131315`（暗面板带品牌蓝调）| 全局 |

## 使用要点

- 标志构造（v2，2026-07-17）：**三根经线 + 一根正弦波形纬线**（幅 6 / 周期 20 / 笔画 3.6，波峰落在经线之间）——波形本身在小尺寸下传达「编织」，大尺寸再靠层级断口表达穿压关系。
- 织纹节奏是标志的灵魂：**纬线穿第 1、3 根经线之下、压第 2 根之上**，不得改节奏/改色/加投影/斜置。
- 最小使用尺寸 16px；小于 24px 只用 mark 不带 wordmark。
- App 内 wordmark 用 `font-display`（Space Grotesk，OFL）小写 `weftwise`；「织识」并排时约为 wordmark 字号 55%，次级前景色。
- 标志组件：`src/components/shared/weftwise-mark.tsx`（`<WeftwiseMark size />`，自动亮暗）。

## 提案存档（`proposals/`，浏览器直接打开即可）

| 文件 | 内容 | 线上版 |
|------|------|--------|
| `2026-07-17-round1-brand-directions.html` | Round 1 · 七个品牌方向（weft/Banyan/Asterism/Muninn/atoll/Clew/Trellis）| [Artifact](https://claude.ai/code/artifact/230ca5ca-2d24-408e-b47f-791fed2336ad) |
| `2026-07-17-round2-coined-names.html` | Round 2 · 从「织识」铸词六案（定名 weftwise）| [Artifact](https://claude.ai/code/artifact/2a2eb797-0645-45c1-9bec-68c8373c0acb) |
| `2026-07-17-brand-sheet.html` | 品牌定稿规格书（含 v2 织纹、核验记录、防御清单）| [Artifact](https://claude.ai/code/artifact/bd2ffe06-6415-4d01-bc8e-4045da3e3077) |
| `2026-07-17-mark-v2-variants.html` | 标志 v2 选型对比（直纬 vs 三种波纬，6 档尺寸×亮暗）| — |

> 资产 zip 不入库：内容（mark SVG / icon.svg / og.png）已由本目录与 `src/app/` 持有。
