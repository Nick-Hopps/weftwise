import type { ChangesetEntry, IngestResult } from '@/lib/contracts';
import type { AgentContext } from '../types';
import {
  applyChangeset,
  createChangeset,
  validateChangeset,
  type SourceLinkOps,
} from '../../wiki/wiki-transaction';
import { stampSystemFrontmatter } from '../../wiki/frontmatter';
import * as pagesRepo from '../../db/repos/pages-repo';
import * as sourcesRepo from '../../db/repos/sources-repo';
import { updateSourcePageLinks } from '../../sources/source-store';

const PATH_RE = /^wiki\/[^/]+\/(.+?)\.md$/;

function slugFromPath(path: string): string | null {
  const match = path.match(PATH_RE);
  return match ? match[1] : null;
}

/** 合并暂存条目与调用方补充条目；同 path 由调用方补充版本覆盖。 */
function mergeEntriesByPath(staged: ChangesetEntry[], supplied: ChangesetEntry[]): ChangesetEntry[] {
  const byPath = new Map<string, ChangesetEntry>();
  for (const entry of staged) byPath.set(entry.path, entry);
  for (const entry of supplied) byPath.set(entry.path, entry);
  return [...byPath.values()];
}

/**
 * 把 AgentContext 中的暂存页面与 service 补充页面通过一次 Saga 原子提交。
 *
 * 这是 ingest/re-enrich 的内部收口函数，不是模型工具。它负责系统 frontmatter、
 * changeset 校验、来源关联与 git 提交，并用 ctx.committed 防止同一 run 重复提交。
 */
export async function commitPending(
  ctx: AgentContext,
  supplied: ChangesetEntry[],
  webSources?: { links: Array<{ sourceId: string; pageSlugs: string[] }>; extraStagePaths: string[] },
): Promise<IngestResult> {
  if (ctx.committed.value) {
    throw new Error('commitPending already invoked in this run');
  }

  const mergedEntries = mergeEntriesByPath(ctx.pending.entries, supplied);
  if (mergedEntries.length === 0) {
    throw new Error('commitPending: nothing to commit (no staged or supplied entries)');
  }

  const now = new Date().toISOString();
  const entries = mergedEntries.map((entry) => {
    if (entry.action === 'delete') return entry;
    const slug = slugFromPath(entry.path);
    const existing = slug ? pagesRepo.getPageBySlug(ctx.subject.id, slug) : null;
    return {
      ...entry,
      content: stampSystemFrontmatter(entry.content ?? '', {
        now,
        existingCreated: existing?.createdAt ?? null,
      }),
    };
  });

  const changeset = createChangeset(ctx.job.id, ctx.subject, entries);
  const validation = validateChangeset(changeset);
  if (!validation.valid) {
    throw new Error(`Changeset validation failed:\n${validation.errors.join('\n')}`);
  }

  const pagesCreated = mergedEntries
    .filter((entry) => entry.action === 'create')
    .map((entry) => slugFromPath(entry.path))
    .filter((slug): slug is string => slug !== null);
  const pagesUpdated = mergedEntries
    .filter((entry) => entry.action === 'update')
    .map((entry) => slugFromPath(entry.path))
    .filter((slug): slug is string => slug !== null);

  const links: Array<{ sourceId: string; pageSlugs: string[] }> = [];
  if (ctx.job.type === 'ingest') {
    const params = JSON.parse(ctx.job.paramsJson || '{}') as { sourceId?: string };
    if (params.sourceId) {
      links.push({ sourceId: params.sourceId, pageSlugs: [...pagesCreated, ...pagesUpdated] });
    }
  }
  if (webSources?.links?.length) links.push(...webSources.links);

  const extraStagePaths = webSources?.extraStagePaths ?? [];
  let sourceOps: SourceLinkOps | undefined;
  if (links.length > 0 || extraStagePaths.length > 0) {
    sourceOps = {
      links,
      extraStagePaths,
      linkPageSource: sourcesRepo.linkPageSource,
      updateSourcePageLinks,
      unlinkPageSource: sourcesRepo.unlinkPageSource,
      onWarning: (message) => ctx.emit('ingest:warn', message),
    };
  }

  const applied = await applyChangeset(changeset, sourceOps);
  ctx.committed.value = true;
  const commitSha = applied.postHead ?? '';

  ctx.emit('ingest:committing', `Committed ${pagesCreated.length + pagesUpdated.length} pages`, {
    commitSha,
    pagesCreated,
    pagesUpdated,
  });

  return { commitSha, pagesCreated, pagesUpdated, linksAdded: 0 };
}
