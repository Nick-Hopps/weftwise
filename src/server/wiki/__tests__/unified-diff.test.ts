import { describe, expect, it } from 'vitest';
import { buildUnifiedDiff } from '../unified-diff';

describe('buildUnifiedDiff', () => {
  it('update 使用 a/b 路径并输出精确删除与新增行', () => {
    const result = buildUnifiedDiff([{
      action: 'update',
      path: 'wiki/general/a.md',
      before: 'title\nold\nend\n',
      after: 'title\nnew\nend\n',
    }]);

    expect(result).toContain('--- a/wiki/general/a.md');
    expect(result).toContain('+++ b/wiki/general/a.md');
    expect(result).toContain('-old');
    expect(result).toContain('+new');
    expect(result).toContain(' title');
    expect(result).toContain(' end');
  });

  it('create 与 delete 分别使用 /dev/null', () => {
    const created = buildUnifiedDiff([{
      action: 'create', path: 'wiki/general/new.md', before: null, after: 'new\n',
    }]);
    expect(created).toContain('--- /dev/null');
    expect(created).toContain('+++ b/wiki/general/new.md');
    expect(created).toContain('+new');

    const deleted = buildUnifiedDiff([{
      action: 'delete', path: 'wiki/general/old.md', before: 'old\n', after: null,
    }]);
    expect(deleted).toContain('--- a/wiki/general/old.md');
    expect(deleted).toContain('+++ /dev/null');
    expect(deleted).toContain('-old');
  });

  it('多路径按 path 排序且跳过无变化条目', () => {
    const result = buildUnifiedDiff([
      { action: 'update', path: 'wiki/general/z.md', before: 'z1', after: 'z2' },
      { action: 'update', path: 'wiki/general/same.md', before: 'same', after: 'same' },
      { action: 'update', path: 'wiki/general/a.md', before: 'a1', after: 'a2' },
    ]);

    expect(result.indexOf('a/wiki/general/a.md')).toBeLessThan(result.indexOf('a/wiki/general/z.md'));
    expect(result).not.toContain('same.md');
  });
});
