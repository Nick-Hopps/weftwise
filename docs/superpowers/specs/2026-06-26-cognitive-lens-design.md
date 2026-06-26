# 认知画像驱动的读时内容透镜（Cognitive Lens）— 设计文档

> 日期：2026-06-26
> 主题：让 Wiki 输出按**读者（vault 主人）的认知画像**在**读取时**动态重塑，使整理后的内容匹配主人当前的背景与表达偏好，并随主人「把知识内化」而自然跟随其水平上升——同时不损害 canonical 内容的事实可信度。

---

## 一、背景与目标

### 现状

应用的价值是「替用户整理、总结、归纳、补充、泛化材料，加速内化」。但 LLM 产出有一个结构性缺陷：**输出是为"平均读者"写的**。每个用户的知识水平与思考方式不同，于是同一份整理后内容，对 A 太浅啰嗦、对 B 又太抽象难懂——有时甚至不如原始资料好读。

当前内容链路里没有任何「读者画像」概念：

- ingest 流水线（planner→writer×N→enricher→verify→indexer）按全局 `wikiLanguage` + per-subject `augmentation_level` 产出**单一 canonical 正文**，落 vault（git）+ SQLite 索引。
- 阅读页（`src/components/wiki/` 的 `PageRenderer`）直接渲染 canonical 正文，对所有读者一视同仁。
- 仅有的"强度"旋钮 `augmentation_level`（off/light/standard/deep）是 per-subject 的**写入期**增益深度，不是 per-reader 的**呈现期**适配。

### 目标

引入 **per-user 认知画像** + **读时内容透镜**：canonical 不变，读者看到的是按其画像实时重塑的版本。

- **匹配认知**：按"领域背景/熟悉度"+"表达偏好"两维调整讲法（深浅、举例密度、形式化程度、详尽度）。
- **跟随成长**：画像随交互信号上升，重塑版自然变深，无需重新生成内容。
- **守住信任**：重塑是**纯呈现层**——只换讲法不换事实，永远一键可切回 canonical 原文。
- **零侵入**：完全不碰 ingest / verifier / Saga / git / maturity 任何一行；透镜是一个可随时丢弃重建的读侧派生视图。

### 非目标（MVP 明确不做）

- **真正的多租户 auth**：本设计假设存在一个 `userId`，今天退化为单例本地用户（`LOCAL_USER_ID`）。账户体系、登录、租户隔离是独立的未来工作；本设计只保证表结构 user-keyed、未来无需迁移。
- **预生成分层存储**（ELI5/标准/深入多份落盘）：已在设计讨论中否决（存储翻倍、层级离散、与"水平连续上升"不契合）。透镜走读时重塑。
- **跨 subject / 跨 vault 的画像共享**：画像挂在 `userId` 上，但 vault 内容本就 subject-scoped，互不影响。
- **从 vault/maturity 派生背景维**（见下方"决策 6"）：列为 **Phase 2**，MVP 只用自报背景。
- **背景维的 LLM 周期性小结**：列为 **Phase 2**，MVP 学习闭环只做确定性旋钮微调。

### 读者模型（关键前提，已与用户确认）

「多用户」= **每个用户拥有自己独立的 project/vault**，而非一个 vault 被多人消费。因此**任一 vault 内的消费者只有一个 = 该 vault 的主人**。这带来两个简化：

1. 重塑的"目标受众"在任何时刻都是**已知的**（就是主人），不存在"面向陌生读者"的不确定性。
2. 画像是 **per-user 单例**（账户层，高于 subject/vault），不需要 per-page 的多版本并存。

---

## 二、关键架构决策

### 决策 1：canonical 神圣，透镜是纯读侧派生视图

重塑产物**永不写回 vault**，不经过 Saga / git / `validateChangeset`，只落一张缓存表 `page_renditions`。所有现有不变量（Saga 顺序、git 可回滚、verifier 联网核查建立的事实可信、maturity 节律、merge/split/relink）**原封不动**作用在 canonical 上。透镜表可随时清空重建，不影响数据正确性。

