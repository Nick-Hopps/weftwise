import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import {
  getWikiLanguage,
  setWikiLanguage,
  getAgentMaxSteps,
  setAgentMaxSteps,
  getAgentMaxTokensPerJob,
  setAgentMaxTokensPerJob,
  getAgentMaxParallelSubAgents,
  setAgentMaxParallelSubAgents,
  getAgentMcpLifecycle,
  setAgentMcpLifecycle,
  getAgentTaskRouterMode,
  setAgentTaskRouterMode,
  getWebSearchProvider,
  setWebSearchProvider,
  getWebSearchApiKey,
  setWebSearchApiKey,
  getWebSearchMaxResults,
  setWebSearchMaxResults,
} from '@/server/db/repos/settings-repo';
import {
  WikiLanguageSchema,
  AgentMaxStepsSchema,
  AgentMaxTokensPerJobSchema,
  AgentMaxParallelSubAgentsSchema,
  AgentMcpLifecycleSchema,
  AgentTaskRouterModeSchema,
  WebSearchProviderSchema,
  WebSearchApiKeySchema,
  WebSearchMaxResultsSchema,
  type AppSettings,
} from '@/lib/contracts';

export const runtime = 'nodejs';

function readSettings(): AppSettings {
  return {
    wikiLanguage: getWikiLanguage(),
    agentMaxSteps: getAgentMaxSteps(),
    agentMaxTokensPerJob: getAgentMaxTokensPerJob(),
    agentMaxParallelSubAgents: getAgentMaxParallelSubAgents(),
    agentMcpLifecycle: getAgentMcpLifecycle(),
    agentTaskRouterMode: getAgentTaskRouterMode(),
    webSearchProvider: getWebSearchProvider(),
    webSearchApiKey: getWebSearchApiKey(),
    webSearchMaxResults: getWebSearchMaxResults(),
  };
}

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  return NextResponse.json(readSettings());
}

const PutBodySchema = z.object({
  wikiLanguage: WikiLanguageSchema.optional(),
  agentMaxSteps: AgentMaxStepsSchema.optional(),
  agentMaxTokensPerJob: AgentMaxTokensPerJobSchema.optional(),
  agentMaxParallelSubAgents: AgentMaxParallelSubAgentsSchema.optional(),
  agentMcpLifecycle: AgentMcpLifecycleSchema.optional(),
  agentTaskRouterMode: AgentTaskRouterModeSchema.optional(),
  webSearchProvider: WebSearchProviderSchema.optional(),
  webSearchApiKey: WebSearchApiKeySchema.optional(),
  webSearchMaxResults: WebSearchMaxResultsSchema.optional(),
});

export async function PUT(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = PutBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const d = parsed.data;
  if (d.wikiLanguage !== undefined) setWikiLanguage(d.wikiLanguage);
  if (d.agentMaxSteps !== undefined) setAgentMaxSteps(d.agentMaxSteps);
  if (d.agentMaxTokensPerJob !== undefined) setAgentMaxTokensPerJob(d.agentMaxTokensPerJob);
  if (d.agentMaxParallelSubAgents !== undefined) setAgentMaxParallelSubAgents(d.agentMaxParallelSubAgents);
  if (d.agentMcpLifecycle !== undefined) setAgentMcpLifecycle(d.agentMcpLifecycle);
  if (d.agentTaskRouterMode !== undefined) setAgentTaskRouterMode(d.agentTaskRouterMode);
  if (d.webSearchProvider !== undefined) setWebSearchProvider(d.webSearchProvider);
  if (d.webSearchApiKey !== undefined) setWebSearchApiKey(d.webSearchApiKey);
  if (d.webSearchMaxResults !== undefined) setWebSearchMaxResults(d.webSearchMaxResults);

  return NextResponse.json(readSettings());
}
