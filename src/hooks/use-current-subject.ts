'use client';

import { useUIStore } from '@/stores/ui-store';

export interface CurrentSubject {
  id: string | null;
  slug: string;
  setCurrentSubject: (subject: { id: string; slug: string }) => void;
}

/**
 * Lightweight selector for the active subject.
 *
 * Returns the persisted `id` (may be `null` before bootstrap finishes), the
 * `slug` (always defined — falls back to "general" until a real subject is
 * loaded), and the setter that also syncs the `wiki_subject` cookie.
 */
export function useCurrentSubject(): CurrentSubject {
  const id = useUIStore((s) => s.currentSubjectId);
  const slug = useUIStore((s) => s.currentSubjectSlug);
  const setCurrentSubject = useUIStore((s) => s.setCurrentSubject);
  return { id, slug, setCurrentSubject };
}
