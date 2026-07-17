# Subject 导出 / 导入

日期：2026-07-17
状态：已定稿

## 目的

让用户把一个 Subject（主题工作区）打包带走，并能在同一实例或另一实例中恢复为一个新的 Subject。用于备份、迁移与分享。

## 现状

- Subject 的权威内容全部在文件 vault：`wiki/<slug>/`、`raw/<slug>/`、`assets/<slug>/`、`.llm-wiki/sources/<slug>/*.json`（source 侧车）。
- SQLite 是可重建索引：`rebuildDatabaseFromVault` 已能从上述目录 + 侧车恢复 pages / wiki_links / FTS / sources / page_sources。
- 无任何导出/导入端点。

## 设计决策

### 导出单元与格式

zip 包，内部布局与 subject slug **解耦**（便于导入时换 slug）：

```
manifest.json          # { formatVersion: 1, exportedAt, subject: { slug, name, description, augmentationLevel } }
wiki/**                # 原 vault/wiki/<slug>/ 下的全部文件
raw/**                 # 原 vault/raw/<slug>/
assets/**              # 原 vault/assets/<slug>/
sources/**             # 原 vault/.llm-wiki/sources/<slug>/*.json 侧车
```

### 包含 / 不包含

包含：wiki 页面、原始源文件、图片资产、source 侧车、subject 元信息（name/description/augmentationLevel）。

不包含（YAGNI，均可再生或属实例本地状态）：embeddings、FTS、对话、pending actions、jobs/operations、research 五表、page renditions、maturity、git 历史。导入后这些从零开始。

### API

- `GET /api/subjects/[id]/export` — requireAuth；持 vault 锁读取（避免导出到 Saga 写入一半的状态）；返回 `application/zip`，`Content-Disposition: attachment; filename="<slug>-export.zip"`。404 subject 不存在。
- `POST /api/subjects/import` — requireAuth + requireCsrf；`multipart/form-data`：`file`（zip 必填）+ `slug`（可选覆盖 manifest slug，用于冲突时换名）。流程：
  1. 解包校验：manifest 存在且 `formatVersion === 1`；所有 entry 路径必须落在四个白名单目录内，拒绝 `..`/绝对路径（zip-slip 防护）。
  2. slug 决定：`slug` 参数 > manifest slug；`subjectsRepo.create` 复用既有 invalid-slug / slug-conflict 守卫（409 让前端提示换名）。
  3. 持 vault 锁：写文件到 `<vault>/{wiki,raw,assets}/<newSlug>/` 与 `.llm-wiki/sources/<newSlug>/`。
  4. 索引：`indexTouchedPages(subjectId, 全部导入页 slug)`；从侧车恢复 sources + page_sources（同 rebuild 的逻辑，subject-scoped）。
  5. `commitVaultChanges("[subject:<slug>] Import subject from archive", 四个目录)`（git 失败非致命，与既有路由一致）。
  6. 任一步失败：清理 vault 目录 + `deleteWithContents` 回滚新建 subject。
  - 返回 201 `{ subject, stats: { pages, sources, assets } }`。

跨主题链接 `[[other-subject:page]]` 导入后可能悬空——不做处理，交给既有 lint 体检发现。

### 前端

- Subjects 管理页页头加 "Import" 按钮：选 zip → POST；409 slug-conflict 时 prompt 输入新 slug 重试；成功后刷新列表。
- Subject 编辑弹窗（gear）加 "Export" 入口：直接导航到导出 URL 下载。

### 上限

zip 使用 adm-zip 内存构建/解析；导入包上限 200MB（超出 413），单实例本地工具场景足够。

## 方案取舍

- **zip vs tar/git bundle**：zip 通用、双端零额外工具；git bundle 能带历史但导入语义复杂（新 subject 无需旧历史）。选 zip。
- **归档内保留原 slug 目录 vs subject 相对布局**：相对布局使换 slug 导入零重写（wikilink 均为 subject 内相对），选后者。
- **导入复用 rebuildDatabaseFromVault vs scoped 索引**：全量 rebuild 会清掉其他 subject 索引再重建，代价大且需要全局锁语义；选 `indexTouchedPages` + subject-scoped 侧车恢复。

## 成功标准

- 导出 zip 结构符合 manifest 契约；导入后新 subject 页面数、source 数与原 subject 一致，FTS 可搜索，页面可渲染。
- 恶意 zip（路径穿越、缺 manifest、版本不符）被 400 拒绝且零落盘。
- slug 冲突返回 409 `slug-conflict`，可用新 slug 重试成功。
- `tsc --noEmit` + `vitest run` 全绿。
