import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const auth = vi.fn();
const getAsset = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: (...args: unknown[]) => auth(...args) }));
vi.mock('@/server/db/repos/renditions-repo', () => ({
  getRenditionAsset: (...args: unknown[]) => getAsset(...args),
}));

import { GET } from '../route';

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockReturnValue(null);
});

describe('GET /api/rendition-assets/[id]', () => {
  it('返回持久化图片内容与不可变缓存头', async () => {
    getAsset.mockReturnValue({ mediaType: 'image/png', dataBase64: 'AQID' });
    const response = await GET(new NextRequest('http://localhost/api/rendition-assets/asset-1'), {
      params: Promise.resolve({ id: 'asset-1' }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('鉴权失败直接返回，资源不存在返回 404', async () => {
    auth.mockReturnValueOnce(NextResponse.json({ error: 'unauthorized' }, { status: 401 }));
    expect((await GET(new NextRequest('http://localhost/x'), {
      params: Promise.resolve({ id: 'asset-1' }),
    })).status).toBe(401);
    expect(getAsset).not.toHaveBeenCalled();

    auth.mockReturnValue(null);
    getAsset.mockReturnValue(null);
    expect((await GET(new NextRequest('http://localhost/x'), {
      params: Promise.resolve({ id: 'missing' }),
    })).status).toBe(404);
  });
});
