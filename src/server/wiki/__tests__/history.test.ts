import { describe, it, expect } from 'vitest';
import { buildHistoryEntries } from '../history';
import type { OperationRow } from '../../db/repos/operations-repo';
import type { VaultCommit } from '../../git/git-service';

function row(p: Partial<OperationRow> = {}): OperationRow {
  return {
    id: 'op1', jobId: 'j1', subjectId: 's1', preHead: 'pre', postHead: 'post',
    changesetJson: '[]', status: 'applied', jobType: null, ...p,
  };
}

describe('buildHistoryEntries', () => {
  it('jobType 存在时直接用作 type，并填充 date/affectedPages', () => {
    const rows = [row({
      jobType: 'ingest',
      changesetJson: JSON.stringify([{ action: 'create', path: 'wiki/general/a.md', content: '# A' }]),
    })];
    const map = new Map<string, VaultCommit>([
      ['post', { sha: 'post', date: '2026-06-22T00:00:00Z', message: '[subject:general] 摄入' }],
    ]);
    const out = buildHistoryEntries(rows, map);
    expect(out[0].type).toBe('ingest');
    expect(out[0].date).toBe('2026-06-22T00:00:00Z');
    expect(out[0].message).toBe('[subject:general] 摄入');
    expect(out[0].affectedPages).toEqual([{ slug: 'a', action: 'create' }]);
  });

  it('无 jobType 且全 delete → type=delete', () => {
    const rows = [row({
      jobType: null,
      changesetJson: JSON.stringify([{ action: 'delete', path: 'wiki/general/a.md', content: null }]),
    })];
    expect(buildHistoryEntries(rows, new Map())[0].type).toBe('delete');
  });

  it('无 jobType 且含 update → type=edit', () => {
    const rows = [row({
      jobType: null,
      changesetJson: JSON.stringify([{ action: 'update', path: 'wiki/general/a.md', content: '# A2' }]),
    })];
    expect(buildHistoryEntries(rows, new Map())[0].type).toBe('edit');
  });

  it('postHead 不在 commit map → date 为 null、message 为空串', () => {
    const out = buildHistoryEntries([row({ postHead: 'missing' })], new Map());
    expect(out[0].date).toBeNull();
    expect(out[0].message).toBe('');
  });

  it('status=reverted 透传', () => {
    expect(buildHistoryEntries([row({ status: 'reverted' })], new Map())[0].status).toBe('reverted');
  });

  it('changeset_json 损坏时降级为空 affectedPages，不抛', () => {
    const out = buildHistoryEntries([row({ changesetJson: 'not-json' })], new Map());
    expect(out[0].affectedPages).toEqual([]);
  });
});
