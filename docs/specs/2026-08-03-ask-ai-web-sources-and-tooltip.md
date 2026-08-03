# Ask AI 弹窗两处优化：右缘 tooltip 被裁 + 回答来源缺 web 链接

日期：2026-08-03
状态：设计定稿（盘问结论已沉淀进「目的 / 约束 / 成功标准」三节）

---

## 一、问题现状

### 症状 1：「保存到 Wiki」的 tooltip 被面板裁掉

Ask AI 悬浮面板右上角的图标动作条里，最右侧的保存按钮悬停后提示气泡只显示出「保存到 Wi」，右半截连同圆角一起被切断。

机制（读代码即可定位，无需复现）：

- 气泡是 `.tip::after` 伪元素，`position:absolute` + `left:50%` + `translateX(-50%)`（`src/app/globals.css:427`）；
- 保存按钮是工具条最后一个元素，距面板右内边缘约 22px（`px-2.5` + 24px 图标按钮的一半）；「保存到 Wiki」气泡宽约 80px，居中后右侧要越界约 18px；
- 祖先 `<section>` 带 `overflow-hidden`（`src/components/layout/ask-ai-floating-panel.tsx:306`，圆角与内容裁剪都靠它），越界部分被裁剪盒直接切掉。

**这不是层级问题**：截图里露出的那半截气泡正常盖在面板背景之上，说明 `--z-tooltip`(60) 已经足够；`overflow:hidden` 的裁剪对后代无条件生效，与 `z-index` 无关。同理，光把 `z-index` 提高一个数量级不会有任何变化。

`globals.css:417` 的注释其实已经预见了这一类：「`tip tip-l`（向左——用于贴在 overflow 裁剪容器右缘的控件）」。但 `tip-l` 是**垂直居中 + 向左弹出**，在这条只有 3 个按钮、横向本就局促的工具条上会整条盖住旁边的删除/新建按钮。缺的是「下方 + 右对齐」这一档。

### 症状 2：回答的 Sources 区永远不可能出现 web 链接

`web.search` 工具在联网检索已配置时确实会注入模型工具集（`query-service.ts:56` 的 `resolveQueryTools`），模型也真的会用它。但它的结果**完全不进引用链路**，三处断层各自独立：

1. `AccessedPages`（`query-tools.ts:52`）只有 wiki 页面与 source 三类桶，`buildQueryToolContext` 的 `webSearch` 包装（同文件 :274）直接 `return webSearch(query)`，**返回什么、模型看了什么，服务端一律不留痕**；
2. 引用解析 `extractCitationsFromAnswer`（`citation-extract.ts:121`）只解析 `[[slug]]` 并与已读 wiki 页求交，结构上无法产出网页条目；
3. Prompt 第 269 行明确**禁止**给 web 结果任何引用格式：「Do not cite web results using the wiki citation format ([[page]]) — describe them in prose with the source URL/title instead.」

所以现状是：模型联网查到的东西只以散文形式混在正文里，Sources 折叠区里一条都没有；用户想点开原始网页只能自己从正文里找 URL（模型甚至可能只写了站名）。

---

## 二、目的

1. Ask AI 面板内贴右缘的图标按钮，tooltip 完整可读，不被面板裁剪。
2. 回答里真正**用作依据**的网页，与 wiki 页面并列出现在同一个 Sources 区，可点击直达原网页；保存成回答页时溯源不丢。

---

## 三、约束

盘问共识，逐条都是硬约束：

**C1（tooltip 修法）**：新增 CSS 变体 `tip-br`（下方 + 按钮右缘对齐，`right:0` 取代 `left:50%`），气泡向左伸展，天然不越界。纯 CSS、零 JS、零运行时开销，与现有 `tip` / `tip-b` / `tip-l` 同体系。
- **不**改面板的 `overflow-hidden`：把裁剪下移到内层能让气泡溢出到面板外，但圆角处的内容裁剪、header、底部 resize handle 都要重新安排，回归面比 tooltip 本身大得多。
- **不**做 portal tooltip：全局替掉 CSS tooltip 是很大一块改造，当前只有这一处真实遮挡，违 YAGNI。

**C2（web 来源的收录判据）**：只收「答案里实际引用、且本轮 `web_search` 真实返回过」的 URL。
- 模型按 prompt 纪律用 markdown 链接 `[标题](url)` 标注 web 依据；服务端流结束后**确定性解析**答案里的 URL，与本轮累积的搜索结果求交。
- 与既有 wiki 引用「prompt 纪律 + 流后确定性解析」完全同构（`citation-extract.ts` 的设计），**零额外 LLM 调用**。
- 求交是反幻觉闸门：模型凭空写的 URL 不会进 Sources。
- 已知代价：模型漏写链接则该来源不显示。这与 wiki 引用「an uncited claim will show no source」的既有语义一致，不为它加兜底。
- **不**把本轮搜索返回的全部结果一股脑列进来：搜了没用上的结果不是依据，多轮搜索会把 Sources 冲成噪声。

**C3（显示标题以服务端为准）**：条目标题取搜索结果里服务端记下的标题，不取答案里 markdown 链接的锚文本——锚文本由模型自由书写，可能与目标页无关。

**C4（呈现）**：仍是**一个** Sources 折叠头，计数 = wiki + web 总数；wiki 行保持现状，web 行带地球图标、显示「网页标题 / 域名」，新标签页打开（`target="_blank"` + `rel="noopener noreferrer"`）。面板窄（桌面默认 440px），不再加一层 Wiki / Web 分组标题。

**C5（保存到 Wiki）**：`## References` 区里 wiki 引用继续写 `[[slug]]`，网页来源写 `- [标题](url)`。frontmatter 的 `sources` 字段**不动**——它专用于 raw source ID，该路径本来就为空。

