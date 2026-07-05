import { describe, it, expect } from 'vitest';
import { decideClaim } from '../worker';

describe('decideClaim', () => {
  it('完全空闲 → 可 claim 任意类型', () => {
    expect(decideClaim([], 2)).toBe('any');
  });

  it('全是 ingest 且未满额 → 只允许再 claim ingest', () => {
    expect(decideClaim(['ingest'], 2)).toBe('ingest-only');
    expect(decideClaim(['ingest', 'ingest'], 3)).toBe('ingest-only');
  });

  it('全是 ingest 且已满额 → 不 claim', () => {
    expect(decideClaim(['ingest', 'ingest'], 2)).toBe('none');
    expect(decideClaim(['ingest'], 1)).toBe('none');
  });

  it('有非 ingest 在跑 → 独占，不 claim', () => {
    expect(decideClaim(['lint'], 2)).toBe('none');
    expect(decideClaim(['curate'], 4)).toBe('none');
  });

  it('limit=1 时行为等同串行现状', () => {
    expect(decideClaim([], 1)).toBe('any');
    expect(decideClaim(['ingest'], 1)).toBe('none');
    expect(decideClaim(['fix'], 1)).toBe('none');
  });
});
