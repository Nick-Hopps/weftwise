import { describe, expect, it } from 'vitest';
import {
  createToolExecutionPolicy,
  profileForIngestSkill,
  resolveToolProfile,
} from '../profiles';

describe('resolveToolProfile', () => {
  it('query:read 只声明读取与证据工具', () => {
    expect(resolveToolProfile('query:read', { webSearchConfigured: false }).tools).toEqual([
      'subject.list',
      'wiki.list',
      'wiki.search',
      'wiki.read',
      'wiki.search_cross_subject',
      'wiki.read_cross_subject',
      'wiki.inspect',
      'source.search',
      'source.read',
    ]);
  });

  it('仅在联网检索已配置时保留 web.search', () => {
    expect(resolveToolProfile('query:read', { webSearchConfigured: true }).tools).toContain('web.search');
    expect(resolveToolProfile('query:read', { webSearchConfigured: false }).tools).not.toContain('web.search');
  });

  it('query:propose 只比 read 多 preview，不包含实际写工具', () => {
    const read = resolveToolProfile('query:read', { webSearchConfigured: false }).tools;
    const propose = resolveToolProfile('query:propose', { webSearchConfigured: false }).tools;
    expect(propose).toEqual([...read, 'wiki.preview_change']);
    for (const writeTool of [
      'wiki.create', 'wiki.update', 'wiki.patch', 'wiki.delete', 'wiki.reenrich',
      'wiki.metadata.patch', 'wiki.link.ensure',
    ]) {
      expect(propose).not.toContain(writeTool);
    }
  });

  it('Fix profile 精确暴露链接窄写，且不获得 metadata.patch', () => {
    expect(resolveToolProfile('fix:links').tools).toEqual([
      'wiki.search', 'wiki.read', 'wiki.inspect', 'source.search', 'source.read',
      'wiki.link.ensure',
    ]);
    expect(resolveToolProfile('fix:contradiction').tools).toEqual([
      'wiki.search', 'wiki.read', 'wiki.inspect', 'source.search', 'source.read',
      'wiki.link.ensure', 'wiki.patch', 'wiki.update',
    ]);
    expect(resolveToolProfile('fix:links').tools).not.toContain('wiki.metadata.patch');
    expect(resolveToolProfile('fix:contradiction').tools).not.toContain('wiki.metadata.patch');
  });

  it('Curate auto/manual 均含两个窄写工具与 update 副作用', () => {
    const auto = resolveToolProfile('curate:auto');
    expect(auto.tools).toEqual([
      'wiki.search', 'wiki.read', 'wiki.inspect', 'wiki.merge', 'wiki.split',
      'wiki.link.ensure', 'wiki.metadata.patch',
    ]);
    expect(auto.allowedSideEffects).toEqual(['none', 'merge', 'split', 'update']);

    const manual = resolveToolProfile('curate:manual');
    expect(manual.tools).toEqual([
      ...auto.tools, 'wiki.create', 'wiki.delete',
    ]);
    expect(manual.allowedSideEffects).toEqual([
      'none', 'merge', 'split', 'update', 'create', 'destructive',
    ]);
  });

  it('ingest profile 保持不变', () => {
    expect(resolveToolProfile('ingest:planner').tools).toEqual(['wiki.read', 'wiki.search']);
    expect(resolveToolProfile('ingest:writer').tools).toEqual(['wiki.read', 'wiki.search']);
  });

  it('跨主题只读工具只属于 Query profile', () => {
    const crossSubjectTools = [
      'subject.list',
      'wiki.search_cross_subject',
      'wiki.read_cross_subject',
    ];
    for (const profileId of [
      'fix:links',
      'fix:contradiction',
      'curate:auto',
      'curate:manual',
      'ingest:planner',
      'ingest:writer',
    ] as const) {
      expect(resolveToolProfile(profileId).tools).not.toEqual(
        expect.arrayContaining(crossSubjectTools),
      );
    }
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
