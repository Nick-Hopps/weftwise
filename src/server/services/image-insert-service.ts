import { z } from 'zod';
import type {
  ChangesetEntry,
  Job,
  PersistedMarkdownBlockAnchor,
  Subject,
} from '@/lib/contracts';
import {
  ImageGenerateInputSchema,
  PersistedMarkdownBlockAnchorSchema,
} from '@/lib/contracts';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as pagesRepo from '../db/repos/pages-repo';
import * as operationsRepo from '../db/repos/operations-repo';
import { getVaultHead } from '../git/git-service';
import {
  readPageInSubject,
  readVaultAsset,
} from '../wiki/wiki-store';
import { buildWikiPath, isCanonicalPageSlug } from '../wiki/page-identity';
import { serializeWikiDocument } from '../wiki/markdown';
import { stampSystemFrontmatter } from '../wiki/frontmatter';
import {
  applyChangeset,
  createChangeset,
  validateChangeset,
} from '../wiki/wiki-transaction';
import { resolveMarkdownBlockAnchor } from '../wiki/markdown-block-anchor';
import {
  generateImageAsset,
} from '../agents/tools/builtin/image-generate';
import { AgentCancelled } from '../agents/runtime/errors';
import * as queue from '../jobs/queue';
import { registerHandler } from '../jobs/worker';
import { enqueueEmbedIndex } from './embedding-enqueue';

const ImageInsertParamsSchema = z.object({
  subjectId: z.string().trim().min(1),
  slug: z.string().trim().refine(isCanonicalPageSlug, 'page slug must be canonical'),
  anchor: PersistedMarkdownBlockAnchorSchema,
  request: ImageGenerateInputSchema,
}).strict();

interface InsertedImage {
  url: string;
  alt: string;
}

function escapeMarkdownAlt(alt: string): string {
  return alt.replace(/\s+/g, ' ').replaceAll('\\', '\\\\').replaceAll(']', '\\]');
}

function newlineCountAtEnd(value: string): number {
  const match = value.match(/\n*$/);
  return match ? match[0].length : 0;
}

function newlineCountAtStart(value: string): number {
  const match = value.match(/^\n*/);
  return match ? match[0].length : 0;
}

/** 纯函数：在 anchor 的完整顶层块之后插入一个 diagram callout。 */
export function insertDiagramAfterAnchor(
  body: string,
  anchor: PersistedMarkdownBlockAnchor,
  image: InsertedImage,
): string {
  const resolved = resolveMarkdownBlockAnchor(body, anchor);
  const before = body.slice(0, resolved.end);
  const after = body.slice(resolved.end);
  const beforeGap = Math.max(0, 2 - newlineCountAtEnd(before));
  const afterGap = Math.max(0, 2 - newlineCountAtStart(after));
  const callout = `> [!diagram]\n> ![${escapeMarkdownAlt(image.alt)}](${image.url})`;
  return `${before}${'\n'.repeat(beforeGap)}${callout}${'\n'.repeat(afterGap)}${after}`;
}

function assertNotCancelled(jobId: string): void {
  if (queue.isCancelRequested(jobId)) throw new AgentCancelled();
}

function assetFilename(path: string, subject: Subject): string {
  const prefix = `assets/${subject.slug}/`;
  if (!path.startsWith(prefix)) throw new Error('Generated image asset path is outside the active subject.');
  const filename = path.slice(prefix.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp)$/i.test(filename)) {
    throw new Error('Generated image asset filename is invalid.');
  }
  return filename;
}

function enqueueEmbeddingBestEffort(subjectId: string): void {
  try {
    enqueueEmbedIndex(subjectId);
  } catch (error) {
    console.warn('[image-insert] embedding enqueue failed (ignored)', error);
  }
}

function appliedImageInsertResult(
  job: Job,
  subject: Subject,
  entries: ChangesetEntry[],
  operationId: string,
): { subjectId: string; slug: string; assetUrl: string; operationId: string; recovered: boolean } {
  const params = ImageInsertParamsSchema.parse(JSON.parse(job.paramsJson));
  const pagePath = buildWikiPath(subject.slug, params.slug);
  const pageEntries = entries.filter((entry) => (
    !entry.auxiliary && entry.action === 'update' && entry.path === pagePath
  ));
  const assetEntries = entries.filter((entry) => (
    entry.auxiliary && entry.auxiliaryKind === 'asset'
      && entry.action === 'create' && entry.assetFor === params.slug
  ));
  const pageEntry = pageEntries[0];
  const assetEntry = assetEntries[0];
  if (
    entries.length !== 2
    || pageEntries.length !== 1
    || assetEntries.length !== 1
    || !pageEntry
    || !assetEntry
    || assetEntry.contentEncoding !== 'base64'
  ) {
    throw new Error(`Cannot recover image-insert job "${job.id}": applied operation is invalid.`);
  }
  const filename = assetFilename(assetEntry.path, subject);
  const asset = readVaultAsset(subject.slug, filename);
  if (!asset || !readPageInSubject(subject.slug, params.slug)?.body.includes(
    `/api/assets/${subject.slug}/${filename}`,
  )) {
    throw new Error(`Cannot recover image-insert job "${job.id}": page or asset is missing.`);
  }
  const assetUrl = `/api/assets/${subject.slug}/${filename}`;
  enqueueEmbeddingBestEffort(subject.id);
  return {
    subjectId: subject.id,
    slug: params.slug,
    assetUrl,
    operationId,
    recovered: true,
  };
}

