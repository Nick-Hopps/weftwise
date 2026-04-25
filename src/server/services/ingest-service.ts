import { registerHandler } from '../jobs/worker';
import * as queue from '../jobs/queue';
import * as pagesRepo from '../db/repos/pages-repo';
import * as sourcesRepo from '../db/repos/sources-repo';
import * as subjectsRepo from '../db/repos/subjects-repo';
import {
  getRawSourceContent,
  getRawSourceBuffer,
  updateSourcePageLinks,
} from '../sources/source-store';
import { parseSourceAsync, requiresBuffer } from '../sources/parser-registry';
import { readPageInSubject } from '../wiki/wiki-store';
import {
  createChangeset,
  validateChangeset,
  applyChangeset,
} from '../wiki/wiki-transaction';
import type { WikiDocument } from '../wiki/markdown';
import { serializeWikiDocument } from '../wiki/markdown';
import { serializeFrontmatter } from '../wiki/frontmatter';
import { generateStructuredOutput } from '../llm/provider-registry';
import {
  IngestPlanSchema,
  PageBodySchema,
  IndexBodySchema,
  PLAN_SYSTEM_PROMPT,
  PAGE_BODY_SYSTEM_PROMPT,
  INDEX_BODY_SYSTEM_PROMPT,
  buildPlanUserPrompt,
  buildPageBodyUserPrompt,
  buildIndexUserPrompt,
} from '../llm/prompts/ingest-prompt';
import { buildWikiPath } from '../wiki/page-identity';
import type { ChangesetEntry, IngestResult, Job } from '@/lib/contracts';

const SOURCE_TEXT_LIMIT = 30_000;

interface IngestParams {
  sourceId: string;
  filename: string;
  subjectId: string;
}

function buildLogContent(
  existingLog: WikiDocument | null,
  logEntry: string
): string {
  if (!existingLog) {
    const now = new Date().toISOString();
    const stub: WikiDocument = {
      frontmatter: {
        title: 'Ingest Log',
        created: now,
        updated: now,
        tags: ['log', 'meta'],
        sources: [],
      },
      body: logEntry,
      links: [],
    };
    return serializeWikiDocument(stub);
  }

  const updatedDoc: WikiDocument = {
    frontmatter: {
      ...existingLog.frontmatter,
      updated: new Date().toISOString(),
    },
    body: existingLog.body.trimEnd() + '\n\n' + logEntry,
    links: existingLog.links,
  };
  return serializeWikiDocument(updatedDoc);
}

