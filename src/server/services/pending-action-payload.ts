import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  PendingActionOperation,
  PreviewChangeInput,
  TagBatchInput,
  TagBatchPreviewInput,
  WorkflowPreviewInput,
} from '@/lib/contracts';
import {
  ImageGenerateInputSchema,
  PersistedMarkdownBlockAnchorSchema,
} from '@/lib/contracts';
import { normalizeMetadataPatch } from '@/server/wiki/narrow-write';
import { isCanonicalPageSlug } from '@/server/wiki/page-identity';

const TrimmedTextSchema = z.string().trim().min(1);
const CanonicalPageSlugSchema = TrimmedTextSchema.refine(
  isCanonicalPageSlug,
  'page slug must be a non-empty canonical page slug',
);
const TagsSchema = z.array(TrimmedTextSchema).optional();
const MetadataPatchPayloadSchema = z.object({
  slug: TrimmedTextSchema,
  title: z.string().optional(),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
  aliases: z.array(z.string()).optional(),
}).strict().transform((payload) => normalizeMetadataPatch(payload));
const LinkEnsurePayloadSchema = z.object({
  sourceSlug: TrimmedTextSchema,
  targetSubjectSlug: TrimmedTextSchema.optional(),
  targetSlug: TrimmedTextSchema,
  oldString: z.string().min(1),
  displayText: z.string().optional(),
  mode: z.enum(['link', 'unlink', 'retarget']),
}).strict();
export const TagBatchPayloadSchema = z.object({
  action: z.enum(['rename', 'merge', 'delete']),
  sourceTag: TrimmedTextSchema.max(128),
  targetTag: TrimmedTextSchema.max(128).optional(),
}).strict().superRefine((payload, ctx) => {
  if (payload.action !== 'delete' && !payload.targetTag) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetTag'],
      message: 'targetTag is required for rename and merge',
    });
  }
  if (payload.action === 'delete' && payload.targetTag) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetTag'],
      message: 'targetTag is not allowed for delete',
    });
  }
  if (payload.targetTag === payload.sourceTag) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetTag'],
      message: 'targetTag must differ from sourceTag',
    });
  }
});

export const PreviewChangeInputSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('create'),
    payload: z.object({
      title: TrimmedTextSchema,
      body: z.string(),
      summary: z.string().trim().optional(),
      tags: TagsSchema,
    }).strict(),
  }).strict(),
  z.object({
    operation: z.literal('update'),
    payload: z.object({
      slug: TrimmedTextSchema,
      title: TrimmedTextSchema.optional(),
      body: z.string(),
      summary: z.string().trim().optional(),
      tags: TagsSchema,
    }).strict(),
  }).strict(),
  z.object({
    operation: z.literal('patch'),
    payload: z.object({
      slug: TrimmedTextSchema,
      edits: z.array(z.object({
        oldString: z.string().min(1),
        newString: z.string(),
      }).strict()).min(1),
    }).strict(),
  }).strict(),
  z.object({
    operation: z.literal('delete'),
    payload: z.object({ slug: TrimmedTextSchema }).strict(),
  }).strict(),
  z.object({
    operation: z.literal('reenrich'),
    payload: z.object({ slug: TrimmedTextSchema }).strict(),
  }).strict(),
  z.object({
    operation: z.literal('metadata-patch'),
    payload: MetadataPatchPayloadSchema,
  }).strict(),
  z.object({
    operation: z.literal('link-ensure'),
    payload: LinkEnsurePayloadSchema,
  }).strict(),
  z.object({
    operation: z.literal('move'),
    payload: z.object({
      slug: CanonicalPageSlugSchema,
      newSlug: CanonicalPageSlugSchema,
    }).strict().refine((payload) => payload.slug !== payload.newSlug, {
      message: 'newSlug must differ from slug',
      path: ['newSlug'],
    }),
  }).strict(),
]);

/**
 * `wiki.preview_change` 的**模型可见 schema**：根节点必须是 object。
 *
 * 上面的 `PreviewChangeInputSchema` 是判别联合，转成 provider JSON Schema 后根节点
 * 只有 `anyOf`、没有 `type: "object"`——OpenAI 兼容接口（DeepSeek 等）在注册工具时
 * 就直接拒绝整个请求（`Invalid schema for function 'wiki_preview_change'`），导致
 * 每一次 propose 问答必错。所以这里给模型一份「operation 枚举 + 全字段可选的扁平
 * payload」：全链路零 `anyOf`，provider 兼容性最好。
 *
 * **合法性没有放宽**：operation 与 payload 字段的真实配对仍由 `normalizePreviewInput`
 * 里那次 `PreviewChangeInputSchema.parse`（每个变体都 `.strict()`）判定，用错字段会
 * 作为工具错误返回给模型自纠。字段集必须与判别联合保持同步，由
 * `pending-action-payload.test.ts` 的漂移测试守住。
 */
