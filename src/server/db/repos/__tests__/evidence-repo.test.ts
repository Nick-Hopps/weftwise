import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evidence-repo-'));
  prev = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

const USER = 'local';

async function setup() {
  const subjectsRepo = await import('../subjects-repo');
  const evidenceRepo = await import('../evidence-repo');
  const subjectId = subjectsRepo.create({ slug: 'ev-subj', name: 'S' }).id;
  return { evidenceRepo, subjectsRepo, subjectId };
}

describe('evidence-repo', () => {
  it('append 后可按页读回，polarity/strength 由 kind 派生', async () => {
    const { evidenceRepo, subjectId } = await setup();

    evidenceRepo.appendEvidence({ userId: USER, subjectId, slug: 'p1', kind: 'quiz-wrong', anchor: 'q1' });
    evidenceRepo.appendEvidence({ userId: USER, subjectId, slug: 'p1', kind: 'page-read' });

    const rows = evidenceRepo.listForPage(USER, subjectId, 'p1');
    expect(rows).toHaveLength(2);

    const wrong = rows.find((r) => r.kind === 'quiz-wrong')!;
    expect(wrong.polarity).toBe('negative');
    expect(wrong.strength).toBe('strong');
    expect(wrong.anchor).toBe('q1');

    const read = rows.find((r) => r.kind === 'page-read')!;
    expect(read.polarity).toBe('exposure');
    expect(read.strength).toBe('weak');
    expect(read.anchor).toBeNull();
  });

  it('quiz-correct 的 strength 不对称：默认 weak（自评），判分时才升 strong', async () => {
    const { evidenceRepo, subjectId } = await setup();

    // 无答案自评「我答对了」——自我拔高偏差，保守落 weak
    evidenceRepo.appendEvidence({ userId: USER, subjectId, slug: 'a', kind: 'quiz-correct' });
    expect(evidenceRepo.listForPage(USER, subjectId, 'a')[0].strength).toBe('weak');

    // 揭晓答案后判对——有客观参照
    evidenceRepo.appendEvidence({
      userId: USER, subjectId, slug: 'b', kind: 'quiz-correct', strength: 'strong',
    });
    expect(evidenceRepo.listForPage(USER, subjectId, 'b')[0].strength).toBe('strong');
  });

  it('strength 覆盖只对 quiz-correct 生效，其余 kind 由 kind 决定', async () => {
    const { evidenceRepo, subjectId } = await setup();

    // 「我答错了」无论有没有客观参照都是 strong（主动承认答错，无拔高动机），
    // 调用方递一个 weak 进来也不能把它降权。
    evidenceRepo.appendEvidence({
      userId: USER, subjectId, slug: 'p', kind: 'quiz-wrong', strength: 'weak',
    });
    expect(evidenceRepo.listForPage(USER, subjectId, 'p')[0].strength).toBe('strong');
  });

  it('未知 kind 拒绝写入', async () => {
    const { evidenceRepo, subjectId } = await setup();
    expect(() =>
      evidenceRepo.appendEvidence({
        userId: USER, subjectId, slug: 'p',
        kind: 'not-a-kind' as never,
      }),
    ).toThrow(/kind/i);
    expect(evidenceRepo.listForPage(USER, subjectId, 'p')).toHaveLength(0);
  });

  it('listForSubject 按 slug 分组，且不串其他 subject / 其他 user', async () => {
    const { evidenceRepo, subjectsRepo, subjectId } = await setup();
    const other = subjectsRepo.create({ slug: 'other-subj', name: 'O' }).id;

    evidenceRepo.appendEvidence({ userId: USER, subjectId, slug: 'p1', kind: 'page-read' });
    evidenceRepo.appendEvidence({ userId: USER, subjectId, slug: 'p1', kind: 'quiz-wrong' });
    evidenceRepo.appendEvidence({ userId: USER, subjectId, slug: 'p2', kind: 'page-read' });
    evidenceRepo.appendEvidence({ userId: USER, subjectId: other, slug: 'p1', kind: 'quiz-wrong' });
    evidenceRepo.appendEvidence({ userId: 'someone-else', subjectId, slug: 'p1', kind: 'quiz-wrong' });

    const grouped = evidenceRepo.listForSubject(USER, subjectId);
    expect([...grouped.keys()].sort()).toEqual(['p1', 'p2']);
    expect(grouped.get('p1')).toHaveLength(2);
    expect(grouped.get('p2')).toHaveLength(1);
  });

  it('deleteByPage 只删目标页', async () => {
    const { evidenceRepo, subjectId } = await setup();
    evidenceRepo.appendEvidence({ userId: USER, subjectId, slug: 'gone', kind: 'page-read' });
    evidenceRepo.appendEvidence({ userId: USER, subjectId, slug: 'stays', kind: 'page-read' });

    evidenceRepo.deleteByPage(subjectId, 'gone');

    expect(evidenceRepo.listForPage(USER, subjectId, 'gone')).toHaveLength(0);
    expect(evidenceRepo.listForPage(USER, subjectId, 'stays')).toHaveLength(1);
  });

  it('deleteByPage 跨 user 清空该页（页面身份操作，与 user 无关）', async () => {
    const { evidenceRepo, subjectId } = await setup();
    evidenceRepo.appendEvidence({ userId: USER, subjectId, slug: 'p', kind: 'page-read' });
    evidenceRepo.appendEvidence({ userId: 'u2', subjectId, slug: 'p', kind: 'page-read' });

    evidenceRepo.deleteByPage(subjectId, 'p');

    expect(evidenceRepo.listForPage(USER, subjectId, 'p')).toHaveLength(0);
    expect(evidenceRepo.listForPage('u2', subjectId, 'p')).toHaveLength(0);
  });

  it('movePage 迁移证据且不串页', async () => {
    const { evidenceRepo, subjectId } = await setup();
    evidenceRepo.appendEvidence({ userId: USER, subjectId, slug: 'old', kind: 'quiz-wrong' });
    evidenceRepo.appendEvidence({ userId: USER, subjectId, slug: 'untouched', kind: 'page-read' });

    evidenceRepo.movePage(subjectId, 'old', 'new');

    expect(evidenceRepo.listForPage(USER, subjectId, 'old')).toHaveLength(0);
    expect(evidenceRepo.listForPage(USER, subjectId, 'new')).toHaveLength(1);
    expect(evidenceRepo.listForPage(USER, subjectId, 'untouched')).toHaveLength(1);
  });

  it('listForPage 按时间正序返回', async () => {
    const { evidenceRepo, subjectId } = await setup();
    evidenceRepo.appendEvidence({
      userId: USER, subjectId, slug: 'p', kind: 'page-read', createdAt: '2026-01-02T00:00:00.000Z',
    });
    evidenceRepo.appendEvidence({
      userId: USER, subjectId, slug: 'p', kind: 'quiz-wrong', createdAt: '2026-01-01T00:00:00.000Z',
    });

    const rows = evidenceRepo.listForPage(USER, subjectId, 'p');
    expect(rows.map((r) => r.kind)).toEqual(['quiz-wrong', 'page-read']);
  });
});