function parseAppliedEntries(job: Job, subject: Subject): {
  operationId: string;
  entries: ChangesetEntry[];
} | null {
  const applied = operationsRepo.listAppliedForJob(job.id, subject.id);
  if (applied.length === 0) return null;
  if (applied.length !== 1) {
    throw new Error(`Cannot recover image-insert job "${job.id}": expected exactly one applied operation.`);
  }
  let entries: unknown;
  try {
    entries = JSON.parse(applied[0]!.changesetJson);
  } catch {
    throw new Error(`Cannot recover image-insert job "${job.id}": applied operation is invalid.`);
  }
  if (
    !Array.isArray(entries)
    || !entries.every((entry) => (
      typeof entry === 'object'
      && entry !== null
      && typeof (entry as { action?: unknown }).action === 'string'
      && typeof (entry as { path?: unknown }).path === 'string'
    ))
  ) {
    throw new Error(`Cannot recover image-insert job "${job.id}": applied operation is invalid.`);
  }
  return { operationId: applied[0]!.id, entries: entries as ChangesetEntry[] };
}

export async function runImageInsertJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const params = ImageInsertParamsSchema.parse(JSON.parse(job.paramsJson));
  const subjectId = params.subjectId;
  if (!job.subjectId || job.subjectId !== subjectId) {
    throw new Error('image-insert job subject does not match its payload.');
  }
  const subject = subjectsRepo.getById(subjectId);
  if (!subject) throw new Error(`Subject ${subjectId} not found`);
  const page = pagesRepo.getPageBySlug(subject.id, params.slug);
  if (!page) throw new Error(`Page "${params.slug}" not found in subject ${subject.slug}`);
  if (pagesRepo.isMetaPage(page)) throw new Error('Cannot insert an illustration into a protected system page.');

  const applied = parseAppliedEntries(job, subject);
  if (applied) return appliedImageInsertResult(job, subject, applied.entries, applied.operationId);

  assertNotCancelled(job.id);
  const preHead = await getVaultHead();
  const before = readPageInSubject(subject.slug, params.slug);
  if (!before) throw new Error(`Page content not found for "${params.slug}".`);
  resolveMarkdownBlockAnchor(before.body, params.anchor);

  emit('image-insert:start', `Generating illustration for ${params.slug}`, {
    subject: subject.slug, slug: params.slug,
  });
  const controller = new AbortController();
  const cancelPoll = setInterval(() => {
    if (queue.isCancelRequested(job.id)) controller.abort();
  }, 2_000);
  cancelPoll.unref?.();
  let generated: Awaited<ReturnType<typeof generateImageAsset>>;
  try {
    generated = await generateImageAsset(params.request, subject.slug, undefined, controller.signal);
  } catch (error) {
    if (queue.isCancelRequested(job.id)) throw new AgentCancelled();
    throw error;
  } finally {
    clearInterval(cancelPoll);
  }

  assertNotCancelled(job.id);
  const postGenerationHead = await getVaultHead();
  if (postGenerationHead !== preHead) {
    throw new Error('Vault HEAD changed while generating the illustration; retry the action.');
  }
  const current = readPageInSubject(subject.slug, params.slug);
  if (!current) {
    throw new Error('Selected Markdown block can no longer be resolved to one unique location.');
  }
  resolveMarkdownBlockAnchor(current.body, params.anchor);
  const filename = assetFilename(generated.asset.path, subject);
  const expectedUrl = `/api/assets/${subject.slug}/${filename}`;
  if (generated.output.url !== expectedUrl) {
    throw new Error('Generated image output URL does not match its asset path.');
  }
  const insertedBody = insertDiagramAfterAnchor(current.body, params.anchor, {
    url: expectedUrl,
    alt: generated.output.alt,
  });
  const updatedContent = stampSystemFrontmatter(
    serializeWikiDocument({ ...current, body: insertedBody }),
    { now: new Date().toISOString(), existingCreated: current.frontmatter.created },
  );
  const entries: ChangesetEntry[] = [
    { action: 'update', path: buildWikiPath(subject.slug, params.slug), content: updatedContent },
    {
      action: 'create', path: generated.asset.path, content: generated.asset.content,
      contentEncoding: 'base64', auxiliary: true, auxiliaryKind: 'asset', assetFor: params.slug,
    },
  ];
  const changeset = createChangeset(job.id, subject, entries);
  const validation = validateChangeset(changeset);
  if (!validation.valid) throw new Error(`image-insert changeset invalid: ${validation.errors.join('; ')}`);
  assertNotCancelled(job.id);
  await applyChangeset(changeset, undefined, {
    expectedPreHead: preHead,
    assertCanApply: () => assertNotCancelled(job.id),
  });
  enqueueEmbeddingBestEffort(subject.id);
  const result = {
    subjectId: subject.id,
    slug: params.slug,
    assetUrl: expectedUrl,
    operationId: changeset.id,
    recovered: false,
  };
  emit('image-insert:complete', `Illustration inserted below ${params.slug}`, {
    subject: subject.slug, slug: params.slug, assetUrl: expectedUrl,
  });
  return result;
}

registerHandler('image-insert', runImageInsertJob);
