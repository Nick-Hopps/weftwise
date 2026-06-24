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
    repo.setAgentTaskRouterMode('task-router-only');
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
    expect(() => repo.setAgentTaskRouterMode('bogus')).toThrow();
  });
});

describe('settings-repo web search keys', () => {
  it('returns defaults when no row exists', async () => {
    const repo = await import('../settings-repo');
    expect(repo.getWebSearchProvider()).toBe('tavily');
    expect(repo.getWebSearchApiKey()).toBe('');
    expect(repo.getWebSearchMaxResults()).toBe(5);
    expect(repo.getWebSearchConfig()).toEqual({ provider: 'tavily', apiKey: '', maxResults: 5 });
  });

  it('roundtrips after set', async () => {
    const repo = await import('../settings-repo');
    repo.setWebSearchProvider('tavily');
    repo.setWebSearchApiKey('  tvly-abc123  ');
    repo.setWebSearchMaxResults(8);
    expect(repo.getWebSearchApiKey()).toBe('tvly-abc123'); // trimmed
    expect(repo.getWebSearchMaxResults()).toBe(8);
    expect(repo.getWebSearchConfig()).toEqual({ provider: 'tavily', apiKey: 'tvly-abc123', maxResults: 8 });
  });

  it('allows empty apiKey (means not configured)', async () => {
    const repo = await import('../settings-repo');
    expect(() => repo.setWebSearchApiKey('')).not.toThrow();
    expect(repo.getWebSearchApiKey()).toBe('');
  });

  it('rejects out-of-range maxResults and bad provider', async () => {
    const repo = await import('../settings-repo');
    expect(() => repo.setWebSearchMaxResults(0)).toThrow();
    expect(() => repo.setWebSearchMaxResults(11)).toThrow();
    // @ts-expect-error testing runtime guard
    expect(() => repo.setWebSearchProvider('bing')).toThrow();
  });
});
