import { describe, expect, it } from 'vitest';
import type { WikiFrontmatter } from '@/lib/contracts';
import {
  MAX_METADATA_ALIASES,
  MAX_METADATA_ALIAS_LENGTH,
  MAX_METADATA_SUMMARY_LENGTH,
  MAX_METADATA_TAG_LENGTH,
  MAX_METADATA_TAGS,
  MAX_METADATA_TITLE_LENGTH,
  findMetadataAliasConflicts,
  normalizeMetadataPatch,
  prepareMetadataPatch,
} from '../narrow-write';

const current: WikiFrontmatter = {
  title: 'Current Title',
  summary: 'Current summary',
  tags: ['alpha', 'Beta'],
  aliases: ['Current Alias'],
  created: '2026-07-01T00:00:00.000Z',
  updated: '2026-07-02T00:00:00.000Z',
  sources: ['source-1'],
};

describe('normalizeMetadataPatch', () => {
  it('要求至少显式提供一个可编辑字段', () => {
    expect(() => normalizeMetadataPatch({ slug: 'current' }))
      .toThrow(/at least one metadata field/i);
  });

  it('trim title/summary，并固定非空与长度边界', () => {
    expect(normalizeMetadataPatch({
      slug: 'current',
      title: ` ${'a'.repeat(MAX_METADATA_TITLE_LENGTH)} `,
      summary: ` ${'b'.repeat(MAX_METADATA_SUMMARY_LENGTH)} `,
    })).toMatchObject({
      title: 'a'.repeat(MAX_METADATA_TITLE_LENGTH),
      summary: 'b'.repeat(MAX_METADATA_SUMMARY_LENGTH),
    });
    expect(normalizeMetadataPatch({ slug: 'current', summary: '   ' }).summary).toBe('');
    expect(() => normalizeMetadataPatch({ slug: 'current', title: '   ' }))
      .toThrow(/title.*empty/i);
    expect(() => normalizeMetadataPatch({
      slug: 'current',
      title: 'a'.repeat(MAX_METADATA_TITLE_LENGTH + 1),
    })).toThrow(/title.*200/i);
    expect(() => normalizeMetadataPatch({
      slug: 'current',
      summary: 'b'.repeat(MAX_METADATA_SUMMARY_LENGTH + 1),
    })).toThrow(/summary.*2000/i);
  });

  it('trim、移除空项并按规范化身份去重 tags/aliases', () => {
    expect(normalizeMetadataPatch({
      slug: 'current',
      tags: [' Alpha ', '', 'ＡＬＰＨＡ', 'Beta', ' beta '],
      aliases: [' Current Alias ', '', 'current_alias', 'Second Alias'],
    })).toMatchObject({
      tags: ['Alpha', 'Beta'],
      aliases: ['Current Alias', 'Second Alias'],
    });
  });

  it('限制 tags/aliases 的数量与单项长度', () => {
    expect(() => normalizeMetadataPatch({
      slug: 'current',
      tags: Array.from({ length: MAX_METADATA_TAGS + 1 }, (_, i) => `tag-${i}`),
    })).toThrow(/tags.*32/i);
    expect(() => normalizeMetadataPatch({
      slug: 'current',
      aliases: Array.from({ length: MAX_METADATA_ALIASES + 1 }, (_, i) => `alias-${i}`),
    })).toThrow(/aliases.*32/i);
    expect(() => normalizeMetadataPatch({
      slug: 'current',
      tags: ['t'.repeat(MAX_METADATA_TAG_LENGTH + 1)],
    })).toThrow(/tag.*64/i);
    expect(() => normalizeMetadataPatch({
      slug: 'current',
      aliases: ['a'.repeat(MAX_METADATA_ALIAS_LENGTH + 1)],
    })).toThrow(/alias.*200/i);
  });
});

describe('prepareMetadataPatch', () => {
  const pages = [
    { slug: 'current', title: 'Current Title', aliases: ['Current Alias'] },
    { slug: 'other-page', title: 'Other Title', aliases: ['Legacy Name'] },
  ];

  it.each(['Other_Page', ' other title ', 'legacy_name'])(
    '拒绝与其他页 slug/title/alias 规范化冲突的 alias：%s',
    (alias) => {
      expect(() => prepareMetadataPatch(current, {
        slug: 'current',
        aliases: [alias],
      }, pages)).toThrow(/alias.*conflict.*other-page/i);
    },
  );

  it('当前页自己的 slug/title/alias 不算其他页冲突', () => {
    expect(findMetadataAliasConflicts(
      'current',
      ['current', 'Current Title', 'Current Alias'],
      pages,
    )).toEqual([]);
  });

  it('按固定顺序返回实际 changedFields，并保留系统字段', () => {
    const prepared = prepareMetadataPatch(current, {
      slug: 'current',
      title: ' New Title ',
      summary: ' New summary ',
      tags: ['new-tag'],
      aliases: ['New Alias'],
    }, pages);

    expect(prepared.changedFields).toEqual(['title', 'summary', 'tags', 'aliases']);
    expect(prepared.frontmatter).toEqual({
      ...current,
      title: 'New Title',
      summary: 'New summary',
      tags: ['new-tag'],
      aliases: ['New Alias'],
    });
    expect(prepared.frontmatter.created).toBe(current.created);
    expect(prepared.frontmatter.updated).toBe(current.updated);
    expect(prepared.frontmatter.sources).toBe(current.sources);
  });

  it('规范化后没有实际变化时拒绝空操作', () => {
    expect(() => prepareMetadataPatch(current, {
      slug: 'current',
      title: ' Current Title ',
      summary: ' Current summary ',
      tags: ['alpha', 'Beta'],
      aliases: ['Current Alias'],
    }, pages)).toThrow(/no actual metadata changes/i);
  });
});
