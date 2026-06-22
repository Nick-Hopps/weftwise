'use client';

import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { cn } from '@/lib/cn';

export function OperationDiff({ operationId }: { operationId: string }) {
  const apiFetch = useApiFetch();
  const { id: subjectId } = useCurrentSubject();

  const { data, isLoading } = useQuery({
    queryKey: ['history-diff', subjectId, operationId],
    queryFn: async () => {
      const res = await apiFetch(`/api/history/${operationId}/diff`);
      if (!res.ok) return { diff: '' };
      return (await res.json()) as { diff: string };
    },
    enabled: !!subjectId,
    staleTime: 60_000,
  });

  if (isLoading) return <div className="h-24 animate-pulse rounded bg-subtle" />;
  const diff = data?.diff ?? '';
  if (!diff.trim()) return <p className="text-xs italic text-foreground-tertiary">No diff.</p>;

  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-surface p-3 font-mono text-xs leading-relaxed">
      {diff.split('\n').map((line, i) => (
        <div
          key={i}
          className={cn(
            line.startsWith('+') && !line.startsWith('+++') && 'text-green-600 dark:text-green-400',
            line.startsWith('-') && !line.startsWith('---') && 'text-red-600 dark:text-red-400',
            line.startsWith('@@') && 'text-cyan-600 dark:text-cyan-400',
            (line.startsWith('diff ') ||
              line.startsWith('+++') ||
              line.startsWith('---') ||
              line.startsWith('index ')) &&
              'font-semibold text-foreground-tertiary',
          )}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}
