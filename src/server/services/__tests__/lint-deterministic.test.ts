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

describe('checkOrphanSources', () => {
  async function setupOrphans() {
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    const jobsRepo = await import('@/server/db/repos/jobs-repo');
    const { getRawDb } = await import('@/server/db/client');
    const db = getRawDb();
    const s = subjectsRepo.create({ slug: 's-orph', name: 'S' });

    const insSrc = db.prepare(
      `INSERT INTO sources (id, subject_id, filename, content_hash, parsed_at, metadata_json)
       VALUES (?,?,?,?,?,?)`
    );
    // 五个 source，全部零 page_sources 关联，job 状态各不同
    insSrc.run('src-failed', s.id, 'failed.md', 'h1', null, '{}');
    insSrc.run('src-running', s.id, 'running.md', 'h2', null, '{}');
    insSrc.run('src-pending', s.id, 'pending.md', 'h3', null, '{}');
    insSrc.run('src-nojob', s.id, 'nojob.md', 'h4', null, '{}');
    insSrc.run('src-done', s.id, 'done.md', 'h5', null, '{}');
    // 第六个 source 已被页面引用 → 不进候选
    insSrc.run('src-linked', s.id, 'linked.md', 'h6', null, '{}');
    db.prepare(`INSERT INTO page_sources (subject_id, page_slug, source_id) VALUES (?,?,?)`)
      .run(s.id, 'some-page', 'src-linked');

    const mkJob = (sourceId: string, filename: string, status: string) => {
      const j = jobsRepo.enqueueJob('ingest', { sourceId, filename, subjectId: s.id }, s.id);
      db.prepare(`UPDATE jobs SET status = ? WHERE id = ?`).run(status, j.id);
      return j;
    };
    const failedJob = mkJob('src-failed', 'failed.md', 'failed');
    mkJob('src-running', 'running.md', 'running');
    mkJob('src-pending', 'pending.md', 'pending');
    mkJob('src-done', 'done.md', 'completed');

    const { checkOrphanSources } = await import('@/server/services/lint-deterministic');
    return { s, failedJob, checkOrphanSources };
  }

  it('failed job → 报 finding 且带 failedJobId', async () => {
    const { s, failedJob, checkOrphanSources } = await setupOrphans();
    const findings = checkOrphanSources(s);
    const f = findings.find((x) => x.sourceId === 'src-failed');
    expect(f).toBeDefined();
    expect(f!.type).toBe('orphan-source');
    expect(f!.severity).toBe('warning');
    expect(f!.pageSlug).toBe('');
    expect(f!.sourceFilename).toBe('failed.md');
    expect(f!.failedJobId).toBe(failedJob.id);
  });

  it('pending / running job → 跳过（在途，正常）', async () => {
    const { s, checkOrphanSources } = await setupOrphans();
    const findings = checkOrphanSources(s);
    expect(findings.find((x) => x.sourceId === 'src-running')).toBeUndefined();
    expect(findings.find((x) => x.sourceId === 'src-pending')).toBeUndefined();
  });

  it('查无 job → 报 finding 且 failedJobId 为 null', async () => {
    const { s, checkOrphanSources } = await setupOrphans();
    const f = checkOrphanSources(s).find((x) => x.sourceId === 'src-nojob');
    expect(f).toBeDefined();
    expect(f!.failedJobId).toBeNull();
  });

  it('completed 但零关联 → 报 finding（溯源丢失）且 failedJobId 为 null', async () => {
    const { s, checkOrphanSources } = await setupOrphans();
    const f = checkOrphanSources(s).find((x) => x.sourceId === 'src-done');
    expect(f).toBeDefined();
    expect(f!.failedJobId).toBeNull();
    expect(f!.description).toContain('completed');
  });

  it('已被页面引用的 source 不报', async () => {
    const { s, checkOrphanSources } = await setupOrphans();
    expect(checkOrphanSources(s).find((x) => x.sourceId === 'src-linked')).toBeUndefined();
  });

  it('并入 runDeterministicChecksForSubject 输出', async () => {
    const { s } = await setupOrphans();
    const { runDeterministicChecksForSubject } = await import('@/server/services/lint-deterministic');
    const all = runDeterministicChecksForSubject(s);
    expect(all.filter((x) => x.type === 'orphan-source').length).toBe(3); // failed + nojob + done
  });
});

describe('checkThinPages', () => {
  const FM = (sources: string[]) => [
    '---',
    'title: T',
    "created: '2026-01-01T00:00:00.000Z'",
    "updated: '2026-01-01T00:00:00.000Z'",
    'tags: []',
    sources.length ? `sources:\n${sources.map((s) => `  - ${s}`).join('\n')}` : 'sources: []',
    '---',
    '',
  ].join('\n');

  async function setupThin() {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    const s = subjectsRepo.create({ slug: 's-thin', name: 'S' });
    const wikiDir = join(process.env.VAULT_PATH!, 'wiki', 's-thin');
    mkdirSync(wikiDir, { recursive: true });
    const write = (slug: string, fm: string, body: string) =>
      writeFileSync(join(wikiDir, `${slug}.md`), `${fm}${body}\n`);

    write('stub', FM([]), '# 短 stub\n\n一小段占位内容。');
    write('short-but-sourced', FM(['a.md']), '# 短但有来源\n\n一小段内容。');
    write('long-enough', FM([]), `# 长页\n\n${'内容充实。'.repeat(200)}`);
    write('index', FM([]), '# 目录\n\n- 短。');

    const { checkThinPages, runDeterministicChecksForSubject } = await import(
      '@/server/services/lint-deterministic'
    );
    return { s, checkThinPages, runDeterministicChecksForSubject };
  }

  it('正文过短且零来源 → 报 thin-page（info）', async () => {
    const { s, checkThinPages } = await setupThin();
    const f = checkThinPages(s).find((x) => x.pageSlug === 'stub');
    expect(f).toBeDefined();
    expect(f!.type).toBe('thin-page');
    expect(f!.severity).toBe('info');
  });

  it('短但有来源的页不报；正文足长的页不报；meta 页（index）跳过', async () => {
    const { s, checkThinPages } = await setupThin();
    const slugs = checkThinPages(s).map((f) => f.pageSlug);
    expect(slugs).not.toContain('short-but-sourced');
    expect(slugs).not.toContain('long-enough');
    expect(slugs).not.toContain('index');
  });

  it('并入 runDeterministicChecksForSubject 输出', async () => {
    const { s, runDeterministicChecksForSubject } = await setupThin();
    const all = runDeterministicChecksForSubject(s);
    expect(all.some((f) => f.type === 'thin-page' && f.pageSlug === 'stub')).toBe(true);
  });
});
