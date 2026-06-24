import { describe, it, expect } from 'vitest';
import { injectMissingThinkingSignatures } from '../provider-factory';

/**
 * 兼容代理（packyapi）的 Anthropic 端点返回的 thinking 块缺 signature 字段，
 * 会被 @ai-sdk/anthropic 响应 schema 拒绝。injectMissingThinkingSignatures
 * 给缺失项补占位空串使响应过校验——以下覆盖其改写边界。
 */
describe('injectMissingThinkingSignatures', () => {
  it('给缺失 signature 的 thinking 块补空串并返回 true', () => {
    const body = {
      content: [
        { type: 'thinking', thinking: 'reasoning…' },
        { type: 'tool_use', id: 't1', name: 'search', input: { query: 'x' } },
      ],
    };
    expect(injectMissingThinkingSignatures(body)).toBe(true);
    expect(body.content[0]).toMatchObject({ type: 'thinking', signature: '' });
  });

  it('signature 已是字符串时不改写、返回 false', () => {
    const body = {
      content: [{ type: 'thinking', thinking: 'r', signature: 'abc123' }],
    };
    expect(injectMissingThinkingSignatures(body)).toBe(false);
    expect(body.content[0].signature).toBe('abc123');
  });

  it('多个 thinking 块只补缺失的那些', () => {
    const body = {
      content: [
        { type: 'thinking', thinking: 'a', signature: 'sig' },
        { type: 'text', text: '' },
        { type: 'thinking', thinking: 'b' },
      ],
    };
    expect(injectMissingThinkingSignatures(body)).toBe(true);
    expect(body.content[0].signature).toBe('sig');
    expect((body.content[2] as { signature?: string }).signature).toBe('');
  });

  it('不碰非 thinking 块（text / tool_use 原样保留）', () => {
    const body = {
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', id: 't1', name: 'search', input: { query: 'x' } },
      ],
    };
    expect(injectMissingThinkingSignatures(body)).toBe(false);
    expect(body.content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 't1', name: 'search', input: { query: 'x' } },
    ]);
  });

  it('content 非数组 / body 非对象 → 安全返回 false', () => {
    expect(injectMissingThinkingSignatures(null)).toBe(false);
    expect(injectMissingThinkingSignatures('str')).toBe(false);
    expect(injectMissingThinkingSignatures({})).toBe(false);
    expect(injectMissingThinkingSignatures({ content: 'nope' })).toBe(false);
  });
});
