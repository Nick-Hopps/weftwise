import { describe, it, expect } from 'vitest';
import { LOCAL_USER_ID, resolveUserId } from '../user';

describe('resolveUserId', () => {
  it('当前单例：恒返回 LOCAL_USER_ID', () => {
    expect(resolveUserId({} as never)).toBe(LOCAL_USER_ID);
    expect(LOCAL_USER_ID).toBe('local');
  });
});
