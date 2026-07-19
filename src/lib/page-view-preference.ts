export type PageViewPreference = 'canonical' | 'reshape';

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY_PREFIX = 'wiki:page-view';

export function pageViewPreferenceKey(subjectSlug: string, slug: string): string {
  return `${KEY_PREFIX}:${encodeURIComponent(subjectSlug)}:${encodeURIComponent(slug)}`;
}

/** 缺失、损坏或存储不可用时保留既有行为：优先展示已保存的 Reshape。 */
export function readPageViewPreference(
  storage: Pick<PreferenceStorage, 'getItem'>,
  subjectSlug: string,
  slug: string,
): PageViewPreference {
  try {
    return storage.getItem(pageViewPreferenceKey(subjectSlug, slug)) === 'canonical'
      ? 'canonical'
      : 'reshape';
  } catch {
    return 'reshape';
  }
}

export function writePageViewPreference(
  storage: Pick<PreferenceStorage, 'setItem'>,
  subjectSlug: string,
  slug: string,
  preference: PageViewPreference,
): void {
  try {
    storage.setItem(pageViewPreferenceKey(subjectSlug, slug), preference);
  } catch {
    // 隐私模式或禁用存储时只影响跨导航记忆，不阻断当前阅读切换。
  }
}
