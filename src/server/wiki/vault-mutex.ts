/**
 * vault 写锁：进程内互斥队列 + 跨进程文件锁 双层结构。
 *
 * 所有修改 vault 文件 + SQLite + git 的操作都必须先取得该锁。
 * 单靠进程内内存锁不够——写路径分散在 Next.js（PUT/DELETE /api/pages、
 * revert 等）与独立 worker（ingest/curate/fix）两个进程，二者并发写同一
 * git 工作树会互相破坏（restoreToHead 的 reset --hard 会抹掉对方未提交
 * 的写入）。因此在内存锁之外，再以 vault 同级目录的锁文件（O_EXCL 原子
 * 创建）实现跨进程互斥；锁文件放在 vault 之外，避免被 git 清理波及。
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
/** 持锁进程存活但超过该时长仍未释放 → 视为异常悬挂，强制夺锁 */
const STALE_LOCK_MS = 10 * 60 * 1000;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但无权限发信号；其余（ESRCH）视为已死
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 判断已存在的锁文件是否为陈旧残留（持有者已死或悬挂超时） */
function isStaleLock(file: string): boolean {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const pid = Number.parseInt(raw, 10);
    if (Number.isFinite(pid) && pid > 0 && !isProcessAlive(pid)) return true;
    const age = Date.now() - fs.statSync(file).mtimeMs;
    return age > STALE_LOCK_MS;
  } catch {
    // 读取竞态（对方刚释放）→ 当作非陈旧，下轮重试自然拿到
    return false;
  }
}

/** 跨进程文件锁：O_EXCL 原子创建，占用则轮询重试，陈旧锁自动回收 */
async function acquireFileLock(): Promise<() => void> {
  const file = lockFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(file);
        } catch {
          // 已被陈旧回收等情况删除 → 忽略
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (isStaleLock(file)) {
        try {
          fs.unlinkSync(file);
        } catch {
          // 与其他等待者竞争删除 → 忽略，下轮重试
        }
        continue;
      }
      await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
    }
  }
}

/**
 * 获取 vault 写锁，返回释放函数。
 * 先在进程内排队（避免同进程多个等待者对锁文件忙轮询），
 * 队首再去竞争跨进程文件锁。
 */
export function acquireVaultLock(): Promise<Release> {
  return new Promise<Release>((resolve, reject) => {
    const tryAcquire = () => {
      if (!locked) {
        locked = true;
        acquireFileLock().then(
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
