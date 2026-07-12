/**
 * Lint Phase 1 — deterministic 检查（无需 LLM）。
 *
 * 覆盖：broken wikilinks / orphan pages / missing frontmatter / stale sources / orphan sources / thin pages。
 * 全部按 subject 维度扫描。
 */

import * as pagesRepo from '../db/repos/pages-repo';
import * as sourcesRepo from '../db/repos/sources-repo';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as jobsRepo from '../db/repos/jobs-repo';
import { scanWikiPages } from '../wiki/wiki-store';
import { parseFrontmatter, validateFrontmatter } from '../wiki/frontmatter';
import type { LintFinding, Subject, WikiPage, WikiLink } from '@/lib/contracts';
import { META_PAGE_SLUGS } from '../wiki/page-identity';
import { isSourceStale } from '../sources/source-staleness';

export function runDeterministicChecksForSubject(subject: Subject): LintFinding[] {
  // 一次性取数后传给各 check，避免重复全表扫描：
  // getAllPages 原本被 3 个 check 各取一次；getMetaPageKeys（跨主题扫描）原本被两次
  // getAllLinks 各算一次——这里都收敛为一次。
  const allPages = pagesRepo.getAllPages(subject.id);
  const metaKeys = pagesRepo.getMetaPageKeys();
  const subjectLinks = pagesRepo.getAllLinks(subject.id, metaKeys); // 本主题出链（broken-link 用）
  const allLinks = pagesRepo.getAllLinks(undefined, metaKeys); // 跨主题全量（orphan 入链统计用）

  const findings: LintFinding[] = [];
  findings.push(...checkBrokenLinks(subject, allPages, subjectLinks));
  findings.push(...checkOrphanPages(subject, allPages, allLinks));
  findings.push(...checkMissingFrontmatter(subject));
  findings.push(...checkStaleSources(subject, allPages));
  findings.push(...checkOrphanSources(subject));
  findings.push(...checkThinPages(subject));
  return findings;
}

function checkBrokenLinks(
  subject: Subject,
  allPages: WikiPage[],
  allLinks: WikiLink[]
): LintFinding[] {
  const findings: LintFinding[] = [];
  const slugSet = new Set(allPages.map((p) => p.slug));

  for (const link of allLinks) {
    // Same-subject link to a missing page
    if (link.targetSubjectId === subject.id && !slugSet.has(link.targetSlug)) {
      findings.push({
        type: 'broken-link',
        severity: 'warning',
        pageSlug: link.sourceSlug,
        description: `Broken wikilink: [[${link.targetSlug}]] referenced from "${link.sourceSlug}" does not exist in subject "${subject.slug}".`,
        suggestedFix: `Create a page with slug "${link.targetSlug}" or update the link to point to an existing page.`,
      });
      continue;
    }

    // Cross-subject link: verify the target page exists in the target subject
    if (link.targetSubjectId !== subject.id) {
      const exists = pagesRepo.getPageBySlug(link.targetSubjectId, link.targetSlug);
      if (!exists) {
        const targetSubject = subjectsRepo.getById(link.targetSubjectId);
        const targetSubjectSlug = targetSubject?.slug ?? link.targetSubjectId;
        findings.push({
          type: 'broken-link',
          severity: 'warning',
          pageSlug: link.sourceSlug,
          description: `Broken cross-subject wikilink: [[${targetSubjectSlug}:${link.targetSlug}]] referenced from "${link.sourceSlug}" does not exist.`,
          suggestedFix: `Create the target page in subject "${targetSubjectSlug}", or remove the cross-subject reference.`,
        });
      }
    }
  }

  return findings;
}

function checkOrphanPages(
  subject: Subject,
  allPages: WikiPage[],
  allLinks: WikiLink[]
): LintFinding[] {
  const findings: LintFinding[] = [];
  // allLinks 为跨主题全量：跨主题入链也算 inbound
  const inboundSlugs = new Set<string>();
  for (const link of allLinks) {
    if (link.targetSubjectId === subject.id) {
      inboundSlugs.add(link.targetSlug);
    }
  }

  for (const page of allPages) {
    if (META_PAGE_SLUGS.has(page.slug)) continue;
    if ((page.tags ?? []).includes('meta')) continue;
    if (!inboundSlugs.has(page.slug)) {
      findings.push({
        type: 'orphan',
        severity: 'info',
        pageSlug: page.slug,
        description: `Orphan page: "${page.slug}" in subject "${subject.slug}" has no inbound links.`,
        suggestedFix: `Link to this page from at least one related page, or from the subject's index page.`,
      });
    }
  }

  return findings;
}

