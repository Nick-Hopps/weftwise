import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;
let prevVault: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lint-det-'));
  prevDb = process.env.DATABASE_PATH;
  prevVault = process.env.VAULT_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  process.env.VAULT_PATH = join(dir, 'vault'); // 空 vault → 无 frontmatter/stale 噪声
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  process.env.VAULT_PATH = prevVault;
  rmSync(dir, { recursive: true, force: true });
});

const NOW = '2026-01-01T00:00:00Z';

function page(subjectId: string, slug: string) {
  return {
    subjectId,
    slug,
    title: slug.toUpperCase(),
    path: `${subjectId}/${slug}.md`,
    summary: '',
    contentHash: 'h',
    tags: [] as string[],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function setup() {
  const subjectsRepo = await import('@/server/db/repos/subjects-repo');
  const pagesRepo = await import('@/server/db/repos/pages-repo');
  const s = subjectsRepo.create({ slug: 's-lint', name: 'S' });
  const s2 = subjectsRepo.create({ slug: 's2-lint', name: 'S2' });

  pagesRepo.upsertPage(page(s.id, 'a'));
  pagesRepo.upsertPage(page(s.id, 'b'));
  pagesRepo.upsertPage(page(s.id, 'c'));

  // a → b（存在，正常）；a → ghost（不存在，broken）
  pagesRepo.setLinksForPage(s.id, 'a', [
    { targetSubjectId: s.id, targetSlug: 'b', context: '[[B]]' },
    { targetSubjectId: s.id, targetSlug: 'ghost', context: '[[ghost]]' },
  ]);
  // 跨主题入链：s2 的页 x → s:c（c 因此不是 orphan）
  pagesRepo.setLinksForPage(s2.id, 'x', [
    { targetSubjectId: s.id, targetSlug: 'c', context: '[[s-lint:c]]' },
  ]);

  const { runDeterministicChecksForSubject } = await import('../lint-deterministic');
  return { run: () => runDeterministicChecksForSubject(s) };
}

describe('runDeterministicChecksForSubject', () => {
  it('broken-link：本主题指向不存在页报，指向存在页不报', async () => {
    const { run } = await setup();
    const broken = run().filter((f) => f.type === 'broken-link');
    expect(broken.map((f) => f.pageSlug)).toContain('a');
    expect(broken.some((f) => f.description.includes('ghost'))).toBe(true);
    expect(broken.some((f) => f.description.includes('[[b]]'))).toBe(false);
  });

  it('orphan：无入链页报；有本主题或跨主题入链的页不报', async () => {
    const { run } = await setup();
    const orphans = run()
      .filter((f) => f.type === 'orphan')
      .map((f) => f.pageSlug);
    expect(orphans).toContain('a'); // 无入链
    expect(orphans).not.toContain('b'); // 本主题入链 a→b
    expect(orphans).not.toContain('c'); // 跨主题入链 s2:x→c → 证明 orphan 用的是跨主题 allLinks
  });
});
