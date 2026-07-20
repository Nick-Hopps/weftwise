import { describe, expect, it } from 'vitest';
import { isMatchingResearchRunUpdate } from '../research-run-updated-event';

describe('isMatchingResearchRunUpdate', () => {
  it('只接受同一 run 与 Subject 的权威更新', () => {
    const current = { id: 'run-1', subjectId: 'subject-1' };
    expect(isMatchingResearchRunUpdate(current, {
      id: 'run-1', subjectId: 'subject-1', status: 'importing',
    })).toBe(true);
    expect(isMatchingResearchRunUpdate(current, {
      id: 'run-2', subjectId: 'subject-1', status: 'importing',
    })).toBe(false);
    expect(isMatchingResearchRunUpdate(current, {
      id: 'run-1', subjectId: 'subject-2', status: 'importing',
    })).toBe(false);
  });
});
