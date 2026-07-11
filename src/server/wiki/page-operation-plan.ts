import * as pagesRepo from '../db/repos/pages-repo';
import { getVaultHead } from '../git/git-service';
import type { Changeset, ChangesetEntry, Subject, WikiFrontmatter } from '@/lib/contracts';
import { serializeFrontmatter, stampSystemFrontmatter } from './frontmatter';
import { buildWikiPath, deriveUniqueSlug, parseWikiPath } from './page-identity';
import { rewriteBacklinkText } from './relink';
import { serializeWikiDocument } from './markdown';
import { readPageInSubject } from './wiki-store';
import { applyChangeset, createChangeset, validateChangeset } from './wiki-transaction';
import { buildUnifiedDiff, type UnifiedDiffEntry } from './unified-diff';

export interface PagePlanMeta {
  effectiveAt: string;
}

export interface PlannedPageOperation<
  ResultHint extends Record<string, unknown> = Record<string, unknown>,
> {
  operation: 'create' | 'update' | 'patch' | 'delete';
  preHead: string;
  changeset: Changeset;
  summary: string;
  affectedPages: Array<{ slug: string; action: 'create' | 'update' | 'delete' }>;
  diff: string;
  warnings: string[];
  resultHint: ResultHint;
}

function buildDiffEntries(subject: Subject, entries: ChangesetEntry[]): UnifiedDiffEntry[] {
  return entries.map((entry) => {
    const identity = parseWikiPath(entry.path);
    const current = identity
      ? readPageInSubject(subject.slug, identity.slug)
      : null;
    return {
      action: entry.action,
      path: entry.path,
      before: entry.action === 'create' || !current ? null : serializeWikiDocument(current),
      after: entry.action === 'delete' ? null : entry.content,
    };
  });
}

async function finishPlan<T extends Record<string, unknown>>(input: {
  operation: PlannedPageOperation<T>['operation'];
  subject: Subject;
  changeset: Changeset;
  summary: string;
  resultHint: T;
  rejectSelfUnresolvedPath?: string;
}): Promise<PlannedPageOperation<T>> {
  const validation = validateChangeset(input.changeset);
  if (!validation.valid) {
    throw new Error(`${input.operation} changeset invalid: ${validation.errors.join('; ')}`);
  }
  const warnings = validation.warnings ?? [];
  if (input.rejectSelfUnresolvedPath) {
    const unresolved = warnings.filter(
      (warning) => warning.startsWith(`[${input.rejectSelfUnresolvedPath}]`)
        && warning.includes('Unresolved wikilink:'),
    );
    if (unresolved.length > 0) {
      throw new Error(
        `update would leave unresolved wikilink(s): ${unresolved.join('; ')}`,
      );
    }
  }

  const preHead = await getVaultHead();
  const affectedPages = input.changeset.entries.map((entry) => {
    const identity = parseWikiPath(entry.path);
    if (!identity) throw new Error(`Invalid planned wiki path: ${entry.path}`);
    return { slug: identity.slug, action: entry.action };
  });

  return {
    operation: input.operation,
    preHead,
    changeset: input.changeset,
    summary: input.summary,
    affectedPages,
    diff: buildUnifiedDiff(buildDiffEntries(input.subject, input.changeset.entries)),
    warnings,
    resultHint: input.resultHint,
  };
}

export async function planPageCreate(
  jobId: string,
  subject: Subject,
  input: {
    title: string;
    body: string;
    summary?: string;
    tags?: string[];
  } & PagePlanMeta,
): Promise<PlannedPageOperation<{ createdSlug: string }>> {
  const existing = new Set(pagesRepo.getAllPages(subject.id).map((page) => page.slug));
  const slug = deriveUniqueSlug(input.title, existing);
  const frontmatter: WikiFrontmatter = {
    title: input.title,
    created: input.effectiveAt,
    updated: input.effectiveAt,
    tags: input.tags ?? [],
    sources: [],
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
  };
  const entries: ChangesetEntry[] = [{
    action: 'create',
    path: buildWikiPath(subject.slug, slug),
    content: serializeFrontmatter(frontmatter, input.body),
  }];
  return finishPlan({
    operation: 'create',
    subject,
    changeset: createChangeset(jobId, subject, entries),
    summary: `创建页面 ${slug}`,
    resultHint: { createdSlug: slug },
  });
}

