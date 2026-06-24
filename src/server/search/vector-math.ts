/** Float32 向量 ↔ Buffer 编解码 + cosine + RRF（语义检索纯函数单一真实源）。 */

export function encodeVector(v: number[]): Buffer {
  const f32 = Float32Array.from(v);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function decodeVector(buf: Buffer): Float32Array {
  const count = Math.floor(buf.byteLength / 4);
  // Float32Array 视图要求 byteOffset 4 字节对齐；better-sqlite3 返回的 BLOB Buffer
  // 通常落在 8 字节对齐的共享池上（命中快路径 → 零拷贝直接视图，省掉每页每次查询的整段内存拷贝）；
  // 仅当偶发未对齐时才复制到对齐的 ArrayBuffer，保证不抛异常。
  if (buf.byteOffset % 4 === 0) {
    return new Float32Array(buf.buffer, buf.byteOffset, count);
  }
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, count);
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