**C6（持久化不加迁移）**：`messages.citations_json` 现在就是一个「role-aware 证据 blob」（`conversations-repo.ts::mapMsg` 只校验 `Array.isArray`）。web 条目作为判别变体存进**同一个数组**（wiki 条目有 `pageSlug`，web 条目有 `url`），读取时按字段拆开。存量行全是 wiki 条目，解析逐字节不变，**不加列、不写迁移**。

**C7（不扩权）**：`web.search` 仍是 `sideEffect:'none'` 只读工具，注入条件不变（`isWebSearchConfigured()`）；本次不改工具面、不改 profile、不新增 LLM task。未配置联网检索时，全链路行为与改动前逐字节一致（`webResults` 恒空 → web 引用恒空数组）。

---

## 四、成功标准

1. Ask AI 面板右上角保存按钮悬停，「保存到 Wiki」气泡完整显示在面板内，不被裁剪、不盖住旁边按钮；`saving` 态的长气泡同样完整。
2. 联网检索已配置时，问一个库内答不上、模型会去搜网页的问题：回答的 Sources 折叠区里出现该网页条目（标题 + 域名），点击在新标签页打开原始 URL；计数含 wiki + web。
3. 模型正文里写的、本轮搜索并未返回过的 URL，**不**出现在 Sources 区。
4. 刷新页面重新载入该会话，web 来源条目原样恢复。
5. 该回答「保存到 Wiki」后，生成页面的 `## References` 同时含 `[[slug]]` 行与 `[标题](url)` 行。
6. 未配置联网检索时，Ask AI 行为与改动前无差异（Sources 只有 wiki 条目）。
7. `npx vitest run` 全绿（含本次新增的确定性解析用例）。

---

## 五、方案

### 5.1 tooltip（C1）

`globals.css` 追加：

```css
.tip.tip-br::after {          /* 下方 + 右缘对齐 */
  left: auto;
  right: 0;
  bottom: auto;
  top: calc(100% + 6px);
  transform: translateY(-4px);
}
.tip.tip-br:hover::after,
.tip.tip-br:focus-visible::after {
  transform: none;             /* 必须覆盖共享 hover 规则里的 translateX(-50%) */
}
```

`save-to-wiki-button.tsx` 两个分支（idle 与 saving）的 `tip tip-b` → `tip tip-br`。工具条另两个按钮距右缘足够（新建约 74px、清空气泡更窄），保持 `tip-b` 居中不动。

### 5.2 web 来源链路（C2–C6）

| 层 | 改动 |
|---|---|
| `lib/contracts.ts` | 新增 `WebCitation { url; title }`；`AnswerCitation = WikiCitation \| WebCitation`；`QueryResult` 增 `webCitations` |
| `lib/wiki-citation.ts` | 新增纯函数 `isWebCitation` / `splitAnswerCitations`（union 数组 → `{ wiki, web }`），供客户端与 repo 读取侧共用 |
| `services/query-tools.ts` | `AccessedPages` 增 `webResults: Map<normalizedUrl, WebCitation>`；`buildQueryToolContext` 的 `webSearch` 包装在返回前累积结果（与 `onSourceAccess` 同层级的留痕职责） |
| `services/citation-extract.ts` | 新增纯函数 `extractWebCitationsFromAnswer(answer, accessed)`：抽 markdown 链接 URL + 裸 URL → `normalizeCitationUrl` 规范化（去尾随标点/尾斜杠差异）→ 与 `webResults` 求交 → 按首次出现顺序去重，标题取服务端记录（C3） |
| `llm/prompts/query-prompt.ts` | 「Web search」一节改纪律：仍禁止 `[[…]]`，改为要求用 `[标题](url)` 内联标注，且 URL 必须是 `web_search` 原样返回的；说明这些链接就是 web 来源的收集方式 |
| `api/query/route.ts` | 流末算 `webCitations`；`emit('citations', { citations, webCitations })`；持久化写 `[...citations, ...webCitations]`（C6）；`recordTurnEvidence` 仍只吃 wiki 条目（掌握度证据按 `(user, subject, slug)` 归属，web 条目没有 slug） |
| `services/query-service.ts` | `runQuery` 一并返回 `webCitations`；`saveQueryAsPage` 接收并渲染 web References（抽纯函数 `buildReferencesSection` 便于单测）；`save-to-wiki` job params 增 `webCitations`（缺省 `[]`，兼容在途旧 job） |
| `db/repos/conversations-repo.ts` | `ConversationMessage.citations` 类型放宽为 `AnswerCitation[]`，映射逻辑不变 |
| `chat/chat-message.ts` | `ChatMessage` 增 `webCitations`；历史消息经 `splitAnswerCitations` 拆分恢复 |
| `chat/chat-interface.tsx` | SSE `citations` 事件同时接收两个数组 |
| `chat/message-list.tsx` | `MessageCitations` 渲染 web 行（Globe + 标题 + 域名 + `target=_blank`），计数取总和，`≤3 默认展开`的既有规则按总数判断 |
| `chat/save-to-wiki-button.tsx` | 请求 body 带上 `webCitations` |

### 5.3 明确不做

- 不抓取网页正文、不做 web 快照入库（那是 Research / Ingest 的职责，已有独立链路）。
- 不给 web 条目做 excerpt 抽取：`web_search` 返回的 snippet 是搜索引擎摘要，不是「原文字面子串」，与 wiki excerpt 的语义保证不同档，Sources 行只显示标题 + 域名。
- 不改 coverage 判定、不改 research backlog 行为。
