import type { Job } from '@/lib/contracts';
import type { ToolSideEffect } from '../types';

export type ToolProfileId =
  | 'query:read'
  | 'query:propose'
  | 'fix:links'
  | 'fix:contradiction'
  | 'curate:auto'
  | 'curate:manual'
  | 'ingest:planner'
  | 'ingest:writer';

export interface ToolProfile {
  id: ToolProfileId;
  tools: readonly string[];
  allowedSideEffects: readonly ToolSideEffect[];
  requiresApproval: boolean;
}

export interface ToolExecutionPolicy {
  profileId: ToolProfileId;
  allowedSideEffects: ReadonlySet<ToolSideEffect>;
  subjectId: string;
  allowedPageSlugs?: ReadonlySet<string>;
  jobCapability?: { jobId: string; jobType: Job['type'] };
}

export interface ToolProfileResolutionContext {
  webSearchConfigured?: boolean;
}

const QUERY_READ_TOOLS = [
  'wiki.list',
  'wiki.search',
  'wiki.read',
  'wiki.inspect',
  'source.search',
  'source.read',
  'web.search',
] as const;

const FIX_LINK_TOOLS = [
  'wiki.search',
  'wiki.read',
  'wiki.inspect',
  'source.search',
  'source.read',
  'wiki.patch',
] as const;

const CURATE_AUTO_TOOLS = [
  'wiki.search',
  'wiki.read',
  'wiki.inspect',
  'wiki.merge',
  'wiki.split',
] as const;

const PROFILES: Record<ToolProfileId, ToolProfile> = {
  'query:read': {
    id: 'query:read',
    tools: QUERY_READ_TOOLS,
    allowedSideEffects: ['none'],
    requiresApproval: false,
  },
  'query:propose': {
    id: 'query:propose',
    tools: [...QUERY_READ_TOOLS, 'wiki.preview_change'],
    allowedSideEffects: ['none', 'propose'],
    requiresApproval: true,
  },
  'fix:links': {
    id: 'fix:links',
    tools: FIX_LINK_TOOLS,
    allowedSideEffects: ['none', 'update'],
    requiresApproval: false,
  },
  'fix:contradiction': {
    id: 'fix:contradiction',
    tools: [...FIX_LINK_TOOLS, 'wiki.update'],
    allowedSideEffects: ['none', 'update'],
    requiresApproval: false,
  },
  'curate:auto': {
    id: 'curate:auto',
    tools: CURATE_AUTO_TOOLS,
    allowedSideEffects: ['none', 'merge', 'split'],
    requiresApproval: false,
  },
  'curate:manual': {
    id: 'curate:manual',
    tools: [...CURATE_AUTO_TOOLS, 'wiki.create', 'wiki.delete'],
    allowedSideEffects: ['none', 'merge', 'split', 'create', 'destructive'],
    requiresApproval: false,
  },
  'ingest:planner': {
    id: 'ingest:planner',
    tools: ['wiki.read', 'wiki.search'],
    allowedSideEffects: ['none'],
    requiresApproval: false,
  },
  'ingest:writer': {
    id: 'ingest:writer',
    tools: ['wiki.read', 'wiki.search'],
    allowedSideEffects: ['none'],
    requiresApproval: false,
  },
};

export function resolveToolProfile(
  profileId: ToolProfileId,
  context: ToolProfileResolutionContext = {},
): ToolProfile {
  const profile = PROFILES[profileId];
  const tools = context.webSearchConfigured === true
    ? profile.tools
    : profile.tools.filter((name) => name !== 'web.search');
  return { ...profile, tools: [...tools], allowedSideEffects: [...profile.allowedSideEffects] };
}

export function createToolExecutionPolicy(
  profile: ToolProfile,
  subjectId: string,
  options: Pick<ToolExecutionPolicy, 'allowedPageSlugs' | 'jobCapability'> = {},
): ToolExecutionPolicy {
  return {
    profileId: profile.id,
    allowedSideEffects: new Set(profile.allowedSideEffects),
    subjectId,
    ...options,
  };
}

export function profileForIngestSkill(skillId: string): ToolProfileId {
  return skillId === 'ingest-planner' ? 'ingest:planner' : 'ingest:writer';
}
