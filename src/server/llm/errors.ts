/**
 * LLM module error hierarchy.
 *
 * LLMConfigError  — configuration loading / validation failures
 * LLMProviderError — provider instantiation or runtime API failures
 */

export class LLMConfigError extends Error {
  override name = 'LLMConfigError';

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

export class LLMProviderError extends Error {
  override name = 'LLMProviderError';

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}