> 这与 Ask AI（`/api/query` 流式作答）同属"读侧"链路：两者都用 `streamText` 产出面向人看的文本，都不写 vault。因此项目「LLM 输出必须 `generateObject`、禁止直出 markdown 文件」的规则**不适用于透镜**——该规则约束的是 vault 写入（ingest），透镜从不写 vault。事实保真改由"决策 4"的确定性护栏保证。

### 决策 2：适配发生在**读时**（read-time on-demand reshape）

canonical = 事实全量、中性深度的唯一真相。读者打开页时看到的是按画像重塑的版本。主人水平上升时透镜自然跟随（画像变 → 缓存失效 → 下次打开即新版），**无需重生成 canonical**。代价是首开有 LLM 延迟，靠缓存 + 流式化解（见决策 3 / 7）。

### 决策 3：实现路线 A 打底 + B 逃生口

| | A：整页重塑（默认快通道） | B：段级重塑（逃生口） |
|---|---|---|
| 触发 | 打开页自动 | 读者点段落「说简单点 / 讲深点 / 这段不懂」 |
| 范围 | 整页正文 | 单个 markdown 块 |
| 缓存 | 落 `page_renditions` | 不落整页缓存（即时 inline 替换 + 发信号） |
| UX | 首开流式生成，命中缓存秒开 | 即时 inline 替换该块 |

A 与 B 不冲突：A 是读时改写的**默认全量**，B 是读者仍不满意时的**局部追加调整**。（注意这跟设计讨论中被否的"分层存储 + 按需"混合是两回事——那是写入期预生成存储，这里是读时改写层，无额外落盘。）

### 决策 4：事实保真护栏（三道，确定性为主）

重塑只能换讲法、不能换事实。三道护栏，从结构到语义：

1. **frontmatter 结构性强制保留**：模型**只看/只改正文**。重塑前用 `gray-matter` 把 frontmatter 切走，重塑后由代码**原样拼回** canonical 的 frontmatter。模型无从篡改 slug / title / tags / sources。
2. **wikilink 目标集 ⊆ canonical**：重塑后用唯一真实源 `extractWikiLinks`（`src/server/wiki/wikilinks.ts`）抽出链接目标集，必须是 canonical 链接目标集的**子集**（重塑可省略链接，但**不得新增或篡改**目标）。出现新增/改写目标 = 判失败。
3. **新增脚手架须显式标记**：模型新增的类比/示例/前置铺垫必须包进 callout（如 `> [!example]` / `> [!note]`）——既视觉上可辨（阅读管线已原生渲染 `[!type]` callout），又便于审计；正文事实陈述不得被 callout 吞掉。

**失败处理**：护栏 2 失败 → **重写一次**（在 prompt 里点名"上次新增了不存在的链接 X，请勿引入新链接"）；二次仍失败 → **回落 canonical**（该页透镜降级为原文，不阻断阅读）。护栏 1 是结构性的，不会失败。

### 决策 5：双维画像 = 自报背景 + 表达偏好旋钮

`user_profiles.style_prefs`（JSON）+ `background_summary`（text）：

- **表达偏好**（`style_prefs`，确定性可调旋钮）：
  - `readingLevel`：`beginner | intermediate | advanced`（整体深浅基线）
  - `verbosity`：`terse | balanced | thorough`（详尽度）
  - `exampleDensity`：`few | some | many`（举例/类比密度）
  - `formality`：`casual | neutral | formal`（形式化程度）
- **领域背景**（`background_summary`，自报自由文本）：主人自述"我是谁、已知什么、想用它做什么"。MVP 纯自报 + 可手改；Phase 2 引入 vault 派生 + LLM 小结。

### 决策 6：画像来源 = onboarding 播种 + 确定性反馈学习

- **播种**：首次使用（画像缺失）弹轻量 onboarding 向导：选 4 个偏好旋钮 + 填一段背景自述 → 写画像 v1。设置面板可随时再改。
- **学习（MVP，确定性）**：交互信号经**纯函数 reducer** 微调旋钮（有界、防抖聚合），不调 LLM：
  - `too_hard` / `simplify_click` → `readingLevel` 降一档或 `verbosity`/`exampleDensity` 上调
  - `too_easy` / `deepen_click` → `readingLevel` 升一档或 `verbosity` 下调
  - 任何旋钮变更 → `profile.version` 自增 → 透镜缓存自然失效
