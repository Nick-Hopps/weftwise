# Coding Style Guide

> 此文件定义团队编码规范，所有 LLM 工具在修改代码时必须遵守。
> 提交到 Git，团队共享。

## General
- Prefer small, reviewable changes; avoid unrelated refactors.
- Keep functions short (<50 lines); avoid deep nesting (≤3 levels).
- Name things explicitly; no single-letter variables except loop counters.
- Handle errors explicitly; never swallow errors silently.

## Language-Specific

### TypeScript (本项目主语言)
- `strict: true`；优先 `interface` 描述对象结构，联合/映射用 `type`。
- 避免 `any`；不可避免时用 `unknown` 并在边界处校验。
- 公共 API 用 `src/lib/contracts.ts` 的 Zod schema 与 TS 类型双轨定义。
- 服务端模块禁止被 "use client" 文件直接 import（参见 `src/server/CLAUDE.md`）。
- React Server Components 默认，仅在需要交互时标注 `"use client"`。
- Next.js Route Handler 的 props 必须序列化；`onValueChange` 类回调在 `"use client"` 入口文件命名为 `onValueChangeAction`。

## Git Commits
- Conventional Commits, imperative mood.
- Atomic commits: one logical change per commit.
- 中文 subject 可用；scope 小写；`type(scope): subject` 格式。

## Testing
- Every feat/fix MUST include corresponding tests.
- Coverage must not decrease.
- Fix flow: write failing test FIRST, then fix code.
- 本项目当前测试覆盖为 0，优先补 `src/server/wiki/{wikilinks,frontmatter,wiki-transaction}.ts`。

## Security
- Never log secrets (tokens/keys/cookies/JWT)。
- `config/env.ts` 的 Zod schema 是 secret 唯一可信源，禁止直接读 `process.env`。
- Validate inputs at trust boundaries（API route、外部 LLM 响应、Markdown 解析）。
