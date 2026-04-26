import { generateObject, generateText, tool, type ToolSet, type CoreMessage } from 'ai';
import { randomUUID } from 'node:crypto';
import type { AgentContext, SkillTemplate, ToolDef } from '../types';
import { resolveTask } from '../../llm/task-router';
import { resolveModel } from '../../llm/provider-registry';
import { getAgentTaskRouterMode } from '../../db/repos/settings-repo';

export class AgentCancelled extends Error {
  constructor() { super('Agent cancelled'); this.name = 'AgentCancelled'; }
}

export interface AgentRunResult {
  runId: string;
  output: unknown;
  tokensUsed: number;
  stepCount: number;
}

export async function runAgentLoop(opts: {
  skill: SkillTemplate;
  ctx: AgentContext;
  input: unknown;
}): Promise<AgentRunResult> {
  const { skill, ctx, input } = opts;
  const runId = randomUUID();

  ctx.emit('agent:run-started', `${skill.name} started`, {
    runId,
    parentRunId: ctx.parentRunId,
    skillId: skill.id,
    subjectId: ctx.subject.id,
  });

  const startedAt = Date.now();

  // Resolve LLM model: task-router defaults < tasks['skill:<id>'] < frontmatter (if mode allows).
  const taskKey = `skill:${skill.id}`;
  const routerMode = getAgentTaskRouterMode();
  const route = resolveTask(taskKey, routerMode === 'frontmatter-override' ? skill.model : undefined);
  const model = resolveModel(route);

  // Resolve tools.
  const toolDefs = ctx.toolRegistry.resolve(skill.tools);
  const toolSet: ToolSet = {};
  for (const t of toolDefs) {
    toolSet[t.name] = tool({
      description: t.description,
      parameters: t.inputSchema,
      execute: async (args: unknown) => {
        const stepStart = Date.now();
        try {
          const out = await t.handler(args, ctx);
          ctx.emit('agent:step', `${skill.name} called ${t.name}`, {
            runId,
            parentRunId: ctx.parentRunId,
            skillId: skill.id,
            stepIndex: ctx.budget.stepCount,
            kind: 'tool-call',
            tool: t.name,
            input: args,
            outputPreview: previewOutput(out),
            durationMs: Date.now() - stepStart,
          });
          return out;
        } catch (err) {
          ctx.emit('agent:step', `${skill.name} tool ${t.name} failed`, {
            runId,
            parentRunId: ctx.parentRunId,
            skillId: skill.id,
            stepIndex: ctx.budget.stepCount,
            kind: 'tool-call',
            tool: t.name,
            input: args,
            error: (err as Error).message,
            durationMs: Date.now() - stepStart,
          });
          throw err;
        }
      },
    });
  }

  // Build messages.
  const messages: CoreMessage[] = [
    { role: 'system', content: skill.systemPrompt },
    { role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input) },
  ];

  // Cancellation gate before LLM call.
  if (ctx.cancelled()) throw new AgentCancelled();
  ctx.budget.assertWithin();

  let output: unknown;
  let inputTokens = 0;
  let outputTokens = 0;

  if (skill.outputSchema) {
    const result = await generateObject({
      model,
      schema: skill.outputSchema,
      messages,
      maxTokens: skill.model?.maxTokens ?? route.maxTokens,
      temperature: skill.model?.temperature ?? route.temperature,
    });
    output = result.object;
    inputTokens = result.usage?.promptTokens ?? 0;
    outputTokens = result.usage?.completionTokens ?? 0;
  } else {
    const result = await generateText({
      model,
      tools: toolSet,
      messages,
      maxTokens: skill.model?.maxTokens ?? route.maxTokens,
      temperature: skill.model?.temperature ?? route.temperature,
      maxSteps: ctx.budgetSnapshot.maxSteps,
    });
    output = result.text;
    inputTokens = result.usage?.promptTokens ?? 0;
    outputTokens = result.usage?.completionTokens ?? 0;
  }

  ctx.budget.chargeStep();
  ctx.budget.chargeTokens(inputTokens + outputTokens);

  ctx.emit('agent:step', `${skill.name} produced final output`, {
    runId,
    parentRunId: ctx.parentRunId,
    skillId: skill.id,
    stepIndex: ctx.budget.stepCount,
    kind: 'final',
    tokensIn: inputTokens,
    tokensOut: outputTokens,
  });

  ctx.emit('agent:run-completed', `${skill.name} completed`, {
    runId,
    tokensUsed: inputTokens + outputTokens,
    stepCount: ctx.budget.stepCount,
    durationMs: Date.now() - startedAt,
  });

  return {
    runId,
    output,
    tokensUsed: inputTokens + outputTokens,
    stepCount: ctx.budget.stepCount,
  };
}

function previewOutput(out: unknown): string {
  try {
    const s = typeof out === 'string' ? out : JSON.stringify(out);
    return s.length > 240 ? s.slice(0, 240) + '…' : s;
  } catch { return '<unserializable>'; }
}
