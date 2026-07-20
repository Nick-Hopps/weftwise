import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import {
  getWikiLanguage,
  setWikiLanguage,
  getBodyFontSize,
  setBodyFontSize,
  getAgentMaxSteps,
  setAgentMaxSteps,
  getAgentMaxTokensPerJob,
  setAgentMaxTokensPerJob,
  getAgentMaxParallelSubAgents,
  setAgentMaxParallelSubAgents,
  getAgentTaskRouterMode,
  setAgentTaskRouterMode,
  getAgentAutoCurate,
  setAgentAutoCurate,
  getIngestConcurrency,
  setIngestConcurrency,
  getWebSearchProvider,
  setWebSearchProvider,
  getWebSearchApiKey,
  setWebSearchApiKey,
  getWebSearchMaxResults,
  setWebSearchMaxResults,
  getMaintenanceEnabled,
  setMaintenanceEnabled,
  getMaintenanceScope,
  setMaintenanceScope,
  getMaintenanceSweepIntervalHours,
  setMaintenanceSweepIntervalHours,
  getMaintenanceMaxPagesPerSweep,
  setMaintenanceMaxPagesPerSweep,
} from '@/server/db/repos/settings-repo';
import {
  WikiLanguageSchema,
  BodyFontSizeSchema,
  AgentMaxStepsSchema,
  AgentMaxTokensPerJobSchema,
  AgentMaxParallelSubAgentsSchema,
  AgentTaskRouterModeSchema,
  AgentAutoCurateSchema,
  IngestConcurrencySchema,
  WebSearchProviderSchema,
  WebSearchApiKeySchema,
  WebSearchMaxResultsSchema,
  MaintenanceEnabledSchema,
  MaintenanceScopeSchema,
  MaintenanceSweepIntervalHoursSchema,
  MaintenanceMaxPagesPerSweepSchema,
  type AppSettings,
} from '@/lib/contracts';

export const runtime = 'nodejs';

function readSettings(): AppSettings {
  return {
    wikiLanguage: getWikiLanguage(),
    bodyFontSize: getBodyFontSize(),
    agentMaxSteps: getAgentMaxSteps(),
    agentMaxTokensPerJob: getAgentMaxTokensPerJob(),
    agentMaxParallelSubAgents: getAgentMaxParallelSubAgents(),
    agentTaskRouterMode: getAgentTaskRouterMode(),
    agentAutoCurate: getAgentAutoCurate(),
    ingestConcurrency: getIngestConcurrency(),
    webSearchProvider: getWebSearchProvider(),
    webSearchApiKey: getWebSearchApiKey(),
    webSearchMaxResults: getWebSearchMaxResults(),
    maintenanceEnabled: getMaintenanceEnabled(),
    maintenanceScope: getMaintenanceScope(),
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
  bodyFontSize: BodyFontSizeSchema.optional(),
  agentMaxSteps: AgentMaxStepsSchema.optional(),
  agentMaxTokensPerJob: AgentMaxTokensPerJobSchema.optional(),
  agentMaxParallelSubAgents: AgentMaxParallelSubAgentsSchema.optional(),
  agentTaskRouterMode: AgentTaskRouterModeSchema.optional(),
  agentAutoCurate: AgentAutoCurateSchema.optional(),
  ingestConcurrency: IngestConcurrencySchema.optional(),
  webSearchProvider: WebSearchProviderSchema.optional(),
  webSearchApiKey: WebSearchApiKeySchema.optional(),
  webSearchMaxResults: WebSearchMaxResultsSchema.optional(),
  maintenanceEnabled: MaintenanceEnabledSchema.optional(),
  maintenanceScope: MaintenanceScopeSchema.optional(),
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
  if (d.bodyFontSize !== undefined) setBodyFontSize(d.bodyFontSize);
  if (d.agentMaxSteps !== undefined) setAgentMaxSteps(d.agentMaxSteps);
  if (d.agentMaxTokensPerJob !== undefined) setAgentMaxTokensPerJob(d.agentMaxTokensPerJob);
  if (d.agentMaxParallelSubAgents !== undefined) setAgentMaxParallelSubAgents(d.agentMaxParallelSubAgents);
  if (d.agentTaskRouterMode !== undefined) setAgentTaskRouterMode(d.agentTaskRouterMode);
  if (d.agentAutoCurate !== undefined) setAgentAutoCurate(d.agentAutoCurate);
  if (d.ingestConcurrency !== undefined) setIngestConcurrency(d.ingestConcurrency);
  if (d.webSearchProvider !== undefined) setWebSearchProvider(d.webSearchProvider);
  if (d.webSearchApiKey !== undefined) setWebSearchApiKey(d.webSearchApiKey);
  if (d.webSearchMaxResults !== undefined) setWebSearchMaxResults(d.webSearchMaxResults);
  if (d.maintenanceEnabled !== undefined) setMaintenanceEnabled(d.maintenanceEnabled);
  if (d.maintenanceScope !== undefined) setMaintenanceScope(d.maintenanceScope);
  if (d.maintenanceSweepIntervalHours !== undefined) setMaintenanceSweepIntervalHours(d.maintenanceSweepIntervalHours);
  if (d.maintenanceMaxPagesPerSweep !== undefined) setMaintenanceMaxPagesPerSweep(d.maintenanceMaxPagesPerSweep);

  return NextResponse.json(readSettings());
}
