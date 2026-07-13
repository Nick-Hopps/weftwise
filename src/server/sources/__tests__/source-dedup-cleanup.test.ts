import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupSourceDedupSidecars,
  finalizeSourceDedupCleanup,
  reconcileSourceDedupSidecars,
} from '../source-dedup-cleanup';
import { ensureVaultRepo, getVaultGit } from '../../git/git-service';

let dir: string;
let sqlite: Database.Database;
let previousVaultPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'source-dedup-cleanup-'));
  previousVaultPath = process.env.VAULT_PATH;
  process.env.VAULT_PATH = dir;
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE source_dedup_cleanup (
      loser_id TEXT PRIMARY KEY NOT NULL,
      winner_id TEXT NOT NULL,
      subject_slug TEXT NOT NULL,
      filename TEXT NOT NULL
    );
    INSERT INTO source_dedup_cleanup VALUES ('loser', 'winner', 'general', 'a.md');
  `);
});

afterEach(() => {
  process.env.VAULT_PATH = previousVaultPath;
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('cleanupSourceDedupSidecars', () => {
  it('删除失败时保留记录，下一次成功后删除 sidecar 并移除补偿表', () => {
    const sidecarDir = join(dir, '.llm-wiki', 'sources', 'general');
    mkdirSync(sidecarDir, { recursive: true });
    const sidecar = join(sidecarDir, 'loser.json');
    const winnerSidecar = join(sidecarDir, 'winner.json');
    writeFileSync(sidecar, JSON.stringify({
      id: 'loser',
      filename: 'a.md',
      linkedPages: ['loser-page', 'shared-page'],
    }));
    writeFileSync(winnerSidecar, JSON.stringify({
      id: 'winner',
      filename: 'a.md',
      linkedPages: ['winner-page', 'shared-page'],
    }));

    const failed = cleanupSourceDedupSidecars(sqlite, dir, () => {
      throw new Error('permission denied');
    });
    expect(failed.completedLoserIds).toEqual([]);
    expect(sqlite.prepare(`SELECT loser_id FROM source_dedup_cleanup`).get())
      .toEqual({ loser_id: 'loser' });
    expect(existsSync(sidecar)).toBe(true);
    expect(JSON.parse(readFileSync(winnerSidecar, 'utf-8'))).toMatchObject({
      id: 'winner',
      linkedPages: ['loser-page', 'shared-page', 'winner-page'],
    });

    const completed = cleanupSourceDedupSidecars(sqlite, dir);
    expect(completed.completedLoserIds).toEqual(['loser']);
    // Git 提交前 ledger 仍在；由调用方在 commit 成功后显式消费。
    expect(sqlite.prepare(`SELECT loser_id FROM source_dedup_cleanup`).get())
      .toEqual({ loser_id: 'loser' });
    finalizeSourceDedupCleanup(sqlite, completed.completedLoserIds);
    expect(existsSync(sidecar)).toBe(false);
    expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_dedup_cleanup'`).get())
      .toBeUndefined();
  });

  it('winner sidecar 缺失时先从 loser 重建权威 metadata，再消费清理记录', () => {
    const sidecarDir = join(dir, '.llm-wiki', 'sources', 'general');
    mkdirSync(sidecarDir, { recursive: true });
    writeFileSync(join(sidecarDir, 'loser.json'), JSON.stringify({
      id: 'loser',
      subjectId: 'subject-1',
      filename: 'a.md',
      originUrl: 'https://example.com/loser',
      customEvidence: { provider: 'legacy-import' },
      linkedPages: ['page-a'],
      chunks: [{ id: 'chunk-1' }],
    }));

    const completed = cleanupSourceDedupSidecars(sqlite, dir);
    finalizeSourceDedupCleanup(sqlite, completed.completedLoserIds);

    const winner = JSON.parse(readFileSync(join(sidecarDir, 'winner.json'), 'utf-8'));
    expect(winner).toMatchObject({
      id: 'winner',
      subjectId: 'subject-1',
      subjectSlug: 'general',
      filename: 'a.md',
      originUrl: 'https://example.com/loser',
      customEvidence: { provider: 'legacy-import' },
      linkedPages: ['page-a'],
      chunks: [{ id: 'chunk-1' }],
    });
    expect(existsSync(join(sidecarDir, 'loser.json'))).toBe(false);
  });

  it('winner 保留冲突字段，loser 回填缺失字段并补齐非空 chunks', () => {
    const sidecarDir = join(dir, '.llm-wiki', 'sources', 'general');
    mkdirSync(sidecarDir, { recursive: true });
    writeFileSync(join(sidecarDir, 'winner.json'), JSON.stringify({
      id: 'winner',
      filename: 'a.md',
      originUrl: 'https://example.com/winner',
      savedAt: '2026-07-13T02:00:00.000Z',
      winnerOnly: true,
      linkedPages: ['winner-page'],
      chunks: [],
    }));
    writeFileSync(join(sidecarDir, 'loser.json'), JSON.stringify({
      id: 'loser',
      filename: 'a.md',
      originUrl: 'https://example.com/loser',
      savedAt: '2026-07-13T01:00:00.000Z',
      loserOnly: { source: 'legacy' },
      linkedPages: ['loser-page'],
      chunks: [{ id: 'chunk-from-loser' }],
    }));

    const completed = cleanupSourceDedupSidecars(sqlite, dir);
    finalizeSourceDedupCleanup(sqlite, completed.completedLoserIds);

    expect(JSON.parse(readFileSync(join(sidecarDir, 'winner.json'), 'utf-8')))
      .toMatchObject({
        id: 'winner',
        originUrl: 'https://example.com/winner',
        savedAt: '2026-07-13T01:00:00.000Z',
        winnerOnly: true,
        loserOnly: { source: 'legacy' },
        linkedPages: ['loser-page', 'winner-page'],
        chunks: [{ id: 'chunk-from-loser' }],
      });
  });

  it('worker 锁内提交可忽略已删除的未 tracked loser，但拒绝夹带无关 staged 文件', async () => {
    await ensureVaultRepo();
    const sidecarDir = join(dir, '.llm-wiki', 'sources', 'general');
    mkdirSync(sidecarDir, { recursive: true });
    writeFileSync(join(sidecarDir, 'loser.json'), JSON.stringify({
      id: 'loser',
      filename: 'a.md',
    }));
    const unrelated = join(dir, 'wiki', 'unrelated.md');
    mkdirSync(join(dir, 'wiki'), { recursive: true });
    writeFileSync(unrelated, '# unrelated');
    const git = getVaultGit();
    await git.add('wiki/unrelated.md');

    await expect(reconcileSourceDedupSidecars(sqlite, dir))
      .rejects.toThrow('非来源去重 staged 文件');
    expect(sqlite.prepare(`SELECT loser_id FROM source_dedup_cleanup`).get())
      .toEqual({ loser_id: 'loser' });

    await git.raw(['reset', '--', 'wiki/unrelated.md']);
    rmSync(unrelated, { force: true });
    await expect(reconcileSourceDedupSidecars(sqlite, dir)).resolves.toBe(1);

    expect(existsSync(join(sidecarDir, 'loser.json'))).toBe(false);
    expect(existsSync(join(sidecarDir, 'winner.json'))).toBe(true);
    expect((await git.status()).isClean()).toBe(true);
    expect(sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'source_dedup_cleanup'
    `).get()).toBeUndefined();

    // 模拟上次进程已 staged “tracked 损坏 loser 删除”却在 commit 前崩溃：
    // 重启后已无文件可重新推导，仍必须先提交授权 index，再消费 ledger。
    sqlite.exec(`
      CREATE TABLE source_dedup_cleanup (
        loser_id TEXT PRIMARY KEY NOT NULL,
        winner_id TEXT NOT NULL,
        subject_slug TEXT NOT NULL,
        filename TEXT NOT NULL
      );
      INSERT INTO source_dedup_cleanup
      VALUES ('broken-loser', 'missing-winner', 'general', 'broken.md');
    `);
    const brokenLoser = join(sidecarDir, 'broken-loser.json');
    writeFileSync(brokenLoser, '{broken');
    await git.add('.llm-wiki/sources/general/broken-loser.json');
    await git.commit('seed tracked broken loser');
    rmSync(brokenLoser, { force: true });
    await git.add('.llm-wiki/sources/general/broken-loser.json');
    expect((await git.status()).staged).toContain(
      '.llm-wiki/sources/general/broken-loser.json',
    );

    await expect(reconcileSourceDedupSidecars(sqlite, dir)).resolves.toBe(1);

    expect((await git.status()).staged).toEqual([]);
    expect((await git.log({ maxCount: 1 })).latest?.message)
      .toBe('维护：合并重复来源元数据');
    expect(sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'source_dedup_cleanup'
    `).get()).toBeUndefined();
  });
});
