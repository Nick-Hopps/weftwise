import * as pagesRepo from '../db/repos/pages-repo';
import * as subjectsRepo from '../db/repos/subjects-repo';
import { getVaultHead } from '../git/git-service';
import type {
  Changeset,
  ChangesetEntry,
  LinkEnsureInput,
  LinkEnsureResult,
  MetadataPatchInput,
  MetadataPatchResult,
  Subject,
  WikiDocument,
  WikiFrontmatter,
} from '@/lib/contracts';
import { parseFrontmatter, serializeFrontmatter, stampSystemFrontmatter } from './frontmatter';
import {
  assertCanonicalPageSlug,
  buildWikiPath,
  deriveUniqueSlug,
  parseWikiPath,
} from './page-identity';
import { rewriteBacklinkText } from './relink';
import { serializeWikiDocument } from './markdown';
import { readPageInSubject, scanWikiPages } from './wiki-store';
import { applyChangeset, createChangeset, validateChangeset } from './wiki-transaction';
import { buildUnifiedDiff, type UnifiedDiffEntry } from './unified-diff';
import {
  buildLinkEnsureEdit,
  normalizeMetadataPatch,
  prepareMetadataPatch,
  type MetadataPageIdentity,
} from './narrow-write';

export interface PagePlanMeta {
  effectiveAt: string;
}

export interface PlannedPageOperation<
  ResultHint extends object = Record<string, unknown>,
> {
  operation: 'create' | 'update' | 'patch' | 'delete' | 'metadata-patch' | 'link-ensure';
  preHead: string;
  changeset: Changeset;
  summary: string;
  affectedPages: Array<{ slug: string; action: 'create' | 'update' | 'delete' }>;
  diff: string;
  warnings: string[];
  resultHint: ResultHint;
}

type BeforeSnapshotByPath = ReadonlyMap<string, string | null>;

function buildDiffEntries(
  entries: ChangesetEntry[],
  beforeByPath: BeforeSnapshotByPath,
): UnifiedDiffEntry[] {
  return entries.map((entry) => {
    if (!beforeByPath.has(entry.path)) {
      throw new Error(`Missing before snapshot for planned path: ${entry.path}`);
    }
    return {
      action: entry.action,
      path: entry.path,
      before: beforeByPath.get(entry.path) ?? null,
      after: entry.action === 'delete' ? null : entry.content,
    };
  });
}

