import { describe, expect, it } from 'vitest';
import type { ChangesetEntry, Subject } from '@/lib/contracts';
import type { OperationRow } from '@/server/db/repos/operations-repo';
import {
  buildPostconditionScope,
  PostconditionScopeError,
} from '../operation-scope-collector';

const subject: Pick<Subject, 'id' | 'slug'> = { id: 's1', slug: 'general' };

function operationRaw(changesetJson: string, id = 'op-1'): OperationRow {
  return {
    id,
    jobId: 'job-1',
    subjectId: 's1',
    preHead: 'pre',
    postHead: `post-${id}`,
    changesetJson,
    status: 'applied',
    jobType: 'fix',
  };
}

function operation(id: string, entries: ChangesetEntry[]): OperationRow {
  return operationRaw(JSON.stringify(entries), id);
}

describe('buildPostconditionScope', () => {
  it('合并多个 Changeset 并按首次出现顺序去重 slug', () => {
    const scope = buildPostconditionScope('job-1', subject, [
      operation('op-1', [
        { action: 'create', path: 'wiki/general/a.md', content: '# A' },
        { action: 'update', path: 'wiki/general/b.md', content: '# B' },
      ]),
      operation('op-2', [
        { action: 'update', path: 'wiki/general/a.md', content: '# A2' },
        { action: 'delete', path: 'wiki/general/c.md', content: null },
      ]),
    ]);

    expect(scope).toEqual({
      jobId: 'job-1',
      subjectId: 's1',
      operationIds: ['op-1', 'op-2'],
      createdSlugs: ['a'],
      updatedSlugs: ['b', 'a'],
      deletedSlugs: ['c'],
      touchedSlugs: ['a', 'b', 'c'],
    });
  });

  it('空 operation 返回空范围', () => {
    expect(buildPostconditionScope('job-1', subject, [])).toEqual({
      jobId: 'job-1',
      subjectId: 's1',
      operationIds: [],
      createdSlugs: [],
      updatedSlugs: [],
      deletedSlugs: [],
      touchedSlugs: [],
    });
  });

  it.each([
    ['损坏 JSON', '{'],
    ['非法 action', '[{"action":"move","path":"wiki/general/a.md","content":null}]'],
    ['更新正文为空', '[{"action":"update","path":"wiki/general/a.md","content":null}]'],
    ['越界 Subject', '[{"action":"delete","path":"wiki/other/a.md","content":null}]'],
    ['非 Wiki 路径', '[{"action":"delete","path":"raw/general/a.md","content":null}]'],
  ])('%s 抛出 PostconditionScopeError', (_name, changesetJson) => {
    expect(() =>
      buildPostconditionScope('job-1', subject, [operationRaw(changesetJson)]),
    ).toThrow(PostconditionScopeError);
  });

  it('拒绝混入其他 Job 或 Subject 的 operation', () => {
    const wrongJob = { ...operationRaw('[]'), jobId: 'job-2' };
    const wrongSubject = { ...operationRaw('[]'), subjectId: 's2' };

    expect(() => buildPostconditionScope('job-1', subject, [wrongJob])).toThrow(
      PostconditionScopeError,
    );
    expect(() => buildPostconditionScope('job-1', subject, [wrongSubject])).toThrow(
      PostconditionScopeError,
    );
  });
});
