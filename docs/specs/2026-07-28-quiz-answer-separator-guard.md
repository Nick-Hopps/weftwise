# Quiz 答案分隔符护栏与存量修复

日期：2026-07-28
状态：设计定稿（盘问结论已沉淀进「目的 / 约束 / 成功标准」三节）

---

## 一、问题现状

阅读页的 `[!quiz]` 卡片有时把**问题与答案一并摊开**，既不折叠也没有「显示答案」按钮，直接剧透。

### 复现与定位

以 `data/vault/wiki/world-history/mongol-empire.md:85` 为例，源文件里根本没有分隔符：

```markdown
> [!quiz] 检验理解
> 问：为什么1241年窝阔台之死会暂时中止蒙古对欧洲的进一步入侵？
> 答：按照蒙古的政治传统，新任大汗必须经由各部首领和统兵将领共同参加的忽里勒台大会选出。……
```

**同一页另外两处 quiz 完全正确**（`> [!quiz] ❓ 自测` + 空 `>` 行 + `> ---` + 空 `>` 行 + 答案）。同一次 ingest、同一个 enricher、同一页，三块里两块守约一块脱模 —— 那块脱模的连标题 emoji 都丢了（`检验理解` vs `❓ 自测`）。

结论：**渲染侧行为完全正确**。`markdown-client.ts::splitQuizCallout` 找不到 `thematicBreak` 时按设计退化成「存量页形态」（不切分、不折叠、直接自评），这是 `2026-07-26-mastery-evidence-model` 刻意保留的兼容路径。根因是 **enricher 的输出漂移** —— prompt 里写了 MUST，模型仍会在同一次运行内部分块脱模。

### 全库统计

用与渲染同一套 mdast 判定扫描 `data/vault/wiki/**/*.md` 共 308 个 quiz：

| 形态 | 数量 | 渲染表现 |
|---|---|---|
| 有 `---` | 30 | 正确折叠 |
| **有答案但无分隔符** | **73** | **答案暴露（本 bug）** |
| 只有问题、无答案 | 205 | 正确（v6 及以前的存量形态） |

73 处受损块**全部**有且**恰有一个**答案标签行，零歧义：

| 标签 | 数量 |
|---|---|
| `答：` / `答:` | 37 |
| `答案：` | 28 |
| `A:` | 7 |
| `参考答案：` | 1 |

结构分布：36 处答案已是独立段落（两段之间插分隔符即可）、33 处与问题同段（软换行，需在标签行处拆段）、4 处为三段形态。

### 第二种失效（尚未发生但已埋好）

CommonMark 下 `> ---` 若前面没有空的 `>` 行，会被解析成 **setext H2**，而不是 `thematicBreak`：

```
> [!quiz] 自测
> 问题在这里
> ---
> 答案在这里
```

实测 mdast → `[{ type:'heading', depth:2 }, { type:'paragraph' }]`。后果是问题段变大标题、答案段变普通段落，同样不折叠。当前 30 处 literal `> ---` 都恰好带了空行，暂未踩到；但 skill 模板只在**示例**里隐含了空行，规则条文一个字都没提。

---

## 二、目的

1. **新产出的 quiz 必须可折叠** —— 生成侧用确定性护栏兜住模型漂移，不再依赖 prompt 自觉。
2. **存量 73 处受损块一次性修好** —— 修复固化进 vault（可 `git diff` 审阅、可回滚），而不是每次渲染都去猜。
3. **失效可诊断** —— 将来若再出现，能从任务日志直接读出是哪一阶段吃掉了分隔符，不必再扭一次 vault 考古。

---

## 三、约束（盘问结论）

### C1 兜底放在生成层，渲染层不动

`markdown-client.ts` 的 quiz 切分保持**纯结构判定**（只认 `thematicBreak`），不引入「答：/A:/Answer:」这类语言标记兜底。

**理由**：语言标记会随 `wikiLanguage` 漂移，且模型不写标签时依然失效 —— 这是 `2026-07-26-mastery-evidence-model` 决策里明确拒绝过的方向。语言标记的脆弱性被隔离在**摄入侧的一次性修复**中，不进入每次渲染的热路径。

### C2 护栏挂在 enricher fanout 之后，commit 前再做零成本终审

- **enricher 产物**违规 → 把 violations 拼回输入**重写一次**（唯一花 token 的地方）。
- **commit 前**对最终内容跑同一个纯函数，仍违规则 `emit` 一条 warn 事件（不改内容、不阻断、不调 LLM）。

**理由**：enricher 是漂移源头，重写机会给它。verify 阶段虽然会整页重写（skill 要求 verbatim 复现），实测 30/30 分隔符都活着穿过了它，且它未必运行（未配置 web search 时 passthrough）—— 给它也加重写面属于无证据的开销。但终审 warn 是零 token 的纯观测，能永久回答「是哪一阶段吃掉的」。

