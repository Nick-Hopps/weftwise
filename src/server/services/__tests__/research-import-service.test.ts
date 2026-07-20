import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job } from '@/lib/contracts';

let dir: string;
let previousDb: string | undefined;
let previousVault: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'research-import-service-'));
  previousDb = process.env.DATABASE_PATH;
  previousVault = process.env.VAULT_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  process.env.VAULT_PATH = join(dir, 'vault');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = previousDb;
  process.env.VAULT_PATH = previousVault;
  rmSync(dir, { recursive: true, force: true });
});

async function setup(urls = ['https://example.com/a']) {
  const subjectsRepo = await import('../../db/repos/subjects-repo');
  const provenance = await import('../research-provenance');
  const repo = await import('../../db/repos/research-provenance-repo');
  const queue = await import('../../jobs/queue');
  const subject = subjectsRepo.getBySlug('general')!;
  const candidates = provenance.prepareResearchCandidates(urls.map((url, index) => ({
    url,
    title: `Candidate ${index + 1}`,
    snippet: `snippet ${index + 1}`,
    score: 3 as const,
    reason: null,
  })));
  const stored = repo.persistResearchRun({
    subjectId: subject.id,
    researchJobId: 'research-job',
    origin: 'topic',
    lintJobId: null,
    topic: 'topic',
    topics: ['topic'],
    queries: ['query'],
    findings: [],
    candidates,
  });
  const approved = repo.approveResearchRunAtomic({
    runId: stored.run.id,
    subjectId: subject.id,
    candidateIds: stored.candidates.map((candidate) => candidate.id),
    expectedVersion: 1,
    idempotencyKey: 'approve-import',
  });
  const coordinator = queue.get(approved.coordinatorJobId)!;
  return { subject, repo, queue, stored: approved.stored, coordinator };
}

