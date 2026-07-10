import { describe, expect, it, vi } from 'vitest';
vi.mock('ai', () => ({ tool: vi.fn((def) => def) }));

import { z } from 'zod';
import { toProviderToolName, compileToolSet, synthesizeFinishTool, FINISH_TOOL_NAME } from '../compile';
import { createToolExecutionPolicy, resolveToolProfile } from '../profiles';
import type { ToolContext } from '../tool-context';
import type { ToolDef } from '../../types';

const ctx = { subject: { id: 's', slug: 'general' } } as ToolContext;
const echoTool: ToolDef = {
  name: 'wiki.read', source: 'builtin', description: 'd',
  inputSchema: z.object({ slug: z.string() }), outputSchema: z.object({ ok: z.boolean() }),
  sideEffect: 'none', handler: async () => ({ ok: true }),
};
const deleteTool: ToolDef = {
  name: 'wiki.delete', source: 'builtin', description: 'd',
  inputSchema: z.object({ slug: z.string() }), outputSchema: z.object({ ok: z.boolean() }),
  sideEffect: 'destructive', handler: async () => ({ ok: true }),
};
const scopedReadTool: ToolDef = {
  name: 'wiki.read', source: 'builtin', description: 'd',
  inputSchema: z.object({ slug: z.string() }),
  outputSchema: z.object({ found: z.boolean(), title: z.string().nullable(), markdown: z.string().nullable() }),
  sideEffect: 'none',
  async handler(input, toolCtx) {
    const page = await toolCtx.readPage((input as { slug: string }).slug);
    return page
      ? { found: true, title: page.title, markdown: page.markdown }
      : { found: false, title: null, markdown: null };
  },
};
const updateTool: ToolDef = {
  name: 'wiki.update', source: 'builtin', description: 'd',
  inputSchema: z.object({ slug: z.string(), body: z.string() }),
  outputSchema: z.object({ ok: z.boolean() }),
  sideEffect: 'update', handler: async () => ({ ok: true }),
};

describe('toProviderToolName', () => {
  it('点号转下划线、冲突加后缀', () => {
    const used = new Set<string>();
    expect(toProviderToolName('wiki.read', used)).toBe('wiki_read');
    used.add('wiki_read');
    expect(toProviderToolName('wiki.read', used)).toBe('wiki_read_2');
  });
});

describe('compileToolSet', () => {
  it('点号名转 provider 安全名；execute 调 handler 并计步', async () => {
    const chargeStep = vi.fn();
    const set = compileToolSet([echoTool], ctx, {
      policy: createToolExecutionPolicy(resolveToolProfile('query:read'), 's'),
      chargeStep,
    });
    expect(Object.keys(set)).toEqual(['wiki_read']);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await (set.wiki_read as any).execute({ slug: 'a' });
    expect(out).toEqual({ ok: true });
    expect(chargeStep).toHaveBeenCalledOnce();
  });

  it('过滤 profile allowlist 外工具', () => {
    const set = compileToolSet([echoTool, deleteTool], ctx, {
      policy: createToolExecutionPolicy(resolveToolProfile('query:read'), 's'),
    });
    expect(Object.keys(set)).toEqual(['wiki_read']);
  });

  it('profile 允许但 runner policy 禁止的副作用在编译期报错', () => {
    const profile = resolveToolProfile('curate:manual');
    expect(() => compileToolSet([deleteTool], ctx, {
      policy: {
        ...createToolExecutionPolicy(profile, 's'),
        allowedSideEffects: new Set(['none']),
      },
    })).toThrow(/SIDE_EFFECT_NOT_ALLOWED/);
  });

  it('worker 写工具缺少匹配的 job capability 时拒绝编译', () => {
    const profile = resolveToolProfile('fix:contradiction');
    expect(() => compileToolSet([updateTool], ctx, {
      policy: createToolExecutionPolicy(profile, 's'),
    })).toThrow(/TOOL_NOT_ALLOWED.*job capability/i);
  });

  it('审计输入不记录页面正文', async () => {
    const onToolCall = vi.fn();
    const profile = resolveToolProfile('fix:contradiction');
    const set = compileToolSet([updateTool], ctx, {
      policy: createToolExecutionPolicy(profile, 's', {
        jobCapability: { jobId: 'job-fix', jobType: 'fix' },
      }),
      onToolCall,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (set.wiki_update as any).execute({ slug: 'a', body: '完整秘密正文' });
    expect(onToolCall).toHaveBeenCalledWith(expect.objectContaining({
      input: { slug: 'a', body: '[REDACTED]' },
    }));
  });

  it('scope 外 read 返回 missing，search 结果被过滤', async () => {
    const readPage = vi.fn(async (slug: string) => ({ title: slug, markdown: slug }));
    const search = vi.fn(async () => [
      { slug: 'inside', title: 'Inside', summary: '' },
      { slug: 'outside', title: 'Outside', summary: '' },
    ]);
    const scopedCtx = { ...ctx, readPage, search } as ToolContext;
    const profile = resolveToolProfile('curate:auto');
    const set = compileToolSet([scopedReadTool], scopedCtx, {
      policy: createToolExecutionPolicy(profile, 's', {
        allowedPageSlugs: new Set(['inside']),
      }),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outside = await (set.wiki_read as any).execute({ slug: 'outside' });
    expect(outside).toEqual({ found: false, title: null, markdown: null });
    expect(readPage).not.toHaveBeenCalled();
  });
});

describe('synthesizeFinishTool', () => {
  it('finish.execute 捕获校验后入参', async () => {
    let captured: unknown;
    const set = synthesizeFinishTool(z.object({ title: z.string() }), (v) => { captured = v; });
    expect(Object.keys(set)).toEqual([FINISH_TOOL_NAME]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (set.finish as any).execute({ title: 'T' });
    expect(captured).toEqual({ title: 'T' });
  });
});