ingest 与 re-enrich **共用**同一个 `kind:'fanout', skillId:'ingest-enricher'` 步骤（`ingest-service.ts:84` / `reenrich-service.ts:49`），护栏挂在 orchestrator 的 fanout 分支上两条路径自动覆盖 —— 与 writer 阶段挂 `merge-update-fidelity` 同一范式。

### C3 重写一次仍违规 → 复用迁移纯函数确定性修复

同一个 `repairQuizSeparator` 纯函数既服务一次性迁移脚本，也充当护栏的第二道回落。两条确定性规则按优先级：

1. blockquote 内存在裸 `---` 行但被解析成 setext heading → 前后各补一个空 `>` 行。**零猜测**，与语言无关。
2. 否则存在答案标签行 → 在其前插入 `>` / `> ---` / `>` 三行（同段时先拆段）。
3. 都不命中 → 保留原样 + emit warn。

**理由**：修复固化进 vault 而非每次渲染都猜（C1 的同一逻辑）；且多一个真实调用方能把该纯函数测透。

### C4 迁移脚本只改文件 + 精确 reindex，不碰 vault git

脚本先 `--dry-run` 打印逐处 diff 供审阅，确认后才落盘；随后对**实际改动的页**调 `indexTouchedPages` 同步 `content_hash` 与 FTS body。**不执行 git commit**。

**理由**：vault git 工作区本来就是脏的（4 个 skill 文件 + 一批 `sources/*.json` 有未提交改动），脚本擅自 commit 会把不相关改动一起卷进去。提交时机由 Nick 看过 `git diff` 后自己决定。

### C5 skill prompt 收紧到 v8，只加两条最小约束

`examples/skills/ingest-enricher.md` v7 → v8，只补：

1. 禁止自造 `问：` / `答：` / `Q:` / `A:` 标签前缀（73 处受损块**全部**带这类自造标签，是脱离模板的病征）。
2. `---` 前后必须各留一个空 `>` 行，否则会被解析成 setext 标题。

**理由**：护栏的「重写一次」是真实 token 成本，降低触发率直接省钱；setext 陷阱在条文里一个字都没提，补上是实质改进。不重构整个 Quiz 章节 —— 改动面大、收益无法先验证，且会同时影响已经正常的那 30 处的生成行为。

版本 bump 必须同步三处，历史上明确漏过（见 `src/server/agents/CLAUDE.md` 2026-07-26 条）：
- `ingest-service.ts::MIN_SKILL_VERSIONS`
- `reenrich-service.ts::MIN_SKILL_VERSIONS`
- `builtin-manifest.ts::BUILTIN_UPGRADE_HASHES` 追加 v7 原版 SHA-256

已核实 vault 副本 `data/vault/.llm-wiki/skills/ingest-enricher.md` 与模板**逐字节一致**（v7），所以 hash 白名单命中、自动升级生效，不会卡版本门。

---

## 四、成功标准

1. **纯函数层**：`findQuizSeparatorViolations` 与 `repairQuizSeparator` 有单测覆盖 —— 正常形态零改动、setext 形态补空行、四种标签、同段/分段/三段结构、无标签保留原样、幂等（修复结果再跑一次不变）。
2. **护栏层**：enricher 产物违规时触发重写一次；重写仍违规时确定性修复并 emit warn；产物合规时**逐字节不变**（零回归是硬要求 —— 护栏不能改动守约的产物）。
3. **存量数据**：迁移脚本落盘后重跑扫描，`spoiled` 计数从 73 降到 **0**，`ok` 从 30 升到 103，`question-only` 保持 205 不变。
4. **DB 一致性**：reindex 后被改页的 `content_hash` 与 vault 文件实际内容一致。
5. **渲染验证**：`mongol-empire` 那一块在阅读页真实呈现为折叠态 + 「显示答案」按钮（不靠推断，实际打开页面确认）。
6. **全量测试**：`npm test` 全绿。

---

## 五、不做（YAGNI）

- **不在渲染层加语言标记兜底**（C1）。
- **不给 verify 阶段加重写面**（C2）—— 无证据显示它破坏分隔符；终审 warn 会在真发生时告诉我们。
- **不加 Health lint 规则**暴露受损 quiz —— 护栏 + 终审 warn 已覆盖新产出，存量一次性清零后没有持续增量需要一个常驻 finding 类型。
- **不重构 Quiz skill 章节**、**不补齐 emoji 标题**（`检验理解` 这类标题本身不影响折叠，纯观感）。
- **不改 `205` 处纯问题形态**的 quiz —— 它们没有答案，退化成直接自评是既有设计而非 bug。
