# Wiki 解析边界设计

日期：2026-07-14  
状态：已完成

## 一、目标

补齐 `src/server/wiki/CLAUDE.md` 已登记的解析边界，使 frontmatter 与 wikilink 单一真实源在 Unicode、Markdown 代码区、Windows 行尾、大小写标题和跨 Subject 重名页面下具有明确且可回归的行为。

## 二、Frontmatter 契约

1. `parseFrontmatter` 必须完整保留 emoji、CJK 与正文代码围栏；正文中的 `---`、YAML 示例和 wikilink 不得被当成第二个 frontmatter。
2. CRLF 输入必须可解析；`body` 的行尾与正文内容按原字节语义保留，序列化后再次解析得到相同结构化数据与正文。
3. `serializeFrontmatter` 允许 gray-matter 重排 YAML key 或选择引号样式，但 `parse → serialize → parse` 后的 `WikiFrontmatter` 与 `body` 必须语义相等。
4. 既有全角冒号修复仅作用于文件开头的首个 frontmatter，不能修改正文或代码围栏。

## 三、Wikilink 标题解析契约

`TitleResolver` 增加可选的目标 Subject 上下文：

```ts
type TitleResolver = (
  title: string,
  targetSubjectSlug?: string,
) => string | undefined;
```

解析顺序固定为：

1. 先从 token 判断显式 `subject:`，无前缀则使用 `currentSubjectSlug`；
2. 再把 `rawTitle` 与解析后的 `targetSubjectSlug` 一并交给 resolver；
3. resolver 未命中时回退 `normalizeSlug(rawTitle)`；
4. 同名 title 必须按 `targetSubjectSlug` 隔离，不能把当前 Subject 的映射套到跨 Subject 页面；
5. 大小写匹配由 Subject 对应的 title map 负责，返回 canonical slug；同一 Subject 内既有 last-write-wins 重名策略本期不改变。

旧的单参数 resolver 仍可作为 TypeScript 兼容回调使用；仓库内生产 resolver 全部改为显式理解目标 Subject，避免作用域不明确。

## 四、实现范围

- 修改 `src/lib/contracts.ts` 的 `TitleResolver` 签名与注释；
- 修改 `wikilinks.ts`，向 resolver 传入目标 Subject；
- 修改 indexer、page operations 与 citation extractor 的 resolver，使其按 Subject 隔离；
- 补充 frontmatter、wikilink、citation/indexer 相关回归测试；
- 更新 Wiki 模块文档与测试基线。

不新增 LLM task、工具或工作流，不修改 `llm-config.example.json`。

## 五、验收

1. emoji / fenced code / CRLF frontmatter 语义往返测试通过；
2. 大小写标题解析到 canonical slug；
3. 当前与跨 Subject 存在同名 title 时，各自解析到正确 slug；
4. 既有单 Subject、alias、move/relink 行为不回归；
5. 全量 Vitest、TypeScript、ESLint 与生产构建通过。
