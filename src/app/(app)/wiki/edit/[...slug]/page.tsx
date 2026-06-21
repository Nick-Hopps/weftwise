import { PageEditor } from '@/components/wiki/page-editor';

export default async function EditPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug: slugParts } = await params;
  const slug = slugParts.join('/');
  return <PageEditor slug={slug} />;
}
