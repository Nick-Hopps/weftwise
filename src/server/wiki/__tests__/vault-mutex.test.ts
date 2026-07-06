/**
 * vault-mutex 跨进程文件锁：心跳续租 + stale 判定单测。
 *
 * 用真实临时目录（非 mock fs）+ 注入短心跳/上限常量，避免真等 30min。
 * 注意：同进程内第二个 acquireVaultLock 会直接进进程内队列排队、走不到
 * isStaleLock，因此"长持锁不被夺"通过直接对导出的 isStaleLock 做判定矩阵
 * 断言来验证（跨进程夺锁只发生在 isStaleLock 返回 true 时）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const configMock = vi.hoisted(() => ({ vaultPath: '' }));
vi.mock('../../config/env', () => ({
  getConfig: () => ({ vaultPath: configMock.vaultPath }),
}));

import { acquireVaultLock, isStaleLock } from '../vault-mutex';

let tmpDir: string;

function lockFilePath(): string {
  return path.join(path.dirname(configMock.vaultPath), '.vault.lock');
}

/** 手工伪造一个锁文件：写入 pid，并把 mtime 拨到 ageMs 之前 */
function fakeLockFile(pid: number | string, ageMs: number): string {
  const file = lockFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(pid));
  const old = new Date(Date.now() - ageMs);
  fs.utimesSync(file, old, old);
  return file;
}

const TUNING = {
  heartbeatIntervalMs: 1000,
  staleHeartbeatMultiplier: 3, // stale 阈值 = 3000ms
  hardStaleLockMs: 10_000,
  retryIntervalMs: 10,
} as const;

const DEAD_PID = 999999; // 几乎不可能存在的 PID

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-mutex-test-'));
  configMock.vaultPath = path.join(tmpDir, 'vault');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('isStaleLock 判定矩阵', () => {
  it('① mtime 新鲜（< 3×心跳间隔）→ 不论持锁进程存活与否均不夺锁', () => {
    // 存活进程（当前进程自身）
    expect(isStaleLock(fakeLockFile(process.pid, 500), TUNING)).toBe(false);
    // 死进程：mtime 新鲜时同样不夺锁（避免瞬时抖动误判）
    expect(isStaleLock(fakeLockFile(DEAD_PID, 500), TUNING)).toBe(false);
  });

  it('② mtime 超 3×心跳 但进程存活且未超硬上限 → 不夺锁（长持锁+心跳存活即安全）', () => {
    expect(isStaleLock(fakeLockFile(process.pid, 5000), TUNING)).toBe(false);
  });

  it('③ mtime 超硬上限，即便进程"存活"（可能是 PID 复用）→ 视为悬挂可夺锁', () => {
    expect(isStaleLock(fakeLockFile(process.pid, 15_000), TUNING)).toBe(true);
  });

  it('④ 进程不存活且 mtime 超 3×心跳 → 视为悬挂可夺锁', () => {
    expect(isStaleLock(fakeLockFile(DEAD_PID, 5000), TUNING)).toBe(true);
  });
});

describe('acquireVaultLock 心跳续租', () => {
  it('持锁期间心跳持续刷新锁文件 mtime，使 stale 先决条件永不成立', async () => {
    const release = await acquireVaultLock({
      heartbeatIntervalMs: 20,
      staleHeartbeatMultiplier: 3,
      hardStaleLockMs: 10_000,
      retryIntervalMs: 10,
    });

    // 手动把 mtime 拨回"很久以前"，模拟未续租前的陈旧状态；
    // 心跳会在下一个 tick 把它续回新鲜。
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFilePath(), old, old);

    await new Promise((r) => setTimeout(r, 100));
    const age = Date.now() - fs.statSync(lockFilePath()).mtimeMs;
    expect(age).toBeLessThan(50);

    // mtime 已被心跳续新鲜 → 跨进程视角下 isStaleLock 必为 false（不会被夺）。
    expect(
      isStaleLock(lockFilePath(), {
        heartbeatIntervalMs: 20,
        staleHeartbeatMultiplier: 3,
        hardStaleLockMs: 10_000,
        retryIntervalMs: 10,
      }),
    ).toBe(false);

    release();
  });

  it('持锁进程已死亡时，锁在一个 stale 判定周期内被回收（等待者成功获取）', async () => {
    fakeLockFile(DEAD_PID, 1000);

    const start = Date.now();
    const release = await acquireVaultLock({
      heartbeatIntervalMs: 10,
      staleHeartbeatMultiplier: 2, // stale 阈值 20ms
      hardStaleLockMs: 60_000,
      retryIntervalMs: 10,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);
    release();
  });

  it('释放锁会清理心跳定时器：锁文件被删且不再被残留定时器重建/触碰', async () => {
    const release = await acquireVaultLock({
      heartbeatIntervalMs: 10,
      staleHeartbeatMultiplier: 3,
      hardStaleLockMs: 10_000,
      retryIntervalMs: 10,
    });
    release();

    // 锁文件已被 release 删除
    expect(fs.existsSync(lockFilePath())).toBe(false);

    // 等待若干心跳周期，确认没有残留定时器把已删除的文件重新 touch。
    await new Promise((r) => setTimeout(r, 60));
    expect(fs.existsSync(lockFilePath())).toBe(false);
  });
});
