import { Suspense } from 'react';
import { TagsIndexView } from '@/components/tags/tags-index-view';
import { TagsRouteFallback } from '@/components/tags/tags-route-fallback';

export default function TagsPage() {
  return (
    <Suspense fallback={<TagsRouteFallback />}>
      <TagsIndexView />
    </Suspense>
  );
}
