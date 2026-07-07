import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'research-backlog-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

describe('research-backlog-repo', () => {
  it('creates an open entry for a new question', async () => {
    const subjectsRepo = await import('../subjects-repo');
    const backlogRepo = await import('../research-backlog-repo');
    const subject = subjectsRepo.create({ slug: 's1', name: 'S1' });

    const entry = backlogRepo.create(subject.id, 'What is quantum entanglement?', 'ask-ai');
    expect(entry.status).toBe('open');
    expect(entry.source).toBe('ask-ai');
    expect(entry.researchJobId).toBeNull();

    const listed = backlogRepo.listForSubject(subject.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(entry.id);
  });

  it('does not duplicate an open entry for the same normalized question', async () => {
    const subjectsRepo = await import('../subjects-repo');
    const backlogRepo = await import('../research-backlog-repo');
    const subject = subjectsRepo.create({ slug: 's2', name: 'S2' });

    const first = backlogRepo.create(subject.id, '  What is X?  ', 'ask-ai');
    const second = backlogRepo.create(subject.id, 'what   is x?', 'manual');

    expect(second.id).toBe(first.id);
    expect(backlogRepo.listForSubject(subject.id)).toHaveLength(1);
  });

  it('allows re-adding a question after the prior entry is no longer open', async () => {
    const subjectsRepo = await import('../subjects-repo');
    const backlogRepo = await import('../research-backlog-repo');
    const subject = subjectsRepo.create({ slug: 's3', name: 'S3' });

    const first = backlogRepo.create(subject.id, 'What is Y?', 'ask-ai');
    backlogRepo.updateStatus(first.id, 'dismissed');
    const second = backlogRepo.create(subject.id, 'what is y?', 'ask-ai');

    expect(second.id).not.toBe(first.id);
    expect(backlogRepo.listForSubject(subject.id)).toHaveLength(2);
  });

  it('filters listForSubject by status', async () => {
    const subjectsRepo = await import('../subjects-repo');
    const backlogRepo = await import('../research-backlog-repo');
    const subject = subjectsRepo.create({ slug: 's4', name: 'S4' });

    const a = backlogRepo.create(subject.id, 'Question A', 'ask-ai');
    backlogRepo.create(subject.id, 'Question B', 'manual');
    backlogRepo.updateStatus(a.id, 'researched', 'job-123');

    const open = backlogRepo.listForSubject(subject.id, 'open');
    expect(open).toHaveLength(1);
    expect(open[0].question).toBe('Question B');

    const researched = backlogRepo.listForSubject(subject.id, 'researched');
    expect(researched).toHaveLength(1);
    expect(researched[0].researchJobId).toBe('job-123');
  });

  it('updateStatus returns null for unknown id', async () => {
    await import('../subjects-repo');
    const backlogRepo = await import('../research-backlog-repo');
    expect(backlogRepo.updateStatus('does-not-exist', 'dismissed')).toBeNull();
  });
});
