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
      'history.list',
      'history.diff',
      'workflow.status',
    ]);
  });

  it('仅在联网检索已配置时保留 web.search', () => {
    expect(resolveToolProfile('query:read', { webSearchConfigured: true }).tools).toContain('web.search');
    expect(resolveToolProfile('query:read', { webSearchConfigured: false }).tools).not.toContain('web.search');
  });

  it('query:propose 只比 read 多审批提案工具，不包含实际写工具', () => {
    const read = resolveToolProfile('query:read', { webSearchConfigured: false }).tools;
    const propose = resolveToolProfile('query:propose', { webSearchConfigured: false }).tools;
    expect(propose).toEqual([
      ...read,
      'wiki.preview_change',
      'history.revert',
      'workflow.reenrich.start',
      'workflow.research.start',
      'workflow.cancel',
      'wiki.reenrich',
      'wiki.move',
      'wiki.image.insert',
    ]);
    for (const writeTool of [
      'wiki.create', 'wiki.update', 'wiki.patch', 'wiki.delete',
      'wiki.metadata.patch', 'wiki.link.ensure', 'image.generate',
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

  it('ingest planner/writer 保持原权限，enricher 仅获得 Mermaid 生图', () => {
    expect(resolveToolProfile('ingest:planner').tools).toEqual(['wiki.read', 'wiki.search']);
    expect(resolveToolProfile('ingest:writer').tools).toEqual(['wiki.read', 'wiki.search']);
    expect(resolveToolProfile('ingest:enricher').tools).toEqual(['image.generate']);
    expect(resolveToolProfile('ingest:enricher').allowedSideEffects).toEqual(['none']);
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
      'ingest:enricher',
    ] as const) {
      expect(resolveToolProfile(profileId).tools).not.toEqual(
        expect.arrayContaining(crossSubjectTools),
      );
    }
  });

  it('History 工具只属于 Query，其他 runner 不可见', () => {
    const historyTools = ['history.list', 'history.diff', 'history.revert'];
    for (const profileId of [
      'fix:links',
      'fix:contradiction',
      'curate:auto',
      'curate:manual',
      'ingest:planner',
      'ingest:writer',
      'ingest:enricher',
    ] as const) {
      expect(resolveToolProfile(profileId).tools).not.toEqual(
        expect.arrayContaining(historyTools),
      );
    }
  });

  it('工作流控制工具只属于 Query，其他 runner 不可见', () => {
    const workflowTools = [
      'workflow.status',
      'workflow.reenrich.start',
      'workflow.research.start',
      'workflow.cancel',
      'wiki.reenrich',
    ];
    for (const profileId of [
      'fix:links',
      'fix:contradiction',
      'curate:auto',
      'curate:manual',
      'ingest:planner',
      'ingest:writer',
      'ingest:enricher',
    ] as const) {
      expect(resolveToolProfile(profileId).tools).not.toEqual(
        expect.arrayContaining(workflowTools),
      );
    }
  });

  it('wiki.move 只属于 Query propose，其他 runner 不可见', () => {
    expect(resolveToolProfile('query:read').tools).not.toContain('wiki.move');
    expect(resolveToolProfile('query:propose').tools).toContain('wiki.move');
    for (const profileId of [
      'fix:links', 'fix:contradiction', 'curate:auto', 'curate:manual',
      'ingest:planner', 'ingest:writer',
      'ingest:enricher',
    ] as const) {
      expect(resolveToolProfile(profileId).tools).not.toContain('wiki.move');
    }
  });

  it('wiki.image.insert 只属于 Query propose，真实 image.generate 仍只属于 enricher', () => {
    expect(resolveToolProfile('query:read').tools).not.toContain('wiki.image.insert');
    expect(resolveToolProfile('query:propose').tools).toContain('wiki.image.insert');
    expect(resolveToolProfile('query:propose').tools).not.toContain('image.generate');
    for (const profileId of [
      'fix:links', 'fix:contradiction', 'curate:auto', 'curate:manual',
      'ingest:planner', 'ingest:writer', 'ingest:enricher',
    ] as const) {
      expect(resolveToolProfile(profileId).tools).not.toContain('wiki.image.insert');
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
  it('planner/writer/enricher 映射到各自 profile，其余步骤回落 writer', () => {
    expect(profileForIngestSkill('ingest-planner')).toBe('ingest:planner');
    expect(profileForIngestSkill('ingest-writer')).toBe('ingest:writer');
    expect(profileForIngestSkill('ingest-enricher')).toBe('ingest:enricher');
    expect(profileForIngestSkill('ingest-verifier')).toBe('ingest:writer');
  });
});