- **学习（Phase 2）**：`background_summary` 的 LLM 周期性小结 + 从 vault 页/maturity 派生"已内化哪些概念"。

> **背景维的 vault 派生**（Phase 2 设想，写明以备）：主人已有的页 + 其 `page_maturity` 是一张"已接触/已内化"地图。重塑时可据此判断"这个概念他在 `[[X]]` 里已吃透，引用即可、不必重讲"，从而真正实现 subject-scoped 的背景适配。MVP 不做，避免一上来耦合 maturity。

### 决策 7：首开流式，原文永远即时可切

- 整页重塑（A）首开走 **SSE 流式**（`streamText`），读者看到内容逐步生成（几秒级）。
- canonical 在本地即时可得，**「看原文」开关永远即时**切换——没耐心或怀疑重塑准确性的读者随时秒看原文。
- 命中缓存的页：lens 端点一次性吐完整正文 + done，前端零延迟渲染。

### 决策 8：缓存键 = 内容 × 画像 × 参数，惰性失效

`page_renditions` 联合唯一键 `(subject_id, slug, canonical_hash, profile_version, params_hash)`：

- `canonical_hash`：canonical 正文（剥 frontmatter 后）的 hash。canonical 被编辑/merge/split/relink 改动 → hash 变 → 自动 miss → 重生成。
- `profile_version`：画像任意变更自增 → 全部 miss。
- `params_hash`：整页默认重塑用固定 `'default'`；预留段级/方向性参数。

**惰性失效**：读取时按当前键查，命中即用、未命中即生成，旧行不主动清。后台周期 prune（或 LRU 上限）回收陈旧行。此模式与 `page_embeddings`（`content_hash` + `model` 判过期）一致。

---

## 三、数据流

### 3.1 打开页（整页透镜，A）

```
阅读页加载
  → 立即拿到 canonical（serializeWikiDocument，本地即时；供「看原文」+ 失败回落）
  → 并发请求 GET /api/pages/[...slug]/lens   (SSE)
       → resolveSubjectFromRequest + resolveUserId
       → 取当前 userId 画像（缺失 → 用默认画像，且提示 onboarding）
       → 算 canonical_hash / profile_version / params_hash='default'
       → renditionsRepo 命中？
            命中 → emit lens-delta(整段) + lens-done(cached:true)
            未命中 →
              split frontmatter（gray-matter）→ body
              streamReshape('reshape:page', { system, body, profile, lang })
                → for await chunk of textStream: emit lens-delta(chunk)
              流完 → 护栏校验（extractWikiLinks 子集）
                 失败 → 重写一次 → 仍失败 → 回落 canonical（emit lens-fallback）
                 通过 → 拼回 frontmatter → renditionsRepo.upsert → emit lens-done
  → 默认显示 lens 流；「看原文」开关切 canonical（即时）
```

### 3.2 段级重塑（逃生口，B）

```
读者在某 markdown 块点「说简单点 / 讲深点 / 这段不懂」
  → POST /api/pages/[...slug]/lens/section { blockMarkdown, direction, blockContext }
       → reshapeSection('reshape:section', { block, direction, profile, context, lang })
       → 护栏（链接子集，针对该块）
       → 返回 reshapedBlock
  → 前端 inline 替换该块（不落整页缓存）
  → 并发 POST /api/profile/signals { type: simplify_click | deepen_click, slug }
       → signalsRepo.append → reducer 评估 → 必要时 profileRepo 调旋钮 + version++
```

### 3.3 反馈与画像更新

```
读者点整页「太难 / 太浅」拇指，或切「看原文」
  → POST /api/profile/signals { type }
  → signalsRepo.append（append-only）
  → applySignalToProfile(profile, recentSignals)  // 纯函数 reducer
       → 命中阈值则调旋钮 + version++  →  透镜缓存因 version 变化自然失效
```

---

## 四、组件与接口

