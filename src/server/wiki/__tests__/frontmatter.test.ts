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
