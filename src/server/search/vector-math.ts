/** Float32 向量 ↔ Buffer 编解码 + cosine + RRF（语义检索纯函数单一真实源）。 */

export function encodeVector(v: number[]): Buffer {
  const f32 = Float32Array.from(v);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function decodeVector(buf: Buffer): Float32Array {
  // 复制到对齐的 ArrayBuffer，避免共享底层 buffer 的偏移问题
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Reciprocal Rank Fusion：每个 id 分数 = Σ 1/(k + rank0based)（出现在某列表才计该项），
 * 按分数降序去重取 topN。无需归一化两路分数。
 */
export function rrfMerge(listA: string[], listB: string[], k: number, topN: number): string[] {
  const score = new Map<string, number>();
  const add = (list: string[]) => {
    list.forEach((id, rank) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (k + rank));
    });
  };
  add(listA);
  add(listB);
  return [...score.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, topN)
    .map(([id]) => id);
}
