import { describe, expect, it } from 'vitest';
import { buildWebSourceImports, filenameFromUrl } from '../ingest-service';
import type { CitedSource } from '../../agents/types';

describe('filenameFromUrl', () => {
  it('derives safe .md filename from url with host + hash', () => {
    const f = filenameFromUrl('https://en.wikipedia.org/wiki/Quicksort');
    expect(f).toMatch(/^web-en\.wikipedia\.org-quicksort-[0-9a-f]{8}\.md$/);
  });
  it('falls back gracefully on unparseable url', () => {
    expect(filenameFromUrl('not a url')).toMatch(/^web-page-[0-9a-f]{8}\.md$/);
  });
});

describe('buildWebSourceImports', () => {
  const cites: CitedSource[] = [
    { url: 'https://a.com/x', title: 'A', citedBy: ['p1', 'p2'], fallbackContent: 'snippet-a' },
  ];

  it('uses extracted content when available, builds links + extraStagePaths', () => {
    const plan = buildWebSourceImports({
      cites,
      subjectSlug: 'general',
      contentFor: (url) => (url === 'https://a.com/x' ? 'FULL EXTRACTED' : null),
      saveSource: (filename, content) => {
        expect(content).toContain('FULL EXTRACTED');
        return { id: 'src-1', filename };
      },
    });
    expect(plan.links).toEqual([{ sourceId: 'src-1', pageSlugs: ['p1', 'p2'] }]);
    expect(plan.extraStagePaths).toEqual([
      `raw/general/${plan.filenames[0]}`,
      `.llm-wiki/sources/general/src-1.json`,
    ]);
  });

  it('falls back to snippet when no extracted content', () => {
    const plan = buildWebSourceImports({
      cites,
      subjectSlug: 'general',
      contentFor: () => null, // extract failed
      saveSource: (filename, content) => {
        expect(content).toContain('snippet-a');
        return { id: 'src-1', filename };
      },
    });
    expect(plan.links).toHaveLength(1);
  });

  it('skips a source whose saveSource throws (does not abort others)', () => {
    const many: CitedSource[] = [
      { url: 'https://bad.com', title: 'Bad', citedBy: ['p1'], fallbackContent: 's' },
      { url: 'https://ok.com', title: 'Ok', citedBy: ['p1'], fallbackContent: 's' },
    ];
    const plan = buildWebSourceImports({
      cites: many,
      subjectSlug: 'general',
      contentFor: () => 'c',
      saveSource: (filename, _content, url) => {
        if (url === 'https://bad.com') throw new Error('bad filename');
        return { id: 'src-ok', filename };
      },
    });
    expect(plan.links).toEqual([{ sourceId: 'src-ok', pageSlugs: ['p1'] }]);
  });
});
