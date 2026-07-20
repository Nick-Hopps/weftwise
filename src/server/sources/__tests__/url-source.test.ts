import { describe, expect, it } from 'vitest';

describe('URL Source identity', () => {
  it('规范化 URL 并生成稳定的 html filename 与身份 hash', async () => {
    const { createUrlSourceIdentity } = await import('../url-source');

    const first = createUrlSourceIdentity(' HTTPS://Example.COM:443/path?q=1 ');
    const second = createUrlSourceIdentity('https://example.com/path?q=1');

    expect(first).toEqual(second);
    expect(first.originUrl).toBe('https://example.com/path?q=1');
    expect(first.filename).toMatch(/^web-example\.com-path-[a-f0-9]{8}\.html$/);
    expect(first.contentHash).toMatch(/^[a-f0-9]{16}$/);
  });

  it('拒绝非 http(s)、userinfo 与私网地址', async () => {
    const { createUrlSourceIdentity } = await import('../url-source');

    expect(() => createUrlSourceIdentity('file:///tmp/a')).toThrow(/protocol/i);
    expect(() => createUrlSourceIdentity('https://user:pass@example.com')).toThrow(/userinfo/i);
    expect(() => createUrlSourceIdentity('http://127.0.0.1/a')).toThrow(/public/i);
  });

  it('识别新 metadata 与带 originUrl 的旧 URL Source，并拒绝非法 metadata', async () => {
    const { readUrlSourceReference } = await import('../url-source');

    expect(readUrlSourceReference({
      metadataJson: JSON.stringify({ kind: 'url', originUrl: 'https://example.com/a' }),
    })).toEqual({ originUrl: 'https://example.com/a' });
    expect(readUrlSourceReference({
      metadataJson: JSON.stringify({ originUrl: 'https://legacy.example.com/a' }),
    })).toEqual({ originUrl: 'https://legacy.example.com/a' });
    expect(readUrlSourceReference({ metadataJson: '{}' })).toBeNull();
    expect(readUrlSourceReference({
      metadataJson: JSON.stringify({ kind: 'url', originUrl: 'http://localhost/a' }),
    })).toBeNull();
    expect(readUrlSourceReference({ metadataJson: '{' })).toBeNull();
  });
});
