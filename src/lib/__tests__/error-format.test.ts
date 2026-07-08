import { describe, it, expect } from 'vitest';
import { describeErrorMessage } from '../error-format';

class FakeRetryError extends Error {
  lastError: unknown;
  constructor(message: string, lastError: unknown) {
    super(message);
    this.name = 'AI_RetryError';
    this.lastError = lastError;
  }
}

describe('describeErrorMessage', () => {
  it('普通 Error 原样返回 message', () => {
    expect(describeErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('非 Error 值转字符串返回', () => {
    expect(describeErrorMessage('boom')).toBe('boom');
  });

  it('lastError message 为空、cause 为字符串时补上 root cause', () => {
    const lastError = Object.assign(new Error(''), { cause: 'terminated' });
    const err = new FakeRetryError('Failed after 3 attempts. Last error: ', lastError);
    expect(describeErrorMessage(err)).toBe(
      'Failed after 3 attempts. Last error:  [root cause: terminated]'
    );
  });

  it('lastError 有自己的 message 时补上（真实原因已经在 message 里则不重复）', () => {
    const err = new FakeRetryError(
      'Failed after 3 attempts. Last error: bad response status code 524',
      new Error('bad response status code 524')
    );
    expect(describeErrorMessage(err)).toBe(
      'Failed after 3 attempts. Last error: bad response status code 524'
    );
  });

  it('lastError message 未被外层 message 包含时补上', () => {
    const err = new FakeRetryError('Failed after 3 attempts.', new Error('econnreset'));
    expect(describeErrorMessage(err)).toBe('Failed after 3 attempts. [root cause: econnreset]');
  });

  it('lastError 既无 message 又无 cause 时退回 name', () => {
    const lastError = new Error('');
    lastError.name = 'CustomError';
    const err = new FakeRetryError('Failed after 3 attempts. Last error: ', lastError);
    expect(describeErrorMessage(err)).toBe(
      'Failed after 3 attempts. Last error:  [root cause: CustomError]'
    );
  });

  it('没有 lastError 字段的普通 Error 不受影响', () => {
    const err = new Error('No object generated: response did not match schema.');
    expect(describeErrorMessage(err)).toBe(err.message);
  });
});
