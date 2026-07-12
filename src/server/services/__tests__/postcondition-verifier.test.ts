import { describe, expect, it } from 'vitest';
import type {
  PostconditionScope,
  Subject,
  WikiLink,
  WikiPage,
} from '@/lib/contracts';
import type { PageSourceIntegrityRow } from '@/server/db/repos/sources-repo';
import {
  verifyDeterministicPostconditions,
  type PostconditionSnapshot,
} from '../postcondition-verifier';

const subject: Subject = {
  id: 's1',
  slug: 'general',
  name: 'General',
  description: '',
  augmentationLevel: 'standard',
  createdAt: '2026-07-12T00:00:00.000Z',
  updatedAt: '2026-07-12T00:00:00.000Z',
};

function page(subjectId: string, slug: string, tags: string[] = []): WikiPage {
  return {
    subjectId,
    slug,
    title: slug,
    path: `wiki/${subjectId}/${slug}.md`,
    summary: '',
    contentHash: `hash-${subjectId}-${slug}`,
    tags,
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  };
}

function link(
  subjectId: string,
  sourceSlug: string,
  targetSubjectId: string,
  targetSlug: string,
): WikiLink {
  return { subjectId, sourceSlug, targetSubjectId, targetSlug, context: '' };
}

function scope(overrides: Partial<PostconditionScope> = {}): PostconditionScope {
  return {
    jobId: 'job-1',
    subjectId: 's1',
    createdSlugs: [],
    updatedSlugs: [],
    deletedSlugs: [],
    touchedSlugs: [],
    operationIds: ['op-1'],
    ...overrides,
  };
}

function snapshot(overrides: Partial<PostconditionSnapshot> = {}): PostconditionSnapshot {
  return { pages: [], links: [], pageSources: [], ...overrides };
}

describe('verifyDeterministicPostconditions', () => {
  it('定向报告 broken link、删除页悬空入链、provenance 与新 orphan', () => {
    const findings = verifyDeterministicPostconditions(
      subject,
      scope({
        createdSlugs: ['new-page'],
        updatedSlugs: ['edited'],
        deletedSlugs: ['deleted-page'],
        touchedSlugs: ['new-page', 'edited', 'deleted-page'],
      }),
      snapshot({
        pages: [
          page('s1', 'edited'),
          page('s1', 'new-page'),
          page('s1', 'unrelated'),
          page('s2', 'foreign-source'),
        ],
        links: [
          link('s1', 'edited', 's1', 'missing-target'),
          link('s2', 'foreign-source', 's1', 'deleted-page'),
          link('s1', 'unrelated', 's1', 'historical-missing'),
        ],
        pageSources: [
          {
            subjectId: 's1',
            pageSlug: 'deleted-page',
            sourceId: 'src-1',
            pageExists: false,
            sourceSubjectId: 's1',
          },
        ],
      }),
    );

    expect(findings.map((finding) => finding.type)).toEqual([
      'broken-link',
      'dangling-incoming-link',
      'dangling-page-source',
      'orphan-page',
    ]);
    expect(
      findings.every((finding) => !finding.description.includes('historical-missing')),
    ).toBe(true);
  });

  it('已存在目标不报 broken，有跨主题入链的新页不报 orphan，meta 页跳过', () => {
    const findings = verifyDeterministicPostconditions(
      subject,
      scope({
        createdSlugs: ['linked-new', 'index'],
        updatedSlugs: ['edited'],
        touchedSlugs: ['linked-new', 'index', 'edited'],
      }),
      snapshot({
        pages: [
          page('s1', 'linked-new'),
          page('s1', 'index', ['meta']),
          page('s1', 'edited'),
          page('s1', 'existing-target'),
          page('s2', 'foreign-source'),
        ],
        links: [
          link('s1', 'edited', 's1', 'existing-target'),
          link('s2', 'foreign-source', 's1', 'linked-new'),
        ],
      }),
    );

    expect(findings).toEqual([]);
  });

  it('检测受影响页的跨主题 broken target', () => {
    const findings = verifyDeterministicPostconditions(
      subject,
      scope({ updatedSlugs: ['edited'], touchedSlugs: ['edited'] }),
      snapshot({
        pages: [page('s1', 'edited')],
        links: [link('s1', 'edited', 's2', 'missing-foreign')],
      }),
    );

    expect(findings).toEqual([
      expect.objectContaining({
        type: 'broken-link',
        pageSlug: 'edited',
        relatedSlugs: ['missing-foreign'],
      }),
    ]);
  });

  it('检测 source 缺失与 source Subject 错配并稳定去重排序', () => {
    const rows: PageSourceIntegrityRow[] = [
      {
        subjectId: 's1',
        pageSlug: 'edited',
        sourceId: 'missing',
        pageExists: true,
        sourceSubjectId: null,
      },
      {
        subjectId: 's1',
        pageSlug: 'edited',
        sourceId: 'foreign',
        pageExists: true,
        sourceSubjectId: 's2',
      },
    ];
    const currentScope = scope({ updatedSlugs: ['edited'], touchedSlugs: ['edited'] });
    const currentSnapshot = snapshot({
      pages: [page('s1', 'edited')],
      pageSources: [...rows, rows[0]],
    });

    const first = verifyDeterministicPostconditions(subject, currentScope, currentSnapshot);
    const second = verifyDeterministicPostconditions(subject, currentScope, currentSnapshot);

    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(first.map((finding) => finding.description)).toEqual([
      expect.stringContaining('foreign'),
      expect.stringContaining('missing'),
    ]);
  });

  it('空 scope 不读取历史问题并返回空数组', () => {
    expect(
      verifyDeterministicPostconditions(
        subject,
        scope({ operationIds: [] }),
        snapshot({
          pages: [page('s1', 'historical')],
          links: [link('s1', 'historical', 's1', 'missing')],
        }),
      ),
    ).toEqual([]);
  });
});
