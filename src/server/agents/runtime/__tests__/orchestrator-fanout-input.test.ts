import { describe, it, expect } from 'vitest';
import { buildFanoutInput } from '../orchestrator';

// buildFanoutInput 仅用到 ctx.emit 与 ctx.chunkStore（item.sourceRefs 为空时不读 chunkStore）
function stubCtx(): any {
  return { emit: () => {}, chunkStore: new Map() };
}

describe('buildFanoutInput', () => {
  it('把 expositionDirective 与 augmentationDirective 一并注入每页输入', async () => {
    const carry = {
      subjectSlug: 'general',
      existingPages: [],
      plan: { pages: [] },
      languageDirective: 'LANG',
      augmentationDirective: 'AUG',
      expositionDirective: 'EXPO',
    };
    const item = { slug: 'foo', title: 'Foo', sourceRefs: [] };
    const out = (await buildFanoutInput(carry, item, stubCtx(), {})) as Record<string, unknown>;
    expect(out.expositionDirective).toBe('EXPO');
    expect(out.augmentationDirective).toBe('AUG');
    expect(out.slug).toBe('foo');
  });
});