### 4.1 数据模型（Drizzle / SQLite，`src/server/db/schema.ts` 加表，附迁移）

```ts
// 账户层，今天单例（userId = LOCAL_USER_ID）
user_profiles {
  user_id        TEXT PRIMARY KEY,          // 今天恒为 'local'
  background_summary TEXT NOT NULL DEFAULT '',
  style_prefs    TEXT NOT NULL,             // JSON: {readingLevel, verbosity, exampleDensity, formality}
  version        INTEGER NOT NULL DEFAULT 1,
  onboarded_at   INTEGER,                   // null = 未完成 onboarding
  updated_at     INTEGER NOT NULL
}

// 重塑缓存（读侧派生，可丢弃重建）
page_renditions {
  id             INTEGER PRIMARY KEY,
  subject_id     TEXT NOT NULL,
  slug           TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  params_hash    TEXT NOT NULL DEFAULT 'default',
  rendered_md    TEXT NOT NULL,             // 重塑后正文（含拼回的 frontmatter）
  model          TEXT,
  created_at     INTEGER NOT NULL,
  UNIQUE(subject_id, slug, canonical_hash, profile_version, params_hash)
}

// 反馈信号（append-only，喂 reducer）
profile_signals {
  id          INTEGER PRIMARY KEY,
  user_id     TEXT NOT NULL,
  type        TEXT NOT NULL,                // too_hard|too_easy|simplify_click|deepen_click|view_original
  subject_id  TEXT,
  slug        TEXT,
  created_at  INTEGER NOT NULL
}
```

> `page_renditions` 不设 FK CASCADE 到 pages（pages 是复合 PK，且 rendition 是可丢弃缓存）；靠 prune + 命中校验自洽。删 subject 时一并 prune 该 subject 的 rendition（与现有 subject 删除路径挂钩）。

### 4.2 repos（`src/server/db/repos/`，新）

- `profiles-repo.ts`：`getProfile(userId)`（缺失返回 `null`）、`upsertProfile(userId, patch)`（自增 version）、`bumpVersion(userId)`、`DEFAULT_STYLE_PREFS` 常量。
- `renditions-repo.ts`：`getRendition(key)`、`upsertRendition(row)`、`pruneStale(opts)`、`deleteBySubject(subjectId)`。
- `signals-repo.ts`：`appendSignal(sig)`、`recentSignals(userId, sinceOrLimit)`。

### 4.3 纯函数（`src/server/profile/`，新——可单测、无 IO）

- `style.ts`：`StylePrefs` 类型、`DEFAULT_STYLE_PREFS`、旋钮档位与边界。
- `signal-reducer.ts`：`applySignalToProfile(profile, recentSignals): { profile, changed }`（确定性、有界、防抖聚合）。
- `rendition-key.ts`：`computeCanonicalHash(body)`、`buildRenditionKey(subject, slug, canonicalHash, profileVersion, params)`。
- `fidelity.ts`：`splitFrontmatter(raw)` / `reattachFrontmatter(fm, body)`（包 gray-matter）、`checkLinkSubset(canonicalBody, reshapedBody): { ok, offending[] }`（复用 `extractWikiLinks`）。

### 4.4 LLM 层（`src/server/llm/`，改）

- `LLMTaskSchema`：新增任务键 `reshape:page` / `reshape:section`（正则已是通用 `<pipeline>:<stage>`，无需改正则）。
- `llm-config.json` / `llm-config.example.json`：加 `reshape:page` / `reshape:section` 路由（示例用偏快的模型，重塑是高频读侧调用）。
- `prompts/reshape-prompt.ts`（新）：
  - `RESHAPE_PAGE_SYSTEM_PROMPT`：纯呈现重塑指令（只换讲法不换事实、保留 wikilink 目标、新增脚手架包 callout、按 `wikiLanguage` 输出、不得新增事实/链接）。
  - `RESHAPE_SECTION_SYSTEM_PROMPT`：段级 + `direction`（simpler/deeper）+ 上下文衔接。
  - `buildReshapePageUser(body, profile)` / `buildReshapeSectionUser(block, direction, profile, context)`：注入画像（背景 + 旋钮）。
  - 复用现有 `wikiLanguage` 注入点（与 ingest/query 一致）。
