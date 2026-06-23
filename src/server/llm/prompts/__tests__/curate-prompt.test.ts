import { describe, expect, it } from 'vitest';
import {
  buildCurateTriageUserPrompt,
  CurateTriageSchema,
  CURATE_TRIAGE_SYSTEM_PROMPT,
  buildCurateMergeConfirmUserPrompt,
  CurateMergeConfirmSchema,
  buildCurateSplitConfirmUserPrompt,
  CurateSplitConfirmSchema,
} from '../curate-prompt';

const ctx = { language: 'English', subject: { slug: 'general', name: 'General' } };

describe('buildCurateTriageUserPrompt', () => {
  it('注入语言指令 + 每页 slug/title/字数', () => {
    const out = buildCurateTriageUserPrompt(
      [{ slug: 'alpha', title: 'Alpha', summary: 's1', tags: ['t'], bodyChars: 1200 }],
      ctx,
    );
    expect(out).toContain('=== OUTPUT LANGUAGE ===');
    expect(out).toContain('alpha');
    expect(out).toContain('Alpha');
    expect(out).toContain('1200');
  });
});

describe('CurateTriageSchema', () => {
  it('缺数组时默认空', () => {
    expect(CurateTriageSchema.parse({})).toEqual({ merges: [], splits: [] });
  });
  it('接受合法候选', () => {
    const v = CurateTriageSchema.parse({
      merges: [{ aSlug: 'a', bSlug: 'b', reason: 'dup' }],
      splits: [{ slug: 'c', reason: 'too big' }],
    });
    expect(v.merges[0].aSlug).toBe('a');
    expect(v.splits[0].slug).toBe('c');
  });
});

describe('curate confirm schemas', () => {
  it('merge confirm 需要 proceed + reason', () => {
    expect(CurateMergeConfirmSchema.parse({ proceed: true, targetSlug: 'a', reason: 'r' }).proceed).toBe(true);
    expect(CurateMergeConfirmSchema.safeParse({ targetSlug: 'a' }).success).toBe(false);
  });
  it('split confirm 接受可选 hint', () => {
    expect(CurateSplitConfirmSchema.parse({ proceed: false, reason: 'r' }).hint).toBeUndefined();
  });
});

describe('confirm prompt builders', () => {
  it('merge-confirm 含两页正文', () => {
    const out = buildCurateMergeConfirmUserPrompt(
      { slug: 'a', title: 'A', body: 'body-a' },
      { slug: 'b', title: 'B', body: 'body-b' },
      ctx,
    );
    expect(out).toContain('body-a');
    expect(out).toContain('body-b');
  });
  it('split-confirm 含页面正文', () => {
    const out = buildCurateSplitConfirmUserPrompt({ slug: 'c', title: 'C', body: 'body-c' }, ctx);
    expect(out).toContain('body-c');
  });
});

describe('CURATE_TRIAGE_SYSTEM_PROMPT', () => {
  it('是非空字符串且强调保守', () => {
    expect(typeof CURATE_TRIAGE_SYSTEM_PROMPT).toBe('string');
    expect(CURATE_TRIAGE_SYSTEM_PROMPT.toLowerCase()).toContain('conservative');
  });
});
