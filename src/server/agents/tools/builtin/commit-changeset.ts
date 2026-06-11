import { z } from 'zod';
import type { ToolDef } from '../../types';
import {
  createChangeset,
  validateChangeset,
  applyChangeset,
} from '../../../wiki/wiki-transaction';
import { stampSystemFrontmatter } from '../../../wiki/frontmatter';
import * as pagesRepo from '../../../db/repos/pages-repo';

const ChangesetEntryInputSchema = z.object({
  action: z.enum(['create', 'update', 'delete']),
  path: z.string().min(1),
  content: z.string(),
});

const InputSchema = z.object({
  entries: z.array(ChangesetEntryInputSchema).min(1),
  /** Forward-compat field; not passed to applyChangeset (commit message is auto-generated). */
  summary: z.string().min(1),
});

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
    'Persist accumulated wiki page changes to disk + git in a single atomic commit. Can only be called once per job; call this last.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'commit',
  async handler(input, ctx) {
    if (ctx.committed.value) {
      throw new Error('commit_changeset already invoked in this run');
    }

    // System owns timestamp frontmatter (created/updated). Writers only author
    // title/summary/tags + body, so stamp the system-owned fields here before
    // validation; preserve an existing page's created on update.
    const now = new Date().toISOString();
    const entries = input.entries.map((entry) => {
      if (entry.action === 'delete') return entry;
      const slug = slugFromPath(entry.path);
      const existing = slug ? pagesRepo.getPageBySlug(ctx.subject.id, slug) : null;
      return {
        ...entry,
        content: stampSystemFrontmatter(entry.content, {
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

    const applied = await applyChangeset(changeset);
    ctx.committed.value = true;

    const pagesCreated = input.entries
      .filter((e) => e.action === 'create')
      .map((e) => slugFromPath(e.path))
      .filter((s): s is string => s !== null);

    const pagesUpdated = input.entries
      .filter((e) => e.action === 'update')
      .map((e) => slugFromPath(e.path))
      .filter((s): s is string => s !== null);

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