function checkMissingFrontmatter(subject: Subject): LintFinding[] {
  const findings: LintFinding[] = [];
  const wikiFiles = scanWikiPages(subject.slug);

  for (const file of wikiFiles) {
    try {
      const { data } = parseFrontmatter(file.content);
      const validation = validateFrontmatter(data as unknown as Record<string, unknown>);
      if (!validation.valid) {
        findings.push({
          type: 'missing-frontmatter',
          severity: 'warning',
          pageSlug: file.slug,
          description: `Invalid frontmatter in "${file.slug}" (subject: ${subject.slug}): ${validation.errors.join('; ')}.`,
          suggestedFix: `Add or fix the required YAML frontmatter fields: title, created, updated, tags, sources.`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      findings.push({
        type: 'missing-frontmatter',
        severity: 'warning',
        pageSlug: file.slug,
        description: `Failed to parse frontmatter in "${file.slug}" (subject: ${subject.slug}): ${msg}.`,
        suggestedFix: `Ensure the page has a valid YAML frontmatter block delimited by "---".`,
      });
    }
  }

  return findings;
}

/** thin-page 判定阈值：正文（去 frontmatter、trim 后）字符数下限。 */
export const THIN_PAGE_MIN_BODY_CHARS = 500;

/**
 * thin-page 检测：正文过短且零来源的页——典型来源是 fix 为消 broken-link 补建的占位 stub。
 * 不自动修（fix ignored 桶）；Health 页可据此引导 research/摄入资料补内容。
 * frontmatter 解析失败的页已由 missing-frontmatter 报，此处跳过不重复报。
 */
export function checkThinPages(subject: Subject): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const file of scanWikiPages(subject.slug)) {
    if (META_PAGE_SLUGS.has(file.slug)) continue;
    try {
      const { data, body } = parseFrontmatter(file.content);
      const tags = Array.isArray(data.tags) ? data.tags : [];
      if (tags.includes('meta')) continue;
      const sources = Array.isArray(data.sources) ? data.sources : [];
      if (sources.length > 0) continue;
      if (body.trim().length >= THIN_PAGE_MIN_BODY_CHARS) continue;
      findings.push({
        type: 'thin-page',
        severity: 'info',
        pageSlug: file.slug,
        description: `Thin page: "${file.slug}" (subject: ${subject.slug}) has a very short body and no sources — likely a placeholder stub that was never fleshed out.`,
        suggestedFix: `Ingest source material covering this topic, run a research job on it, or merge it into a related page.`,
      });
    } catch {
      // 解析失败 → missing-frontmatter 已报
    }
  }
  return findings;
}

/**
 * 单页 stale-source 判定（供 T1.8 re-enrich 质量信号复用，避免为一页触发全库扫描）。
 */
export function checkStaleSourcesForPage(subject: Subject, page: WikiPage): LintFinding[] {
  const findings: LintFinding[] = [];
  const sources = sourcesRepo.getSourcesForPage(subject.id, page.slug);
  for (const source of sources) {
    if (!isSourceStale(subject.slug, source)) continue;
    findings.push({
      type: 'stale-source',
      severity: 'info',
      pageSlug: page.slug,
      sourceId: source.id,
      sourceFilename: source.filename,
      description: `Source file "${source.filename}" linked to "${page.slug}" (subject: ${subject.slug}) is missing or changed on disk.`,
      suggestedFix: 'Re-ingest the source file to update the wiki page content.',
    });
  }
  return findings;
}

function checkStaleSources(subject: Subject, allPages: WikiPage[]): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const page of allPages) {
    findings.push(...checkStaleSourcesForPage(subject, page));
  }
  return findings;
}

/**
 * 孤儿 source 检测：零 page_sources 关联的 source，按其 ingest job 状态分类——
 *   pending/running → 在途，跳过（正常状态，不报）；
 *   failed          → 报（可 checkpoint 续传重试，带 failedJobId）；
 *   查无 job        → 报（enqueue 失败或 job 行已清理，failedJobId=null）；
 *   completed       → 报（ingest 成功但溯源丢失，属异常，failedJobId=null）。
 */
export function checkOrphanSources(subject: Subject): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const source of sourcesRepo.listUnreferencedSources(subject.id)) {
    const job = jobsRepo.findLatestIngestJobForSource(subject.id, source.id);
    if (job && (job.status === 'pending' || job.status === 'running')) continue;

    const failedJobId = job?.status === 'failed' ? job.id : null;
    const description = !job
      ? `Orphan source: "${source.filename}" (subject: ${subject.slug}) is not referenced by any wiki page and has no ingest job on record.`
      : job.status === 'failed'
        ? `Orphan source: "${source.filename}" (subject: ${subject.slug}) was saved but its ingest job failed — no wiki page references it.`
        : `Orphan source: "${source.filename}" (subject: ${subject.slug}) has a completed ingest job but no wiki page references it (provenance lost).`;

    findings.push({
      type: 'orphan-source',
      severity: 'warning',
      pageSlug: '',
      description,
      suggestedFix:
        'Retry the ingest to (re)build pages from this source, or delete the source if it is no longer needed.',
      sourceId: source.id,
      sourceFilename: source.filename,
      failedJobId,
    });
  }
  return findings;
}
