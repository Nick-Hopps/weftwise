import { describe, expect, it, vi } from 'vitest';
vi.mock('ai', () => ({ tool: vi.fn((def) => def) }));

import { z } from 'zod';
import { toProviderToolName, compileToolSet, synthesizeFinishTool, FINISH_TOOL_NAME } from '../compile';
import type { ToolContext } from '../tool-context';
import type { ToolDef } from '../../types';

const ctx = { subject: { id: 's', slug: 'general' } } as ToolContext;
const echoTool: ToolDef = {
  name: 'wiki.read', source: 'builtin', description: 'd',
  inputSchema: z.object({ slug: z.string() }), outputSchema: z.object({ ok: z.boolean() }),
  sideEffect: 'none', handler: async () => ({ ok: true }),
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
    const set = compileToolSet([echoTool], ctx, { chargeStep });
    expect(Object.keys(set)).toEqual(['wiki_read']);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await (set.wiki_read as any).execute({ slug: 'a' });
    expect(out).toEqual({ ok: true });
    expect(chargeStep).toHaveBeenCalledOnce();
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
