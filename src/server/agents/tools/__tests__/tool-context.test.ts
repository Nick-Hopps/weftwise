import { describe, expect, it, vi } from 'vitest';

const repoMocks = vi.hoisted(() => ({
  getAllPages: vi.fn(() => [
    { slug: 'b', title: 'B', summary: 'sb', tags: ['x'] },
    { slug: 'm', title: 'Meta', summary: '', tags: ['meta'] },
  ]),
  isMetaPage: vi.fn((p: { tags?: string[] }) => (p.tags ?? []).includes('meta')),
}));
vi.mock('../../../db/repos/pages-repo', () => repoMocks);

import { agentToolContext } from '../tool-context';
import type { AgentContext } from '../../types';

function fakeAgent(): AgentContext {
  return {
    subject: { id: 's1', slug: 'general' },
    emit: vi.fn(),
    overlay: {
      readPage: vi.fn(async (_subjectSlug: string, slug: string) =>
        slug === 'b' ? { markdown: '---\ntitle: B Title\n---\nbody-b' } : null),
      search: vi.fn(async () => [{ slug: 'b', title: 'B', summary: 'sb', source: 'store' }]),
    },
  } as unknown as AgentContext;
}

describe('agentToolContext', () => {
  it('readPage 经 overlay 读取并从 frontmatter 解析 title', async () => {
    const ctx = agentToolContext(fakeAgent());
    expect(await ctx.readPage('b')).toEqual({ title: 'B Title', markdown: '---\ntitle: B Title\n---\nbody-b' });
    expect(await ctx.readPage('missing')).toBeNull();
  });

  it('search 经 overlay.search，裁剪到 {slug,title,summary}', async () => {
    const ctx = agentToolContext(fakeAgent());
    expect(await ctx.search('q', 5)).toEqual([{ slug: 'b', title: 'B', summary: 'sb' }]);
  });

  it('listPages 排除 meta 页', async () => {
    const ctx = agentToolContext(fakeAgent());
    const pages = await ctx.listPages();
    expect(pages.map((p) => p.slug)).toEqual(['b']);
  });

  it('不暴露原 AgentContext 逃生舱；onAccess 不设置', () => {
    const ctx = agentToolContext(fakeAgent());
    expect('agent' in ctx).toBe(false);
    expect(ctx.onAccess).toBeUndefined();
  });
});
