import { z } from 'zod';
import type { ChangesetEntry } from '@/lib/contracts';
import type { ToolDef } from '../../types';
import {
  createChangeset,
  validateChangeset,
  applyChangeset,
} from '../../../wiki/wiki-transaction';
import type { SourceLinkOps } from '../../../wiki/wiki-transaction';
import { stampSystemFrontmatter } from '../../../wiki/frontmatter';
import * as pagesRepo from '../../../db/repos/pages-repo';
import * as sourcesRepo from '../../../db/repos/sources-repo';
import { updateSourcePageLinks } from '../../../sources/source-store';

const ChangesetEntryInputSchema = z.object({
  action: z.enum(['create', 'update', 'delete']),
  path: z.string().min(1),
  content: z.string(),
});

const InputSchema = z.object({
  // Writer pages are pre-staged in ctx.pending by the orchestrator; the reviewer only supplies
  // index.md / log.md and any corrected pages here. Optional so a clean run can commit staged
  // pages alone (the handler merges pending ∪ entries, input winning on path conflicts).
  entries: z.array(ChangesetEntryInputSchema).optional(),
  /** Forward-compat field; unused (commit message is auto-generated). */
  summary: z.string().optional(),
});

/** 合并暂存(pending)与工具入参 entries：按 path 去重，input 覆盖同 path（reviewer 修正版生效）。 */
function mergeEntriesByPath(staged: ChangesetEntry[], supplied: ChangesetEntry[]): ChangesetEntry[] {
  const byPath = new Map<string, ChangesetEntry>();
  for (const e of staged) byPath.set(e.path, e);
  for (const e of supplied) byPath.set(e.path, e);
  return [...byPath.values()];
}

const OutputSchema = z.object({
  commitSha: z.string(),
  pagesCreated: z.array(z.string()),
  pagesUpdated: z.array(z.string()),
  linksAdded: z.number().int().nonnegative(),
});

/** Extract slug from a vault path like `wiki/<subject>/<slug>.md` */
const PATH_RE = /^wiki\/[^/]+\/(.+?)\.md$/;
function slugFromPath(path: string): string | null {
  const m = path.match(PATH_RE);
  return m ? m[1] : null;
}

export const commitChangesetTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'commit_changeset',
  source: 'builtin',
  description:
    'Persist the wiki changes to disk + git in one atomic commit. Writer pages are already staged; ' +
    'pass only index.md, log.md, and any pages you corrected — do NOT re-emit unchanged pages. ' +
    'Can only be called once per job; call this last.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'commit',
  async handler(input, ctx) {
    if (ctx.committed.value) {
      throw new Error('commit_changeset already invoked in this run');
    }

    // writer 页面已由 orchestrator 暂存进 ctx.pending；reviewer 只传 index/log + 修正页。
    // 合并：暂存 ∪ input，按 path 去重、input 覆盖同 path（reviewer 修正版盖过暂存版；对旧版
    // reviewer 重发全部也兼容——同 path 去重不产生重复）。
    const mergedEntries = mergeEntriesByPath(ctx.pending.entries, input.entries ?? []);
    if (mergedEntries.length === 0) {
      throw new Error('commit_changeset: nothing to commit (no staged or supplied entries)');
    }

    // System owns timestamp frontmatter (created/updated). Writers only author
    // title/summary/tags + body, so stamp the system-owned fields here before
    // validation; preserve an existing page's created on update.
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
      throw new Error(
        `Changeset validation failed:\n${validation.errors.join('\n')}`
      );
    }

    const pagesCreated = mergedEntries
      .filter((e) => e.action === 'create')
      .map((e) => slugFromPath(e.path))
      .filter((s): s is string => s !== null);

    const pagesUpdated = mergedEntries
      .filter((e) => e.action === 'update')
      .map((e) => slugFromPath(e.path))
      .filter((s): s is string => s !== null);

    // ingest 任务需要在提交时写 page_sources 溯源（页面 ↔ 源文件多对多）
    let sourceOps: SourceLinkOps | undefined;
    if (ctx.job.type === 'ingest') {
      const params = JSON.parse(ctx.job.paramsJson || '{}') as { sourceId?: string };
      if (params.sourceId) {
        sourceOps = {
          sourceId: params.sourceId,
          pageSlugs: [...pagesCreated, ...pagesUpdated],
          linkPageSource: sourcesRepo.linkPageSource,
          updateSourcePageLinks,
          onWarning: (message) => ctx.emit('ingest:warn', message),
        };
      }
    }

    const applied = await applyChangeset(changeset, sourceOps);
    ctx.committed.value = true;

    const commitSha = applied.postHead ?? '';

    ctx.emit('ingest:committing', `Committed ${pagesCreated.length + pagesUpdated.length} pages`, {
      commitSha,
      pagesCreated,
      pagesUpdated,
    });

    return {
      commitSha,
      pagesCreated,
      pagesUpdated,
      linksAdded: 0,
    };
  },
};
