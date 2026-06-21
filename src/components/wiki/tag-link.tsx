import Link from 'next/link';
import { Tag, type TagProps } from '@/components/ui/tag';

interface TagLinkProps {
  tag: string;
  subjectSlug: string;
  tone?: TagProps['tone'];
  size?: TagProps['size'];
}

/**
 * 可点 tag chip：链接到 /tags/<tag>?s=<subjectSlug>。
 * prop 驱动（不调 hooks），可在 Server / Client Component 通用。
 */
export function TagLink({ tag, subjectSlug, tone = 'neutral', size }: TagLinkProps) {
  const href = `/tags/${encodeURIComponent(tag)}?s=${encodeURIComponent(subjectSlug)}`;
  return (
    <Link href={href} className="rounded-sm hover:opacity-80 transition-opacity focus-ring">
      <Tag tone={tone} size={size}>{tag}</Tag>
    </Link>
  );
}
