/**
 * 崩溃恢复：处理 worker 启动时发现的 `status='pending'` operations。
 *
 * 背景：`applyChangeset` 在 git commit 成功之后才把 operation 置为 `applied`
 * （见 wiki-transaction.ts）。若进程在 commit 与状态落库之间崩溃，operation
 * 会停留在 `pending`，但 vault 里的变更其实已经成功提交。这种情况下不能像
 * 常规失败那样 `rollbackChangeset(preHead)`——那会把已经落地的变更连同之后
 * 别的提交一起 reset --hard 掉，静默丢数据。
 *
 * 判定依据：`commitVaultChanges` 会在 commit message 末尾追加确定性标记
 * `[cs:<changesetId>]`。恢复时读 HEAD commit message：
 *
 *   1. HEAD message 含本 changeset 的标记 → 已经提交成功，只是状态没落库
 *      → **前滚**：补 postHead、置 applied、幂等重跑 indexTouchedPages。
 *   2. 不含标记，且 HEAD === preHead（vault 没有变化，commit 从未发生）
 *      → 按现状**回滚**（rollbackChangeset）。
 *   3. 不含标记，且 HEAD !== preHead（commit 未打标记，但之后已有其他提交
 *      落在它前面——例如另一个 changeset 顺利提交）→ 不能再 `restoreToHead`，
 *      否则会把后续提交一起冲掉。只把该 operation 标成终态并记录告警，
 *      交由人工/lint 事后核查。
 */

import { getVaultHead, getHeadCommitMessage } from '../git/git-service';
import { getRawDb } from '../db/client';
import { indexTouchedPages } from './indexer';
import { rollbackChangeset, collectTouchedSlugs } from './wiki-transaction';
import { createLogger } from '../logging';
import type { Changeset } from '@/lib/contracts';

const log = createLogger('wiki-recovery');

export type RecoveryOutcome = 'rolled-forward' | 'rolled-back' | 'orphaned';

function changesetMarker(changesetId: string): string {
  return `[cs:${changesetId}]`;
}

/**
 * 恢复单个 pending operation。幂等——重复调用安全。
 */
export async function recoverPendingOperation(
  changeset: Changeset
): Promise<RecoveryOutcome> {
  const headMessage = await getHeadCommitMessage();
  const marker = changesetMarker(changeset.id);

  if (headMessage.includes(marker)) {
    // 分支 1：commit 已成功，只是 applied 状态没来得及落库 → 前滚。
    const headSha = await getVaultHead();
    const db = getRawDb();

    try {
      const touchedSlugs = collectTouchedSlugs(changeset.subjectSlug, changeset.entries);
      const reindex = db.transaction(() => {
        indexTouchedPages(changeset.subjectId, touchedSlugs);
      });
      reindex();
    } catch (err) {
      log.warn(
        `Roll-forward reindex failed for operation ${changeset.id}, DB/vault may be temporarily inconsistent`,
        err
      );
    }

    db
      .prepare(`UPDATE operations SET post_head = ?, status = 'applied' WHERE id = ?`)
      .run(headSha, changeset.id);

    log.info(`Rolled forward operation ${changeset.id} (commit already applied at ${headSha})`);
    return 'rolled-forward';
  }

  const headSha = await getVaultHead();
  if (headSha === changeset.preHead) {
    // 分支 2：commit 从未真正发生（或没有留下痕迹），vault 仍在 preHead → 常规回滚。
    await rollbackChangeset(changeset);
    return 'rolled-back';
  }

  // 分支 3：HEAD 既没打标记也不等于 preHead —— 说明之后已有别的提交落在
  // 它前面。restoreToHead 会把那些提交一并冲掉，绝不能做。只标终态+告警。
  try {
    getRawDb()
      .prepare(`UPDATE operations SET status = 'rolled-back' WHERE id = ?`)
      .run(changeset.id);
  } catch (err) {
    log.error(`Failed to mark orphaned operation ${changeset.id} as terminal`, err);
  }

  log.warn(
    `Operation ${changeset.id} left in an indeterminate state: HEAD (${headSha}) is neither ` +
      `preHead (${changeset.preHead}) nor tagged with ${marker}. Vault has moved on since this ` +
      `changeset's preHead — skipping restoreToHead to avoid discarding later commits. ` +
      `Marked as rolled-back without touching the vault; please audit manually.`
  );
  return 'orphaned';
}
