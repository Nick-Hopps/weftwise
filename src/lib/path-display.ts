interface PageTitleEntry {
  slug: string;
  title: string;
}

function safeDecodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function displayTitleForSlug(slug: string, pages?: PageTitleEntry[]): string {
  const decodedSlug = safeDecodePathSegment(slug);
  return (
    pages?.find((page) => page.slug === slug || page.slug === decodedSlug)?.title ?? decodedSlug
  );
}
