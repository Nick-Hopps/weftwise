import type {
  MetadataPatchField,
  MetadataPatchInput,
  WikiFrontmatter,
} from '@/lib/contracts';
import { normalizeSlug } from './page-identity';

export const MAX_METADATA_TITLE_LENGTH = 200;
export const MAX_METADATA_SUMMARY_LENGTH = 2_000;
export const MAX_METADATA_TAGS = 32;
export const MAX_METADATA_TAG_LENGTH = 64;
export const MAX_METADATA_ALIASES = 32;
export const MAX_METADATA_ALIAS_LENGTH = 200;

const METADATA_FIELDS = ['title', 'summary', 'tags', 'aliases'] as const;

export interface MetadataPageIdentity {
  slug: string;
  title: string;
  aliases?: readonly string[];
}

export interface MetadataAliasConflict {
  alias: string;
  pageSlug: string;
  field: 'slug' | 'title' | 'alias';
  conflictingValue: string;
}

export interface PreparedMetadataPatch {
  patch: MetadataPatchInput;
  frontmatter: WikiFrontmatter;
  changedFields: MetadataPatchField[];
}

function assertMaxLength(field: string, value: string, max: number): void {
  if (value.length > max) {
    throw new Error(`${field} must be ${max} characters or fewer`);
  }
}

function normalizeTagIdentity(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

function normalizeStringList(
  field: 'tags' | 'aliases',
  values: string[],
  maxItems: number,
  maxLength: number,
  identityOf: (value: string) => string,
): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    assertMaxLength(field === 'tags' ? 'tag' : 'alias', value, maxLength);
    const identity = identityOf(value);
    if (seen.has(identity)) continue;
    seen.add(identity);
    normalized.push(value);
  }
  if (normalized.length > maxItems) {
    throw new Error(`${field} must contain ${maxItems} items or fewer`);
  }
  return normalized;
}

/** 规范化并校验调用方可编辑的 metadata 字段；不读取页面、不产生副作用。 */
export function normalizeMetadataPatch(input: MetadataPatchInput): MetadataPatchInput {
  const hasEditableField = METADATA_FIELDS.some((field) => input[field] !== undefined);
  if (!hasEditableField) {
    throw new Error('metadata patch requires at least one metadata field');
  }

  const normalized: MetadataPatchInput = { slug: input.slug };
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) throw new Error('metadata title must not be empty');
    assertMaxLength('metadata title', title, MAX_METADATA_TITLE_LENGTH);
    normalized.title = title;
  }
  if (input.summary !== undefined) {
    const summary = input.summary.trim();
    assertMaxLength('metadata summary', summary, MAX_METADATA_SUMMARY_LENGTH);
    normalized.summary = summary;
  }
  if (input.tags !== undefined) {
    normalized.tags = normalizeStringList(
      'tags',
      input.tags,
      MAX_METADATA_TAGS,
      MAX_METADATA_TAG_LENGTH,
      normalizeTagIdentity,
    );
  }
  if (input.aliases !== undefined) {
    normalized.aliases = normalizeStringList(
      'aliases',
      input.aliases,
      MAX_METADATA_ALIASES,
      MAX_METADATA_ALIAS_LENGTH,
      normalizeSlug,
    );
  }
  return normalized;
}

/**
 * 扫描同 Subject 页面身份，返回 alias 对其他页 slug/title/alias 的规范化冲突。
 * 当前页由原始 slug 精确识别并排除，避免把自己的既有身份误报为冲突。
 */
export function findMetadataAliasConflicts(
  currentSlug: string,
  aliases: readonly string[],
  pages: readonly MetadataPageIdentity[],
): MetadataAliasConflict[] {
  const conflicts: MetadataAliasConflict[] = [];
  for (const page of pages) {
    if (page.slug === currentSlug) continue;
    const identities: Array<{
      field: MetadataAliasConflict['field'];
      value: string;
    }> = [
      { field: 'slug', value: page.slug },
      { field: 'title', value: page.title },
      ...(page.aliases ?? []).map((value) => ({ field: 'alias' as const, value })),
    ];
    for (const alias of aliases) {
      const aliasIdentity = normalizeSlug(alias);
      for (const identity of identities) {
        if (aliasIdentity === normalizeSlug(identity.value)) {
          conflicts.push({
            alias,
            pageSlug: page.slug,
            field: identity.field,
            conflictingValue: identity.value,
          });
        }
      }
    }
  }
  return conflicts;
}

function sameStrings(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left !== undefined
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/**
 * 计算规范化后的下一份 frontmatter 与真实变更字段。系统字段原样保留；空操作直接拒绝。
 */
export function prepareMetadataPatch(
  current: WikiFrontmatter,
  input: MetadataPatchInput,
  pages: readonly MetadataPageIdentity[],
): PreparedMetadataPatch {
  const patch = normalizeMetadataPatch(input);
  if (patch.aliases !== undefined) {
    const [conflict] = findMetadataAliasConflicts(input.slug, patch.aliases, pages);
    if (conflict) {
      throw new Error(
        `metadata alias conflict with page "${conflict.pageSlug}" ${conflict.field}: "${conflict.alias}"`,
      );
    }
  }

  const frontmatter: WikiFrontmatter = { ...current };
  const changedFields: MetadataPatchField[] = [];
  if (patch.title !== undefined && patch.title !== current.title) {
    frontmatter.title = patch.title;
    changedFields.push('title');
  }
  if (patch.summary !== undefined && patch.summary !== current.summary) {
    frontmatter.summary = patch.summary;
    changedFields.push('summary');
  }
  if (patch.tags !== undefined && !sameStrings(current.tags, patch.tags)) {
    frontmatter.tags = patch.tags;
    changedFields.push('tags');
  }
  if (patch.aliases !== undefined && !sameStrings(current.aliases, patch.aliases)) {
    frontmatter.aliases = patch.aliases;
    changedFields.push('aliases');
  }
  if (changedFields.length === 0) {
    throw new Error('metadata patch has no actual metadata changes');
  }

  return { patch, frontmatter, changedFields };
}
