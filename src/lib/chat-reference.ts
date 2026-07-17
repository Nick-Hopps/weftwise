import type { UserMessageReference } from '@/lib/contracts';

export const MAX_USER_MESSAGE_REFERENCES = 40;

export interface UserMessageReferenceSource {
  section: string | null;
  text: string;
}

/** 把本轮真正发送的 Passage 绑定到当前 Subject/page，供即时展示与持久化。 */
export function buildUserMessageReferences(
  sources: UserMessageReferenceSource[],
  context: { pageSlug: string; pageTitle: string; subjectSlug: string },
): UserMessageReference[] {
  return sources
    .map((source) => ({
      pageSlug: context.pageSlug,
      pageTitle: context.pageTitle,
      subjectSlug: context.subjectSlug,
      section: source.section?.trim() || null,
      excerpt: source.text.trim(),
    }))
    .filter((reference) => reference.excerpt.length > 0)
    .slice(0, MAX_USER_MESSAGE_REFERENCES);
}
