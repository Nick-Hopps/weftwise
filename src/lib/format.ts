/** 数值展示格式化纯函数（客户端/服务端通用，零依赖）。 */

/** 保留一位小数，`.0` 省略：1 → '1'，1.23 → '1.2'。有意用 floor 而非四舍五入，避免 999_950 类边界进位跳档（'999.9k' 不会显示成 '1000k'）。 */
function trimOneDecimal(v: number): string {
  return (Math.floor(v * 10) / 10).toFixed(1).replace(/\.0$/, '');
}

/** token 数格式化：≥1M 显示 `1.2M`，≥1000 显示 `12.3k`，其余原样；非法输入回落 '0'。 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${trimOneDecimal(n / 1_000_000)}M`;
  if (n >= 1000) return `${trimOneDecimal(n / 1000)}k`;
  return String(Math.round(n));
}
