/**
 * YAML frontmatter handling for wiki pages using gray-matter.
 * All functions are pure with no side effects.
 */

import matter from 'gray-matter';
import type { WikiFrontmatter } from '@/lib/contracts';

export type { WikiFrontmatter };

/**
 * Extract YAML frontmatter from raw markdown content.
 * Returns typed frontmatter data and the markdown body (without frontmatter block).
 */
export function parseFrontmatter(content: string): {
  data: WikiFrontmatter;
  body: string;
} {
  // 传一个 options 对象绕过 gray-matter 的全局缓存（index.js: `if (!options)` 才读写缓存）。
  // 缓存有 bug：matter 在 parseMatter **抛错前**就把半成品 file（data:{}、content:完整原文）
  // 写进 matter.cache[原文]；非法内容首次解析抛错后，缓存被这个半成品污染，导致**第二次**
  // 解析同一原文命中缓存、不再抛错而返回 {data:{}, content:完整原文}，既绕过下面的修复
  // 又造成「双 frontmatter / 空标题」的静默数据损坏。绕过缓存即可消除该不确定性。
  let result: matter.GrayMatterFile<string>;
  try {
    result = matter(content, {});
  } catch (err) {
    // LLM（尤其写中文内容时）偶发把 YAML key 的半角冒号打成全角冒号「：」(U+FF1A)，
    // 典型 `tags：`，使 frontmatter 成为非法 YAML（gray-matter 抛 YAMLException）。
    // frontmatter key 契约上恒为 ASCII，故把行首 ASCII-key 的全角冒号修回半角后重解析；
    // 无可修复处则原样上抛（不掩盖真实错误）。
    const repaired = repairFrontmatterColons(content);
    if (repaired === null) throw err;
    result = matter(repaired, {});
  }

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
 * 修复 LLM 手写 frontmatter 的常见错误：把 YAML key 的全角冒号「：」(U+FF1A) 改回半角 `:`。
 *
 * 仅作用于**首个 `---` 包裹的 frontmatter 区域**内、**行首 ASCII key 紧跟全角冒号**的情形
 * （如中文写作时把 `tags:` 误打成 `tags：`）。frontmatter key 契约上恒为 ASCII，故该替换
 * 不会误伤中文值（值在冒号之后或为列表项，不在行首 key 位置），正文中的全角冒号也不受影响。
 *
 * 无 frontmatter 块、或块内无可修复的全角冒号 key 时返回 `null`（避免无意义重解析、不掩盖真实错误）。
 * 纯函数。
 */
export function repairFrontmatterColons(content: string): string | null {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(content);
  if (!match) return null;

  const [, open, block, close] = match;
  // 行首（含可选缩进）ASCII 字母起头的 key，紧跟全角冒号 → 修回半角冒号。
  const fixed = block.replace(/^(\s*[A-Za-z][\w-]*)：/gm, '$1:');
  if (fixed === block) return null;

  return open + fixed + close + content.slice(match[0].length);
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
