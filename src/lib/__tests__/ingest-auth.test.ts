import { describe, expect, it } from 'vitest';
import { currentUrlAuthChallenge, jobResultRequiresUrlAuth } from '../ingest-auth';

function event(type: string, data?: Record<string, unknown>) {
  return {
    type,
    data: {
      message: type,
      data: data ?? null,
    },
  };
}

const challenge = {
  code: 'url-auth-required',
  status: 401,
  authOrigin: 'https://example.com',
  sourceId: 'source-1',
};

describe('currentUrlAuthChallenge', () => {
  it('读取 SSE 嵌套 payload 中当前 401/403 challenge', () => {
    expect(currentUrlAuthChallenge([
      event('ingest:start'),
      event('ingest:auth-required', challenge),
      event('job:failed'),
    ])).toEqual({
      status: 401,
      authOrigin: 'https://example.com',
      sourceId: 'source-1',
    });
  });

  it('旧 challenge 之后发生 retry 时清空，下一轮新 challenge 可再次生效', () => {
    expect(currentUrlAuthChallenge([
      event('ingest:auth-required', challenge),
      event('job:failed'),
      event('job:retrying'),
      event('agent:error'),
      event('job:failed'),
    ])).toBeNull();
    expect(currentUrlAuthChallenge([
      event('ingest:auth-required', challenge),
      event('job:retrying'),
      event('ingest:auth-required', { ...challenge, status: 403 }),
      event('job:failed'),
    ])).toEqual({
      status: 403,
      authOrigin: 'https://example.com',
      sourceId: 'source-1',
    });
  });

  it('非法 code/status/origin/source fail closed', () => {
    expect(currentUrlAuthChallenge([
      event('ingest:auth-required', { ...challenge, code: 'other' }),
    ])).toBeNull();
    expect(currentUrlAuthChallenge([
      event('ingest:auth-required', { ...challenge, status: 500 }),
    ])).toBeNull();
    expect(currentUrlAuthChallenge([
      event('ingest:auth-required', { ...challenge, authOrigin: 'javascript:alert(1)' }),
    ])).toBeNull();
    expect(currentUrlAuthChallenge([
      event('ingest:auth-required', { ...challenge, sourceId: '' }),
    ])).toBeNull();
  });
});

describe('jobResultRequiresUrlAuth', () => {
  it('只接受持久化的安全 error code', () => {
    expect(jobResultRequiresUrlAuth(JSON.stringify({
      error: { code: 'url-auth-required', message: 'Authentication required' },
    }))).toBe(true);
    expect(jobResultRequiresUrlAuth(JSON.stringify({
      error: { message: 'Authentication required' },
    }))).toBe(false);
    expect(jobResultRequiresUrlAuth('{broken')).toBe(false);
    expect(jobResultRequiresUrlAuth(null)).toBe(false);
  });
});
