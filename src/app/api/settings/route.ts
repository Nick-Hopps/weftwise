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
  getAgentAutoCurate,
  setAgentAutoCurate,
  getWebSearchProvider,
  setWebSearchProvider,
  getWebSearchApiKey,
  setWebSearchApiKey,
  getWebSearchMaxResults,
  setWebSearchMaxResults,
  getMaintenanceEnabled,
  setMaintenanceEnabled,
  getMaintenanceSweepIntervalHours,
  setMaintenanceSweepIntervalHours,
  getMaintenanceMaxPagesPerSweep,
  setMaintenanceMaxPagesPerSweep,
} from '@/server/db/repos/settings-repo';
import {
  WikiLanguageSchema,
  AgentMaxStepsSchema,
  AgentMaxTokensPerJobSchema,
  AgentMaxParallelSubAgentsSchema,
  AgentMcpLifecycleSchema,
  AgentTaskRouterModeSchema,
  AgentAutoCurateSchema,
  WebSearchProviderSchema,
  WebSearchApiKeySchema,
  WebSearchMaxResultsSchema,
  MaintenanceEnabledSchema,
  MaintenanceSweepIntervalHoursSchema,
  MaintenanceMaxPagesPerSweepSchema,
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
    agentAutoCurate: getAgentAutoCurate(),
    webSearchProvider: getWebSearchProvider(),
    webSearchApiKey: getWebSearchApiKey(),
    webSearchMaxResults: getWebSearchMaxResults(),
    maintenanceEnabled: getMaintenanceEnabled(),
    maintenanceSweepIntervalHours: getMaintenanceSweepIntervalHours(),
    maintenanceMaxPagesPerSweep: getMaintenanceMaxPagesPerSweep(),
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
  agentAutoCurate: AgentAutoCurateSchema.optional(),
  webSearchProvider: WebSearchProviderSchema.optional(),
  webSearchApiKey: WebSearchApiKeySchema.optional(),
  webSearchMaxResults: WebSearchMaxResultsSchema.optional(),
  maintenanceEnabled: MaintenanceEnabledSchema.optional(),
  maintenanceSweepIntervalHours: MaintenanceSweepIntervalHoursSchema.optional(),
  maintenanceMaxPagesPerSweep: MaintenanceMaxPagesPerSweepSchema.optional(),
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
  if (d.agentAutoCurate !== undefined) setAgentAutoCurate(d.agentAutoCurate);
  if (d.webSearchProvider !== undefined) setWebSearchProvider(d.webSearchProvider);
  if (d.webSearchApiKey !== undefined) setWebSearchApiKey(d.webSearchApiKey);
  if (d.webSearchMaxResults !== undefined) setWebSearchMaxResults(d.webSearchMaxResults);
  if (d.maintenanceEnabled !== undefined) setMaintenanceEnabled(d.maintenanceEnabled);
  if (d.maintenanceSweepIntervalHours !== undefined) setMaintenanceSweepIntervalHours(d.maintenanceSweepIntervalHours);
  if (d.maintenanceMaxPagesPerSweep !== undefined) setMaintenanceMaxPagesPerSweep(d.maintenanceMaxPagesPerSweep);

  return NextResponse.json(readSettings());
}
