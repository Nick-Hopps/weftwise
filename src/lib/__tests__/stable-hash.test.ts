import { describe, it, expect } from 'vitest';
import { fnv1a } from '../stable-hash';

describe('fnv1a', () => {
  it('同输入同输出（跨调用稳定）', () => {
    expect(fnv1a('why does backprop keep activations?')).toBe(
      fnv1a('why does backprop keep activations?'),
    );
  });

  it('不同输入不同输出（抽样，含仅一字之差）', () => {
    const samples = [
      '',
      'a',
      'b',
      'ab',
      'ba',
      '为什么反向传播需要保存中间激活值？',
      '为什么反向传播需要保存中间激活值。',
      'The quick brown fox',
      'The quick brown fix',
    ];
    expect(new Set(samples.map(fnv1a)).size).toBe(samples.length);
  });

  it('输出是稳定的小写 hex，不随平台变化', () => {
    // 写死期望值：这是 quiz 的跨会话身份，一旦漂移所有既有证据都会失配。
    expect(fnv1a('')).toBe('811c9dc5');
    expect(fnv1a('a')).toBe('e40c292c');
    expect(fnv1a('foobar')).toBe('bf9cf968');
    expect(fnv1a('中文')).toBe(fnv1a('中文'));
    expect(fnv1a('foobar')).toMatch(/^[0-9a-f]{8}$/);
  });
});
