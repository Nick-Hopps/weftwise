import { describe, it, expect } from 'vitest';
import { validateUrlList, ingestUrlBatch, MAX_URLS_PER_REQUEST } from '../url-ingest';

describe('validateUrlList', () => {
  it('trim、去空行、去重', () => {
    const r = validateUrlList([' https://a.com ', '', 'https://a.com', 'https://b.com']);
    expect(r).toEqual({ urls: ['https://a.com', 'https://b.com'] });
  });
  it('非数组 / 空数组 / 非字符串项报错', () => {
    expect(validateUrlList('x')).toHaveProperty('error');
    expect(validateUrlList([])).toHaveProperty('error');
    expect(validateUrlList([42])).toHaveProperty('error');
  });
  it('含非法 URL 报错并指明该条', () => {
    const r = validateUrlList(['ftp://a.com']);
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toContain('ftp://a.com');
  });
  it('拒绝 userinfo 与 private IP literal', () => {
    expect(validateUrlList(['https://user:pass@example.com'])).toHaveProperty('error');
    expect(validateUrlList(['http://127.0.0.1/secret'])).toHaveProperty('error');
    expect(validateUrlList(['http://[::1]/secret'])).toHaveProperty('error');
  });
  it('超上限报错', () => {
    const many = Array.from({ length: MAX_URLS_PER_REQUEST + 1 }, (_, i) => `https://a.com/${i}`);
    expect(validateUrlList(many)).toHaveProperty('error');
  });
});

describe('ingestUrlBatch', () => {
  const okDeps = {
    persist: (url: string) => ({
      sourceId: `src-${url.slice(-1)}`,
      jobId: `job-src-${url.slice(-1)}`,
    }),
  };
  it('全部成功：每条带 jobId/sourceId', async () => {
    const r = await ingestUrlBatch(['https://a.com/1', 'https://a.com/2'], okDeps);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ url: 'https://a.com/1', sourceId: 'src-1', jobId: 'job-src-1' });
  });
  it('部分失败：失败条目带 error，不影响其他', async () => {
    const deps = {
      ...okDeps,
      persist: (url: string) => {
        if (url.endsWith('bad')) throw new Error('HTTP 404');
        return { sourceId: 'src-ok', jobId: 'job-src-ok' };
      },
    };
    const r = await ingestUrlBatch(['https://a.com/bad', 'https://a.com/ok'], deps);
    expect(r[0]).toEqual({ url: 'https://a.com/bad', error: 'HTTP 404' });
    expect(r[1].jobId).toBeDefined();
  });
});
