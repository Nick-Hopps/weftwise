import { describe, expect, it } from 'vitest';
import type { LintResult } from '../../llm/prompts/lint-prompt';
import { validateSemanticFindings } from '../lint-semantic-validation';

const pages = [
  {
    slug: 'source-page',
    title: 'Source Page',
    content: 'The Render Graph schedules GPU work. See [[Other Page]] for context.',
  },
  {
    slug: 'render-graph',
    title: 'Render Graph',
    content: 'A render graph orders rendering passes.',
  },
  {
    slug: 'other-page',
    title: 'Other Page',
    content: 'Frame pacing depends on swap timing.',
  },
];

function findings(...items: LintResult['findings']): LintResult['findings'] {
  return items;
}

describe('validateSemanticFindings', () => {
  it('保留有精确证据且目标页存在的 missing-crossref', () => {
    const result = validateSemanticFindings(findings({
      type: 'missing-crossref',
      severity: 'warning',
      pageSlug: 'source-page',
      targetSlug: 'render-graph',
      evidence: [{ pageSlug: 'source-page', quote: 'The Render Graph schedules GPU work.' }],
      description: 'Render Graph is mentioned without a wikilink.',
      suggestedFix: 'Link the mention to [[Render Graph]].',
    }), pages, 'game-development');

    expect(result).toEqual([expect.objectContaining({
      pageSlug: 'source-page',
      targetSlug: 'render-graph',
    })]);
  });

  it('拒绝 quote 不是页面原文字面片段的 finding', () => {
    const result = validateSemanticFindings(findings({
      type: 'missing-crossref',
      severity: 'warning',
      pageSlug: 'source-page',
      targetSlug: 'render-graph',
      evidence: [{ pageSlug: 'source-page', quote: 'A paraphrase not present in the page.' }],
      description: 'Missing link.',
      suggestedFix: 'Add a link.',
    }), pages, 'game-development');

    expect(result).toEqual([]);
  });

  it('拒绝当前已经存在 wikilink 的 missing-crossref', () => {
    const result = validateSemanticFindings(findings({
      type: 'missing-crossref',
      severity: 'warning',
      pageSlug: 'source-page',
      targetSlug: 'other-page',
      evidence: [{ pageSlug: 'source-page', quote: '[[Other Page]]' }],
      description: 'Other Page is not linked.',
      suggestedFix: 'Add a link.',
    }), pages, 'game-development');

    expect(result).toEqual([]);
  });

  it('把页面历史 alias 解析为 canonical target，避免误报缺链', () => {
    const pagesWithAliasLink = pages.map((page) => page.slug === 'source-page'
      ? { ...page, content: `${page.content} Also see [[Legacy Render Graph]].` }
      : page);
    const result = validateSemanticFindings(findings({
      type: 'missing-crossref',
      severity: 'warning',
      pageSlug: 'source-page',
      targetSlug: 'render-graph',
      evidence: [{ pageSlug: 'source-page', quote: '[[Legacy Render Graph]]' }],
      description: 'Render Graph is mentioned without a wikilink.',
      suggestedFix: 'Add a link.',
    }), pagesWithAliasLink, 'game-development', new Map([
      ['legacy-render-graph', 'render-graph'],
    ]));

    expect(result).toEqual([]);
  });

  it('拒绝目标页已经存在或不足两个独立证据页的 coverage-gap', () => {
    const existingTarget = {
      type: 'coverage-gap',
      severity: 'warning',
      pageSlug: 'source-page',
      targetSlug: 'render-graph',
      evidence: [
        { pageSlug: 'source-page', quote: 'Render Graph' },
        { pageSlug: 'render-graph', quote: 'render graph' },
      ],
      description: 'Render Graph needs a page.',
      suggestedFix: 'Create it.',
    } satisfies LintResult['findings'][number];
    const oneEvidencePage = {
      ...existingTarget,
      targetSlug: 'frame-pacing-guide',
      evidence: [
        { pageSlug: 'other-page', quote: 'Frame pacing' },
        { pageSlug: 'other-page', quote: 'swap timing' },
      ],
    };

    expect(validateSemanticFindings(findings(existingTarget), pages, 'game-development')).toEqual([]);
    expect(validateSemanticFindings(findings(oneEvidencePage), pages, 'game-development')).toEqual([]);
  });

  it('保留有两个独立原文证据页且尚无目标页的 coverage-gap', () => {
    const result = validateSemanticFindings(findings({
      type: 'coverage-gap',
      severity: 'warning',
      pageSlug: 'source-page',
      targetSlug: 'gpu-frame-pacing',
      evidence: [
        { pageSlug: 'source-page', quote: 'GPU work' },
        { pageSlug: 'other-page', quote: 'Frame pacing' },
      ],
      description: 'GPU frame pacing is discussed on multiple pages without its own page.',
      suggestedFix: 'Create a GPU frame pacing page.',
    }), pages, 'game-development');

    expect(result).toEqual([expect.objectContaining({ targetSlug: 'gpu-frame-pacing' })]);
  });

  it('contradiction 必须包含两个不同页面的精确引文', () => {
    const valid = {
      type: 'contradiction',
      severity: 'critical',
      pageSlug: 'source-page',
      targetSlug: null,
      evidence: [
        { pageSlug: 'source-page', quote: 'The Render Graph schedules GPU work.' },
        { pageSlug: 'other-page', quote: 'Frame pacing depends on swap timing.' },
      ],
      description: 'The scheduling claims conflict.',
      suggestedFix: null,
    } satisfies LintResult['findings'][number];

    expect(validateSemanticFindings(findings(valid), pages, 'game-development')).toHaveLength(1);
    expect(validateSemanticFindings(findings({
      ...valid,
      evidence: [
        { pageSlug: 'source-page', quote: 'The Render Graph schedules GPU work.' },
        { pageSlug: 'source-page', quote: 'GPU work' },
      ],
    }), pages, 'game-development')).toEqual([]);
  });
});
