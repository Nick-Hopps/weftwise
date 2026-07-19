import { describe, expect, it } from 'vitest';
import {
  pageViewPreferenceKey,
  readPageViewPreference,
  writePageViewPreference,
} from '../page-view-preference';

function memoryStorage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    value: (key: string) => values.get(key),
  };
}

describe('page view preference', () => {
  it('按 subject 与页面 slug 隔离存储 key', () => {
    expect(pageViewPreferenceKey('general', 'nested/page'))
      .toBe('wiki:page-view:general:nested%2Fpage');
    expect(pageViewPreferenceKey('notes', 'nested/page'))
      .not.toBe(pageViewPreferenceKey('general', 'nested/page'));
  });

  it('缺失或非法值回退到 reshape，保持既有默认行为', () => {
    const storage = memoryStorage({
      [pageViewPreferenceKey('general', 'bad')]: 'unexpected',
    });
    expect(readPageViewPreference(storage, 'general', 'missing')).toBe('reshape');
    expect(readPageViewPreference(storage, 'general', 'bad')).toBe('reshape');
  });

  it('写入后只恢复当前页面的 canonical 偏好', () => {
    const storage = memoryStorage();
    writePageViewPreference(storage, 'general', 'a', 'canonical');
    expect(readPageViewPreference(storage, 'general', 'a')).toBe('canonical');
    expect(readPageViewPreference(storage, 'general', 'b')).toBe('reshape');
  });

  it('浏览器禁用存储时读写均安全降级', () => {
    const storage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    expect(readPageViewPreference(storage, 'general', 'page')).toBe('reshape');
    expect(() => writePageViewPreference(storage, 'general', 'page', 'canonical')).not.toThrow();
  });
});
