import { describe, expect, it } from 'vitest';
import {
  buildUrlAuthSubmissionBody,
  currentUrlAuthChallenge,
  jobResultRequiresUrlAuth,
} from '../ingest-auth';

function event(type: string, data?: Record<string, unknown>, id = `event-${type}`) {
  return {
    id,
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
      challengeId: 'event-ingest:auth-required',
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
      event('ingest:auth-required', { ...challenge, status: 403 }, 'challenge-2'),
      event('job:failed'),
    ])).toEqual({
      challengeId: 'challenge-2',
      status: 403,
      authOrigin: 'https://example.com',
      sourceId: 'source-1',
    });
  });

  it('用户取消任务后旧 challenge 失效', () => {
    expect(currentUrlAuthChallenge([
      event('ingest:auth-required', challenge),
      event('job:failed'),
      event('job:cancelled'),
    ])).toBeNull();
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

  it('缺少持久化 event ID 时不产生可自动恢复的 challenge', () => {
    expect(currentUrlAuthChallenge([{
      type: 'ingest:auth-required',
      data: { message: 'auth', data: challenge },
    }])).toBeNull();
  });
});

describe('jobResultRequiresUrlAuth', () => {
  it('只接受持久化的安全 error code', () => {
    expect(jobResultRequiresUrlAuth(JSON.stringify({
      error: { code: 'url-auth-required', message: 'Authentication required' },
    }))).toBe(true);
    expect(jobResultRequiresUrlAuth(JSON.stringify({
      error: { code: 'url-auth-required', message: 'Authentication required' },
      cancelled: true,
    }))).toBe(false);
    expect(jobResultRequiresUrlAuth(JSON.stringify({
      error: { message: 'Authentication required' },
    }))).toBe(false);
    expect(jobResultRequiresUrlAuth('{broken')).toBe(false);
    expect(jobResultRequiresUrlAuth(null)).toBe(false);
  });
});

describe('buildUrlAuthSubmissionBody', () => {
  it('使用 job 自身 Subject 并只提交规范化后的非空凭证', () => {
    expect(buildUrlAuthSubmissionBody({
      subjectId: 'research-subject',
      cookie: '  session=secret  ',
      authorization: '   ',
    })).toEqual({
      subjectId: 'research-subject',
      cookie: 'session=secret',
    });
  });
});
