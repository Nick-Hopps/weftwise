import { describe, expect, it } from 'vitest';
import {
  prepareIngest,
  fillInlineContent,
  isInlinePath,
  estimateIngestCost,
  reduceCostForResume,
  PLAN_INLINE_THRESHOLD,
} from '../ingest-prep';
import type { CheckpointProgress } from '@/lib/contracts';

describe('prepareIngest', () => {
  it('清洗→切块→构建 chunkStore/chunkRefs/outline/totalTokens', () => {
    const md = `## Alpha\n\n${'Alpha 段内容句。'.repeat(40)}\n\n## Beta\n\n${'Beta 段内容句。'.repeat(40)}`;
    const prep = prepareIngest([{ sourceId: 's1', filename: 'doc.md', cleanText: md }]);
    expect(prep.chunkCount).toBeGreaterThan(0);
    expect(prep.chunkRefs).toHaveLength(prep.chunkCount);
    expect(prep.chunkStore.size).toBe(prep.chunkCount);
    expect(prep.totalTokens).toBeGreaterThan(0);
    // chunkRefs 初始 content 为空（由调用方决定填全文或摘要）
    expect(prep.chunkRefs.every((r) => r.content === '')).toBe(true);
    // key 与 chunkStore 对得上
    for (const ref of prep.chunkRefs) {
      expect(prep.chunkStore.get(ref.key)?.id).toBe(ref.id);
    }
    // outline 含 heading
    expect(prep.outline).toContain('Alpha');
  });

  it('plain 源 heading 为空时 outline 回退块首行截断', () => {
    const prep = prepareIngest([
      { sourceId: 's1', filename: 'doc.txt', cleanText: `这是没有任何标题的纯文本首行内容用来测试大纲回退。\n\n${'后续内容。'.repeat(20)}` },
    ]);
    expect(prep.outline).toContain('这是没有任何标题的纯文本首行');
  });

  it('chunksBySource 按源聚合（供持久化）', () => {
    const prep = prepareIngest([{ sourceId: 's1', filename: 'a.txt', cleanText: '内容。' }]);
    expect(prep.chunksBySource['s1']).toHaveLength(1);
    expect(prep.chunksBySource['s1'][0].tokenCount).toBeGreaterThan(0);
  });

  it('emoji 首行截断不产生孤立 surrogate', () => {
    const emoji = '😀'.repeat(40);
    const prep = prepareIngest([{ sourceId: 's1', filename: 'a.txt', cleanText: `${emoji}\n\n${'后续内容。'.repeat(10)}` }]);
    // 大纲行截断处不得是孤立高位代理
    for (const line of prep.outline.split('\n')) {
      const beforeEllipsis = line.endsWith('…') ? line.slice(0, -1) : line;
      const last = beforeEllipsis.charCodeAt(beforeEllipsis.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it('重复 sourceId 抛错', () => {
    expect(() => prepareIngest([
      { sourceId: 's1', filename: 'a.txt', cleanText: '甲。' },
      { sourceId: 's1', filename: 'b.txt', cleanText: '乙。' },
    ])).toThrow(/Duplicate sourceId/);
  });

  it('空源产出 0 块', () => {
    const prep = prepareIngest([{ sourceId: 's1', filename: 'a.txt', cleanText: '   ' }]);
    expect(prep.chunkCount).toBe(0);
    expect(prep.chunkRefs).toEqual([]);
  });
});

describe('fillInlineContent', () => {
  it('把 chunkStore 全文填入 content', () => {
    const prep = prepareIngest([{ sourceId: 's1', filename: 'a.txt', cleanText: '内容句。' }]);
    const filled = fillInlineContent(prep.chunkRefs, prep.chunkStore);
    expect(filled[0].content).toContain('内容句');
  });
});

describe('isInlinePath / estimateIngestCost', () => {
  it('阈值内走 inline', () => {
    expect(isInlinePath(PLAN_INLINE_THRESHOLD)).toBe(true);
    expect(isInlinePath(PLAN_INLINE_THRESHOLD + 1)).toBe(false);
  });

  it('大路径成本估算高于 inline 且随块数增长', () => {
    const inline = estimateIngestCost(10_000, 10, true);
    const large = estimateIngestCost(100_000, 100, false);
    expect(inline).toBeGreaterThan(10_000); // 含 reserve
    expect(large).toBeGreaterThan(100_000 * 1.2);
    expect(estimateIngestCost(100_000, 200, false)).toBeGreaterThan(large);
  });

  it('大路径估算计入 writer 二次读全文：≥ 2× totalTokens', () => {
    // 回归：旧公式仅按 1.2× 建模 map 输入，漏算 writer 按 sourceRefs 二次读相关全文
    // （map 通读一遍 + writer 再读一遍 ≈ 2× totalTokens）。书本级文档因此预检放行后运行期爆预算。
    const totalTokens = 245_685; // Linear Algebra Done Right 实测
    const chunkCount = 234;
    expect(estimateIngestCost(totalTokens, chunkCount, false)).toBeGreaterThanOrEqual(2 * totalTokens);
  });
});

describe('reduceCostForResume', () => {
  const prog = (p: Partial<CheckpointProgress>): CheckpointProgress => ({
    plan: false, chunkSummaries: 0, writerPages: 0, totalPages: null, ...p,
  });

  it('plan 未缓存（totalPages 未知）时不折减', () => {
    expect(reduceCostForResume(100_000, prog({ plan: false, writerPages: 5 }))).toBe(100_000);
  });

  it('totalPages 为 0 时不折减（防除零）', () => {
    expect(reduceCostForResume(100_000, prog({ plan: true, totalPages: 0, writerPages: 0 }))).toBe(100_000);
  });

  it('按已写页比例折减 fanout 占比（60%）', () => {
    // 100 页写完 50 页：减 100000 * 0.6 * 0.5 = 30000
    expect(reduceCostForResume(100_000, prog({ plan: true, totalPages: 100, writerPages: 50 }))).toBe(70_000);
  });

  it('已写页超过 totalPages 时按 100% 封顶（最多减 fanout 全占比）', () => {
    expect(reduceCostForResume(100_000, prog({ plan: true, totalPages: 10, writerPages: 99 }))).toBe(40_000);
  });
});