const PreviewChangeToolPayloadSchema = z.object({
  slug: z.string().optional().describe('update / patch / delete / reenrich / metadata-patch / move'),
  newSlug: z.string().optional().describe('move only: the new canonical slug'),
  title: z.string().optional().describe('create / update / metadata-patch'),
  body: z.string().optional().describe('create / update: the full page markdown body'),
  summary: z.string().optional().describe('create / update / metadata-patch'),
  tags: z.array(z.string()).optional().describe('create / update / metadata-patch'),
  aliases: z.array(z.string()).optional().describe('metadata-patch only'),
  edits: z.array(z.object({
    oldString: z.string(),
    newString: z.string(),
  }).strict()).optional().describe('patch only: exact unique old_string/new_string replacements'),
  sourceSlug: z.string().optional().describe('link-ensure only: the page whose body is edited'),
  targetSlug: z.string().optional().describe('link-ensure only: the link target page'),
  targetSubjectSlug: z.string().optional().describe('link-ensure only: cross-subject target'),
  oldString: z.string().optional().describe('link-ensure only: the exact unique source text anchor'),
  displayText: z.string().optional().describe('link-ensure only: optional wikilink display text'),
  mode: z.enum(['link', 'unlink', 'retarget']).optional().describe('link-ensure only'),
}).strict();

export const PreviewChangeToolInputSchema = z.object({
  operation: z.enum([
    'create',
    'update',
    'patch',
    'delete',
    'reenrich',
    'metadata-patch',
    'link-ensure',
    'move',
  ]),
  payload: PreviewChangeToolPayloadSchema.describe(
    'Only the fields that belong to this operation; any other field is rejected.',
  ),
}).strict();

export type PreviewChangeToolInput = z.infer<typeof PreviewChangeToolInputSchema>;

export const WorkflowPreviewInputSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('workflow-reenrich-start'),
    payload: z.object({ slug: TrimmedTextSchema }).strict(),
  }).strict(),
  z.object({
    operation: z.literal('workflow-research-start'),
    payload: z.object({ topic: TrimmedTextSchema.max(500) }).strict(),
  }).strict(),
  z.object({
    operation: z.literal('workflow-image-insert-start'),
    payload: z.object({
      slug: CanonicalPageSlugSchema,
      anchor: PersistedMarkdownBlockAnchorSchema,
      request: ImageGenerateInputSchema,
    }).strict(),
  }).strict(),
  z.object({
    operation: z.literal('workflow-cancel'),
    payload: z.object({ jobId: TrimmedTextSchema }).strict(),
  }).strict(),
]);

export type NormalizedPreviewInput = PreviewChangeInput extends infer Input
  ? Input extends { operation: infer Operation; payload: infer Payload }
    ? { operation: Operation; payload: Payload & { effectiveAt: string } }
    : never
  : never;

function canonicalValue(value: unknown, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Canonical JSON requires finite numbers at ${path}`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalValue(item, `${path}[${index}]`));
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Canonical JSON encountered an unsupported object at ${path}`);
    }
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = canonicalValue(record[key], `${path}.${key}`);
    }
    return out;
  }
  throw new Error(`Canonical JSON encountered an unsupported value at ${path}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, '$'));
}

export function hashPendingActionPayload(input: {
  conversationId: string | null;
  subjectId: string;
  operation: PendingActionOperation;
  payload: unknown;
}): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

export function normalizePreviewInput(
  input: PreviewChangeInput,
  effectiveAt: string,
): NormalizedPreviewInput {
  const parsed = PreviewChangeInputSchema.parse(input);
  const timestamp = z.string().datetime().parse(effectiveAt);
  return {
    operation: parsed.operation,
    payload: { ...parsed.payload, effectiveAt: timestamp },
  } as NormalizedPreviewInput;
}

export function normalizeTagBatchPreviewInput(
  input: TagBatchInput,
  effectiveAt: string,
): TagBatchPreviewInput & { payload: TagBatchInput & { effectiveAt: string } } {
  const payload = TagBatchPayloadSchema.parse(input);
  const timestamp = z.string().datetime().parse(effectiveAt);
  return {
    operation: 'tag-batch',
    payload: { ...payload, effectiveAt: timestamp },
  };
}

export function normalizeWorkflowPreviewInput(
  input: WorkflowPreviewInput,
  effectiveAt: string,
): WorkflowPreviewInput & { payload: Record<string, unknown> & { effectiveAt: string } } {
  const parsed = WorkflowPreviewInputSchema.parse(input);
  const timestamp = z.string().datetime().parse(effectiveAt);
  return {
    operation: parsed.operation,
    payload: { ...parsed.payload, effectiveAt: timestamp },
  } as WorkflowPreviewInput & {
    payload: Record<string, unknown> & { effectiveAt: string };
  };
}