- `provider-registry.ts`：复用现成 `streamTextResponse`（A 流式）/ `generateText`（B 同步或短流式）；无需新增工具版（重塑无 tools）。

### 4.5 services（`src/server/services/reshape-service.ts`，新）

- `streamPageReshape({ subject, slug, userId, abortSignal })`：取画像 → 算 key → 查缓存（命中即一次性吐）→ 否则 split frontmatter → `streamTextResponse('reshape:page', ...)` → 护栏 → 重写/回落 → 拼回 frontmatter → upsert 缓存。返回 SSE 友好的 stream + 终态。
- `reshapeSection({ subject, slug, userId, blockMarkdown, direction, blockContext })`：`generateText('reshape:section', ...)` → 段级护栏 → 返回 reshapedBlock。

### 4.6 API 路由（`src/app/api/`，新/改）

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/profile` | GET | 读当前 userId 画像（缺失返回默认 + `onboarded:false`） |
| `/api/profile` | PUT | 写画像（onboarding 提交 / 手改旋钮 / 改背景）→ version++；`requireAuth`+`requireCsrf` |
| `/api/profile/signals` | POST | 追加信号 + 触发 reducer；`requireAuth`+`requireCsrf` |
| `/api/pages/[...slug]/lens` | GET | SSE：重塑正文（命中缓存一次性吐）；`resolveSubjectFromRequest`（required）+ `resolveUserId` |
| `/api/pages/[...slug]/lens/section` | POST | 段级重塑；`requireAuth`+`requireCsrf` |

> `resolveUserId(request)`（`src/server/middleware/` 新增）：今天恒返回 `LOCAL_USER_ID`，未来接 auth。lens 为读操作，遵循现有读路由约定（不强制 CSRF）；profile 写 / signals / section 为写操作，`requireAuth`+`requireCsrf`。

### 4.7 前端（`src/components/`、`src/stores/`、`src/hooks/`，改/新）

- 阅读页（`src/components/wiki/` + `(app)/wiki/[...slug]`）：
  - 默认请求并显示 lens（流式）；`PageRenderer` 渲染重塑正文（wikilink/callout/mermaid/数学公式与原阅读页一致）。
  - 顶部「已按你的画像调整 · 看原文」开关（toggle canonical，即时）。
  - 每个 markdown 块悬浮「说简单点 / 讲深点 / 这段不懂」；整页底部「太难 / 太浅」拇指。
- `use-lens-stream`（新 hook）：消费 lens SSE（`lens-delta`/`lens-done`/`lens-fallback`），参照现有 `use-job-stream` 的 SSE 解析风格（注意事件 payload 嵌套层级）。
- `use-current-profile`（新 hook）：读 `/api/profile`，缺失触发 onboarding。
- onboarding 向导 + 设置面板「认知画像」区：复用 `components/ui/*` 原语；画像走 `/api/profile`（**不**镜像进 Zustand——server 是唯一真实源，与 `wikiLanguage` 同规）。

---

## 五、错误处理与降级

- **护栏失败**：重写一次 → 仍失败 → 回落 canonical（lens-fallback 事件，前端无缝显示原文）。读者永远有内容可读。
- **重塑 LLM 调用失败 / 超时 / abort**：回落 canonical + 一条提示；abort 沿用 `request.signal` 合并。
- **画像缺失**：用 `DEFAULT_STYLE_PREFS`（intermediate/balanced/some/neutral）重塑，并提示 onboarding。
- **未配置 `reshape:*` 路由**：lens 端点直接回落 canonical（优雅降级为"无透镜"）——保证未配置也能正常阅读。
- **段级护栏失败**：返回原块 + 提示，不阻断。

---

## 六、测试策略（vitest，贴 `__tests__/` 布局）

1. **纯函数（核心）**：
   - `signal-reducer`：各信号类型的旋钮微调、边界钳制、防抖聚合、version 自增条件。
   - `rendition-key`：canonical_hash 对正文敏感、对 frontmatter 不敏感（剥离后）；键拼装稳定。
   - `fidelity`：`splitFrontmatter`/`reattachFrontmatter` 往返一致；`checkLinkSubset` —— 漏链接通过、新增链接拒绝、篡改目标拒绝、跨主题前缀正确处理。
2. **repos**：profiles（get/upsert/version++/默认）、renditions（命中/未命中/陈旧 prune/按 subject 删）、signals（append/recent）。
3. **prompt 快照**：`RESHAPE_PAGE_SYSTEM_PROMPT` 含保真约束；`buildReshapePageUser` 正确注入画像旋钮与背景；`wikiLanguage` 指令存在。
4. **reshape-service**（mock LLM stream）：缓存命中不调模型；未命中生成 + upsert；护栏失败触发重写；二次失败回落 canonical。
5. **（可选）路由层**：mock service，断言 lens SSE 事件序列（delta/done/fallback）与 profile/signals 写路径鉴权。

> `streamTextResponse` 直连 AI SDK，沿用现状不单测其内部。

---

## 七、影响文件清单

| 文件 | 改动 |
|------|------|
| `src/server/db/schema.ts` + 迁移 | **新** 3 表：`user_profiles` / `page_renditions` / `profile_signals` |
| `src/server/db/repos/profiles-repo.ts` | **新** |
| `src/server/db/repos/renditions-repo.ts` | **新** |
| `src/server/db/repos/signals-repo.ts` | **新** |
| `src/server/profile/style.ts` | **新**：StylePrefs + 默认 + 档位 |
| `src/server/profile/signal-reducer.ts` | **新**：纯函数 reducer |
| `src/server/profile/rendition-key.ts` | **新**：hash + key 派生 |
| `src/server/profile/fidelity.ts` | **新**：frontmatter 拆拼 + 链接子集护栏 |
| `LLMTaskSchema` 定义处（llm 模块内，实现时定位） | +`reshape:page` / `reshape:section` |
| `llm-config.json` / `llm-config.example.json` | +`reshape:*` 路由 |
| `src/server/llm/prompts/reshape-prompt.ts` | **新** |
| `src/server/services/reshape-service.ts` | **新** |
| `src/server/middleware/`（resolveUserId） | **新** 轻量 helper（今天单例） |
| `src/app/api/profile/route.ts` | **新** GET/PUT |
| `src/app/api/profile/signals/route.ts` | **新** POST |
| `src/app/api/pages/[...slug]/lens/route.ts` | **新** GET SSE |
| `src/app/api/pages/[...slug]/lens/section/route.ts` | **新** POST |
| `src/hooks/use-lens-stream.ts` / `use-current-profile.ts` | **新** |
| `src/components/wiki/*` + `(app)/wiki/[...slug]` | 默认 lens + 看原文开关 + 段级/整页反馈 |
| onboarding 向导 + 设置面板「认知画像」区 | **新**（复用 ui 原语） |
| `__tests__/`（profile / fidelity / rendition / reshape-service / prompts / repos） | 新增用例 |
| 根 `CLAUDE.md` + 相关模块 `CLAUDE.md` | changelog + 模块文档 |

---

## 八、分期

- **MVP**（本 spec → 实现计划）：读时整页重塑（A）+ 段级逃生口（B）+ 自报背景画像 + 确定性反馈学习 + 三道保真护栏 + 缓存 + onboarding + 看原文开关。
- **Phase 2**（后续 spec）：背景维从 vault 页 + `page_maturity` 派生（"已内化"地图）、`background_summary` 的 LLM 周期性小结、更丰富的信号（停留/重读/小测）、阅读 beacon 加权。

---

## 九、待评审决策（实现前可回退）

1. **背景维 vault 派生** → MVP **不做**，仅自报（Phase 2）。
2. **保真护栏严格度** → frontmatter 结构性强制保留 + wikilink 目标子集 + 失败重写一次再回落 canonical（不做"丢链即整页回落"的激进策略）。
3. **首开延迟** → 默认流式生成重塑版；「看原文」因 canonical 本地即时而永远可秒切。
