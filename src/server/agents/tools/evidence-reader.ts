import type { InspectSection, Subject, WikiInspection } from '@/lib/contracts';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import * as sourcesRepo from '@/server/db/repos/sources-repo';
import * as subjectsRepo from '@/server/db/repos/subjects-repo';
import { getSourceMetadata } from '@/server/sources/source-store';
import { isSourceStale } from '@/server/sources/source-staleness';

const ALL_INSPECT_SECTIONS: InspectSection[] = [
  'links',
  'backlinks',
  'sources',
  'health',
];

export function emptyWikiInspection(): WikiInspection {
  return {
    found: false,
    page: null,
    outgoing: [],
    backlinks: [],
    sources: [],
    health: {
      brokenLinks: 0,
      inboundCount: 0,
      outboundCount: 0,
      sourceCount: 0,
    },
  };
}

/** 读取页面关系、来源和轻量健康信息，不暴露页面正文。 */
export function inspectPageEvidence(
  subject: Subject,
  slug: string,
  include: InspectSection[] = ALL_INSPECT_SECTIONS,
): WikiInspection {
  const page = pagesRepo.getPageBySlug(subject.id, slug);
  if (!page || pagesRepo.isMetaPage(page)) return emptyWikiInspection();

  const requested = new Set(include);
  const needLinks = requested.has('links') || requested.has('health');
  const needBacklinks = requested.has('backlinks') || requested.has('health');
  const needSources = requested.has('sources') || requested.has('health');

  const links = needLinks
    ? pagesRepo.getAllLinks(subject.id).filter((link) => link.sourceSlug === slug)
    : [];
  const resolvedLinks = links.map((link) => {
    const targetSubject = subjectsRepo.getById(link.targetSubjectId);
    const target = pagesRepo.getPageBySlug(link.targetSubjectId, link.targetSlug);
    return {
      subjectSlug: targetSubject?.slug ?? '',
      slug: link.targetSlug,
      title: target?.title ?? null,
      context: link.context,
      resolved: target !== null,
    };
  });

  const backlinkPages = needBacklinks
    ? pagesRepo.getBacklinks(subject.id, slug)
    : [];
  const linkedSources = needSources
    ? sourcesRepo.getSourcesForPage(subject.id, slug)
    : [];

  return {
    found: true,
    page: {
      slug: page.slug,
      title: page.title,
      summary: page.summary ?? '',
      tags: page.tags ?? [],
      updatedAt: page.updatedAt,
    },
    outgoing: requested.has('links') ? resolvedLinks : [],
    backlinks: requested.has('backlinks')
      ? backlinkPages.map((backlink) => ({
          subjectSlug: subjectsRepo.getById(backlink.subjectId)?.slug ?? '',
          slug: backlink.slug,
          title: backlink.title,
        }))
      : [],
    sources: requested.has('sources')
      ? linkedSources.map((source) => ({
          id: source.id,
          filename: source.filename,
          originUrl: readOriginUrl(
            getSourceMetadata(source.id) ?? parseMetadataJson(source.metadataJson),
          ),
          parsedAt: source.parsedAt,
          stale: isSourceStale(subject.slug, source),
        }))
      : [],
    health: requested.has('health')
      ? {
          brokenLinks: resolvedLinks.filter((link) => !link.resolved).length,
          inboundCount: backlinkPages.length,
          outboundCount: links.length,
          sourceCount: linkedSources.length,
        }
      : {
          brokenLinks: 0,
          inboundCount: 0,
          outboundCount: 0,
          sourceCount: 0,
        },
  };
}

function readOriginUrl(metadata: Record<string, unknown> | null): string | null {
  return typeof metadata?.originUrl === 'string' && metadata.originUrl.length > 0
    ? metadata.originUrl
    : null;
}

function parseMetadataJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
