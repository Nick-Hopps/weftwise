import { describe, expect, it } from 'vitest';

import { CURATE_AGENTIC_SYSTEM_PROMPT, buildCurateAgenticUserPrompt } from '../curate-prompt';

describe('CURATE_AGENTIC_SYSTEM_PROMPT', () => {
  it('列出结构写与两个窄写工具，且强调保守 + 无人确认', () => {
    for (const t of [
      'wiki_merge', 'wiki_split', 'wiki_delete', 'wiki_create', 'wiki_read',
      'wiki_metadata_patch', 'wiki_link_ensure', 'wiki_patch',
    ]) {
      expect(CURATE_AGENTIC_SYSTEM_PROMPT).toContain(t);
    }
    expect(CURATE_AGENTIC_SYSTEM_PROMPT).toMatch(/conservative/i);
    expect(CURATE_AGENTIC_SYSTEM_PROMPT).toMatch(/no human|NO human/);
    expect(CURATE_AGENTIC_SYSTEM_PROMPT).toMatch(/index|log/);
    expect(CURATE_AGENTIC_SYSTEM_PROMPT).not.toContain('wiki_list');
  });

  it('窄写要求先读、唯一自然锚点、target 只验证且禁止 Related 段', () => {
    expect(CURATE_AGENTIC_SYSTEM_PROMPT).toMatch(/wiki_read[\s\S]*(unique|uniquely)[\s\S]*natural anchor/i);
    expect(CURATE_AGENTIC_SYSTEM_PROMPT).toMatch(/target[\s\S]*(validation|verify|verified)[\s\S]*source page/i);
    expect(CURATE_AGENTIC_SYSTEM_PROMPT).toMatch(/(never|do not)[\s\S]*(append|create|add)[\s\S]*Related/i);
  });

  it('metadata patch 仅允许四个 metadata 字段且不得改正文', () => {
    for (const field of ['title', 'summary', 'tags', 'aliases']) {
      expect(CURATE_AGENTIC_SYSTEM_PROMPT).toContain(field);
    }
    expect(CURATE_AGENTIC_SYSTEM_PROMPT).toMatch(/metadata[\s\S]*(only|ONLY)[\s\S]*(body|prose)[\s\S]*(unchanged|never)/i);
  });
});

describe('buildCurateAgenticUserPrompt', () => {
  const pages = [{ slug: 'a', title: 'A', summary: 's', tags: ['t'], bodyChars: 100 }];
  const ctx = { language: 'English', subject: { slug: 'general', name: 'G', description: '' } };
  it('列出 scope 页 + auto 模式禁建/禁删提示', () => {
    const auto = buildCurateAgenticUserPrompt(pages, ctx, { auto: true });
    expect(auto).toContain('`a`');
    expect(auto).toMatch(/AUTOMATIC/);
    expect(auto).toMatch(/do NOT create or delete/i);
    expect(auto).not.toMatch(/delete redundant pages/i);
  });
  it('manual 模式无禁建页提示', () => {
    const manual = buildCurateAgenticUserPrompt(pages, ctx, { auto: false });
    expect(manual).toMatch(/MANUAL/);
    expect(manual).not.toMatch(/do NOT create/i);
    expect(manual).toMatch(/delete redundant pages/i);
  });

  describe('orphan worklist 注入', () => {
    const orphans = [{
      pageSlug: 'mongol-empire',
      description: 'Orphan page: "mongol-empire" in subject "world-history" has no inbound links.',
      suggestedFix: 'Link to this page from at least one related page.',
    }];

    it('注入 assignment 段，含孤页 slug 与 description', () => {
      const out = buildCurateAgenticUserPrompt(pages, ctx, { auto: true, orphans });
      expect(out).toMatch(/assignment/i);
      expect(out).toContain('`mongol-empire`');
      expect(out).toContain('has no inbound links');
      expect(out).toContain('Link to this page from at least one related page.');
    });

    it('assignment 段出现在 Pages 清单之前', () => {
      const out = buildCurateAgenticUserPrompt(pages, ctx, { auto: true, orphans });
      expect(out.search(/assignment/i)).toBeLessThan(out.indexOf('## Pages'));
    });

    it('给出两条路的优先级：先 link_ensure，无锚点才 patch 补一句', () => {
      const out = buildCurateAgenticUserPrompt(pages, ctx, { auto: true, orphans });
      expect(out).toContain('wiki_link_ensure');
      expect(out).toContain('wiki_patch');
      // link_ensure 必须先于 patch 出现（优先级即顺序）
      expect(out.indexOf('wiki_link_ensure')).toBeLessThan(out.indexOf('wiki_patch'));
      expect(out).toMatch(/prefer|first|preferred/i);
    });

    it('补句纪律：一句、含目标链接、不建 Related、不改写周边', () => {
      const out = buildCurateAgenticUserPrompt(pages, ctx, { auto: true, orphans });
      expect(out).toMatch(/(one|single) sentence/i);
      expect(out).toMatch(/\[\[/);
      expect(out).toMatch(/Related/);
      expect(out).toMatch(/(do not|never)[\s\S]{0,120}rewrit/i);
    });

    it('说明候选源页已含语义检索结果、须先 read 再定落点', () => {
      const out = buildCurateAgenticUserPrompt(pages, ctx, { auto: true, orphans });
      expect(out).toMatch(/wiki_read/);
      expect(out).toMatch(/(search|retriev|semantic)/i);
    });

    it('不注入 finding ID', () => {
      const out = buildCurateAgenticUserPrompt(pages, ctx, {
        auto: true,
        orphans,
      });
      expect(out).not.toMatch(/[0-9a-f]{64}/);
    });

    it('缺省 / 空数组时输出与不带 orphans 逐字节相同', () => {
      const baseline = buildCurateAgenticUserPrompt(pages, ctx, { auto: true });
      expect(buildCurateAgenticUserPrompt(pages, ctx, { auto: true, orphans: [] }))
        .toBe(baseline);
      expect(buildCurateAgenticUserPrompt(pages, ctx, { auto: true, orphans: undefined }))
        .toBe(baseline);

      const manualBaseline = buildCurateAgenticUserPrompt(pages, ctx, { auto: false });
      expect(buildCurateAgenticUserPrompt(pages, ctx, { auto: false, orphans: [] }))
        .toBe(manualBaseline);
    });

    it('注入后仍保留 auto 模式的禁建/禁删提示', () => {
      const out = buildCurateAgenticUserPrompt(pages, ctx, { auto: true, orphans });
      expect(out).toMatch(/AUTOMATIC/);
      expect(out).toMatch(/do NOT create or delete/i);
      expect(out).toContain('`a`');
    });

    it('多条孤页逐条列出并报数', () => {
      const out = buildCurateAgenticUserPrompt(pages, ctx, {
        auto: true,
        orphans: [
          orphans[0],
          { pageSlug: 'black-death', description: 'Orphan page: "black-death" …', suggestedFix: null },
        ],
      });
      expect(out).toContain('`mongol-empire`');
      expect(out).toContain('`black-death`');
      expect(out).toMatch(/2 orphan/i);
    });
  });
});
