/**
 * YAML frontmatter handling for wiki pages using gray-matter.
 * All functions are pure with no side effects.
 */

import matter from 'gray-matter';

/**
 * Typed frontmatter fields for every wiki page.
 */
export interface WikiFrontmatter {
  title: string;
  created: string;
  updated: string;
  tags: string[];
  sources: string[];
  summary?: string;
  aliases?: string[];
}

/**
 * Extract YAML frontmatter from raw markdown content.
 * Returns typed frontmatter data and the markdown body (without frontmatter block).
 */
export function parseFrontmatter(content: string): {
  data: WikiFrontmatter;
  body: string;
} {
  const result = matter(content);

  const raw = result.data as Record<string, unknown>;

  const toStr = (v: unknown): string =>
    typeof v === 'string' ? v : v instanceof Date ? v.toISOString() : '';

  const data: WikiFrontmatter = {
    title: typeof raw['title'] === 'string' ? raw['title'] : '',
    created: toStr(raw['created']),
    updated: toStr(raw['updated']),
    tags: Array.isArray(raw['tags'])
      ? (raw['tags'] as unknown[]).map(String)
      : [],
    sources: Array.isArray(raw['sources'])
      ? (raw['sources'] as unknown[]).map(String)
      : [],
    ...(raw['summary'] !== undefined && {
      summary: typeof raw['summary'] === 'string' ? raw['summary'] : String(raw['summary']),
    }),
    ...(raw['aliases'] !== undefined && {
      aliases: Array.isArray(raw['aliases'])
        ? (raw['aliases'] as unknown[]).map(String)
        : [],
    }),
  };

  return { data, body: result.content };
}

/**
 * Reconstruct a full markdown document from structured frontmatter + body.
 * Produces an Obsidian-compatible YAML frontmatter block followed by the body.
 */
export function serializeFrontmatter(data: WikiFrontmatter, body: string): string {
  // Build a plain object; omit optional fields when they are undefined
  const frontmatterObj: Record<string, unknown> = {
    title: data.title,
    created: data.created,
    updated: data.updated,
    tags: data.tags,
    sources: data.sources,
  };
  if (data.summary !== undefined) {
    frontmatterObj['summary'] = data.summary;
  }
  if (data.aliases !== undefined) {
    frontmatterObj['aliases'] = data.aliases;
  }

  return matter.stringify(body, frontmatterObj);
}

/**
 * Stamp system-owned frontmatter fields onto a page's raw content.
 *
 * Division of ownership: the LLM authors `title` / `summary` / `tags` and the
 * body; the system owns the timestamps. `updated` is always set to `now`;
 * `created` is preserved from the existing page when known, otherwise `now`.
 * Any LLM-supplied `created` / `updated` is intentionally overwritten so the
 * model never invents timestamps. `sources` is guaranteed to be an array.
 *
 * Pure: `now` and `existingCreated` are passed in so the result is deterministic.
 */
export function stampSystemFrontmatter(
  content: string,
  opts: { now: string; existingCreated?: string | null },
): string {
  const { data, body } = parseFrontmatter(content);

  const existing = opts.existingCreated?.trim();
  const created = existing ? existing : opts.now;

  const stamped: WikiFrontmatter = {
    ...data,
    created,
    updated: opts.now,
    tags: Array.isArray(data.tags) ? data.tags : [],
    sources: Array.isArray(data.sources) ? data.sources : [],
  };

  return serializeFrontmatter(stamped, body);
}

const REQUIRED_FIELDS: (keyof WikiFrontmatter)[] = [
  'title',
  'created',
  'updated',
  'tags',
  'sources',
];

/**
 * Validate a parsed frontmatter record for required fields and expected types.
 * Returns `{ valid, errors }` — does not throw.
 */
export function validateFrontmatter(data: Record<string, unknown>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  for (const field of REQUIRED_FIELDS) {
    if (!(field in data) || data[field] === undefined || data[field] === null) {
      errors.push(`Missing required field: "${field}"`);
      continue;
    }
    if (field === 'tags' || field === 'sources') {
      if (!Array.isArray(data[field])) {
        errors.push(`Field "${field}" must be an array`);
      }
    } else {
      if (typeof data[field] !== 'string') {
        errors.push(`Field "${field}" must be a string`);
      } else if ((data[field] as string).trim() === '') {
        errors.push(`Field "${field}" must not be empty`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
