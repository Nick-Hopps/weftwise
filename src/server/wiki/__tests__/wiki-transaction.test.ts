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
  rebuildPageIndex: vi.fn(),
}));
vi.mock('../indexer', () => indexerMocks);

const identityMocks = vi.hoisted(() => ({
  collectPageIdentityMoves: vi.fn((): Array<{ fromSlug: string; toSlug: string }> => []),
  migratePageIdentityCaches: vi.fn(),
}));
vi.mock('../page-identity-migration', () => identityMocks);

// 假的 better-sqlite3 句柄：prepare().run 记录调用；transaction(fn) 直接返回 fn
const dbMocks = vi.hoisted(() => {
  const run = vi.fn();
  const get = vi.fn<() => { maintenance_state: string; mutation_epoch: number } | undefined>(
    () => ({ maintenance_state: 'active', mutation_epoch: 0 }),
  );
  const prepare = vi.fn(() => ({ run, get }));
  return {
    run,
    get,
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
  dbMocks.get.mockReturnValue({ maintenance_state: 'active', mutation_epoch: 0 });
  indexerMocks.indexTouchedPages.mockImplementation(() => undefined);
  indexerMocks.rebuildPageIndex.mockImplementation(() => undefined);
  identityMocks.collectPageIdentityMoves.mockReturnValue([]);
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

  it('只允许当前 Subject source sidecar 作为 auxiliary JSON', () => {
    const valid = makeChangeset([{
      action: 'update',
      path: '.llm-wiki/sources/general/source-1.json',
      content: '{"linkedPages":["new-page"]}',
      auxiliary: true,
    }]);
    expect(validateChangeset(valid).valid).toBe(true);

    const escaped = makeChangeset([{
      action: 'update', path: '.llm-wiki/sources/other/source-1.json',
      content: '{}', auxiliary: true,
    }]);
    expect(validateChangeset(escaped).errors).toEqual([
      expect.stringContaining('not an allowed source sidecar'),
    ]);
  });

  it('图片资产允许关联规范化的 Unicode 页面 slug', () => {
    const cs = makeChangeset([{
      action: 'create',
      path: 'assets/general/asset-id.jpg',
      content: 'aW1hZ2U=',
      contentEncoding: 'base64',
      auxiliary: true,
      auxiliaryKind: 'asset',
      assetFor: '3d图形学基础',
    }]);

    expect(validateChangeset(cs)).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it('movedFromPath 必须是同 Subject 匹配 delete 的 create marker', () => {
    const valid = makeChangeset([
      {
        action: 'create', path: 'wiki/general/new.md', content: VALID_CONTENT,
        movedFromPath: 'wiki/general/old.md',
      },
      { action: 'delete', path: 'wiki/general/old.md', content: null },
    ]);
    expect(validateChangeset(valid).valid).toBe(true);

    const missingDelete = makeChangeset([{
      action: 'create', path: 'wiki/general/new.md', content: VALID_CONTENT,
      movedFromPath: 'wiki/general/old.md',
    }]);
    expect(validateChangeset(missingDelete).valid).toBe(false);
    expect(validateChangeset(missingDelete).errors.join(' ')).toMatch(/matching delete/i);
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

describe('applyChangeset cancellation guard', () => {
  it('在 vault 锁内、任何 operation/fs 写入前执行 assertCanApply', async () => {
    const cs = makeChangeset([
      { action: 'update', path: 'wiki/general/a-page.md', content: VALID_CONTENT },
    ]);
    const cancelled = new Error('cancelled');

    await expect(applyChangeset(cs, undefined, {
      assertCanApply: () => { throw cancelled; },
    })).rejects.toBe(cancelled);

    expect(dbMocks.prepare).not.toHaveBeenCalled();
    expect(storeMocks.writeVaultFiles).not.toHaveBeenCalled();
    expect(gitMocks.commitVaultChanges).not.toHaveBeenCalled();
    expect(mutexMocks.release).toHaveBeenCalledOnce();
  });

  it('索引后、commit 前取消会触发 Saga rollback', async () => {
    const cs = makeChangeset([
      { action: 'update', path: 'wiki/general/a-page.md', content: VALID_CONTENT },
    ]);
    const cancelled = new Error('cancelled during apply');
    const assertCanApply = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw cancelled; });

    await expect(applyChangeset(cs, undefined, { assertCanApply })).rejects.toBe(cancelled);

    expect(storeMocks.writeVaultFiles).toHaveBeenCalledOnce();
    expect(indexerMocks.indexTouchedPages).toHaveBeenCalled();
    expect(gitMocks.commitVaultChanges).not.toHaveBeenCalled();
    expect(gitMocks.restoreToHead).toHaveBeenCalledWith('pre-sha');
    expect(mutexMocks.release).toHaveBeenCalledOnce();
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

  it('move 回滚反向迁移派生缓存并全量重建 alias/link 索引', async () => {
    identityMocks.collectPageIdentityMoves.mockReturnValue([
      { fromSlug: 'old', toSlug: 'new' },
    ]);
    const cs = makeChangeset([
      {
        action: 'create', path: 'wiki/general/new.md', content: 'new',
        movedFromPath: 'wiki/general/old.md',
      },
      { action: 'delete', path: 'wiki/general/old.md', content: null },
    ], { preHead: 'pre-sha' });

    await rollbackChangeset(cs);

    expect(identityMocks.migratePageIdentityCaches).toHaveBeenCalledWith(
      's1', { fromSlug: 'new', toSlug: 'old' },
    );
    expect(indexerMocks.rebuildPageIndex).toHaveBeenCalledOnce();
    expect(indexerMocks.indexTouchedPages).toHaveBeenCalledWith('s1', ['new', 'old']);
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
  it('expectedPreHead 不匹配时在锁内拒绝且不创建 operation 或写文件', async () => {
    const cs = makeChangeset([
      { action: 'create', path: 'wiki/general/a.md', content: VALID_CONTENT },
    ]);

    await expect(
      applyChangeset(cs, undefined, { expectedPreHead: 'older-sha' }),
    ).rejects.toMatchObject({ code: 'ACTION_STALE_PREVIEW' });

    expect(mutexMocks.acquireVaultLock.mock.invocationCallOrder[0])
      .toBeLessThan(gitMocks.getVaultHead.mock.invocationCallOrder[0]);
    expect(dbMocks.prepare).not.toHaveBeenCalled();
    expect(storeMocks.writeVaultFiles).not.toHaveBeenCalled();
    expect(storeMocks.deleteVaultFile).not.toHaveBeenCalled();
    expect(indexerMocks.indexTouchedPages).not.toHaveBeenCalled();
    expect(gitMocks.commitVaultChanges).not.toHaveBeenCalled();
    expect(mutexMocks.release).toHaveBeenCalledTimes(1);
  });

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

  it('move marker 迁移派生缓存、全量重建链接索引，并把 auxiliary sidecar 纳入同一 commit', async () => {
    identityMocks.collectPageIdentityMoves.mockReturnValue([
      { fromSlug: 'old', toSlug: 'new' },
    ]);
    const sidecarPath = '.llm-wiki/sources/general/source-1.json';
    const cs = makeChangeset([
      {
        action: 'create', path: 'wiki/general/new.md', content: VALID_CONTENT,
        movedFromPath: 'wiki/general/old.md',
      },
      { action: 'delete', path: 'wiki/general/old.md', content: null },
      { action: 'update', path: sidecarPath, content: '{}', auxiliary: true },
    ]);

    await applyChangeset(cs);

    expect(identityMocks.migratePageIdentityCaches).toHaveBeenCalledWith(
      's1', { fromSlug: 'old', toSlug: 'new' },
    );
    expect(indexerMocks.rebuildPageIndex).toHaveBeenCalledOnce();
    expect(indexerMocks.indexTouchedPages).toHaveBeenCalledWith('s1', ['new', 'old']);
    expect(storeMocks.writeVaultFiles).toHaveBeenCalledWith([
      { path: 'wiki/general/new.md', content: VALID_CONTENT },
      { path: sidecarPath, content: '{}' },
    ]);
    expect(gitMocks.commitVaultChanges).toHaveBeenCalledWith(
      expect.any(String),
      ['wiki/general/new.md', 'wiki/general/old.md', sidecarPath],
    );
  });

  it('锁内发现 Subject 已删除时拒绝写入并释放 vault 锁', async () => {
    dbMocks.get.mockReturnValueOnce(undefined);
    const cs = makeChangeset([
      { action: 'create', path: 'wiki/general/a.md', content: VALID_CONTENT },
    ]);

    await expect(applyChangeset(cs)).rejects.toMatchObject({
      code: 'SUBJECT_MUTATION_UNAVAILABLE',
      subjectId: 's1',
    });
    expect(storeMocks.writeVaultFiles).not.toHaveBeenCalled();
    expect(gitMocks.commitVaultChanges).not.toHaveBeenCalled();
    expect(mutexMocks.release).toHaveBeenCalledTimes(1);
  });

  it('锁内发现 mutation epoch 已变化时拒绝旧同步计划', async () => {
    dbMocks.get.mockReturnValueOnce({ maintenance_state: 'active', mutation_epoch: 4 });
    const cs = makeChangeset([
      { action: 'update', path: 'wiki/general/a.md', content: VALID_CONTENT },
    ], { mutationEpoch: 3 });

    await expect(applyChangeset(cs)).rejects.toMatchObject({
      code: 'SUBJECT_MUTATION_UNAVAILABLE',
      subjectId: 's1',
    });
    expect(storeMocks.writeVaultFiles).not.toHaveBeenCalled();
    expect(gitMocks.commitVaultChanges).not.toHaveBeenCalled();
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

  it('sidecar 写入发生在 git commit 成功之后（commit 前不触碰 sidecar）', async () => {
    const callOrder: string[] = [];
    gitMocks.commitVaultChanges.mockImplementationOnce(async () => {
      callOrder.push('commit');
      return 'post-sha';
    });
    const updateSourcePageLinks = vi.fn(() => {
      callOrder.push('sidecar');
    });
    const cs = makeChangeset([
      { action: 'create', path: 'wiki/general/a.md', content: VALID_CONTENT },
    ]);
    await applyChangeset(cs, {
      links: [{ sourceId: 'src-1', pageSlugs: ['a'] }],
      linkPageSource: vi.fn(() => true),
      updateSourcePageLinks,
    });
    expect(callOrder).toEqual(['commit', 'sidecar']);
  });

  it('索引事务成功后、git commit 前抛错：回滚删除本次新插入的 page_sources 行，sidecar 从未被调用', async () => {
    gitMocks.commitVaultChanges.mockRejectedValueOnce(new Error('git boom'));
    const linkPageSource = vi.fn(() => true); // 模拟真正新插入
    const unlinkPageSource = vi.fn();
    const updateSourcePageLinks = vi.fn();
    const cs = makeChangeset([
      { action: 'create', path: 'wiki/general/a.md', content: VALID_CONTENT },
    ]);

    await expect(
      applyChangeset(cs, {
        links: [{ sourceId: 'src-1', pageSlugs: ['a'] }],
        linkPageSource,
        updateSourcePageLinks,
        unlinkPageSource,
      })
    ).rejects.toThrow('git boom');

    expect(linkPageSource).toHaveBeenCalledWith('s1', 'a', 'src-1');
    // 回滚补偿：本次新插入的一行被删除
    expect(unlinkPageSource).toHaveBeenCalledWith('s1', 'a', 'src-1');
    expect(unlinkPageSource).toHaveBeenCalledTimes(1);
    // sidecar 顺序调整后在 commit 之前从未被调用，也不需要回滚
    expect(updateSourcePageLinks).not.toHaveBeenCalled();
  });

  it('linkPageSource 返回 false（本次之前已存在的行）时不计入回滚补偿——不误删预先存在的行', async () => {
    gitMocks.commitVaultChanges.mockRejectedValueOnce(new Error('git boom'));
    const linkPageSource = vi.fn(() => false); // 已存在，本次未新插入
    const unlinkPageSource = vi.fn();
    const cs = makeChangeset([
      { action: 'create', path: 'wiki/general/a.md', content: VALID_CONTENT },
    ]);

    await expect(
      applyChangeset(cs, {
        links: [{ sourceId: 'src-1', pageSlugs: ['a'] }],
        linkPageSource,
        updateSourcePageLinks: vi.fn(),
        unlinkPageSource,
      })
    ).rejects.toThrow('git boom');

    expect(unlinkPageSource).not.toHaveBeenCalled();
  });
});

describe('rollbackChangeset 的 page_sources 补偿', () => {
  it('按 compensation.insertedSourceLinks 清单逐条删除，未提供 unlinkPageSource 时不报错也不清理', async () => {
    const cs = makeChangeset(
      [{ action: 'create', path: 'wiki/general/a.md', content: 'x' }],
      { preHead: 'pre-sha' }
    );
    await expect(rollbackChangeset(cs)).resolves.toBeUndefined();
    await expect(
      rollbackChangeset(cs, { insertedSourceLinks: [{ pageSlug: 'a', sourceId: 'src-1' }] })
    ).resolves.toBeUndefined();
  });

  it('unlinkPageSource 抛错时被吞掉（best effort）', async () => {
    const cs = makeChangeset(
      [{ action: 'create', path: 'wiki/general/a.md', content: 'x' }],
      { preHead: 'pre-sha' }
    );
    const unlinkPageSource = vi.fn(() => {
      throw new Error('unlink boom');
    });
    await expect(
      rollbackChangeset(cs, {
        insertedSourceLinks: [{ pageSlug: 'a', sourceId: 'src-1' }],
        unlinkPageSource,
      })
    ).resolves.toBeUndefined();
    expect(unlinkPageSource).toHaveBeenCalledWith('s1', 'a', 'src-1');
  });
});
