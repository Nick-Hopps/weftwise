/**
 * wiki-transaction Saga 单元测试。
 *
 * Mock 策略：frontmatter / wikilinks / page-identity 走真实实现（纯函数），
 * 把 git-service / wiki-store / indexer / db client / repos / vault-mutex
 * 全部用 vi.mock 替换，避免依赖真实 vault 与 SQLite。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Changeset, ChangesetEntry } from '@/lib/contracts';

const gitMocks = vi.hoisted(() => ({
  getVaultHead: vi.fn(async () => 'pre-sha'),
  commitVaultChanges: vi.fn(async () => 'post-sha'),
  restoreToHead: vi.fn(async () => undefined),
  cleanUntrackedPaths: vi.fn(async () => undefined),
}));
vi.mock('../../git/git-service', () => gitMocks);

const storeMocks = vi.hoisted(() => ({
  writeVaultFiles: vi.fn(),
  deleteVaultFile: vi.fn(),
}));
vi.mock('../wiki-store', () => storeMocks);

const indexerMocks = vi.hoisted(() => ({
  indexTouchedPages: vi.fn(),
}));
vi.mock('../indexer', () => indexerMocks);

// 假的 better-sqlite3 句柄：prepare().run 记录调用；transaction(fn) 直接返回 fn
const dbMocks = vi.hoisted(() => {
  const run = vi.fn();
  const prepare = vi.fn(() => ({ run }));
  return {
    run,
    prepare,
    getRawDb: vi.fn(() => ({
      prepare,
      transaction: (fn: () => void) => fn,
    })),
  };
});
vi.mock('../../db/client', () => ({ getRawDb: dbMocks.getRawDb }));

const pagesRepoMocks = vi.hoisted(() => ({
  getAllPages: vi.fn(() => [{ slug: 'known-page', title: 'Known Page' }]),
  getTitleToSlugMap: vi.fn(() => new Map([['Known Page', 'known-page']])),
  getPageBySlug: vi.fn(() => null as unknown),
}));
vi.mock('../../db/repos/pages-repo', () => pagesRepoMocks);

const subjectsRepoMocks = vi.hoisted(() => ({
  getById: vi.fn((id: string) =>
    id === 's1' ? { id: 's1', slug: 'general', name: 'General' } : null
  ),
  getBySlug: vi.fn(
    (_slug: string): { id: string; slug: string; name: string } | null => null
  ),
}));
vi.mock('../../db/repos/subjects-repo', () => subjectsRepoMocks);

const mutexMocks = vi.hoisted(() => ({
  release: vi.fn(),
  acquireVaultLock: vi.fn(async () => mutexMocks.release),
}));
vi.mock('../vault-mutex', () => ({ acquireVaultLock: mutexMocks.acquireVaultLock }));

import {
  createChangeset,
  validateChangeset,
  applyChangeset,
  rollbackChangeset,
} from '../wiki-transaction';

const VALID_CONTENT = [
  '---',
  'title: A Page',
  "created: '2026-01-01T00:00:00.000Z'",
  "updated: '2026-01-01T00:00:00.000Z'",
  'tags: []',
  'sources: []',
  '---',
  '',
  '正文，引用 [[known-page]]。',
].join('\n');

function makeChangeset(entries: ChangesetEntry[], overrides: Partial<Changeset> = {}): Changeset {
  return {
    ...createChangeset('job-1', { id: 's1', slug: 'general' }, entries),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks 不会重置 mockImplementation，这里显式恢复默认实现，避免用例间泄漏
  dbMocks.run.mockImplementation(() => undefined);
  indexerMocks.indexTouchedPages.mockImplementation(() => undefined);
  pagesRepoMocks.getAllPages.mockReturnValue([{ slug: 'known-page', title: 'Known Page' }]);
  pagesRepoMocks.getTitleToSlugMap.mockReturnValue(new Map([['Known Page', 'known-page']]));
  pagesRepoMocks.getPageBySlug.mockReturnValue(null);
  subjectsRepoMocks.getBySlug.mockReturnValue(null);
});

describe('validateChangeset', () => {
  it('合法 changeset 通过校验且无告警', () => {
    const cs = makeChangeset([
      { action: 'create', path: 'wiki/general/a-page.md', content: VALID_CONTENT },
    ]);
    const result = validateChangeset(cs);
    expect(result).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it('subject 不存在时直接整体失败', () => {
    const cs = makeChangeset([], { subjectId: 'missing' });
    const result = validateChangeset(cs);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/no longer exists/);
  });

  it('空路径与非法 wiki 路径归为 error', () => {
    const cs = makeChangeset([
      { action: 'create', path: '   ', content: VALID_CONTENT },
      // 'wiki/.md' 剥壳后为空字符串 → parseWikiPath 返回 null
      { action: 'create', path: 'wiki/.md', content: VALID_CONTENT },
    ]);
    const result = validateChangeset(cs);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('empty path'),
        expect.stringContaining('not a valid wiki path'),
      ])
    );
  });

  it('路径 subject 与 changeset subject 不一致归为 error', () => {
    const cs = makeChangeset([
      { action: 'create', path: 'wiki/other-subject/a.md', content: VALID_CONTENT },
    ]);
    const result = validateChangeset(cs);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/does not match changeset subject "general"/);
  });

  it('create/update 缺少 content 归为 error', () => {
    const cs = makeChangeset([
      { action: 'create', path: 'wiki/general/a.md', content: null as unknown as string },
    ]);
    const result = validateChangeset(cs);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/has no content/);
  });

  it('非法 frontmatter（缺必填字段）归为 error', () => {
    const cs = makeChangeset([
      { action: 'create', path: 'wiki/general/a.md', content: '---\ntitle: A\n---\nbody' },
    ]);
    const result = validateChangeset(cs);
    expect(result.valid).toBe(false);
    // 疑点：parseFrontmatter 会把缺失字段补成 '' / []，validateFrontmatter 仍按
    // "必须非空字符串" 报错（created/updated 为空串）——按实际行为断言
    expect(result.errors.some((e) => /Frontmatter:/.test(e))).toBe(true);
  });

  it('未解析的本 subject wikilink 归为 warning 且不阻断', () => {
    const content = VALID_CONTENT.replace('[[known-page]]', '[[nowhere-page]]');
    const cs = makeChangeset([
      { action: 'create', path: 'wiki/general/a-page.md', content },
    ]);
    const result = validateChangeset(cs);
    expect(result.valid).toBe(true);
    // link.raw 已含 `[[...]]` 外壳，消息直接使用 raw
    expect(result.warnings).toEqual([
      expect.stringContaining('Unresolved wikilink: [[nowhere-page]]'),
    ]);
  });

  it('指向本 changeset 即将创建的页面不产生 warning', () => {
    const content = VALID_CONTENT.replace('[[known-page]]', '[[sibling]]');
    const cs = makeChangeset([
      { action: 'create', path: 'wiki/general/a-page.md', content },
      { action: 'create', path: 'wiki/general/sibling.md', content: VALID_CONTENT },
    ]);
    const result = validateChangeset(cs);
    expect(result.warnings).toEqual([]);
  });

  it('跨 subject wikilink：目标 subject 不存在 / 目标页不存在分别给 warning', () => {
    subjectsRepoMocks.getBySlug.mockImplementation((slug: string) =>
      slug === 'physics' ? { id: 's2', slug: 'physics', name: 'Physics' } : null
    );
    pagesRepoMocks.getPageBySlug.mockReturnValue(null);
    const content = VALID_CONTENT.replace(
      '[[known-page]]',
      '[[ghost-subject:foo]] 与 [[physics:missing-page]]'
    );
    const cs = makeChangeset([
      { action: 'create', path: 'wiki/general/a-page.md', content },
    ]);
    const result = validateChangeset(cs);
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Unknown subject in wikilink'),
        expect.stringContaining('Unresolved cross-subject wikilink'),
      ])
    );
  });
});

describe('rollbackChangeset', () => {
  it('preHead 为空时不 reset，但仍清理未跟踪文件并重建索引', async () => {
    const cs = makeChangeset([{ action: 'create', path: 'wiki/general/a.md', content: 'x' }]);
    expect(cs.preHead).toBe('');
    await rollbackChangeset(cs);
    expect(gitMocks.restoreToHead).not.toHaveBeenCalled();
    expect(gitMocks.cleanUntrackedPaths).toHaveBeenCalledWith(['wiki/general/a.md']);
    expect(indexerMocks.indexTouchedPages).toHaveBeenCalledWith('s1', ['a']);
  });

  it('create 条目回滚：reset 后清理未跟踪残留文件（reset --hard 不删未跟踪）', async () => {
    const cs = makeChangeset(
      [{ action: 'create', path: 'wiki/general/a.md', content: 'x' }],
      { preHead: 'pre-sha' }
    );
    await rollbackChangeset(cs);
    expect(gitMocks.restoreToHead).toHaveBeenCalledWith('pre-sha');
    expect(gitMocks.cleanUntrackedPaths).toHaveBeenCalledWith(['wiki/general/a.md']);
  });

  it('幂等：连续两次回滚安全，每次都恢复到 preHead 并重建索引', async () => {
    const cs = makeChangeset(
      [{ action: 'create', path: 'wiki/general/a.md', content: 'x' }],
      { preHead: 'pre-sha' }
    );
    await rollbackChangeset(cs);
    await rollbackChangeset(cs);
    expect(gitMocks.restoreToHead).toHaveBeenCalledTimes(2);
    expect(gitMocks.restoreToHead).toHaveBeenCalledWith('pre-sha');
    expect(indexerMocks.indexTouchedPages).toHaveBeenCalledTimes(2);
    expect(indexerMocks.indexTouchedPages).toHaveBeenCalledWith('s1', ['a']);
  });

  it('reindex 或 operations 更新失败时被吞掉（best effort），不抛出', async () => {
    indexerMocks.indexTouchedPages.mockImplementation(() => {
      throw new Error('index boom');
    });
    dbMocks.run.mockImplementation(() => {
      throw new Error('db boom');
    });
    const cs = makeChangeset(
      [{ action: 'create', path: 'wiki/general/a.md', content: 'x' }],
      { preHead: 'pre-sha' }
    );
    await expect(rollbackChangeset(cs)).resolves.toBeUndefined();
  });
});

describe('applyChangeset', () => {
  it('成功路径：写文件 → 重建索引 → git commit → applied，并释放 vault 锁', async () => {
    const cs = makeChangeset([
      { action: 'create', path: 'wiki/general/a.md', content: VALID_CONTENT },
      { action: 'delete', path: 'wiki/general/old.md', content: null },
    ]);
    const applied = await applyChangeset(cs);
    expect(applied.status).toBe('applied');
    expect(applied.preHead).toBe('pre-sha');
    expect(applied.postHead).toBe('post-sha');
    expect(storeMocks.writeVaultFiles).toHaveBeenCalledWith([
      { path: 'wiki/general/a.md', content: VALID_CONTENT },
    ]);
    expect(storeMocks.deleteVaultFile).toHaveBeenCalledWith('wiki/general/old.md');
    expect(gitMocks.commitVaultChanges).toHaveBeenCalledWith(
      expect.stringContaining('[subject:general]'),
      ['wiki/general/a.md', 'wiki/general/old.md']
    );
    expect(mutexMocks.release).toHaveBeenCalledTimes(1);
  });

  it('git commit 失败时触发 rollback（restoreToHead preHead）并重新抛错', async () => {
    gitMocks.commitVaultChanges.mockRejectedValueOnce(new Error('git boom'));
    const cs = makeChangeset([
      { action: 'create', path: 'wiki/general/a.md', content: VALID_CONTENT },
    ]);
    await expect(applyChangeset(cs)).rejects.toThrow('git boom');
    expect(gitMocks.restoreToHead).toHaveBeenCalledWith('pre-sha');
    // 失败路径同样必须释放锁
    expect(mutexMocks.release).toHaveBeenCalledTimes(1);
  });

  it('sourceOps.updateSourcePageLinks 抛错时调用 onWarning 且 changeset 仍 applied', async () => {
    const onWarning = vi.fn();
    const cs = makeChangeset([
      { action: 'create', path: 'wiki/general/a.md', content: VALID_CONTENT },
    ]);
    const linkPageSource = vi.fn();
    const applied = await applyChangeset(cs, {
      links: [{ sourceId: 'src-1', pageSlugs: ['a'] }],
      linkPageSource,
      updateSourcePageLinks: vi.fn(() => {
        throw new Error('sidecar boom');
      }),
      onWarning,
    });
    expect(applied.status).toBe('applied');
    expect(applied.postHead).toBe('post-sha');
    expect(linkPageSource).toHaveBeenCalledWith('s1', 'a', 'src-1');
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('src-1'));
    expect(onWarning.mock.calls[0][0]).toContain('sidecar boom');
    // sidecar 失败不应触发 git 回滚
    expect(gitMocks.restoreToHead).not.toHaveBeenCalled();
  });

  it('sourceOps 失败但未提供 onWarning 时静默继续', async () => {
    const cs = makeChangeset([
      { action: 'create', path: 'wiki/general/a.md', content: VALID_CONTENT },
    ]);
    const applied = await applyChangeset(cs, {
      links: [{ sourceId: 'src-1', pageSlugs: ['a'] }],
      linkPageSource: vi.fn(),
      updateSourcePageLinks: vi.fn(() => {
        throw new Error('sidecar boom');
      }),
    });
    expect(applied.status).toBe('applied');
  });
});
