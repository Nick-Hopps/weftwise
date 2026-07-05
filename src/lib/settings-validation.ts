/** 设置表单数字校验：合法返回整数，否则 null（空串/空白/非整数/越界均不合法）。*/
export function validateIntInRange(raw: string, min: number, max: number): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < min || n > max) return null;
  return n;
}
