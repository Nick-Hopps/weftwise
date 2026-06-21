import { TagPagesView } from '@/components/tags/tag-pages-view';

export default async function TagPage({ params }: { params: Promise<{ tag: string }> }) {
  const { tag } = await params;
  return <TagPagesView tag={decodeURIComponent(tag)} />;
}
