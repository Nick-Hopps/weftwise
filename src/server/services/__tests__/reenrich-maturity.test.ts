import { describe, it, expect } from 'vitest';
import { deriveMaturityUpdate } from '../reenrich-service';

const NOW = new Date('2026-06-23T00:00:00.000Z');
const draft = '# T\nprose';
const enriched = '# T\nprose\n\n> [!intuition] 💡\n> a\n\n> [!example] 📝\n> b';

describe('deriveMaturityUpdate', () => {
  it('首遍（current 为 null）按新增 callout 数推进', () => {
    const r = deriveMaturityUpdate({ draftContent: draft, finalContent: enriched, current: null, now: NOW });
    // 新增 2 callout（< 3）→ 阶梯从默认 1 起 +1 = 3
    expect(r.intervalDays).toBe(3);
    expect(r.passes).toBe(1);
    expect(r.state).toBe('active');
  });

  it('零新增 + 已 3 遍 → 毕业', () => {
    const r = deriveMaturityUpdate({
      draftContent: enriched,
      finalContent: enriched, // 无新增
      current: { subjectId: 's', slug: 'p', passes: 3, lastEnrichedAt: null, intervalDays: 7, nextDueAt: NOW.toISOString(), state: 'active', priority: 0, updatedAt: NOW.toISOString() },
      now: NOW,
    });
    expect(r.state).toBe('graduated');
  });

  it('纯正文补全（无新 callout）也推进成熟度、不判 saturation', () => {
    const draft = 'x'.repeat(200);
    const final = 'x'.repeat(200 + 400 * 3); // 正文增量 → 等效 3 个 callout
    const next = deriveMaturityUpdate({ draftContent: draft, finalContent: final, current: null, now: NOW });
    // newIncrement=3 ≥ SUBSTANTIAL_INCREMENT → 停当前档（active，不毕业）
    expect(next.state).toBe('active');
  });
});
