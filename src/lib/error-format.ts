/**
 * AI SDK 的 RetryError（重试耗尽后抛出）会把每次尝试的真实错误放在 `.lastError`，
 * 但当最后一次尝试本身 message 为空时，RetryError 自身的 message 是
 * "Failed after N attempts. Last error: "（后面留白），诊断信息全丢。
 * 这里在外层 message 缺失真实原因时，补上 lastError 的 message/cause。
 */
function textFromUnknownError(value: unknown): string {
  if (value instanceof Error) {
    if (value.message) return value.message;
    const cause = (value as { cause?: unknown }).cause;
    if (typeof cause === 'string' && cause) return cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return value.name;
  }
  return String(value);
}

export function describeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const base = error.message;
  const lastError = (error as { lastError?: unknown }).lastError;
  if (lastError === undefined) return base;
  const lastText = textFromUnknownError(lastError);
  if (!lastText || base.includes(lastText)) return base;
  return `${base} [root cause: ${lastText}]`;
}
