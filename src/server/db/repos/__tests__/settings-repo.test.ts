import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'settings-repo-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

describe('settings-repo agent keys', () => {
  it('returns defaults when no row exists', async () => {
    const repo = await import('../settings-repo');
    expect(repo.getAgentMaxSteps()).toBe(25);
    expect(repo.getAgentMaxTokensPerJob()).toBe(1_200_000);
    expect(repo.getAgentMaxParallelSubAgents()).toBe(3);
    expect(repo.getAgentMcpLifecycle()).toBe('lazy');
    expect(repo.getAgentTaskRouterMode()).toBe('frontmatter-override');
  });

  it('roundtrips numeric keys after set', async () => {
    const repo = await import('../settings-repo');
    repo.setAgentMaxSteps(50);
    repo.setAgentMaxTokensPerJob(1_000_000);
    repo.setAgentMaxParallelSubAgents(5);
    expect(repo.getAgentMaxSteps()).toBe(50);
    expect(repo.getAgentMaxTokensPerJob()).toBe(1_000_000);
    expect(repo.getAgentMaxParallelSubAgents()).toBe(5);
  });

  it('roundtrips enum keys after set', async () => {
    const repo = await import('../settings-repo');
    repo.setAgentMcpLifecycle('eager');
    repo.setAgentTaskRouterMode('task-router-only');
    expect(repo.getAgentMcpLifecycle()).toBe('eager');
    expect(repo.getAgentTaskRouterMode()).toBe('task-router-only');
  });

  it('rejects out-of-range numeric values', async () => {
    const repo = await import('../settings-repo');
    expect(() => repo.setAgentMaxSteps(0)).toThrow();
    expect(() => repo.setAgentMaxSteps(201)).toThrow();
    expect(() => repo.setAgentMaxTokensPerJob(1_000)).toThrow();
    expect(() => repo.setAgentMaxParallelSubAgents(11)).toThrow();
  });

  it('rejects unknown enum values', async () => {
    const repo = await import('../settings-repo');
    // @ts-expect-error testing runtime guard
    expect(() => repo.setAgentMcpLifecycle('bogus')).toThrow();
    // @ts-expect-error testing runtime guard
    expect(() => repo.setAgentTaskRouterMode('bogus')).toThrow();
  });
});