async function finishPlan<T extends object>(input: {
  operation: PlannedPageOperation<T>['operation'];
  preHead: string;
  changeset: Changeset;
  beforeByPath: BeforeSnapshotByPath;
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

  const affectedPages = input.changeset.entries.map((entry) => {
    const identity = parseWikiPath(entry.path);
    if (!identity) throw new Error(`Invalid planned wiki path: ${entry.path}`);
    return { slug: identity.slug, action: entry.action };
  });

  return {
    operation: input.operation,
    preHead: input.preHead,
    changeset: input.changeset,
    summary: input.summary,
    affectedPages,
    diff: buildUnifiedDiff(buildDiffEntries(input.changeset.entries, input.beforeByPath)),
    warnings,
    resultHint: input.resultHint,
  };
}

/** 把改标题引发的 backlink 机械重写追加到同一 changeset；update/metadata 共用。 */
function appendTitleRelinkEntries(input: {
  subject: Subject;
  pageSlug: string;
  oldTitle: string;
  newTitle: string;
  entries: ChangesetEntry[];
  beforeByPath: Map<string, string | null>;
}): number {
  if (input.newTitle === input.oldTitle) return 0;
  let referencesUpdated = 0;
  const backlinks = pagesRepo
    .getBacklinks(input.subject.id, input.pageSlug)
    .filter((backlink) => (
      backlink.subjectId === input.subject.id && backlink.slug !== input.pageSlug
    ));
  for (const backlink of backlinks) {
    const backlinkDoc = readPageInSubject(input.subject.slug, backlink.slug);
    if (!backlinkDoc) continue;
    const raw = serializeWikiDocument(backlinkDoc);
    const rewritten = rewriteBacklinkText(
      raw,
      input.oldTitle,
      input.newTitle,
      input.subject.slug,
    );
    if (rewritten !== raw) {
      const path = buildWikiPath(input.subject.slug, backlink.slug);
      input.entries.push({
        action: 'update',
        path,
        content: rewritten,
      });
      input.beforeByPath.set(path, raw);
      referencesUpdated += 1;
    }
  }
  return referencesUpdated;
}

/** 从 vault frontmatter 构造同 Subject 页面身份快照，aliases 不依赖 DB 缓存。 */
function scanMetadataPageIdentities(subjectSlug: string): MetadataPageIdentity[] {
  return scanWikiPages(subjectSlug).map((page) => {
    try {
      const { data } = parseFrontmatter(page.content);
      return { slug: page.slug, title: data.title, aliases: data.aliases };
    } catch (cause) {
      throw new Error(
        `Failed to parse metadata identity for page "${page.slug}" at ${page.relativePath}`,
        { cause },
      );
    }
  });
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
  const preHead = await getVaultHead();
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
  const beforeByPath = new Map<string, string | null>([[entries[0]!.path, null]]);
  return finishPlan({
    operation: 'create',
    preHead,
    changeset: createChangeset(jobId, subject, entries),
    beforeByPath,
    summary: `创建页面 ${slug}`,
    resultHint: { createdSlug: slug },
  });
}

async function planPageUpdateAtHead(
  jobId: string,
  subject: Subject,
  input: {
    slug: string;
    title?: string;
    body: string;
    summary?: string;
    tags?: string[];
  } & PagePlanMeta,
  preHead: string,
  existingDoc?: WikiDocument,
): Promise<PlannedPageOperation<{ updatedSlug: string; referencesUpdated: number }>> {
  const doc = existingDoc ?? readPageInSubject(subject.slug, input.slug);
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
  const beforeByPath = new Map<string, string | null>([
    [selfPath, serializeWikiDocument(doc)],
  ]);

  const referencesUpdated = appendTitleRelinkEntries({
    subject,
    pageSlug: input.slug,
    oldTitle,
    newTitle,
    entries,
    beforeByPath,
  });

  return finishPlan({
    operation: 'update',
    preHead,
    changeset: createChangeset(jobId, subject, entries),
    beforeByPath,
    summary: `更新页面 ${input.slug}`,
    resultHint: { updatedSlug: input.slug, referencesUpdated },
    rejectSelfUnresolvedPath: selfPath,
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
  const preHead = await getVaultHead();
  return planPageUpdateAtHead(jobId, subject, input, preHead);
}

/**
 * 只规划 metadata 更新：正文逐字复用当前 doc.body，aliases 冲突以 vault frontmatter 为准。
 * title 变化时与既有 update 共用 backlink relink，并纳入同一 changeset。
 */
export async function planPageMetadataPatch(
  jobId: string,
  subject: Subject,
  input: MetadataPatchInput & PagePlanMeta,
): Promise<PlannedPageOperation<MetadataPatchResult>> {
  assertCanonicalPageSlug(input.slug, 'slug');
  const preHead = await getVaultHead();
  const doc = readPageInSubject(subject.slug, input.slug);
  if (!doc) throw new Error(`page "${input.slug}" not found`);

  const normalized = normalizeMetadataPatch(input);
  const identities = normalized.aliases && normalized.aliases.length > 0
    ? scanMetadataPageIdentities(subject.slug)
    : [];
  const prepared = prepareMetadataPatch(
    doc.frontmatter,
    normalized,
    identities,
  );
  const content = stampSystemFrontmatter(
    serializeFrontmatter(prepared.frontmatter, doc.body),
    { now: input.effectiveAt, existingCreated: doc.frontmatter.created },
  );
  const selfPath = buildWikiPath(subject.slug, input.slug);
  const entries: ChangesetEntry[] = [{ action: 'update', path: selfPath, content }];
  const beforeByPath = new Map<string, string | null>([
    [selfPath, serializeWikiDocument(doc)],
  ]);
  const referencesUpdated = appendTitleRelinkEntries({
    subject,
    pageSlug: input.slug,
    oldTitle: doc.frontmatter.title,
    newTitle: prepared.frontmatter.title,
    entries,
    beforeByPath,
  });

  return finishPlan({
    operation: 'metadata-patch',
    preHead,
    changeset: createChangeset(jobId, subject, entries),
    beforeByPath,
    summary: `更新页面 ${input.slug} 的元数据`,
    resultHint: {
      updatedSlug: input.slug,
      referencesUpdated,
      changedFields: prepared.changedFields,
    },
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

async function planPagePatchAtHead(
  jobId: string,
  subject: Subject,
  input: {
    slug: string;
    edits: Array<{ oldString: string; newString: string }>;
  } & PagePlanMeta,
  preHead: string,
  doc: WikiDocument,
): Promise<PlannedPageOperation<{ updatedSlug: string; appliedEdits: number }>> {
  const updatePlan = await planPageUpdateAtHead(jobId, subject, {
    slug: input.slug,
    body: applyPatchEdits(doc.body, input.edits),
    effectiveAt: input.effectiveAt,
  }, preHead, doc);
  return {
    ...updatePlan,
    operation: 'patch',
    summary: `局部更新页面 ${input.slug}`,
    resultHint: { updatedSlug: input.slug, appliedEdits: input.edits.length },
  };
}

export async function planPagePatch(
  jobId: string,
  subject: Subject,
  input: {
    slug: string;
    edits: Array<{ oldString: string; newString: string }>;
  } & PagePlanMeta,
): Promise<PlannedPageOperation<{ updatedSlug: string; appliedEdits: number }>> {
  const preHead = await getVaultHead();
  const doc = readPageInSubject(subject.slug, input.slug);
  if (!doc) throw new Error(`page "${input.slug}" not found`);
  return planPagePatchAtHead(jobId, subject, input, preHead, doc);
}

/**
 * 只规划 wikilink 窄写：HEAD 与 source 快照各取一次，link/retarget 才校验目标存在。
 * 实际正文变更复用 patch/update 的同一 changeset 与 diff 快照路径。
 */
export async function planPageLinkEnsure(
  jobId: string,
  subject: Subject,
  input: LinkEnsureInput & PagePlanMeta,
): Promise<PlannedPageOperation<LinkEnsureResult>> {
  assertCanonicalPageSlug(input.sourceSlug, 'sourceSlug');
  const preHead = await getVaultHead();
  const doc = readPageInSubject(subject.slug, input.sourceSlug);
  if (!doc) throw new Error(`page "${input.sourceSlug}" not found`);

  const edit = buildLinkEnsureEdit(doc.body, input, subject.slug);
  if (input.mode !== 'unlink') {
    const targetSubject = edit.targetSubjectSlug === subject.slug
      ? subject
      : subjectsRepo.getBySlug(edit.targetSubjectSlug);
    if (!targetSubject) {
      throw new Error(`target subject "${edit.targetSubjectSlug}" not found`);
    }
    if (!pagesRepo.getPageBySlug(targetSubject.id, edit.targetSlug)) {
      throw new Error(
        `target page "${edit.targetSubjectSlug}:${edit.targetSlug}" not found`,
      );
    }
  }

  const patchPlan = await planPagePatchAtHead(jobId, subject, {
    slug: input.sourceSlug,
    edits: [{ oldString: edit.oldString, newString: edit.newString }],
    effectiveAt: input.effectiveAt,
  }, preHead, doc);
  return {
    ...patchPlan,
    operation: 'link-ensure',
    summary: `确保页面 ${input.sourceSlug} 的链接状态`,
    resultHint: {
      updatedSlug: input.sourceSlug,
      mode: input.mode,
      targetSubjectSlug: edit.targetSubjectSlug,
      targetSlug: edit.targetSlug,
    },
  };
}

export async function planPageDelete(
  jobId: string,
  subject: Subject,
  input: { slug: string } & PagePlanMeta,
): Promise<PlannedPageOperation<{ deletedSlug: string; brokenBacklinks: number }>> {
  const preHead = await getVaultHead();
  const doc = readPageInSubject(subject.slug, input.slug);
  if (!doc) throw new Error(`page "${input.slug}" not found`);
  const brokenBacklinks = pagesRepo
    .getBacklinks(subject.id, input.slug)
    .filter((backlink) => backlink.slug !== input.slug).length;
  const entries: ChangesetEntry[] = [{
    action: 'delete',
    path: buildWikiPath(subject.slug, input.slug),
    content: null,
  }];
  const beforeByPath = new Map<string, string | null>([
    [entries[0]!.path, serializeWikiDocument(doc)],
  ]);
  return finishPlan({
    operation: 'delete',
    preHead,
    changeset: createChangeset(jobId, subject, entries),
    beforeByPath,
    summary: `删除页面 ${input.slug}`,
    resultHint: { deletedSlug: input.slug, brokenBacklinks },
  });
}

export async function applyPlannedPageOperation<T extends object>(
  plan: PlannedPageOperation<T>,
): Promise<T & { operationId: string }> {
  const applied = await applyChangeset(
    plan.changeset,
    undefined,
    { expectedPreHead: plan.preHead },
  );
  return { ...plan.resultHint, operationId: applied.id };
}