async function runIngestJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void
): Promise<Record<string, unknown>> {
  const params = JSON.parse(job.paramsJson) as Partial<IngestParams>;
  const { sourceId, filename, subjectId } = params;

  if (!sourceId || !filename) {
    throw new Error('Ingest job missing sourceId or filename');
  }
  if (!subjectId) {
    throw new Error('Ingest job missing subjectId — re-queue with a subject');
  }

  const subject = subjectsRepo.getById(subjectId);
  if (!subject) {
    throw new Error(`Subject ${subjectId} not found`);
  }

  emit('ingest:start', `Reading source: ${filename}`, { subject: subject.slug });

  let textContent: string;
  let bufferContent: Buffer | null = null;

  if (requiresBuffer(filename)) {
    bufferContent = getRawSourceBuffer(subject.slug, filename);
    if (!bufferContent) {
      throw new Error(`Source file not found: ${filename}`);
    }
    textContent = '';
  } else {
    const raw = getRawSourceContent(subject.slug, filename);
    if (!raw) {
      throw new Error(`Source file not found: ${filename}`);
    }
    textContent = raw;
  }

  emit('ingest:parsing', `Parsing source: ${filename}`);
  const parsed = await parseSourceAsync(filename, textContent, bufferContent);

  const isTruncated = parsed.cleanText.length > SOURCE_TEXT_LIMIT;
  if (isTruncated) {
    emit(
      'ingest:warn',
      `Source text is ${parsed.cleanText.length.toLocaleString()} chars; truncating to ${SOURCE_TEXT_LIMIT.toLocaleString()} for LLM processing. Some content near the end may not be captured.`,
    );
  }
  const truncatedText = parsed.cleanText.slice(0, SOURCE_TEXT_LIMIT);

  emit('ingest:reading-wiki', `Reading current wiki state (subject: ${subject.slug})`);
  const existingPages = pagesRepo.getAllPages(subject.id).map((p) => ({
    slug: p.slug,
    title: p.title,
    summary: p.summary,
  }));

  const subjectCtx = {
    slug: subject.slug,
    name: subject.name,
    description: subject.description,
  };

  // ── Phase A: Generate page plan ────────────────────────────────────────────

  emit('ingest:llm', 'Phase A: Generating page plan via LLM...', { phase: 'plan' });
  const plan = await generateStructuredOutput(
    'ingest',
    IngestPlanSchema,
    PLAN_SYSTEM_PROMPT,
    buildPlanUserPrompt(truncatedText, existingPages, subjectCtx),
    { maxTokens: 8192 },
  );

  emit(
    'ingest:planned',
    `Phase A complete: planned ${plan.pages.length} page(s)`,
    {
      pages: plan.pages.map((p) => ({ action: p.action, slug: p.slug, title: p.title })),
    }
  );

  // ── Phase B: Generate body for each page ───────────────────────────────────

  const allPageTitles = [
    ...existingPages.map((p) => p.title),
    ...plan.pages.map((p) => p.title),
  ];

  const pageBodies: Map<string, string> = new Map();

  for (let i = 0; i < plan.pages.length; i++) {
    const page = plan.pages[i];
    emit(
      'ingest:llm',
      `Phase B: Writing page ${i + 1}/${plan.pages.length}: ${page.title}`,
      { phase: 'body', page: page.slug },
    );

    const result = await generateStructuredOutput(
      'ingest',
      PageBodySchema,
      PAGE_BODY_SYSTEM_PROMPT,
      buildPageBodyUserPrompt(page, truncatedText, allPageTitles, subjectCtx),
      { maxTokens: 8192 },
    );

    pageBodies.set(page.slug, result.body);
  }

  emit('ingest:llm', `Phase B complete: ${pageBodies.size} page bodies generated`, { phase: 'body-done' });

  // ── Phase C: Generate index page ───────────────────────────────────────────

  const allPagesForIndex = [
    ...existingPages,
    ...plan.pages.map((p) => ({ slug: p.slug, title: p.title, summary: p.summary })),
  ];

  emit('ingest:llm', 'Phase C: Generating index page...', { phase: 'index' });
  const indexResult = await generateStructuredOutput(
    'ingest',
    IndexBodySchema,
    INDEX_BODY_SYSTEM_PROMPT,
    buildIndexUserPrompt(allPagesForIndex, subjectCtx),
    { maxTokens: 4096 },
  );

  // ── Build changeset entries ────────────────────────────────────────────────

  const now = new Date().toISOString();
  const entries: ChangesetEntry[] = [];

  for (const page of plan.pages) {
    let createdTime = now;
    if (page.action === 'update') {
      const existing = readPageInSubject(subject.slug, page.slug);
      if (existing?.frontmatter.created) {
        createdTime = existing.frontmatter.created;
      }
    }

    const body = pageBodies.get(page.slug) ?? '';
    const content = serializeFrontmatter(
      {
        title: page.title,
        created: createdTime,
        updated: now,
        tags: page.tags,
        sources: page.sources ?? [filename],
        summary: page.summary,
      },
      body,
    );
    entries.push({
      action: page.action,
      path: buildWikiPath(subject.slug, page.slug),
      content,
    });
  }

  // index.md update (subject-scoped)
  if (indexResult.indexBody) {
    const existingIndex = readPageInSubject(subject.slug, 'index');
    const indexContent = serializeFrontmatter(
      {
        title: existingIndex?.frontmatter.title ?? `${subject.name} — Index`,
        created: existingIndex?.frontmatter.created ?? now,
        updated: now,
        tags: existingIndex?.frontmatter.tags ?? ['index', 'meta'],
        sources: existingIndex?.frontmatter.sources ?? [],
      },
      indexResult.indexBody,
    );
    entries.push({
      action: existingIndex ? 'update' : 'create',
      path: buildWikiPath(subject.slug, 'index'),
      content: indexContent,
    });
  }

  // log.md update (subject-scoped)
  const existingLog = readPageInSubject(subject.slug, 'log');
  entries.push({
    action: existingLog ? 'update' : 'create',
    path: buildWikiPath(subject.slug, 'log'),
    content: buildLogContent(existingLog, plan.logEntry),
  });

  emit('ingest:validating', 'Validating changeset');
  const changeset = createChangeset(job.id, subject, entries);
  const validation = validateChangeset(changeset);

  if (!validation.valid) {
    const errorSummary = validation.errors.join('; ');
    emit(
      'ingest:validation-failed',
      `Validation failed: ${errorSummary}`,
      { errors: validation.errors }
    );
    throw new Error(`Changeset validation failed: ${errorSummary}`);
  }

  const pageSlugs = plan.pages.map((p) => p.slug);
  const sourceOps = {
    sourceId,
    pageSlugs,
    linkPageSource: sourcesRepo.linkPageSource,
    updateSourcePageLinks,
  };

  emit('ingest:applying', 'Applying changeset (files + SQLite + source links + git commit)');
  const applied = await applyChangeset(changeset, sourceOps);

  const result: IngestResult = {
    pagesCreated: plan.pages
      .filter((p) => p.action === 'create')
      .map((p) => p.slug),
    pagesUpdated: plan.pages
      .filter((p) => p.action === 'update')
      .map((p) => p.slug),
    linksAdded: Array.from(pageBodies.values()).reduce(
      (sum, body) => sum + (body.match(/\[\[/g) ?? []).length,
      0
    ),
    commitSha: applied.postHead ?? '',
  };

  emit(
    'ingest:complete',
    `Ingest complete: ${result.pagesCreated.length} created, ${result.pagesUpdated.length} updated`,
    { result }
  );

  // Chain a lint job for this subject so the knowledge base stays clean.
  try {
    const lintJob = queue.enqueue('lint', { subjectId: subject.id }, subject.id);
    emit('ingest:lint-queued', `Lint job ${lintJob.id.slice(0, 8)} queued`, { lintJobId: lintJob.id });
  } catch (err) {
    emit(
      'ingest:lint-queue-failed',
      `Failed to enqueue follow-up lint job: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return result as unknown as Record<string, unknown>;
}

// Side-effect import: register handler when this module is imported by worker-entry.
registerHandler('ingest', runIngestJob);
