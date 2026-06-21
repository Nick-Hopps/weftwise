'use client';

import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import type { LintLatestResult } from '@/lib/contracts';

const EMPTY: LintLatestResult = {
  jobId: null,
  ranAt: null,
  bySeverity: { critical: 0, warning: 0, info: 0 },
  findings: [],
};

/**
 * 读取最近一次体检结果。allSubjects=true 时读全量快照（侧边栏徽标恒用 subject-scoped）。
 */
export function useLintSummary(allSubjects = false) {
  const apiFetch = useApiFetch();
  const { id: subjectId } = useCurrentSubject();

  return useQuery({
    queryKey: ['lint-latest', allSubjects ? 'all' : subjectId],
    queryFn: async (): Promise<LintLatestResult> => {
      const res = await apiFetch(`/api/lint/latest${allSubjects ? '?allSubjects=1' : ''}`);
      if (!res.ok) return EMPTY;
      return (await res.json()) as LintLatestResult;
    },
    staleTime: 30_000,
    enabled: allSubjects || !!subjectId,
  });
}
