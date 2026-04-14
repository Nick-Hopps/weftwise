import { NextRequest, NextResponse } from 'next/server';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import { requireAuth } from '@/server/middleware/auth';

export const runtime = 'nodejs';

// GET /api/graph
// Returns { nodes, edges } from wikilinks
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const pages = pagesRepo.getAllPages();
  const links = pagesRepo.getAllLinks();

  const inboundCount = new Map<string, number>();
  for (const link of links) {
    inboundCount.set(link.targetSlug, (inboundCount.get(link.targetSlug) || 0) + 1);
  }

  const slugSet = new Set(pages.map((p) => p.slug));

  const nodes = pages.map((p) => ({
    id: p.slug,
    label: p.title,
    linkCount: inboundCount.get(p.slug) || 0,
  }));

  const edges = links
    .filter((l) => slugSet.has(l.sourceSlug) && slugSet.has(l.targetSlug))
    .map((l) => ({
      source: l.sourceSlug,
      target: l.targetSlug,
    }));

  return NextResponse.json({
    nodes,
    edges,
    meta: { source: 'wiki', status: 'ready', nodeCount: nodes.length, edgeCount: edges.length },
  });
}
