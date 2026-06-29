import { describe, expect, it } from 'vitest';
import {
  parseFrontmatter,
  validateFrontmatter,
  stampSystemFrontmatter,
} from '../frontmatter';

// Writer skills emit only title/summary/tags + body (no created/updated/sources),
// matching the writer skill prompt. The wiki contract requires non-empty
// created/updated — these are system-owned and stamped at the commit boundary.
const WRITER_CONTENT = [
  '---',
  'title: TypeScript',
  'summary: A typed superset of JavaScript',
  'tags:',
  '  - language',
  '---',
  '',
  '## Overview',
  '',
  'TypeScript adds static types.',
  '',
].join('\n');

// 真实复现：writer（写中文内容时）把 YAML key 的半角冒号打成全角冒号「：」(U+FF1A)，
// 典型是 `tags：`。gray-matter 把它当多行 plain scalar → 撞 `---` 抛
// "can not read a block mapping entry; a multiline key may not be an implicit key"，
// ingest commit/verify 解析时炸掉整个 job。frontmatter key 契约上恒为 ASCII，
// 故 parseFrontmatter 应在解析失败时把行首 ASCII-key 的全角冒号修回半角再解析。
const FULLWIDTH_COLON_CONTENT = [
  '---',
  'title: 算子范数与低秩逼近',
  'summary: 算子范数定义为最大奇异值，以及利用 SVD 实现最佳低秩逼近。',
  'tags：', // ← 全角冒号
  '  - 线性代数',
  '  - 算子范数',
  '---',
  '',
  '# 算子范数',
  '',
  '正文：这里的中文全角冒号「：」必须保留，不能被误改。',
  '',
].join('\n');

describe('parseFrontmatter 全角冒号 key 容错（bug 复现）', () => {
  it('行首 ASCII-key 的全角冒号被修回半角后正常解析，不抛错', () => {
    const { data } = parseFrontmatter(FULLWIDTH_COLON_CONTENT);
    expect(data.title).toBe('算子范数与低秩逼近');
    expect(data.tags).toEqual(['线性代数', '算子范数']);
  });

  it('只修 frontmatter 内的 key 分隔符，正文里的中文全角冒号原样保留', () => {
    const { body } = parseFrontmatter(FULLWIDTH_COLON_CONTENT);
    expect(body).toContain('正文：这里的中文全角冒号「：」必须保留');
  });

  it('合法 frontmatter 行为不变（无全角冒号时不触发修复）', () => {
    const { data } = parseFrontmatter(WRITER_CONTENT);
    expect(data.title).toBe('TypeScript');
    expect(data.tags).toEqual(['language']);
  });

  // gray-matter 在 parseMatter 抛错前就把半成品 file 写进全局缓存（index.js:47），
  // 导致同一非法内容第二次解析命中缓存、不再抛错而返回 {data:{}, content:完整原文}，
  // 绕过修复 → 静默数据损坏。parseFrontmatter 必须绕过该缓存，保证多次解析结果一致。
  it('同一非法内容多次解析结果一致（不被 gray-matter 缓存中毒）', () => {
    const first = parseFrontmatter(FULLWIDTH_COLON_CONTENT);
    const second = parseFrontmatter(FULLWIDTH_COLON_CONTENT);
    expect(second.data.title).toBe('算子范数与低秩逼近');
    expect(second.data.tags).toEqual(['线性代数', '算子范数']);
    expect(second.data.title).toBe(first.data.title);
  });

  it('stampSystemFrontmatter 对全角冒号内容产出单个合法 frontmatter（不重复、不丢标题）', () => {
    const stamped = stampSystemFrontmatter(FULLWIDTH_COLON_CONTENT, {
      now: '2026-06-02T00:00:00.000Z',
    });
    // 只应有一个 frontmatter 分隔块（开头 --- + 结尾 ---，共 2 个 ---）
    const fences = stamped.split('\n').filter((l) => l.trim() === '---').length;
    expect(fences).toBe(2);
    const { data } = parseFrontmatter(stamped);
    expect(data.title).toBe('算子范数与低秩逼近');
    expect(data.tags).toEqual(['线性代数', '算子范数']);
    expect(data.created).toBe('2026-06-02T00:00:00.000Z');
  });
});

describe('frontmatter validation contract (bug reproduction)', () => {
  it('writer content without created/updated fails validateFrontmatter', () => {
    const { data } = parseFrontmatter(WRITER_CONTENT);
    const result = validateFrontmatter(data as unknown as Record<string, unknown>);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'Field "created" must not be empty',
        'Field "updated" must not be empty',
      ]),
    );
  });
});

describe('stampSystemFrontmatter', () => {
  const NOW = '2026-06-02T00:00:00.000Z';

  it('stamps created/updated so the content passes validation, preserving LLM fields', () => {
    const stamped = stampSystemFrontmatter(WRITER_CONTENT, { now: NOW });
    const { data, body } = parseFrontmatter(stamped);

    expect(data.created).toBe(NOW);
    expect(data.updated).toBe(NOW);
    expect(data.title).toBe('TypeScript');
    expect(data.summary).toBe('A typed superset of JavaScript');
    expect(data.tags).toEqual(['language']);
    expect(Array.isArray(data.sources)).toBe(true);
    expect(body).toContain('## Overview');

    const result = validateFrontmatter(data as unknown as Record<string, unknown>);
    expect(result.valid).toBe(true);
  });

  it('preserves an existing page created timestamp on update, bumps updated', () => {
    const stamped = stampSystemFrontmatter(WRITER_CONTENT, {
      now: NOW,
      existingCreated: '2025-01-01T00:00:00.000Z',
    });
    const { data } = parseFrontmatter(stamped);
    expect(data.created).toBe('2025-01-01T00:00:00.000Z');
    expect(data.updated).toBe(NOW);
  });
});
