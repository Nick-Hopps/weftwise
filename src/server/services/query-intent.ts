import { generateStructuredOutput } from '@/server/llm/provider-registry';
import {
  buildQueryIntentUserPrompt,
  QUERY_INTENT_SYSTEM_PROMPT,
  QueryIntentSchema,
  type QueryIntentClassification,
  type QueryIntentContext,
} from '@/server/llm/prompts/query-prompt';

export type QueryMode = 'read' | 'propose' | 'image-insert';
export type { QueryIntentClassification, QueryIntentContext };

const TARGET_NONE = { reference: 'none' as const, slug: null };

function fallbackFor(context: QueryIntentContext): QueryIntentClassification {
  return {
    intent: context.phase === 'reset-confirmation' ? 'reset-unclear' : 'read',
    targetPage: TARGET_NONE,
  };
}

function narrowToContext(
  result: QueryIntentClassification,
  context: QueryIntentContext,
): QueryIntentClassification {
  if (context.phase === 'reset-confirmation') {
    return ['reset-confirm', 'reset-cancel', 'reset-unclear'].includes(result.intent)
      ? { ...result, targetPage: TARGET_NONE }
      : fallbackFor(context);
  }

  if (['reset-confirm', 'reset-cancel', 'reset-unclear'].includes(result.intent)) {
    return fallbackFor(context);
  }
  if (result.intent === 'image-insert' && !context.hasSelection) {
    return fallbackFor(context);
  }
  if (result.intent !== 'direct-reenrich') {
    return { ...result, targetPage: TARGET_NONE };
  }

  const target = result.targetPage;
  if (target.reference === 'current-page') {
    return { ...result, targetPage: { reference: 'current-page', slug: null } };
  }
  if (target.reference === 'slug' && target.slug?.trim()) {
    return {
      ...result,
      targetPage: { reference: 'slug', slug: target.slug.trim() },
    };
  }
  return { ...result, targetPage: TARGET_NONE };
}

export async function classifyQueryIntent(
  question: string,
  context: QueryIntentContext,
  options: { generate?: typeof generateStructuredOutput } = {},
): Promise<QueryIntentClassification> {
  const generate = options.generate ?? generateStructuredOutput;
  try {
    const result = await generate(
      'query',
      QueryIntentSchema,
      QUERY_INTENT_SYSTEM_PROMPT,
      buildQueryIntentUserPrompt(question, context),
      {},
      { schemaRetries: 1 },
    );
    return narrowToContext(result, context);
  } catch (error) {
    console.warn(
      '[query-intent] structured classification failed; using conservative fallback',
      error instanceof Error ? error.message : String(error),
    );
    return fallbackFor(context);
  }
}

export function queryModeForIntent(intent: QueryIntentClassification): QueryMode {
  if (intent.intent === 'image-insert') return 'image-insert';
  return intent.intent === 'propose' || intent.intent === 'direct-reenrich'
    ? 'propose'
    : 'read';
}

export function resolveDirectReenrichTarget(
  intent: QueryIntentClassification,
  currentPageSlug?: string,
): string | null {
  if (intent.intent !== 'direct-reenrich') return null;
  if (intent.targetPage.reference === 'current-page') {
    return currentPageSlug?.trim() || null;
  }
  if (intent.targetPage.reference === 'slug') {
    return intent.targetPage.slug?.trim() || null;
  }
  return null;
}
