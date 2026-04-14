/**
 * @deprecated Legacy compatibility shim. Use the task-aware facade in
 * provider-registry.ts instead: generateStructuredOutput(task, ...) and
 * streamTextResponse(task, ...).
 */

import type { LanguageModel } from 'ai';
import { resolveTask } from './task-router';
import { getLanguageModel } from './provider-factory';

/**
 * @deprecated Use generateStructuredOutput(task, ...) from provider-registry.ts
 */
export function getModel(): LanguageModel {
  return getLanguageModel(resolveTask('query'));
}

/**
 * @deprecated Provider factories are internal to provider-factory.ts.
 */
export function getLLMClient(): never {
  throw new Error(
    'getLLMClient() is deprecated. Use generateStructuredOutput(task, ...) ' +
      'or streamTextResponse(task, ...) from provider-registry.ts instead.',
  );
}
