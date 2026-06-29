import { PageEditor } from '@/components/wiki/page-editor';
import { decodeRouteSegments } from '@/lib/route-params';

export default async function EditPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug: slugParts } = await params;
  const slug = decodeRouteSegments(slugParts);
  return <PageEditor slug={slug} />;
}