describe('runResearchImportJob', () => {
  it('只从服务端 candidate snapshot 读取 URL，并原子创建 source、child ingest 与 queued delivery', async () => {
    const { subject, repo, queue, stored, coordinator } = await setup();
    const service = await import('../research-import-service');
    const fetch = vi.fn(async (url: string) => ({ filename: 'candidate.html', content: `<p>${url}</p>` }));

    const result = await service.runResearchImportJob(coordinator, vi.fn(), { fetchUrlSource: fetch });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.deliveries).toHaveLength(1);
    const run = repo.findResearchRunById(stored.run.id, subject.id)!;
    expect(run.deliveries[0]).toMatchObject({ status: 'queued', attemptCount: 1 });
    expect(run.deliveries[0]!.sourceId).toBeTruthy();
    expect(run.deliveries[0]!.ingestJobId).toBeTruthy();
    const child = queue.get(run.deliveries[0]!.ingestJobId!)!;
    expect(JSON.parse(child.paramsJson)).toMatchObject({
      researchProvenance: {
        runId: stored.run.id,
        approvalId: stored.approval!.id,
        candidateId: stored.candidates[0]!.id,
      },
      sourceId: run.deliveries[0]!.sourceId,
      subjectId: subject.id,
    });
    const childParams = JSON.parse(child.paramsJson) as { filename: string };
    expect(childParams.filename).toMatch(/^web-example\.com-a-[a-f0-9]{8}\.html$/);
    const source = (await import('../../db/repos/sources-repo')).getSource(run.deliveries[0]!.sourceId!)!;
    expect(JSON.parse(source.metadataJson)).toMatchObject({
      kind: 'url',
      originUrl: 'https://example.com/a',
    });
    expect(existsSync(join(dir, 'vault', 'raw', 'general', source.filename))).toBe(false);
  });

  it('重复执行 coordinator 不重复抓取、source、sidecar 或 child job', async () => {
    const { subject, repo, stored, coordinator } = await setup();
    const service = await import('../research-import-service');
    const { getRawDb } = await import('../../db/client');
    const fetch = vi.fn(async () => ({ filename: 'candidate.html', content: '<p>A</p>' }));

    await service.runResearchImportJob(coordinator, vi.fn(), { fetchUrlSource: fetch });
    await service.runResearchImportJob(coordinator, vi.fn(), { fetchUrlSource: fetch });

    expect(fetch).not.toHaveBeenCalled();
    const sqlite = getRawDb();
    expect(sqlite.prepare('SELECT count(*) AS count FROM sources').get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT count(*) AS count FROM jobs WHERE type = 'ingest'").get())
      .toEqual({ count: 1 });
    expect(repo.findResearchRunById(stored.run.id, subject.id)!.deliveries[0])
      .toMatchObject({ status: 'queued' });
    expect(readdirSync(join(dir, 'vault', '.llm-wiki', 'sources', 'general'))).toHaveLength(1);
  });

  it('已有 sourceId 但缺 child job 时从 source 原子续建，不重复抓取或 sidecar', async () => {
    const { subject, repo, stored, coordinator } = await setup();
    const service = await import('../research-import-service');
    const sourceStore = await import('../../sources/source-store');
    const { getRawDb } = await import('../../db/client');
    const saved = sourceStore.saveUrlSource(subject, 'https://example.com/a');
    getRawDb().prepare(`
      UPDATE research_candidate_ingests SET source_id = ? WHERE run_id = ?
    `).run(saved.id, stored.run.id);
    const fetch = vi.fn();

    await service.runResearchImportJob(coordinator, vi.fn(), { fetchUrlSource: fetch });

    expect(fetch).not.toHaveBeenCalled();
    const delivery = repo.findResearchRunById(stored.run.id, subject.id)!.deliveries[0]!;
    expect(delivery).toMatchObject({ status: 'queued', sourceId: saved.id });
    expect(delivery.ingestJobId).toBeTruthy();
    expect(readdirSync(join(dir, 'vault', '.llm-wiki', 'sources', 'general')))
      .toEqual([`${saved.id}.json`]);
  });

  it('多个候选只创建 URL 引用，不在 coordinator 中抓取', async () => {
    const { subject, repo, stored, coordinator } = await setup([
      'https://example.com/fail',
      'https://example.com/success',
    ]);
    const service = await import('../research-import-service');
    const fetch = vi.fn();

    const result = await service.runResearchImportJob(coordinator, vi.fn(), { fetchUrlSource: fetch });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.deliveries.map((delivery) => delivery.status)).toEqual(['queued', 'queued']);
    const deliveries = repo.findResearchRunById(stored.run.id, subject.id)!.deliveries;
    expect(deliveries.map((delivery) => delivery.status)).toEqual(['queued', 'queued']);
  });

  it('拒绝未知参数、URL 参数与 job/params Subject 不一致', async () => {
    const { coordinator } = await setup();
    const service = await import('../research-import-service');
    const fetch = vi.fn();
    const base = JSON.parse(coordinator.paramsJson) as Record<string, unknown>;

    for (const params of [
      { ...base, url: 'https://attacker.invalid' },
      { ...base, unexpected: true },
      { ...base, subjectId: 'other-subject' },
    ]) {
      const malformed: Job = { ...coordinator, paramsJson: JSON.stringify(params) };
      await expect(service.runResearchImportJob(malformed, vi.fn(), { fetchUrlSource: fetch }))
        .rejects.toThrow(/params|subject/i);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('child job 插入失败时补偿 source/raw/sidecar，delivery 终结为 failed', async () => {
    const { subject, repo, stored, coordinator } = await setup();
    const service = await import('../research-import-service');
    const { getRawDb } = await import('../../db/client');
    const sqlite = getRawDb();
    sqlite.exec(`
      CREATE TRIGGER fail_research_child
      BEFORE INSERT ON jobs WHEN NEW.type = 'ingest'
      BEGIN SELECT RAISE(ABORT, 'child insert failed'); END
    `);

    const fetch = vi.fn();
    const result = await service.runResearchImportJob(coordinator, vi.fn(), { fetchUrlSource: fetch });

    expect(result.deliveries).toEqual([
      expect.objectContaining({ status: 'failed' }),
    ]);
    expect(sqlite.prepare('SELECT count(*) AS count FROM sources').get()).toEqual({ count: 0 });
    expect(repo.findResearchRunById(stored.run.id, subject.id)!.deliveries[0])
      .toMatchObject({ status: 'failed', sourceId: null, ingestJobId: null });
    expect(fetch).not.toHaveBeenCalled();
    const sidecarDir = join(dir, 'vault', '.llm-wiki', 'sources', 'general');
    expect(existsSync(sidecarDir) ? readdirSync(sidecarDir) : []).toEqual([]);
  });
});
