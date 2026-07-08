import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jobs-repo-fail-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

class AIRetryError extends Error {
  lastError: unknown;
  constructor(message: string, lastError: unknown) {
    super(message);
    this.name = 'AI_RetryError';
    this.lastError = lastError;
  }
}

describe('jobs-repo.failJob', () => {
  it('AI_RetryError 的 message 为空时，落库的 error.message 补上 lastError 的真实原因', async () => {
    const repo = await import('../jobs-repo');
    const job = repo.enqueueJob('lint', {});

    const lastError = Object.assign(new Error(''), { cause: 'terminated' });
    repo.failJob(job.id, new AIRetryError('Failed after 3 attempts. Last error: ', lastError));

    const failed = repo.getJob(job.id);
    const errorMessage = JSON.parse(failed!.resultJson!).error.message;
    expect(errorMessage).toBe('Failed after 3 attempts. Last error:  [root cause: terminated]');
  });

  it('普通 Error 不受影响，原样落库', async () => {
    const repo = await import('../jobs-repo');
    const job = repo.enqueueJob('lint', {});

    repo.failJob(job.id, new Error('No object generated: response did not match schema.'));

    const failed = repo.getJob(job.id);
    const errorMessage = JSON.parse(failed!.resultJson!).error.message;
    expect(errorMessage).toBe('No object generated: response did not match schema.');
  });
});
