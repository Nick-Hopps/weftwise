/**
 * Process-level mutex for serializing vault write operations.
 *
 * All operations that modify vault files + SQLite + git should acquire this
 * mutex to prevent interleaving. The worker already serializes jobs, but
 * this provides an additional safety net for any code paths that might
 * bypass the job queue.
 */

type Release = () => void;

let pending: (() => void)[] = [];
let locked = false;

/**
 * Acquire the vault mutex. Returns a release function.
 * If another operation holds the lock, the returned promise waits until
 * the lock is released.
 */
export function acquireVaultLock(): Promise<Release> {
  return new Promise<Release>((resolve) => {
    const tryAcquire = () => {
      if (!locked) {
        locked = true;
        resolve(() => {
          locked = false;
          const next = pending.shift();
          if (next) next();
        });
      } else {
        pending.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}
