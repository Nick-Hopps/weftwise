import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conversations-repo-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const { getRawDb } = await import('../../client');
  const db = getRawDb();
  const sub = db.prepare(
    `INSERT INTO subjects (id, slug, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
  );
  sub.run('s1', 'sub-a', 'Sub A', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  sub.run('s2', 'sub-b', 'Sub B', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  return import('../conversations-repo');
}

describe('conversations-repo', () => {
  it('create + list（仅本 subject）', async () => {
    const repo = await setup();
    const c1 = repo.createConversation('s1', '问题 A');
    repo.createConversation('s2', '别的 subject');
    expect(c1.subjectId).toBe('s1');
    expect(c1.title).toBe('问题 A');
    const list = repo.listConversations('s1');
    expect(list.map((c) => c.id)).toEqual([c1.id]);
  });

  it('listConversations 按 updated_at DESC（touch 后置顶）', async () => {
    const repo = await setup();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:01Z'));
      const a = repo.createConversation('s1', 'A');
      vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
      const b = repo.createConversation('s1', 'B');
      // b 较新 → 先返回
      expect(repo.listConversations('s1').map((c) => c.id)).toEqual([b.id, a.id]);
      // touch a 到更晚时间 → a 置顶
      vi.setSystemTime(new Date('2026-01-01T00:00:03Z'));
      repo.touchConversation(a.id);
      expect(repo.listConversations('s1')[0].id).toBe(a.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it('appendMessage + listMessages（ASC，citations 反序列化）', async () => {
    const repo = await setup();
    const c = repo.createConversation('s1', 'A');
    repo.appendMessage(c.id, 'user', '问题', null);
    repo.appendMessage(c.id, 'assistant', '答案', JSON.stringify([{ pageSlug: 'p', excerpt: 'e' }]));
    const msgs = repo.listMessages(c.id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[0].citations).toBeNull();
    expect(msgs[1].citations).toEqual([{ pageSlug: 'p', excerpt: 'e' }]);
  });

  it('renameConversation 改标题', async () => {
    const repo = await setup();
    const c = repo.createConversation('s1', '旧');
    repo.renameConversation(c.id, '新');
    expect(repo.getConversation(c.id)?.title).toBe('新');
  });

  it('deleteConversation 级联删 messages', async () => {
    const repo = await setup();
    const c = repo.createConversation('s1', 'A');
    repo.appendMessage(c.id, 'user', '问题', null);
    repo.deleteConversation(c.id);
    expect(repo.getConversation(c.id)).toBeNull();
    expect(repo.listMessages(c.id)).toEqual([]);
  });

  it('getConversation 未知 id → null', async () => {
    const repo = await setup();
    expect(repo.getConversation('nope')).toBeNull();
  });
});