export async function planPageUpdate(
  jobId: string,
  subject: Subject,
  input: {
    slug: string;
    title?: string;
    body: string;
    summary?: string;
    tags?: string[];
  } & PagePlanMeta,
): Promise<PlannedPageOperation<{ updatedSlug: string; referencesUpdated: number }>> {
  const doc = readPageInSubject(subject.slug, input.slug);
  if (!doc) throw new Error(`page "${input.slug}" not found`);

  const oldTitle = doc.frontmatter.title;
  const newTitle = input.title?.trim() || oldTitle;
  const frontmatter: WikiFrontmatter = {
    ...doc.frontmatter,
    title: newTitle,
    tags: input.tags ?? doc.frontmatter.tags,
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
  };
  const content = stampSystemFrontmatter(serializeFrontmatter(frontmatter, input.body), {
    now: input.effectiveAt,
    existingCreated: doc.frontmatter.created,
  });
  const selfPath = buildWikiPath(subject.slug, input.slug);
  const entries: ChangesetEntry[] = [{ action: 'update', path: selfPath, content }];

  let referencesUpdated = 0;
  if (newTitle !== oldTitle) {
    const backlinks = pagesRepo
      .getBacklinks(subject.id, input.slug)
      .filter((backlink) => backlink.subjectId === subject.id && backlink.slug !== input.slug);
    for (const backlink of backlinks) {
      const backlinkDoc = readPageInSubject(subject.slug, backlink.slug);
      if (!backlinkDoc) continue;
      const raw = serializeWikiDocument(backlinkDoc);
      const rewritten = rewriteBacklinkText(raw, oldTitle, newTitle, subject.slug);
      if (rewritten !== raw) {
        entries.push({
          action: 'update',
          path: buildWikiPath(subject.slug, backlink.slug),
          content: rewritten,
        });
        referencesUpdated += 1;
      }
    }
  }

  return finishPlan({
    operation: 'update',
    subject,
    changeset: createChangeset(jobId, subject, entries),
    summary: `更新页面 ${input.slug}`,
    resultHint: { updatedSlug: input.slug, referencesUpdated },
    rejectSelfUnresolvedPath: selfPath,
  });
}

export function applyPatchEdits(
  body: string,
  edits: Array<{ oldString: string; newString: string }>,
): string {
  if (edits.length === 0) throw new Error('patch requires at least one edit');
  let current = body;
  edits.forEach((edit, index) => {
    const number = index + 1;
    if (!edit.oldString) throw new Error(`edit #${number}: old_string must not be empty`);
    if (edit.oldString === edit.newString) {
      throw new Error(`edit #${number}: old_string and new_string are identical`);
    }
    const first = current.indexOf(edit.oldString);
    if (first === -1) {
      throw new Error(`edit #${number}: old_string not found — quote the page text verbatim`);
    }
    let count = 0;
    for (let at = first; at !== -1; at = current.indexOf(edit.oldString, at + 1)) count += 1;
    if (count > 1) {
      throw new Error(
        `edit #${number}: old_string matches ${count} locations — include more surrounding context`,
      );
    }
    current = current.slice(0, first)
      + edit.newString
      + current.slice(first + edit.oldString.length);
  });
  return current;
}

export async function planPagePatch(
  jobId: string,
  subject: Subject,
  input: {
    slug: string;
    edits: Array<{ oldString: string; newString: string }>;
  } & PagePlanMeta,
): Promise<PlannedPageOperation<{ updatedSlug: string; appliedEdits: number }>> {
  const doc = readPageInSubject(subject.slug, input.slug);
  if (!doc) throw new Error(`page "${input.slug}" not found`);
  const updatePlan = await planPageUpdate(jobId, subject, {
    slug: input.slug,
    body: applyPatchEdits(doc.body, input.edits),
    effectiveAt: input.effectiveAt,
  });
  return {
    ...updatePlan,
    operation: 'patch',
    summary: `局部更新页面 ${input.slug}`,
    resultHint: { updatedSlug: input.slug, appliedEdits: input.edits.length },
  };
}

export async function planPageDelete(
  jobId: string,
  subject: Subject,
  input: { slug: string } & PagePlanMeta,
): Promise<PlannedPageOperation<{ deletedSlug: string; brokenBacklinks: number }>> {
  const brokenBacklinks = pagesRepo
    .getBacklinks(subject.id, input.slug)
    .filter((backlink) => backlink.slug !== input.slug).length;
  const entries: ChangesetEntry[] = [{
    action: 'delete',
    path: buildWikiPath(subject.slug, input.slug),
    content: null,
  }];
  return finishPlan({
    operation: 'delete',
    subject,
    changeset: createChangeset(jobId, subject, entries),
    summary: `删除页面 ${input.slug}`,
    resultHint: { deletedSlug: input.slug, brokenBacklinks },
  });
}

export async function applyPlannedPageOperation<T extends Record<string, unknown>>(
  plan: PlannedPageOperation<T>,
): Promise<T & { operationId: string }> {
  const applied = await applyChangeset(
    plan.changeset,
    undefined,
    { expectedPreHead: plan.preHead },
  );
  return { ...plan.resultHint, operationId: applied.id };
}
