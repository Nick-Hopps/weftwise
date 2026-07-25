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
