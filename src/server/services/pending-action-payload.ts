import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PendingActionOperation, PreviewChangeInput } from '@/lib/contracts';
import { normalizeMetadataPatch } from '@/server/wiki/narrow-write';

const TrimmedTextSchema = z.string().trim().min(1);
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
  conversationId: string;
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
