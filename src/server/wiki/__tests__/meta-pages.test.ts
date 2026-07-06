import { describe, expect, it } from 'vitest';
import {
  renderIndexPage,
  renderLogPage,
  parseLogEntries,
  buildIngestLogEntry,
  resolveTemplateLang,
  MAX_LOG_ENTRIES,
  type IndexPageEntry,
} from '../meta-pages';
import { parseFrontmatter } from '../frontmatter';

describe('resolveTemplateLang', () => {
  it('detects Chinese from common wikiLanguage values', () => {
    expect(resolveTemplateLang('Chinese')).toBe('zh');
    expect(resolveTemplateLang('中文')).toBe('zh');
    expect(resolveTemplateLang('简体中文')).toBe('zh');
  });

  it('falls back to English for anything else', () => {
    expect(resolveTemplateLang('English')).toBe('en');
    expect(resolveTemplateLang('Japanese')).toBe('en');
    expect(resolveTemplateLang('')).toBe('en');
  });
});

describe('renderIndexPage', () => {
  const subjectSlug = 'general';

  it('groups pages by first tag, sorts groups and entries, tags-less pages fall into Uncategorized', () => {
    const pages: IndexPageEntry[] = [
      { slug: 'b-page', title: 'B Page', summary: 'about b', tags: ['alpha'] },
      { slug: 'a-page', title: 'A Page', summary: 'about a', tags: ['alpha'] },
      { slug: 'z-page', title: 'Z Page', summary: '', tags: [] },
      { slug: 'c-page', title: 'C Page', summary: 'about c', tags: ['beta'] },
    ];
    const md = renderIndexPage(pages, { subjectSlug, subjectName: 'General', language: 'en' });
    const { data, body } = parseFrontmatter(md);
    expect(data.title).toContain('Index');
    expect(data.tags).toEqual(['meta']);

    // group order: alpha, beta, then Uncategorized last
    const alphaIdx = body.indexOf('## alpha');
    const betaIdx = body.indexOf('## beta');
    const uncatIdx = body.indexOf('## Uncategorized');
    expect(alphaIdx).toBeGreaterThanOrEqual(0);
    expect(betaIdx).toBeGreaterThan(alphaIdx);
    expect(uncatIdx).toBeGreaterThan(betaIdx);

    // within alpha group, A Page before B Page (sorted by title)
    const aIdx = body.indexOf('[[a-page|A Page]]');
    const bIdx = body.indexOf('[[b-page|B Page]]');
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThan(aIdx);

    expect(body).toContain('[[a-page|A Page]] — about a');
    expect(body).toContain('[[z-page|Z Page]]');
  });

  it('renders an empty-but-valid index page for a subject with no pages', () => {
    const md = renderIndexPage([], { subjectSlug, subjectName: 'General', language: 'en' });
    const { data, body } = parseFrontmatter(md);
    expect(data.title).toContain('Index');
    expect(body.trim().length).toBeGreaterThan(0);
  });

  it('uses zh template strings when language=zh', () => {
    const md = renderIndexPage(
      [{ slug: 'a', title: 'A', summary: '', tags: [] }],
      { subjectSlug, subjectName: 'General', language: 'zh' },
    );
    const { body } = parseFrontmatter(md);
    expect(body).toContain('未分类');
  });

  it('never produces duplicate slugs and preserves all input pages', () => {
    const pages: IndexPageEntry[] = Array.from({ length: 5 }, (_, i) => ({
      slug: `p${i}`,
      title: `P${i}`,
      summary: '',
      tags: i % 2 === 0 ? ['even'] : ['odd'],
    }));
    const md = renderIndexPage(pages, { subjectSlug, subjectName: 'General', language: 'en' });
    for (const p of pages) {
      expect(md).toContain(`[[${p.slug}|${p.title}]]`);
    }
  });
});

describe('parseLogEntries + buildIngestLogEntry + renderLogPage', () => {
  it('parseLogEntries extracts bullet lines from an existing log body', () => {
    const existing = '---\ntitle: General — Change Log\ntags: [meta]\n---\n# Change Log\n\n- entry one\n- entry two\n';
    expect(parseLogEntries(existing)).toEqual(['entry one', 'entry two']);
  });

  it('parseLogEntries returns [] for null/empty input', () => {
    expect(parseLogEntries(null)).toEqual([]);
  });

  it('buildIngestLogEntry formats filenames and page count', () => {
    const line = buildIngestLogEntry([{ filename: 'doc.txt' }], 3);
    expect(line).toBe('ingested "doc.txt": 3 page(s)');
  });

  it('buildIngestLogEntry supports multiple sources', () => {
    const line = buildIngestLogEntry([{ filename: 'a.txt' }, { filename: 'b.md' }], 5);
    expect(line).toBe('ingested "a.txt", "b.md": 5 page(s)');
  });

  it('renderLogPage puts new entries first and preserves order', () => {
    const md = renderLogPage(['new entry', 'old entry 1', 'old entry 2'], {
      subjectSlug: 'general',
      subjectName: 'General',
      language: 'en',
    });
    const { data, body } = parseFrontmatter(md);
    expect(data.title).toContain('Change Log');
    const lines = body.split('\n').filter((l) => l.trim().startsWith('- '));
    expect(lines[0]).toContain('new entry');
    expect(lines[1]).toContain('old entry 1');
    expect(lines[2]).toContain('old entry 2');
  });

  it('renderLogPage truncates to MAX_LOG_ENTRIES, keeping the most recent', () => {
    const entries = Array.from({ length: MAX_LOG_ENTRIES + 10 }, (_, i) => `entry ${i}`);
    const md = renderLogPage(entries, { subjectSlug: 'general', subjectName: 'General', language: 'en' });
    const { body } = parseFrontmatter(md);
    const lines = body.split('\n').filter((l) => l.trim().startsWith('- '));
    expect(lines).toHaveLength(MAX_LOG_ENTRIES);
    expect(lines[0]).toContain('entry 0');
    expect(lines[MAX_LOG_ENTRIES - 1]).toContain(`entry ${MAX_LOG_ENTRIES - 1}`);
  });
});
