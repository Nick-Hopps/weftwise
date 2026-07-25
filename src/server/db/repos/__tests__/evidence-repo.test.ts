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
