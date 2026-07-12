import type {
  PostconditionFinding,
  PostconditionScope,
  Subject,
  WikiLink,
  WikiPage,
} from '@/lib/contracts';
import * as pagesRepo from '../db/repos/pages-repo';
import * as sourcesRepo from '../db/repos/sources-repo';
import type { PageSourceIntegrityRow } from '../db/repos/sources-repo';
import { META_PAGE_SLUGS } from '../wiki/page-identity';

export interface PostconditionSnapshot {
  pages: WikiPage[];
  links: WikiLink[];
  pageSources: PageSourceIntegrityRow[];
}

function pageKey(subjectId: string, slug: string): string {
  return `${subjectId}\0${slug}`;
}

export function loadPostconditionSnapshot(
  subject: Subject,
  scope: PostconditionScope,
): PostconditionSnapshot {
  return {
    pages: pagesRepo.getAllPagesAcrossSubjects(),
    links: pagesRepo.getAllLinks(undefined, pagesRepo.getMetaPageKeys()),
    pageSources: sourcesRepo.listPageSourceIntegrityRows(
      subject.id,
      [...new Set([...scope.touchedSlugs, ...scope.deletedSlugs])],
    ),
  };
}

function stableFindings(findings: PostconditionFinding[]): PostconditionFinding[] {
  const unique = new Map<string, PostconditionFinding>();
  for (const finding of findings) {
    const key = `${finding.type}\0${finding.pageSlug ?? ''}\0${finding.description}`;
    if (!unique.has(key)) unique.set(key, finding);
  }
  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, finding]) => finding);
}

/** 校验当前 Job 实际变更范围内的结构性写后不变量。 */
export function verifyDeterministicPostconditions(
  subject: Subject,
  scope: PostconditionScope,
  providedSnapshot?: PostconditionSnapshot,
): PostconditionFinding[] {
  if (scope.operationIds.length === 0) return [];

  const snapshot = providedSnapshot ?? loadPostconditionSnapshot(subject, scope);
  const existingPageKeys = new Set(
    snapshot.pages.map((page) => pageKey(page.subjectId, page.slug)),
  );
  const pagesByKey = new Map(
    snapshot.pages.map((page) => [pageKey(page.subjectId, page.slug), page]),
  );
  const touched = new Set(scope.touchedSlugs);
  const deleted = new Set(scope.deletedSlugs);
  const findings: PostconditionFinding[] = [];

  for (const link of snapshot.links) {
    const sourceKey = pageKey(link.subjectId, link.sourceSlug);
    const targetKey = pageKey(link.targetSubjectId, link.targetSlug);

    if (
      link.subjectId === subject.id &&
      touched.has(link.sourceSlug) &&
      existingPageKeys.has(sourceKey) &&
      !existingPageKeys.has(targetKey)
    ) {
      findings.push({
        type: 'broken-link',
        severity: 'warning',
        pageSlug: link.sourceSlug,
        description: `受影响页面 "${link.sourceSlug}" 仍链接到不存在的页面 "${link.targetSlug}"。`,
        relatedSlugs: [link.targetSlug],
      });
    }

    if (
      link.targetSubjectId === subject.id &&
      deleted.has(link.targetSlug) &&
      !existingPageKeys.has(targetKey) &&
      existingPageKeys.has(sourceKey)
    ) {
      findings.push({
        type: 'dangling-incoming-link',
        severity: 'warning',
        pageSlug: link.sourceSlug,
        description: `页面 "${link.sourceSlug}" 仍指向本次已删除的页面 "${link.targetSlug}"。`,
        relatedSlugs: [link.targetSlug],
      });
    }
  }

  const inboundTargets = new Set(
    snapshot.links
      .filter((link) => link.targetSubjectId === subject.id)
      .map((link) => link.targetSlug),
  );
  for (const slug of scope.createdSlugs) {
    const page = pagesByKey.get(pageKey(subject.id, slug));
    if (!page) continue;
    if (META_PAGE_SLUGS.has(slug) || pagesRepo.isMetaPage(page)) continue;
    if (inboundTargets.has(slug)) continue;
    findings.push({
      type: 'orphan-page',
      severity: 'info',
      pageSlug: slug,
      description: `本次新建页面 "${slug}" 没有任何入链。`,
    });
  }

  for (const row of snapshot.pageSources) {
    if (row.pageExists && row.sourceSubjectId === subject.id) continue;
    const reason = !row.pageExists
      ? '页面不存在'
      : row.sourceSubjectId === null
        ? '来源不存在'
        : `来源属于其他 Subject（${row.sourceSubjectId}）`;
    findings.push({
      type: 'dangling-page-source',
      severity: 'warning',
      pageSlug: row.pageSlug,
      description: `页面 "${row.pageSlug}" 的来源关联 "${row.sourceId}" 无效：${reason}。`,
    });
  }

  return stableFindings(findings);
}
