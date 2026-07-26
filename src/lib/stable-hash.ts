/**
 * 同步、非加密的稳定 hash。
 *
 * 用途：quiz 的跨会话身份（`data-quiz-id`）。选它而不是 `crypto.subtle` 是因为后者是
 * **异步**的，而计算发生在 remark 插件的同步 transformer 里；这只是本地标识，
 * 不是安全边界，不需要抗碰撞强度。
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const encoder = new TextEncoder();

/** FNV-1a（32 位），按 UTF-8 字节计算，返回 8 位小写 hex。 */
export function fnv1a(text: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of encoder.encode(text)) {
    hash ^= byte;
    // Math.imul 保证 32 位有符号乘法回绕，与 C 实现一致；`*` 会溢出到浮点。
    hash = Math.imul(hash, FNV_PRIME);
  }
  // >>> 0 转回无符号，否则高位为 1 时 toString(16) 会带负号。
  return (hash >>> 0).toString(16).padStart(8, '0');
}
