import type { ResearchRunView } from './contracts';

export const RESEARCH_RUN_UPDATED_EVENT = 'wiki:research-run-updated';

export interface ResearchRunUpdatedEventDetail {
  run: ResearchRunView;
}

export function dispatchResearchRunUpdated(run: ResearchRunView): void {
  window.dispatchEvent(new CustomEvent<ResearchRunUpdatedEventDetail>(
    RESEARCH_RUN_UPDATED_EVENT,
    { detail: { run } },
  ));
}

export function isMatchingResearchRunUpdate<
  Current extends Pick<ResearchRunView, 'id' | 'subjectId'>,
  Updated extends Pick<ResearchRunView, 'id' | 'subjectId'>,
>(current: Current, updated: Updated): boolean {
  return current.id === updated.id && current.subjectId === updated.subjectId;
}
