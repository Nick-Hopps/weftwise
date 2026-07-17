import type { SubjectId, WikiLink, WikiPage } from '@/lib/contracts';

type GraphPage = Pick<WikiPage, 'slug' | 'title'>;

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
}

export interface GraphProjection {
  nodes: Array<{ id: string; label: string; linkCount: number }>;
  edges: GraphEdge[];
  referenceCount: number;
}

/** 将原始 wikilink 投影为适合可视化的唯一有向关系。 */
export function buildGraphProjection(
  pages: GraphPage[],
  links: WikiLink[],
  subjectId: SubjectId,
): GraphProjection {
  const slugSet = new Set(pages.map((page) => page.slug));
  const edgesByPair = new Map<string, GraphEdge>();
  const inboundSources = new Map<string, Set<string>>();
  let referenceCount = 0;

  for (const link of links) {
    if (
      link.targetSubjectId !== subjectId ||
      !slugSet.has(link.sourceSlug) ||
      !slugSet.has(link.targetSlug)
    ) {
      continue;
    }

    referenceCount += 1;
    const pairKey = `${link.sourceSlug}\u0000${link.targetSlug}`;
    const edge = edgesByPair.get(pairKey);
    if (edge) {
      edge.weight += 1;
    } else {
      edgesByPair.set(pairKey, {
        source: link.sourceSlug,
        target: link.targetSlug,
        weight: 1,
      });
    }

    const sources = inboundSources.get(link.targetSlug) ?? new Set<string>();
    sources.add(link.sourceSlug);
    inboundSources.set(link.targetSlug, sources);
  }

  return {
    nodes: pages.map((page) => ({
      id: page.slug,
      label: page.title,
      linkCount: inboundSources.get(page.slug)?.size ?? 0,
    })),
    edges: [...edgesByPair.values()],
    referenceCount,
  };
}
