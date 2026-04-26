import { describe, expect, it, vi } from 'vitest';
import { createOverlayVault } from '../overlay-vault';
import type { ChangesetEntry } from '@/lib/contracts';

const fakeFs = { readFileSync: vi.fn() };
const fakeStore = { scanWikiPages: vi.fn() };

vi.mock('node:fs', () => ({
  default: { readFileSync: (...a: unknown[]) => fakeFs.readFileSync(...a) },
  readFileSync: (...a: unknown[]) => fakeFs.readFileSync(...a),
}));
vi.mock('@/server/config/env', () => ({
  vaultPath: (...parts: string[]) => '/vault/' + parts.join('/'),
}));
vi.mock('../../../wiki/wiki-store', () => ({
  scanWikiPages: (...a: unknown[]) => fakeStore.scanWikiPages(...a),
}));

describe('OverlayVault', () => {
  it('reads from overlay first, falls back to fs', async () => {
    fakeFs.readFileSync.mockReturnValue('---\ntitle: Foo\n---\non disk');
    const overlay = createOverlayVault({ subjectSlug: 'general' });
    const r1 = await overlay.readPage('general', 'foo');
    expect(r1?.markdown).toContain('on disk');

    overlay.putEntries([
      { action: 'create', path: 'wiki/general/foo.md', content: '---\ntitle: Foo\n---\nfrom overlay' },
    ] as ChangesetEntry[]);
    const r2 = await overlay.readPage('general', 'foo');
    expect(r2?.markdown).toContain('from overlay');
  });

  it('readPage returns null when both overlay and fs miss', async () => {
    fakeFs.readFileSync.mockImplementation(() => {
      const e = new Error('ENOENT') as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      throw e;
    });
    const overlay = createOverlayVault({ subjectSlug: 'general' });
    expect(await overlay.readPage('general', 'missing')).toBeNull();
  });

  it('snapshot freezes overlay state', async () => {
    fakeFs.readFileSync.mockImplementation(() => {
      const e = new Error('ENOENT') as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      throw e;
    });
    const overlay = createOverlayVault({ subjectSlug: 'general' });
    overlay.putEntries([{ action: 'create', path: 'wiki/general/a.md', content: '---\ntitle: A\n---\nA1' }] as ChangesetEntry[]);
    const snap = overlay.snapshot();
    overlay.putEntries([{ action: 'create', path: 'wiki/general/b.md', content: '---\ntitle: B\n---\nB1' }] as ChangesetEntry[]);
    expect(await snap.readPage('general', 'b')).toBeNull();
    expect((await snap.readPage('general', 'a'))?.markdown).toContain('A1');
  });

  it('search merges overlay entries with store hits', async () => {
    fakeStore.scanWikiPages.mockReturnValue([
      {
        subjectSlug: 'general',
        slug: 'foo',
        relativePath: 'wiki/general/foo.md',
        path: '/vault/wiki/general/foo.md',
        content: '---\ntitle: Foo\nsummary: from store\n---\nbody-foo',
      },
    ]);
    const overlay = createOverlayVault({ subjectSlug: 'general' });
    overlay.putEntries([
      { action: 'create', path: 'wiki/general/bar.md', content: '---\ntitle: Bar\nsummary: overlay summary\n---\nbody-bar' },
    ] as ChangesetEntry[]);
    const results = await overlay.search('general', 'summary');
    const slugs = results.map(r => r.slug).sort();
    expect(slugs).toEqual(['bar', 'foo']);
  });

  it('search prefers overlay over store for same slug', async () => {
    fakeStore.scanWikiPages.mockReturnValue([
      {
        subjectSlug: 'general',
        slug: 'foo',
        relativePath: 'wiki/general/foo.md',
        path: '/vault/wiki/general/foo.md',
        content: '---\ntitle: Old\nsummary: old\n---\nold body',
      },
    ]);
    const overlay = createOverlayVault({ subjectSlug: 'general' });
    overlay.putEntries([
      { action: 'create', path: 'wiki/general/foo.md', content: '---\ntitle: New\nsummary: new\n---\nnew body' },
    ] as ChangesetEntry[]);
    const results = await overlay.search('general', 'foo');
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('overlay');
    expect(results[0].title).toBe('New');
  });
});
