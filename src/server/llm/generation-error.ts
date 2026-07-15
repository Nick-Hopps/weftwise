export interface GenerationErrorSummary {
  finishReason?: string;
  /** 模型原始输出（截断）；仅允许在明确可承载正文的内部诊断事件中启用。 */
  rawText?: string;
  /** schema 校验问题（Zod issue 路径）或解析错误信息。 */
  detail?: string;
}

export interface GenerationErrorSummaryOptions {
  includeRawText?: boolean;
  rawTextLimit?: number;
}

/** 把 AI SDK 结构化输出错误提炼为稳定、可选择脱敏的诊断数据。 */
export function summarizeGenerationError(
  err: unknown,
  options: GenerationErrorSummaryOptions = {},
): GenerationErrorSummary {
  if (!err || typeof err !== 'object') return {};

  const { includeRawText = true, rawTextLimit = 800 } = options;
  const e = err as Record<string, unknown>;
  const out: GenerationErrorSummary = {};
  if (typeof e.finishReason === 'string') out.finishReason = e.finishReason;
  if (includeRawText && typeof e.text === 'string') {
    out.rawText = e.text.length > rawTextLimit
      ? `${e.text.slice(0, rawTextLimit)}…`
      : e.text;
  }

  const issues = readZodIssues(e);
  if (issues) {
    out.detail = issues;
  } else {
    const cause = e.cause as Record<string, unknown> | undefined;
    if (cause && typeof cause.message === 'string') out.detail = cause.message;
    else if (typeof e.message === 'string') out.detail = e.message;
  }
  return out;
}

/** 从 TypeValidationError 内层 ZodError 提取有限数量的问题路径。 */
function readZodIssues(e: Record<string, unknown>): string | undefined {
  const c1 = e.cause as Record<string, unknown> | undefined;
  const c2 = c1?.cause as Record<string, unknown> | undefined;
  const raw = c2?.issues ?? c1?.issues;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw
    .slice(0, 5)
    .map((item) => {
      const issue = item as Record<string, unknown>;
      const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
      return `${path || '(root)'}: ${String(issue.message ?? 'invalid')}`;
    })
    .join('; ');
}
