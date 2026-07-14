import { describe, it, expect } from 'vitest';
import { buildRevertEntries } from '../revert';
import type { ChangesetEntry } from '@/lib/contracts';

const P = 'wiki/general/a.md';

describe('buildRevertEntries', () => {
  it('原操作新建一页（preHead 无该文件）→ 回滚为 delete', () => {
    const original: ChangesetEntry[] = [{ action: 'create', path: P, content: '# A' }];
    const out = buildRevertEntries(original, () => null, () => true);
    expect(out).toEqual([{ action: 'delete', path: P, content: null }]);
  });

  it('原操作更新一页（preHead 有、当前存在）→ 回滚为 update + 旧内容', () => {
    const original: ChangesetEntry[] = [{ action: 'update', path: P, content: '# A new' }];
    const out = buildRevertEntries(original, () => '# A old', () => true);
    expect(out).toEqual([{ action: 'update', path: P, content: '# A old' }]);
  });

  it('原操作删除一页（preHead 有、当前不存在）→ 回滚为 create + 旧内容', () => {
    const original: ChangesetEntry[] = [{ action: 'delete', path: P, content: null }];
    const out = buildRevertEntries(original, () => '# A old', () => false);
    expect(out).toEqual([{ action: 'create', path: P, content: '# A old' }]);
  });

  it('preHead 有内容但当前已被后续删除（不存在）→ 回滚为 create', () => {
    const original: ChangesetEntry[] = [{ action: 'update', path: P, content: '# A new' }];
    const out = buildRevertEntries(original, () => '# A old', () => false);
    expect(out).toEqual([{ action: 'create', path: P, content: '# A old' }]);
  });

  it('多条目混合 + 同 path 去重', () => {
    const P2 = 'wiki/general/b.md';
    const original: ChangesetEntry[] = [
      { action: 'create', path: P, content: '# A' },
      { action: 'update', path: P2, content: '# B new' },
      { action: 'update', path: P, content: '# A again' }, // 同 path，应被去重
    ];
    const fileAtPreHead = (p: string) => (p === P2 ? '# B old' : null);
    const out = buildRevertEntries(original, fileAtPreHead, () => true);
    expect(out).toEqual([
      { action: 'delete', path: P, content: null },
      { action: 'update', path: P2, content: '# B old' },
    ]);
  });

  it('move 回滚生成反向 movedFromPath，并保留 auxiliary 标记', () => {
    const oldPath = 'wiki/general/old.md';
    const newPath = 'wiki/general/new.md';
    const sidecar = '.llm-wiki/sources/general/source-1.json';
    const original: ChangesetEntry[] = [
      { action: 'create', path: newPath, content: 'new', movedFromPath: oldPath },
      { action: 'delete', path: oldPath, content: null },
      { action: 'update', path: sidecar, content: '{"linkedPages":["new"]}', auxiliary: true },
    ];
    const prior = (path: string) => {
      if (path === oldPath) return 'old';
      if (path === sidecar) return '{"linkedPages":["old"]}';
      return null;
    };
    expect(buildRevertEntries(original, prior, (path) => path !== oldPath)).toEqual([
      { action: 'delete', path: newPath, content: null },
      { action: 'create', path: oldPath, content: 'old', movedFromPath: newPath },
      {
        action: 'update', path: sidecar, content: '{"linkedPages":["old"]}',
        auxiliary: true,
      },
    ]);
  });
});
