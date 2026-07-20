import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { validateHttpUrl } from './url-safety';

export const SOURCE_AUTH_GRANT_TTL_MS = 2 * 60 * 60_000;
const COOKIE_MAX_BYTES = 16 * 1024;
const AUTHORIZATION_MAX_BYTES = 8 * 1024;
const GRANT_VERSION = 1;
const GRANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SourceAuthGrantPayload {
  version: 1;
  jobId: string;
  sourceId: string;
  authOrigin: string;
  cookie?: string;
  authorization?: string;
  createdAt: string;
  expiresAt: string;
}

interface SourceAuthGrantEnvelope {
  version: 1;
  expiresAt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface SourceAuthHeaders {
  cookie?: string;
  authorization?: string;
}

export interface CreateSourceAuthGrantInput extends SourceAuthHeaders {
  jobId: string;
  sourceId: string;
  authOrigin: string;
  now?: Date;
}

export interface ReadSourceAuthGrantBinding {
  jobId: string;
  sourceId: string;
  now?: Date;
}

export interface SourceAuthGrant extends SourceAuthHeaders {
  id: string;
  authOrigin: string;
  expiresAt: string;
}

/** 只接受两个受控敏感头；先剥可选前缀，再拒绝 header injection 与过大输入。 */
export function normalizeSourceAuthHeaders(input: {
  cookie?: unknown;
  authorization?: unknown;
}): SourceAuthHeaders {
  const cookie = normalizeHeader(input.cookie, 'cookie', COOKIE_MAX_BYTES, '16 KiB');
  const authorization = normalizeHeader(
    input.authorization,
    'authorization',
    AUTHORIZATION_MAX_BYTES,
    '8 KiB',
  );
  if (!cookie && !authorization) {
    throw new Error('At least one of Cookie or Authorization is required');
  }
  return { cookie, authorization };
}

export function createSourceAuthGrant(input: CreateSourceAuthGrantInput): {
  id: string;
  expiresAt: string;
} {
  const now = input.now ?? new Date();
  pruneExpiredSourceAuthGrants(now);
  const headers = normalizeSourceAuthHeaders(input);
  const authOrigin = normalizeAuthOrigin(input.authOrigin);
  const id = randomUUID();
  const expiresAt = new Date(now.getTime() + SOURCE_AUTH_GRANT_TTL_MS).toISOString();
  const payload: SourceAuthGrantPayload = {
    version: GRANT_VERSION,
    jobId: nonEmpty(input.jobId, 'jobId'),
    sourceId: nonEmpty(input.sourceId, 'sourceId'),
    authOrigin,
    ...headers,
    createdAt: now.toISOString(),
    expiresAt,
  };
  const key = readOrCreateMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(grantAad(id));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const envelope: SourceAuthGrantEnvelope = {
    version: GRANT_VERSION,
    expiresAt,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  writeEnvelopeAtomically(id, envelope);
  return { id, expiresAt };
}

/** 解密失败、绑定不符或过期统一返回 null，避免把密文细节带到 job/API。 */
export function readSourceAuthGrant(
  id: string,
  binding: ReadSourceAuthGrantBinding,
): SourceAuthGrant | null {
  if (!GRANT_ID_PATTERN.test(id)) return null;
  const path = grantPath(id);
  if (!existsSync(path)) return null;
  const now = binding.now ?? new Date();

  try {
    const envelope = parseEnvelope(readFileSync(path, 'utf8'));
    if (!envelope) return null;
    if (new Date(envelope.expiresAt).getTime() <= now.getTime()) {
      deleteSourceAuthGrant(id);
      return null;
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      readOrCreateMasterKey(),
      Buffer.from(envelope.iv, 'base64'),
    );
    decipher.setAAD(grantAad(id));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    const payload = parsePayload(plaintext);
    if (!payload) return null;
    if (payload.jobId !== binding.jobId || payload.sourceId !== binding.sourceId) return null;
    if (new Date(payload.expiresAt).getTime() <= now.getTime()) {
      deleteSourceAuthGrant(id);
      return null;
    }
    return {
      id,
      authOrigin: payload.authOrigin,
      cookie: payload.cookie,
      authorization: payload.authorization,
      expiresAt: payload.expiresAt,
    };
  } catch {
    return null;
  }
}

export function deleteSourceAuthGrant(id: string): void {
  if (!GRANT_ID_PATTERN.test(id)) return;
  try {
    unlinkSync(grantPath(id));
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

export function pruneExpiredSourceAuthGrants(now = new Date()): void {
  const directory = grantDirectory();
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (!GRANT_ID_PATTERN.test(id)) continue;
    try {
      const envelope = parseEnvelope(readFileSync(join(directory, name), 'utf8'));
      if (envelope && new Date(envelope.expiresAt).getTime() <= now.getTime()) {
        deleteSourceAuthGrant(id);
      }
    } catch {
      // 损坏文件留给绑定读取 fail closed；这里不误删无法判定期限的数据。
    }
  }
}

function normalizeHeader(
  value: unknown,
  name: 'cookie' | 'authorization',
  maxBytes: number,
  maxLabel: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value
    .trim()
    .replace(new RegExp(`^${name}\\s*:\\s*`, 'i'), '')
    .trim();
  if (!normalized) return undefined;
  if (/[\r\n\0]/.test(normalized)) throw new Error(`Invalid ${name} header`);
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    throw new Error(`${name} header exceeds ${maxLabel}`);
  }
  return normalized;
}

function normalizeAuthOrigin(raw: string): string {
  const parsed = validateHttpUrl(nonEmpty(raw, 'authOrigin'));
  if (raw.trim() !== parsed.origin && raw.trim() !== `${parsed.origin}/`) {
    throw new Error('authOrigin must contain only scheme, host, and port');
  }
  return parsed.origin;
}

function nonEmpty(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function dataDirectory(): string {
  return dirname(resolve(process.env.DATABASE_PATH ?? './data/wiki.db'));
}

function grantDirectory(): string {
  return join(dataDirectory(), 'source-auth');
}

function grantPath(id: string): string {
  return join(grantDirectory(), `${id}.json`);
}

function keyPath(): string {
  return join(dataDirectory(), '.source-auth-key');
}

function readOrCreateMasterKey(): Buffer {
  mkdirSync(dataDirectory(), { recursive: true });
  const finalPath = keyPath();
  if (!existsSync(finalPath)) {
    const temporary = `${finalPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, randomBytes(32), { flag: 'wx', mode: 0o600 });
      try {
        linkSync(temporary, finalPath);
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
      }
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
      }
    }
  }
  const stat = lstatSync(finalPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Source auth key must be a regular file');
  }
  chmodSync(finalPath, 0o600);
  const key = readFileSync(finalPath);
  if (key.byteLength !== 32) throw new Error('Source auth key has an invalid length');
  return key;
}

function writeEnvelopeAtomically(id: string, envelope: SourceAuthGrantEnvelope): void {
  const directory = grantDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const finalPath = grantPath(id);
  const temporary = `${finalPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(envelope), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, finalPath);
    chmodSync(finalPath, 0o600);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch (cleanupError) {
      if (!isNodeError(cleanupError, 'ENOENT')) throw cleanupError;
    }
    throw error;
  }
}

function grantAad(id: string): Buffer {
  return Buffer.from(`weftwise-source-auth-v${GRANT_VERSION}:${id}`, 'utf8');
}

function parseEnvelope(json: string): SourceAuthGrantEnvelope | null {
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    if (
      value.version !== GRANT_VERSION
      || typeof value.expiresAt !== 'string'
      || typeof value.iv !== 'string'
      || typeof value.tag !== 'string'
      || typeof value.ciphertext !== 'string'
      || !Number.isFinite(new Date(value.expiresAt).getTime())
    ) return null;
    return value as unknown as SourceAuthGrantEnvelope;
  } catch {
    return null;
  }
}

function parsePayload(json: string): SourceAuthGrantPayload | null {
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    if (
      value.version !== GRANT_VERSION
      || typeof value.jobId !== 'string'
      || typeof value.sourceId !== 'string'
      || typeof value.authOrigin !== 'string'
      || typeof value.createdAt !== 'string'
      || typeof value.expiresAt !== 'string'
      || (value.cookie !== undefined && typeof value.cookie !== 'string')
      || (value.authorization !== undefined && typeof value.authorization !== 'string')
    ) return null;
    normalizeAuthOrigin(value.authOrigin);
    normalizeSourceAuthHeaders({ cookie: value.cookie, authorization: value.authorization });
    return value as unknown as SourceAuthGrantPayload;
  } catch {
    return null;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
