/**
 * 确定性渲染 subject 的两张系统元页：`index.md`（map-of-content）与 `log.md`（变更日志）。
 *
 * 取代原先由无 tools 的 `ingest-indexer` LLM 结构化输出重建这两页的做法：目录/日志本质上
 * 是可从数据库/本次运行信息确定性派生的数据，不需要 LLM 生成，且页数上升后原方案要把
 * 全 subject 页清单塞进 prompt，token 随规模线性增长直至撑爆上下文窗口。
 *
 * 全部为纯函数：不接触 fs/db/LLM，方便单测；调用方（ingest-service）负责取数与落盘。
 */

import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import type { WikiFrontmatter } from '@/lib/contracts';

export interface IndexPageEntry {
  slug: string;
  title: string;
  summary?: string;
  tags?: string[];
}

export type TemplateLang = 'zh' | 'en';

export interface RenderIndexOptions {
  subjectSlug: string;
  subjectName: string;
  language: TemplateLang;
}

export interface RenderLogOptions {
  subjectSlug: string;
  subjectName: string;
  language: TemplateLang;
}

/** log.md 保留的最近条目数（新条目在前，超出的旧条目被截断丢弃）。 */
export const MAX_LOG_ENTRIES = 50;

const UNCATEGORIZED = { zh: '未分类', en: 'Uncategorized' } as const;

const INDEX_STRINGS = {
  zh: {
    titleSuffix: '— 索引',
    heading: '# 索引',
    intro: (name: string) => `${name} 主题下所有页面的分组索引。`,
    empty: '本主题暂无页面。',
  },
  en: {
    titleSuffix: '— Index',
    heading: '# Index',
    intro: (name: string) => `A grouped index of every page in the "${name}" subject.`,
    empty: 'This subject has no pages yet.',
  },
} as const;

const LOG_STRINGS = {
  zh: { titleSuffix: '— 变更日志', heading: '# 变更日志', empty: '暂无记录。' },
  en: { titleSuffix: '— Change Log', heading: '# Change Log', empty: 'No entries yet.' },
} as const;

/**
 * 把全局 `wikiLanguage` 设置（自由文本，如 "Chinese" / "English" / 自定义）粗略归一到
 * 固定模板语言二值。命中常见中文关键词（含中文字符本身）判 zh，否则一律 en。
 * 只影响 index/log 的**固定文案**（分组标题、页头），不影响页面标题/摘要本身的语言
 * （那些来自 title/summary 字段，早已按 wikiLanguage 生成）。
 */
export function resolveTemplateLang(language: string): TemplateLang {
  const normalized = language.trim().toLowerCase();
  if (/chinese|mandarin|中文|汉语|漢語/.test(normalized) || /[一-鿿]/.test(language)) {
    return 'zh';
  }
  return 'en';
}

function buildFrontmatter(title: string): WikiFrontmatter {
  return {
    title,
    created: '',
    updated: '',
    tags: ['meta'],
    sources: [],
  };
}

/** 稳定排序：按标题（locale-aware）比较，标题相同按 slug 决胜，保证输出确定性。 */
function compareByTitle(a: IndexPageEntry, b: IndexPageEntry): number {
  const t = a.title.localeCompare(b.title);
  return t !== 0 ? t : a.slug.localeCompare(b.slug);
}

/**
 * 渲染 index.md：按每页的第一个 tag 分组（无 tag 归"未分类"/"Uncategorized"，永远排在
 * 最后一组），组名按字典序排序，组内页面按标题排序。每个条目为 `[[slug|Title]]`，
 * 有摘要则追加 `— <summary>`。wikilink 用 slug 作 target（同 subject 内可解析、不产生坏链）。
 */
export function renderIndexPage(pages: IndexPageEntry[], opts: RenderIndexOptions): string {
  const strings = INDEX_STRINGS[opts.language];
  const uncategorized = UNCATEGORIZED[opts.language];

  const groups = new Map<string, IndexPageEntry[]>();
  for (const page of pages) {
    const key = page.tags && page.tags.length > 0 ? page.tags[0] : uncategorized;
    const bucket = groups.get(key);
    if (bucket) bucket.push(page);
    else groups.set(key, [page]);
  }

  const groupNames = [...groups.keys()]
    .filter((name) => name !== uncategorized)
    .sort((a, b) => a.localeCompare(b));
  if (groups.has(uncategorized)) groupNames.push(uncategorized);

  const lines: string[] = [strings.heading, '', strings.intro(opts.subjectName)];

  if (pages.length === 0) {
    lines.push('', strings.empty);
  }

  for (const groupName of groupNames) {
    const entries = [...(groups.get(groupName) ?? [])].sort(compareByTitle);
    lines.push('', `## ${groupName}`, '');
    for (const entry of entries) {
      const link = `[[${entry.slug}|${entry.title}]]`;
      const tail = entry.summary && entry.summary.trim() ? ` — ${entry.summary.trim()}` : '';
      lines.push(`- ${link}${tail}`);
    }
  }

  const title = `${opts.subjectName} ${strings.titleSuffix}`;
  return serializeFrontmatter(buildFrontmatter(title), `${lines.join('\n')}\n`);
}

/**
 * 从既有 log.md 全文解析出条目列表（正文中以 `- ` 开头的行，按原文顺序、去掉前缀）。
 * 不存在（首建）或无可解析条目时返回 `[]`。纯字符串解析，不理解 markdown 语义之外的结构，
 * 但足够可靠——log 条目由本模块自己渲染，格式受控。
 */
export function parseLogEntries(existingLogMd: string | null): string[] {
  if (!existingLogMd) return [];
  const { body } = parseFrontmatter(existingLogMd);
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());
}

/** 构造本次 ingest 的一条日志文案：`ingested "a.txt", "b.md": N page(s)`。 */
export function buildIngestLogEntry(
  sources: Array<{ filename: string }>,
  pageCount: number,
): string {
  const filenames = sources.map((s) => `"${s.filename}"`).join(', ');
  return `ingested ${filenames}: ${pageCount} page(s)`;
}

/**
 * 渲染 log.md：`entries` 已按新→旧排好序（调用方负责把新条目 unshift 到既有条目前），
 * 本函数只截断到 `MAX_LOG_ENTRIES` 条并套上 frontmatter/表头。
 */
export function renderLogPage(entries: string[], opts: RenderLogOptions): string {
  const strings = LOG_STRINGS[opts.language];
  const capped = entries.slice(0, MAX_LOG_ENTRIES);

  const lines: string[] = [strings.heading, ''];
  if (capped.length === 0) {
    lines.push(strings.empty);
  } else {
    for (const entry of capped) lines.push(`- ${entry}`);
  }

  const title = `${opts.subjectName} ${strings.titleSuffix}`;
  return serializeFrontmatter(buildFrontmatter(title), `${lines.join('\n')}\n`);
}
