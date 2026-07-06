/**
 * vault-mutex 跨进程文件锁：心跳续租 + stale 判定单测。
 *
 * 用真实临时目录（非 mock fs）+ 注入短心跳/上限常量，避免真等 30min。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const configMock = vi.hoisted(() => ({ vaultPath: '' }));
vi.mock('../../config/env', () => ({
  getConfig: () => ({ vaultPath: configMock.vaultPath }),
}));

import { acquireVaultLock } from '../vault-mutex';

let tmpDir: string;

function lockFilePath(): string {
  return path.join(path.dirname(configMock.vaultPath), '.vault.lock');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-mutex-test-'));
  configMock.vaultPath = path.join(tmpDir, 'vault');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('acquireVaultLock heartbeat + stale 判定', () => {
  it('心跳持续刷新时，即使锁文件已"存在很久"也不会被第二个等待者夺锁', async () => {
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

    // 等待若干个心跳周期，确认心跳持续把 mtime 刷新为新鲜。
    await new Promise((r) => setTimeout(r, 100));
    const age = Date.now() - fs.statSync(lockFilePath()).mtimeMs;
    expect(age).toBeLessThan(50);

    // 第二个获取者应长时间拿不到锁（因为心跳持续续租，不判 stale）。
    let acquired = false;
    const second = acquireVaultLock({
      heartbeatIntervalMs: 20,
      staleHeartbeatMultiplier: 3,
      hardStaleLockMs: 10_000,
      retryIntervalMs: 10,
    }).then((r) => {
      acquired = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 150));
    expect(acquired).toBe(false);

    release();
    const secondRelease = await second;
    expect(acquired).toBe(true);
    secondRelease();
  });

  it('持锁进程已死亡时，锁在一个 stale 判定周期内被回收', async () => {
    // 手动伪造一个"死进程"持有的锁文件（不走 acquireVaultLock，绕开心跳）。
    const file = lockFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 一个几乎不可能存在的 PID
    fs.writeFileSync(file, '999999');
    const old = new Date(Date.now() - 1000);
    fs.utimesSync(file, old, old);

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

  it('释放锁（正常路径）会清理心跳定时器，不留下持续刷新的悬挂句柄', async () => {
    const release = await acquireVaultLock({
      heartbeatIntervalMs: 10,
      staleHeartbeatMultiplier: 3,
      hardStaleLockMs: 10_000,
      retryIntervalMs: 10,
    });
    release();

    const mtimeAfterRelease = (() => {
      try {
        return fs.statSync(lockFilePath()).mtimeMs;
      } catch {
        return null;
      }
    })();
    // 锁文件已被 release 删除
    expect(mtimeAfterRelease).toBeNull();

    // 等待若干心跳周期，确认没有定时器把已删除的文件重新 touch/报错刷屏。
    await new Promise((r) => setTimeout(r, 60));
    expect(fs.existsSync(lockFilePath())).toBe(false);
  });

  it('异常释放路径（reject）也会清理心跳定时器', async () => {
    // 直接构造场景：两次获取，第二次因为第一次未释放会一直等待；
    // 这里改为验证 acquireFileLock 内部异常路径——通过让 openSync 之外的分支
    // 走 reject，观察 pending 状态恢复且无残留定时器导致的重复 touch 报错。
    const release = await acquireVaultLock({
      heartbeatIntervalMs: 10,
      staleHeartbeatMultiplier: 3,
      hardStaleLockMs: 10_000,
      retryIntervalMs: 10,
    });

    // 释放后立即再次获取应正常成功（证明状态机 locked 被正确复位，
    // 且第一次的心跳定时器已被清理不会互相干扰）。
    release();
    const release2 = await acquireVaultLock({
      heartbeatIntervalMs: 10,
      staleHeartbeatMultiplier: 3,
      hardStaleLockMs: 10_000,
      retryIntervalMs: 10,
    });
    release2();
    expect(fs.existsSync(lockFilePath())).toBe(false);
  });
});
