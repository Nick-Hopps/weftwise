import { describe, expect, it, vi } from 'vitest';

const repoMocks = vi.hoisted(() => ({
  getAllPages: vi.fn(() => [
    { slug: 'b', title: 'B', summary: 'sb', tags: ['x'], updatedAt: '2026-01-01' },
    { slug: 'm', title: 'Meta', summary: '', tags: ['meta'], updatedAt: '2026-01-01' },
  ]),
  isMetaPage: vi.fn((p: { tags?: string[] }) => (p.tags ?? []).includes('meta')),
}));
const imageMocks = vi.hoisted(() => ({
  generateImageAsset: vi.fn(async () => ({
    output: { type: 'image', path: 'assets/general/id.png', url: '/api/assets/general/id.png', alt: '示意图' },
    asset: { path: 'assets/general/id.png', content: 'aW1hZ2U=' },
  })),
}));
vi.mock('../../../db/repos/pages-repo', () => repoMocks);
vi.mock('../builtin/image-generate', () => imageMocks);

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
    budget: { chargeTokens: vi.fn() },
    pending: { entries: [] },
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
    const result = await ctx.listPages();
    expect(result.pages.map((p) => p.slug)).toEqual(['b']);
    expect(result.nextCursor).toBeNull();
  });

  it('不暴露原 AgentContext 逃生舱；onAccess 不设置', () => {
    const ctx = agentToolContext(fakeAgent());
    expect('agent' in ctx).toBe(false);
    expect(ctx.onAccess).toBeUndefined();
  });

  it('用运行时 Unicode slug 绑定图片资产，不让模型提供页面身份', async () => {
    const agent = fakeAgent();
    const ctx = agentToolContext(agent, '3d图形学基础');

    await expect(ctx.generateImage?.({ prompt: '展示坐标变换', alt: '坐标变换示意图' }))
      .resolves.toMatchObject({ type: 'image' });
    expect(agent.pending.entries).toContainEqual(expect.objectContaining({
      path: 'assets/general/id.png',
      assetFor: '3d图形学基础',
    }));
  });

  it('没有当前页面身份时不注入图片能力', () => {
    expect(agentToolContext(fakeAgent()).generateImage).toBeUndefined();
  });
});
