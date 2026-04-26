import { z } from 'zod';

export const SkillModelSchema = z.object({
  profile: z.string().optional(),
  model: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
}).strict();

export const SkillBudgetSchema = z.object({
  maxSteps: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
}).strict();

export const SkillFrontmatterSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.number().int().positive(),
  tools: z.array(z.string()).default([]),
  canDispatch: z.array(z.string()).default([]),
  model: SkillModelSchema.optional(),
  outputSchema: z.string().optional(),
  budget: SkillBudgetSchema.optional(),
}).strict();

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
