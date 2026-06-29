import { TagPagesView } from '@/components/tags/tag-pages-view';
import { decodeRouteSegment } from '@/lib/route-params';

export default async function TagPage({ params }: { params: Promise<{ tag: string }> }) {
  const { tag } = await params;
  return <TagPagesView tag={decodeRouteSegment(tag)} />;
}
