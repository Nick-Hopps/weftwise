import { Suspense } from 'react';
import { TagPagesView } from '@/components/tags/tag-pages-view';
import { TagsRouteFallback } from '@/components/tags/tags-route-fallback';
import { decodeRouteSegment } from '@/lib/route-params';

export default async function TagPage({ params }: { params: Promise<{ tag: string }> }) {
  const { tag } = await params;
  return (
    <Suspense fallback={<TagsRouteFallback />}>
      <TagPagesView tag={decodeRouteSegment(tag)} />
    </Suspense>
  );
}
