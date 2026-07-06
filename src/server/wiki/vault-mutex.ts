/**
 * vault 写锁：进程内互斥队列 + 跨进程文件锁 双层结构。
 *
 * 所有修改 vault 文件 + SQLite + git 的操作都必须先取得该锁。
 * 单靠进程内内存锁不够——写路径分散在 Next.js（PUT/DELETE /api/pages、
 * revert 等）与独立 worker（ingest/curate/fix）两个进程，二者并发写同一
 * git 工作树会互相破坏（restoreToHead 的 reset --hard 会抹掉对方未提交
 * 的写入）。因此在内存锁之外，再以 vault 同级目录的锁文件（O_EXCL 原子
 * 创建）实现跨进程互斥；锁文件放在 vault 之外，避免被 git 清理波及。
 *
 * 心跳续租：持锁期间定时刷新锁文件 mtime，避免长任务（>10 分钟）被误判为
 * 悬挂而被第二个等待者夺锁——那会导致两进程同时进入 Saga，互相
 * `reset --hard` 损坏 vault。stale 判定为双条件：mtime 陈旧（超过心跳间隔
 * 的若干倍）且（持锁进程不存活 或 mtime 超过硬上限）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../config/env';

type Release = () => void;

let pending: (() => void)[] = [];
let locked = false;

/** 锁文件路径：vault 的同级目录（如 data/.vault.lock） */
function lockFilePath(): string {
  const vault = getConfig().vaultPath;
  return path.join(path.dirname(vault), '.vault.lock');
}

const RETRY_INTERVAL_MS = 100;
/** 心跳刷新间隔：持锁期间以此间隔刷新锁文件 mtime */
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
/** mtime 距今超过 心跳间隔 × 该倍数 才可能被视为陈旧（先决条件之一） */
const STALE_HEARTBEAT_MULTIPLIER = 3;
/** 无论进程是否"存活"（可能是 PID 复用），mtime 超过该硬上限一律视为悬挂 */
const HARD_STALE_LOCK_MS = 30 * 60 * 1000;

export interface VaultLockTuning {
  heartbeatIntervalMs?: number;
  staleHeartbeatMultiplier?: number;
  hardStaleLockMs?: number;
  retryIntervalMs?: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但无权限发信号；其余（ESRCH）视为已死
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 判断已存在的锁文件是否为陈旧残留（持有者已死或悬挂超时）。
 * 导出仅供单测直接断言 stale 判定矩阵，业务方不要直接调用。
 */
export function isStaleLock(file: string, tuning: Required<VaultLockTuning>): boolean {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const pid = Number.parseInt(raw, 10);
    const age = Date.now() - fs.statSync(file).mtimeMs;

    // 先决条件：mtime 必须陈旧到超过若干个心跳周期，否则说明持锁方仍在
    // 正常续租（哪怕它的 PID 因某种原因判定不存活也不夺锁——避免瞬时抖动）。
    const staleByHeartbeat = age > tuning.heartbeatIntervalMs * tuning.staleHeartbeatMultiplier;
    if (!staleByHeartbeat) return false;

    const deadProcess = Number.isFinite(pid) && pid > 0 && !isProcessAlive(pid);
    const pastHardCap = age > tuning.hardStaleLockMs;
    return deadProcess || pastHardCap;
  } catch {
    // 读取竞态（对方刚释放）→ 当作非陈旧，下轮重试自然拿到
    return false;
  }
}

function touchLockFile(file: string): void {
  try {
    const now = new Date();
    fs.utimesSync(file, now, now);
  } catch {
    // 心跳失败（如锁文件被外部删除）不抛进业务流，仅记录告警；
    // 下一轮持锁尝试自然会重建锁文件。
    // eslint-disable-next-line no-console
    console.warn('[vault-mutex] heartbeat failed to touch lock file:', file);
  }
}

/** 跨进程文件锁：O_EXCL 原子创建，占用则轮询重试，陈旧锁自动回收 */
async function acquireFileLock(tuning: Required<VaultLockTuning>): Promise<() => void> {
  const file = lockFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);

      const heartbeat = setInterval(() => touchLockFile(file), tuning.heartbeatIntervalMs);
      heartbeat.unref();

      return () => {
        clearInterval(heartbeat);
        try {
          fs.unlinkSync(file);
        } catch {
          // 已被陈旧回收等情况删除 → 忽略
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (isStaleLock(file, tuning)) {
        try {
          fs.unlinkSync(file);
        } catch {
          // 与其他等待者竞争删除 → 忽略，下轮重试
        }
        continue;
      }
      await new Promise((r) => setTimeout(r, tuning.retryIntervalMs));
    }
  }
}

/**
 * 获取 vault 写锁，返回释放函数。
 * 先在进程内排队（避免同进程多个等待者对锁文件忙轮询），
 * 队首再去竞争跨进程文件锁。
 *
 * `tuning` 仅供测试注入更短的心跳/上限常量，生产调用不传即用默认值。
 */
export function acquireVaultLock(tuning: VaultLockTuning = {}): Promise<Release> {
  const resolvedTuning: Required<VaultLockTuning> = {
    heartbeatIntervalMs: tuning.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
    staleHeartbeatMultiplier: tuning.staleHeartbeatMultiplier ?? STALE_HEARTBEAT_MULTIPLIER,
    hardStaleLockMs: tuning.hardStaleLockMs ?? HARD_STALE_LOCK_MS,
    retryIntervalMs: tuning.retryIntervalMs ?? RETRY_INTERVAL_MS,
  };

  return new Promise<Release>((resolve, reject) => {
    const tryAcquire = () => {
      if (!locked) {
        locked = true;
        acquireFileLock(resolvedTuning).then(
          (releaseFile) => {
            resolve(() => {
              releaseFile();
              locked = false;
              const next = pending.shift();
              if (next) next();
            });
          },
          (err) => {
            locked = false;
            const next = pending.shift();
            if (next) next();
            reject(err);
          },
        );
      } else {
        pending.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}
