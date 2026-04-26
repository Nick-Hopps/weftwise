import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({
  skillId: z.string(),
  input: z.unknown(),
});
const OutputSchema = z.object({
  output: z.unknown(),
});

/**
 * Phase 1 placeholder. Dynamic dispatch is implemented in orchestrator;
 * this tool wires LLM-driven sub-agent calls into the same code path. Phase 1
 * has no skill that whitelists this tool.
 */
export const dispatchSkillTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'dispatch.skill',
  source: 'dispatch',
  description: 'Dispatch a sub-agent skill (advanced; Phase 2).',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'none',
  async handler(input, ctx) {
    if (!ctx.skillRegistry.get(input.skillId)) {
      throw new Error(`Unknown skill: ${input.skillId}`);
    }
    // Real implementation lands in orchestrator.runSingle; for Phase 1, callers
    // never reach this code path because no skill whitelists 'dispatch.skill'.
    throw new Error('dispatch.skill is reserved for Phase 2 dynamic topology');
  },
};
