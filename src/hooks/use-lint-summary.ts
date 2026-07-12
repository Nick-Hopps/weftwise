'use client';

import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { fetchHealthSnapshot } from '@/lib/health-snapshot';
import { useCurrentSubject } from '@/hooks/use-current-subject';

/**
 * 读取最近一次体检结果。allSubjects=true 时读全量快照（侧边栏徽标恒用 subject-scoped）。
 */
export function useLintSummary(allSubjects = false) {
  const apiFetch = useApiFetch();
  const { id: subjectId } = useCurrentSubject();

  return useQuery({
    queryKey: ['lint-latest', allSubjects ? 'all' : subjectId],
    queryFn: () => fetchHealthSnapshot(
      apiFetch,
      `/api/lint/latest${allSubjects ? '?allSubjects=1' : ''}`,
    ),
    staleTime: 30_000,
    enabled: allSubjects || !!subjectId,
  });
}
