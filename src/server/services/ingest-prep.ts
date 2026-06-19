import { chunkText, sourceKindFor, type SourceChunk } from '../sources/source-chunker';
import { cleanSourceText, cleanerKindFor } from '../sources/source-cleaner';
import type { ChunkRef, StoredChunk } from '../agents/types';

/** inline / map 路径分界（token）；超过则插入 map 摘要步 */
export const PLAN_INLINE_THRESHOLD = 25_000;
/**
 * 大路径全文处理倍率：map 步通读全文一遍（输入≈totalTokens），writer 步再按
 * planner 的 sourceRefs 从 chunkStore 二次读相关全文（最坏≈再读一遍）≈ 2× totalTokens，
 * 余下 0.3× 给两遍读各自的输出与 slack。旧值 1.2× 只建模 map 输入、漏算 writer 二次读，
 * 导致书本级文档预检放行后运行期爆 maxTokensPerJob。
 */
const MAP_REDUCE_TOKEN_FACTOR = 2.3;
/**
 * 每块的固定开销（与全文输入正交，计输出与重复读）：summarizer 系统提示（~250）
 * + 摘要输出（实测 ~700/块；不封顶——封顶会截断 structured-output 产生残缺 JSON）
 * + planner 复读该摘要（~700）。摘要输出被算两次（map 写 + planner 读），含余量取 1500。
 */
const PER_CHUNK_OVERHEAD_TOKENS = 1_500;
/** planner / writers / reviewer 的预留 token */
const PIPELINE_RESERVE_TOKENS = 60_000;

export interface PreparedSourceInput {
  sourceId: string;
  filename: string;
  cleanText: string;
}

export interface PreparedIngest {
  chunkStore: Map<string, StoredChunk>;
  chunkRefs: ChunkRef[];
  outline: string;
  totalTokens: number;
  chunkCount: number;
  /** 按源聚合的原始 chunk（供 source-store 持久化） */
  chunksBySource: Record<string, SourceChunk[]>;
}

/** 解析期确定性准备：预清洗 → 切块 → 构建 chunkStore / chunkRefs / outline。零 token。 */
export function prepareIngest(sources: PreparedSourceInput[]): PreparedIngest {
  // 重复 sourceId 会让 chunkStore key 互相覆盖、chunksBySource 静默丢数据，直接 fail-fast
  const seen = new Set<string>();
  for (const src of sources) {
    if (seen.has(src.sourceId)) throw new Error(`Duplicate sourceId: ${src.sourceId}`);
    seen.add(src.sourceId);
  }

  const chunkStore = new Map<string, StoredChunk>();
  const chunkRefs: ChunkRef[] = [];
  const outlineLines: string[] = [];
  const chunksBySource: Record<string, SourceChunk[]> = {};
  let totalTokens = 0;

  for (const src of sources) {
    const cleaned = cleanSourceText(src.cleanText, cleanerKindFor(src.filename));
    const chunks = chunkText(cleaned, sourceKindFor(src.filename));
    chunksBySource[src.sourceId] = chunks;
    for (const c of chunks) {
      const key = `${src.sourceId}:${c.id}`;
      chunkStore.set(key, { sourceId: src.sourceId, id: c.id, heading: c.heading, text: c.text });
      chunkRefs.push({ key, sourceId: src.sourceId, id: c.id, heading: c.heading, content: '' });
      // heading 为空（plain 源）回退块首行截断作 pseudo-outline 条目
      outlineLines.push(`- [${key}] ${c.heading || firstLineOf(c.text)}`);
      totalTokens += c.tokenCount;
    }
  }

  return {
    chunkStore,
    chunkRefs,
    outline: outlineLines.join('\n'),
    totalTokens,
    chunkCount: chunkRefs.length,
    chunksBySource,
  };
}

/** 小路径：content 直接填全文。 */
export function fillInlineContent(
  chunkRefs: ChunkRef[],
  chunkStore: Map<string, StoredChunk>,
): ChunkRef[] {
  return chunkRefs.map((ref) => ({ ...ref, content: chunkStore.get(ref.key)?.text ?? '' }));
}

export function isInlinePath(totalTokens: number): boolean {
  return totalTokens <= PLAN_INLINE_THRESHOLD;
}

/** 粗粒度成本上界（宁可保守），用于流水线启动前的预算预检。 */
export function estimateIngestCost(totalTokens: number, chunkCount: number, inline: boolean): number {
  if (inline) return totalTokens + PIPELINE_RESERVE_TOKENS;
  return Math.round(totalTokens * MAP_REDUCE_TOKEN_FACTOR) + chunkCount * PER_CHUNK_OVERHEAD_TOKENS + PIPELINE_RESERVE_TOKENS;
}

/**
 * 取文本首行并截断到 60 个 code point。
 * 截断本体必须按 code point：UTF-16 slice 可能切断 emoji 代理对产生孤立 surrogate，
 * 经 JSON.stringify 会变成 RFC 8259 无效的 \uXXXX 转义，provider 端会拒绝整个请求。
 * 外层 line.length（code unit）只是触发条件，宁可多触发，不影响正确性。
 */
function firstLineOf(text: string): string {
  const line = text.trimStart().split('\n', 1)[0] ?? '';
  return line.length > 60 ? `${Array.from(line).slice(0, 60).join('')}…` : line;
}
