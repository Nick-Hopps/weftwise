import { describe, it, expect } from 'vitest';
import { buildReenrichInitialInput, reenrichSteps, buildProfileHint } from '../reenrich-service';

describe('reenrich input', () => {
  it('reenrichSteps 固定为 supplement → enricher fanout → verify', () => {
    const steps = reenrichSteps();
    expect(steps.map((s) => ('skillId' in s ? s.skillId : s.kind))).toEqual(['reenrich-supplement', 'ingest-enricher', 'verify']);
    expect((steps[0] as { injectPriorPageAs?: string }).injectPriorPageAs).toBe('draftContent');
  });

  it('initialInput 把现有正文 seed 进 writerOutputs 供 enricher 读 draft', () => {
    const input = buildReenrichInitialInput({
      slug: 'eigenvalues',
      title: 'Eigenvalues',
      summary: 's',
      subjectSlug: 'general',
      draftContent: '# Eigenvalues\nbody',
      languageDirective: 'LANG',
      augmentationDirective: 'AUG',
      profileHint: 'HINT',
    }) as {
      plan: { pages: Array<{ slug: string }> };
      writerOutputs: Array<{ path: string; content: string }>;
      existingPages: Array<{ slug: string }>;
      augmentationDirective: string;
    };
    expect(input.plan.pages[0].slug).toBe('eigenvalues');
    expect(input.writerOutputs[0].path).toBe('wiki/general/eigenvalues.md');
    expect(input.writerOutputs[0].content).toBe('# Eigenvalues\nbody');
    expect(input.existingPages[0].slug).toBe('eigenvalues'); // 命中 → action=update
    expect(input.augmentationDirective).toBe('AUG');
  });
});

describe('buildProfileHint', () => {
  it('有画像 → 探针提示含背景与阅读水平，且声明补充须中性', () => {
    const hint = buildProfileHint({
      backgroundSummary: '有本科数学基础，不熟计算机',
      stylePrefs: { readingLevel: 'beginner', verbosity: 'thorough', exampleDensity: 'many' },
    });
    expect(hint).toContain('有本科数学基础');
    expect(hint).toContain('beginner');
    expect(hint.toLowerCase()).toContain('neutral'); // 强调补充写成中性、普遍适用
  });
  it('无背景（空画像）→ 回落中性中级读者假设', () => {
    const hint = buildProfileHint({
      backgroundSummary: '',
      stylePrefs: { readingLevel: 'intermediate', verbosity: 'balanced', exampleDensity: 'some' },
    });
    expect(hint.toLowerCase()).toContain('general');
  });
});

describe('reenrichSteps 三阶段', () => {
  it('首步是 supplement，其后 enricher、verify', () => {
    const steps = reenrichSteps();
    expect(steps.map((s) => s.kind)).toEqual(['supplement', 'fanout', 'verify']);
    expect(steps[0]).toMatchObject({ kind: 'supplement', skillId: 'reenrich-supplement', injectPriorPageAs: 'draftContent', checkpointAs: 'supplement-page' });
  });
});

describe('buildReenrichInitialInput 携带 profileHint', () => {
  it('把 profileHint 写进 initialInput（供 orchestrator 转发给 supplement）', () => {
    const input = buildReenrichInitialInput({
      slug: 'qs', title: 'QS', summary: 's', subjectSlug: 'general',
      draftContent: '# body', languageDirective: 'L', augmentationDirective: 'A',
      profileHint: 'reader is a beginner',
    }) as { profileHint?: string; writerOutputs?: unknown[] };
    expect(input.profileHint).toBe('reader is a beginner');
    // writerOutputs 仍 seed 现有正文供 supplement 的 draftContent 注入
    expect(input.writerOutputs).toEqual([{ action: 'update', path: 'wiki/general/qs.md', content: '# body' }]);
  });
});
