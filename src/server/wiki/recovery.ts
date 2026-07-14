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
 * `[cs:<changesetId>]`。恢复时在 `preHead..HEAD` 提交范围内查找该标记
 * （并发调度下崩溃后可能已有其他任务正常提交，本 changeset 的提交未必是
 * HEAD，只看 HEAD 会误判成分支 3）：
 *
 *   1. 范围内找到标记提交 → 已经提交成功，只是状态没落库
 *      → **前滚**：postHead=该提交哈希、置 applied、幂等重跑 indexTouchedPages。
 *   2. 没找到，且 HEAD === preHead（vault 没有变化，commit 从未发生）
 *      → 按现状**回滚**（rollbackChangeset）。
 *   3. 没找到，且 HEAD !== preHead（本 changeset 的 commit 未落地，但之后
 *      已有其他提交落在它前面）→ 不能再 `restoreToHead`，
 *      否则会把后续提交一起冲掉。只把该 operation 标成终态并记录告警，
 *      交由人工/lint 事后核查。
 */

import { getVaultHead, findCommitWithMarker } from '../git/git-service';
import { getRawDb } from '../db/client';
import { indexTouchedPages, rebuildPageIndex } from './indexer';
import { rollbackChangeset, collectTouchedSlugs } from './wiki-transaction';
import { createLogger } from '../logging';
import type { Changeset } from '@/lib/contracts';
import {
  collectPageIdentityMoves,
  migratePageIdentityCaches,
} from './page-identity-migration';

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
  const marker = changesetMarker(changeset.id);
  // 在 preHead..HEAD 范围内找标记提交（preHead 为空则查全部 log）——并发
  // 调度下本 changeset 的提交可能已被后续提交盖过，不能只看 HEAD。
  const markedSha = await findCommitWithMarker(
    marker,
    changeset.preHead || undefined
  );

  if (markedSha) {
    // 分支 1：commit 已成功，只是 applied 状态没来得及落库 → 前滚。
    const db = getRawDb();

    try {
      const touchedSlugs = collectTouchedSlugs(changeset.subjectSlug, changeset.entries);
      const identityMoves = collectPageIdentityMoves(changeset.subjectSlug, changeset.entries);
      const reindex = db.transaction(() => {
        for (const move of identityMoves) {
          migratePageIdentityCaches(changeset.subjectId, move);
        }
        if (identityMoves.length > 0) {
          rebuildPageIndex();
          indexTouchedPages(changeset.subjectId, touchedSlugs);
        } else indexTouchedPages(changeset.subjectId, touchedSlugs);
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
      .run(markedSha, changeset.id);

    log.info(`Rolled forward operation ${changeset.id} (commit already applied at ${markedSha})`);
    return 'rolled-forward';
  }

  const headSha = await getVaultHead();
  if (headSha === changeset.preHead) {
    // 分支 2：commit 从未真正发生（或没有留下痕迹），vault 仍在 preHead → 常规回滚。
    await rollbackChangeset(changeset);
    return 'rolled-back';
  }

  // 分支 3：范围内没有本 changeset 的标记，且 HEAD 已不等于 preHead ——
  // 说明本 commit 未落地但之后已有别的提交落在它前面。restoreToHead
  // 会把那些提交一并冲掉，绝不能做。只标终态+告警。
  try {
    getRawDb()
      .prepare(`UPDATE operations SET status = 'rolled-back' WHERE id = ?`)
      .run(changeset.id);
  } catch (err) {
    log.error(`Failed to mark orphaned operation ${changeset.id} as terminal`, err);
  }

  log.warn(
    `Operation ${changeset.id} left in an indeterminate state: no commit tagged ${marker} ` +
      `found in ${changeset.preHead || '(root)'}..HEAD, and HEAD (${headSha}) has moved past ` +
      `preHead (${changeset.preHead}) — skipping restoreToHead to avoid discarding later commits. ` +
      `Marked as rolled-back without touching the vault; please audit manually.`
  );
  return 'orphaned';
}
