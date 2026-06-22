import { describe, it, expect } from 'vitest';
import { deriveConversationTitle } from '../conversation-title';

describe('deriveConversationTitle', () => {
  it('普通问题原样（trim）', () => {
    expect(deriveConversationTitle('  什么是向量检索  ')).toBe('什么是向量检索');
  });
  it('只取首行', () => {
    expect(deriveConversationTitle('第一行问题\n第二行补充')).toBe('第一行问题');
  });
  it('折叠内部多空白为单空格', () => {
    expect(deriveConversationTitle('a    b\tc')).toBe('a b c');
  });
  it('超 60 字截断', () => {
    const long = 'x'.repeat(80);
    expect(deriveConversationTitle(long)).toHaveLength(60);
  });
  it('空 / 全空白 → 兜底', () => {
    expect(deriveConversationTitle('')).toBe('New conversation');
    expect(deriveConversationTitle('   \n  ')).toBe('New conversation');
  });
});