describe('evidence-repo：detail 大小闸门', () => {
  /** `detail_json` 不进 `EvidenceRow`（它只用于事后审计），只能回读原始列。 */
  async function readDetail(slug: string): Promise<string | null> {
    const { getRawDb } = await import('../../client');
    const row = getRawDb()
      .prepare('SELECT detail_json FROM page_evidence WHERE slug = ?')
      .get(slug) as { detail_json: string | null } | undefined;
    return row?.detail_json ?? null;
  }

  it('正常 detail 原样落库', async () => {
    const { evidenceRepo, subjectId } = await setup();
    evidenceRepo.appendEvidence({
      userId: USER, subjectId, slug: 'ok', kind: 'page-read',
      detail: { viewedSource: 'reshape', profileVersion: 3 },
    });
    expect(JSON.parse((await readDetail('ok'))!)).toEqual({
      viewedSource: 'reshape', profileVersion: 3,
    });
  });

  it('缺省 detail 仍为 null', async () => {
    const { evidenceRepo, subjectId } = await setup();
    evidenceRepo.appendEvidence({ userId: USER, subjectId, slug: 'none', kind: 'page-read' });
    expect(await readDetail('none')).toBeNull();
  });

  it('超大 detail 被截断，但证据本身照常落库', async () => {
    // `page_evidence` 是 append-only 永不删除的表，一次失控写入是永久的。
    // 但为一条只用于事后审计的字段丢掉整条证据，与 best-effort 语义矛盾。
    const { evidenceRepo, subjectId } = await setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const huge = 'x'.repeat(evidenceRepo.MAX_DETAIL_BYTES + 1);
    evidenceRepo.appendEvidence({
      userId: USER, subjectId, slug: 'big', kind: 'selection-ask', detail: { excerpt: huge },
    });

    expect(evidenceRepo.listForPage(USER, subjectId, 'big')).toHaveLength(1);
    const stored = JSON.parse((await readDetail('big'))!);
    // 落的是「这里原本有多大」，不是被砍半的 JSON——半截 JSON 既不可解析也不可解释。
    expect(stored.truncated).toBe(true);
    expect(stored.bytes).toBeGreaterThan(evidenceRepo.MAX_DETAIL_BYTES);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('恰好等于上限不截断', async () => {
    const { evidenceRepo, subjectId } = await setup();
    // `{"v":"…"}` 外壳占 8 字符
    const pad = 'y'.repeat(evidenceRepo.MAX_DETAIL_BYTES - 8);
    evidenceRepo.appendEvidence({
      userId: USER, subjectId, slug: 'edge', kind: 'page-read', detail: { v: pad },
    });
    expect(JSON.parse((await readDetail('edge'))!).v).toBe(pad);
  });

  it('闸门在 repo 层，服务端生产方经 recordEvidence 同样受保护', async () => {
    // `/api/query` 的 selection-ask / citation-hit 与 `/api/lens` 的 reshape-request
    // 都直接调 repo、绕过路由。闸门装在唯一写入口才有意义。
    const { evidenceRepo, subjectId } = await setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { recordEvidence } = await import('@/server/services/record-evidence');

    recordEvidence({
      userId: USER, subjectId, slug: 'via-service', kind: 'selection-ask',
      detail: { excerpt: 'z'.repeat(evidenceRepo.MAX_DETAIL_BYTES + 1) },
    });

    expect(evidenceRepo.listForPage(USER, subjectId, 'via-service')).toHaveLength(1);
    expect(JSON.parse((await readDetail('via-service'))!).truncated).toBe(true);
    warn.mockRestore();
  });
});
