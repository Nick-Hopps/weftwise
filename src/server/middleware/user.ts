import type { NextRequest } from 'next/server';

/**
 * 单租户占位用户。今天整个 app 只有一个本地用户；
 * 未来多租户时由 auth 层从 session 解析真实 userId，调用点无需改动。
 */
export const LOCAL_USER_ID = 'local';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function resolveUserId(_request: NextRequest): string {
  return LOCAL_USER_ID;
}
