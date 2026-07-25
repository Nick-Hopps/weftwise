import type { Source } from '@/lib/contracts';

/**
 * Source 展示元数据（标题 / 描述）的唯一真实源。
 *
 * 与实体类型无关：链接型 URL Source 由 worker 抓取后写回，Ingest 自主检索导入的
 * 网页快照 Source 由 finalize 阶段写入，普通上传文件则没有。读取方按
 * 「展示字段 → 各自的回退（hostname / filename）」解析，绝不因渲染列表联网或读盘。
 */
export const SOURCE_TITLE_MAX_LENGTH = 300;
export const SOURCE_DESCRIPTION_MAX_LENGTH = 1000;

export interface SourcePresentation {
  title?: string;
  description?: string;
}

function normalizeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

export function normalizeSourcePresentation(
  presentation: { title?: unknown; description?: unknown },
): SourcePresentation {
  return {
    title: normalizeText(presentation.title, SOURCE_TITLE_MAX_LENGTH),
    description: normalizeText(presentation.description, SOURCE_DESCRIPTION_MAX_LENGTH),
  };
}

const MIN_PROSE_LENGTH = 30;
const MIN_SENTENCE_LENGTH = 6;
const SENTENCE_END = /[.。!！?？]\s*$/;

/** 去掉 Markdown 语法只留可读文本，用于判断一段内容是正文还是导航噪声。 */
function plainTextOf(paragraph: string): string {
  return paragraph
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')       // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')     // 链接保留文字
    .replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s*/gm, '') // 标题/引用/列表标记
    .replace(/[*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 取网页正文 Markdown 中第一段“像正文”的段落，供缺省描述使用。
 * 判据：去 Markdown 语法后足够长，或较短但有句末标点；纯图片/纯导航链接被跳过。
 */
export function firstMeaningfulParagraph(markdown: string): string | undefined {
  for (const paragraph of markdown.split(/\n\s*\n/)) {
    const text = plainTextOf(paragraph);
    if (!text) continue;
    if (text.length >= MIN_PROSE_LENGTH) return text;
    if (text.length >= MIN_SENTENCE_LENGTH && SENTENCE_END.test(text)) return text;
  }
  return undefined;
}

/** 从 SQLite metadata cache 读取展示字段；损坏或非对象元数据一律返回空展示。 */
export function readSourcePresentation(
  source: Pick<Source, 'metadataJson'>,
): SourcePresentation {
  let metadata: unknown;
  try {
    metadata = JSON.parse(source.metadataJson);
  } catch {
    return {};
  }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return {};
  return normalizeSourcePresentation(metadata as { title?: unknown; description?: unknown });
}
