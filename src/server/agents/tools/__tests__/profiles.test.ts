import { describe, expect, it } from 'vitest';
import {
  createToolExecutionPolicy,
  profileForIngestSkill,
  resolveToolProfile,
} from '../profiles';

describe('resolveToolProfile', () => {
  it('query:read 只声明读取与证据工具', () => {
    expect(resolveToolProfile('query:read', { webSearchConfigured: false }).tools).toEqual([
      'wiki.list',
      'wiki.search',
      'wiki.read',
      'wiki.inspect',
      'source.search',
      'source.read',
    ]);
  });

  it('仅在联网检索已配置时保留 web.search', () => {
    expect(resolveToolProfile('query:read', { webSearchConfigured: true }).tools).toContain('web.search');
    expect(resolveToolProfile('query:read', { webSearchConfigured: false }).tools).not.toContain('web.search');
  });

  it('Auto Curate 不声明 list/create/delete', () => {
    const tools = resolveToolProfile('curate:auto').tools;
    expect(tools).not.toContain('wiki.list');
    expect(tools).not.toContain('wiki.create');
    expect(tools).not.toContain('wiki.delete');
  });
});

describe('createToolExecutionPolicy', () => {
  it('复制 profile 副作用并附加 subject 与 page scope', () => {
    const profile = resolveToolProfile('curate:auto');
    const allowedPageSlugs = new Set(['seed', 'neighbor']);
    const policy = createToolExecutionPolicy(profile, 'subject-1', { allowedPageSlugs });

    expect(policy.profileId).toBe('curate:auto');
    expect(policy.subjectId).toBe('subject-1');
    expect([...policy.allowedSideEffects]).toEqual(profile.allowedSideEffects);
    expect(policy.allowedPageSlugs).toBe(allowedPageSlugs);
  });
});

describe('profileForIngestSkill', () => {
  it('planner 映射到 planner，其余 ingest 内容步骤映射到 writer', () => {
    expect(profileForIngestSkill('ingest-planner')).toBe('ingest:planner');
    expect(profileForIngestSkill('ingest-writer')).toBe('ingest:writer');
    expect(profileForIngestSkill('ingest-verifier')).toBe('ingest:writer');
  });
});
