import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface PublicHttpTarget extends ResolvedAddress {
  url: URL;
  hostname: string;
}

const defaultResolver: HostResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.flatMap((entry): ResolvedAddress[] =>
    entry.family === 4 || entry.family === 6
      ? [{ address: entry.address, family: entry.family }]
      : [],
  );
};

/**
 * 解析 http(s) URL，并拒绝 userinfo、内部专用 hostname 与不可公开路由的 IP literal。
 * DNS hostname 的最终地址校验由 resolvePublicHttpTarget 在每次请求/重定向前完成。
 */
export function validateHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error('URL userinfo is not allowed');
  }

  const hostname = bareHostname(url.hostname);
  if (!hostname) throw new Error('URL hostname is required');
  const lower = hostname.toLowerCase();
  if (
    lower === 'localhost'
    || lower.endsWith('.localhost')
    || lower.endsWith('.local')
    || lower.endsWith('.internal')
  ) {
    throw new Error('URL hostname must resolve to a public address');
  }

  if (isIP(hostname) !== 0 && !isPublicIpAddress(hostname)) {
    throw new Error('URL IP address is not publicly routable');
  }
  return url;
}

/** 每一跳都解析全部 DNS 答案；任一答案不公开即拒绝，并固定使用首个已验证地址。 */
export async function resolvePublicHttpTarget(
  raw: string | URL,
  resolver: HostResolver = defaultResolver,
): Promise<PublicHttpTarget> {
  const url = validateHttpUrl(typeof raw === 'string' ? raw : raw.toString());
  const hostname = bareHostname(url.hostname);
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return { url, hostname, address: hostname, family: literalFamily };
  }

  const addresses = await resolver(hostname);
  if (addresses.length === 0) {
    throw new Error(`URL hostname did not resolve: ${hostname}`);
  }
  for (const entry of addresses) {
    if (
      (entry.family !== 4 && entry.family !== 6)
      || isIP(entry.address) !== entry.family
      || !isPublicIpAddress(entry.address)
    ) {
      throw new Error(`URL hostname must resolve exclusively to public addresses: ${hostname}`);
    }
  }

  return { url, hostname, ...addresses[0]! };
}

/** 仅允许公开 IPv4 与 2000::/3 公网 IPv6；特殊用途/保留前缀一律拒绝。 */
export function isPublicIpAddress(raw: string): boolean {
  const address = bareHostname(raw);
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;

  const value = parseIpv6(address);
  if (value === null) return false;
  // 公网 IPv6 global unicast：2000::/3。
  if (!inIpv6Prefix(value, ipv6('2000::'), 3)) return false;
  // IETF protocol assignments / benchmarking / ORCHID 等特殊用途聚合段。
  if (inIpv6Prefix(value, ipv6('2001::'), 23)) return false;
  // 文档地址。
  if (inIpv6Prefix(value, ipv6('2001:db8::'), 32)) return false;
  // 6to4 会把 IPv4 嵌入路由，避免借此绕过 IPv4 判定。
  if (inIpv6Prefix(value, ipv6('2002::'), 16)) return false;
  // RFC 9637 文档地址。
  if (inIpv6Prefix(value, ipv6('3fff::'), 20)) return false;
  return true;
}

function bareHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv6(address: string): number[] {
  const value = parseIpv6(address);
  if (value === null) throw new Error(`Invalid internal IPv6 prefix: ${address}`);
  return value;
}

function inIpv6Prefix(value: number[], prefix: number[], bits: number): boolean {
  const fullGroups = Math.floor(bits / 16);
  for (let index = 0; index < fullGroups; index += 1) {
    if (value[index] !== prefix[index]) return false;
  }
  const remaining = bits % 16;
  if (remaining === 0) return true;
  const mask = (0xffff << (16 - remaining)) & 0xffff;
  return ((value[fullGroups] ?? 0) & mask) === ((prefix[fullGroups] ?? 0) & mask);
}

function parseIpv6(raw: string): number[] | null {
  let address = bareHostname(raw).toLowerCase();
  if (address.includes('%')) return null;

  if (address.includes('.')) {
    const colon = address.lastIndexOf(':');
    if (colon < 0) return null;
    const ipv4Text = address.slice(colon + 1);
    const parts = ipv4Text.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return null;
    }
    const packed = ((parts[0]! << 24) >>> 0)
      + (parts[1]! << 16)
      + (parts[2]! << 8)
      + parts[3]!;
    address = `${address.slice(0, colon)}:${(packed >>> 16).toString(16)}:${(packed & 0xffff).toString(16)}`;
  }

  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return null;
  }

  return groups.map((group) => parseInt(group, 16));
}
