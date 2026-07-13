import { describe, expect, it, vi } from 'vitest';
import {
  isPublicIpAddress,
  resolvePublicHttpTarget,
  validateHttpUrl,
  type HostResolver,
} from '../url-safety';

describe('validateHttpUrl', () => {
  it('只接受没有 userinfo 的 http/https URL', () => {
    expect(validateHttpUrl('https://example.com/a').hostname).toBe('example.com');
    expect(() => validateHttpUrl('ftp://example.com/a')).toThrow(/protocol/i);
    expect(() => validateHttpUrl('https://user:pass@example.com/a')).toThrow(/userinfo/i);
    expect(() => validateHttpUrl('not-a-url')).toThrow(/invalid url/i);
  });
});

describe('isPublicIpAddress', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '64:ff9b::7f00:1',
    '100::1',
    '2001:db8::1',
    '2002:7f00:1::',
    'fc00::1',
    'fe80::1',
    'ff02::1',
  ])('拒绝不可公开路由地址 %s', (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '93.184.216.34',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
  ])('接受公开地址 %s', (address) => {
    expect(isPublicIpAddress(address)).toBe(true);
  });

  it('拒绝非法 IP 文本', () => {
    expect(isPublicIpAddress('example.com')).toBe(false);
    expect(isPublicIpAddress('999.1.1.1')).toBe(false);
  });
});

describe('resolvePublicHttpTarget', () => {
  it('解析全部公开 DNS 结果并固定首个地址', async () => {
    const resolver: HostResolver = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 as const },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 as const },
    ]);

    await expect(resolvePublicHttpTarget('https://example.com/a', resolver)).resolves.toMatchObject({
      address: '93.184.216.34',
      family: 4,
      hostname: 'example.com',
    });
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('任一 DNS 结果不可公开路由时拒绝整个 hostname', async () => {
    const resolver: HostResolver = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];

    await expect(resolvePublicHttpTarget('https://example.com', resolver)).rejects.toThrow(/public/i);
  });

  it('IP literal 不走 DNS，并拒绝 loopback 与 IPv4-mapped IPv6', async () => {
    const resolver: HostResolver = vi.fn(async () => []);

    await expect(resolvePublicHttpTarget('http://127.0.0.1', resolver)).rejects.toThrow(/public/i);
    await expect(resolvePublicHttpTarget('http://[::ffff:127.0.0.1]', resolver)).rejects.toThrow(/public/i);
    expect(resolver).not.toHaveBeenCalled();
  });
});
