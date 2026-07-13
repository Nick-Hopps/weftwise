import type {
  LinkEnsureInput,
  LinkEnsureMode,
  MetadataPatchField,
  MetadataPatchInput,
  WikiFrontmatter,
} from '@/lib/contracts';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { normalizeSlug } from './page-identity';
import { extractWikiLinks, resolveWikiLinkTarget } from './wikilinks';

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

export interface PreparedLinkEnsureEdit {
  oldString: string;
  newString: string;
  mode: LinkEnsureMode;
  targetSubjectSlug: string;
  targetSlug: string;
}

interface MarkdownNode {
  type: string;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
  children?: MarkdownNode[];
}

interface OffsetRange {
  start: number;
  end: number;
}

const FORBIDDEN_LINK_ANCHOR_NODES = new Set([
  'code',
  'html',
  'inlineCode',
  'link',
  'image',
  'linkReference',
  'imageReference',
]);

const COMMONMARK_ESCAPABLE_PUNCTUATION = new Set(
  "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
);

function countExactMatches(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    count += 1;
  }
  return count;
}

function nodeRange(node: MarkdownNode): OffsetRange | null {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return typeof start === 'number' && typeof end === 'number' ? { start, end } : null;
}

function collectCommonMarkSourceEscapeRanges(body: string): OffsetRange[] {
  const ranges: OffsetRange[] = [];
  const characterReference = /&(?:#[xX][0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g;
  for (const match of body.matchAll(characterReference)) {
    if (match.index !== undefined) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  for (let index = 0; index < body.length - 1; index += 1) {
    if (
      body[index] === '\\'
      && COMMONMARK_ESCAPABLE_PUNCTUATION.has(body[index + 1]!)
    ) {
      ranges.push({ start: index, end: index + 2 });
      index += 1;
    }
  }
  return ranges;
}

function collectMarkdownRanges(body: string): {
  forbidden: OffsetRange[];
  visibleText: OffsetRange[];
  sourceEscapes: OffsetRange[];
} {
  const root = unified().use(remarkParse).parse(body) as unknown as MarkdownNode;
  const forbidden: OffsetRange[] = [];
  const visibleText: OffsetRange[] = [];

  function walk(node: MarkdownNode): void {
    const range = nodeRange(node);
    if (range && FORBIDDEN_LINK_ANCHOR_NODES.has(node.type)) forbidden.push(range);
    if (range && node.type === 'text') visibleText.push(range);
    for (const child of node.children ?? []) walk(child);
  }
  walk(root);
  return {
    forbidden,
    visibleText,
    sourceEscapes: collectCommonMarkSourceEscapeRanges(body),
  };
}

function overlaps(left: OffsetRange, right: OffsetRange): boolean {
  return left.start < right.end && left.end > right.start;
}

function contains(outer: OffsetRange, inner: OffsetRange): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}

function normalizeLinkTarget(
  input: LinkEnsureInput,
  currentSubjectSlug: string,
): { targetSubjectSlug: string; targetSlug: string } {
  const targetSubjectSlug = input.targetSubjectSlug === undefined
    ? currentSubjectSlug
    : input.targetSubjectSlug.trim();
  if (!targetSubjectSlug) throw new Error('target subject slug must not be empty');
  const targetSlug = normalizeSlug(input.targetSlug);
  if (!targetSlug) throw new Error('target slug must not be empty');
  return { targetSubjectSlug, targetSlug };
}

function stableWikiLink(
  currentSubjectSlug: string,
  targetSubjectSlug: string,
  targetSlug: string,
  displayText: string,
): string {
  const target = targetSubjectSlug === currentSubjectSlug
    ? targetSlug
    : `${targetSubjectSlug}:${targetSlug}`;
  return `[[${target}|${displayText}]]`;
}

function assertCompleteStableWikiLink(input: {
  token: string;
  currentSubjectSlug: string;
  targetSubjectSlug: string;
  targetSlug: string;
  displayText: string;
}): void {
  const links = extractWikiLinks(input.token, {
    currentSubjectSlug: input.currentSubjectSlug,
  });
  const [link] = links;
  const complete = links.length === 1
    && link.raw === input.token
    && link.position.start === 0
    && link.position.end === input.token.length
    && link.targetSubjectSlug === input.targetSubjectSlug
    && link.target === input.targetSlug
    && link.alias === input.displayText;
  if (!complete) {
    throw new Error('displayText cannot form a complete stable wikilink token');
  }
}

/**
 * 纯函数：把一次 link/unlink/retarget 规约为精确替换，不读取 vault 或数据库。
 * link 的自然语言锚点必须落在 remark AST 的可见文本中，且不得位于代码或 Markdown 链接内。
 */
export function buildLinkEnsureEdit(
  body: string,
  input: LinkEnsureInput,
  currentSubjectSlug: string,
): PreparedLinkEnsureEdit {
  if (!input.oldString) throw new Error('oldString must not be empty');
  const oldStringMatches = countExactMatches(body, input.oldString);
  if (oldStringMatches === 0) {
    throw new Error('oldString not found — quote the page text verbatim');
  }
  if (oldStringMatches > 1) {
    throw new Error(
      `oldString matches ${oldStringMatches} locations — include more surrounding context`,
    );
  }

  const target = normalizeLinkTarget(input, currentSubjectSlug);
  const oldStringStart = body.indexOf(input.oldString);

  if (input.mode === 'link') {
    if (extractWikiLinks(input.oldString, { currentSubjectSlug }).length > 0) {
      throw new Error('link oldString must not contain an existing wikilink');
    }
    const anchor = input.displayText === undefined
      ? input.oldString
      : input.displayText.trim();
    if (!anchor) throw new Error('displayText must not be empty');
    const anchorMatches = countExactMatches(input.oldString, anchor);
    if (anchorMatches === 0) {
      throw new Error('displayText not found in oldString');
    }
    if (anchorMatches > 1) {
      throw new Error(`displayText matches ${anchorMatches} locations in oldString`);
    }

    const anchorStart = oldStringStart + input.oldString.indexOf(anchor);
    const anchorRange = { start: anchorStart, end: anchorStart + anchor.length };
    const markdownRanges = collectMarkdownRanges(body);
    const wikilinkRanges = extractWikiLinks(body, { currentSubjectSlug })
      .map((link) => link.position);
    const inForbiddenContext = markdownRanges.forbidden.some((range) => overlaps(range, anchorRange))
      || wikilinkRanges.some((range) => overlaps(range, anchorRange));
    const isVisibleText = markdownRanges.visibleText.some((range) => contains(range, anchorRange));
    if (inForbiddenContext || !isVisibleText) {
      throw new Error('link anchor must be visible prose outside code, wikilinks, and Markdown links');
    }
    if (markdownRanges.sourceEscapes.some((range) => overlaps(range, anchorRange))) {
      throw new Error(
        'link anchor must not overlap a CommonMark character reference or backslash source escape',
      );
    }

    const replacement = stableWikiLink(
      currentSubjectSlug,
      target.targetSubjectSlug,
      target.targetSlug,
      anchor,
    );
    assertCompleteStableWikiLink({
      token: replacement,
      currentSubjectSlug,
      targetSubjectSlug: target.targetSubjectSlug,
      targetSlug: target.targetSlug,
      displayText: anchor,
    });
    const anchorOffset = input.oldString.indexOf(anchor);
    const newString = input.oldString.slice(0, anchorOffset)
      + replacement
      + input.oldString.slice(anchorOffset + anchor.length);
    return { oldString: input.oldString, newString, mode: input.mode, ...target };
  }

  const links = extractWikiLinks(input.oldString, { currentSubjectSlug });
  if (links.length !== 1) {
    throw new Error('unlink/retarget oldString must contain exactly one valid wikilink');
  }
  const [link] = links;
  const tokenRange = {
    start: oldStringStart + link.position.start,
    end: oldStringStart + link.position.end,
  };
  const markdownRanges = collectMarkdownRanges(body);
  const inForbiddenContext = markdownRanges.forbidden.some((range) => overlaps(range, tokenRange));
  const isVisibleText = markdownRanges.visibleText.some((range) => contains(range, tokenRange));
  if (inForbiddenContext || !isVisibleText) {
    throw new Error(
      'unlink/retarget token context must be visible prose outside code, links, images, and HTML',
    );
  }
  if (
    input.mode === 'unlink'
    && markdownRanges.sourceEscapes.some((range) => (
      range.start < tokenRange.start && range.end > tokenRange.start
    ))
  ) {
    throw new Error('unlink token start must not cross a CommonMark source escape boundary');
  }
  const displayText = link.alias ?? link.rawTitle;
  if (input.displayText !== undefined && input.displayText.trim() !== displayText) {
    throw new Error('displayText does not match the existing wikilink display text');
  }

  if (input.mode === 'unlink') {
    const oldTarget = resolveWikiLinkTarget(link.raw.slice(2, -2), currentSubjectSlug);
    if (
      oldTarget.subjectSlug !== target.targetSubjectSlug
      || oldTarget.slug !== target.targetSlug
    ) {
      throw new Error('existing wikilink target does not match the requested unlink target');
    }
    const newString = input.oldString.slice(0, link.position.start)
      + displayText
      + input.oldString.slice(link.position.end);
    return { oldString: input.oldString, newString, mode: input.mode, ...target };
  }

  const replacement = stableWikiLink(
    currentSubjectSlug,
    target.targetSubjectSlug,
    target.targetSlug,
    displayText,
  );
  assertCompleteStableWikiLink({
    token: replacement,
    currentSubjectSlug,
    targetSubjectSlug: target.targetSubjectSlug,
    targetSlug: target.targetSlug,
    displayText,
  });
  if (replacement === link.raw) throw new Error('retarget has no actual link change');
  const newString = input.oldString.slice(0, link.position.start)
    + replacement
    + input.oldString.slice(link.position.end);
  return { oldString: input.oldString, newString, mode: input.mode, ...target };
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
