'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { Button } from '@/components/ui/button';
import { Tag } from '@/components/ui/tag';
import type { ResearchBacklogEntry } from '@/lib/contracts';
import { researchBacklogPatchBody } from './remediation-ui';

/**
 * T3.2 Health 页 "Research backlog" 区块：列出本 subject 的待研究问题（Ask AI 未命中信号 +
 * 手动添加），支持逐条 Research（复用现成 POST /api/research topic 分支）与 Dismiss。
 */
export function ResearchBacklogSection({
  researchBusy,
  onResearch,
}: {
  /** 父组件统一持有 Research 锁与 job 跟踪，避免多个入口覆盖同一 jobId。 */
  researchBusy: boolean;
  onResearch: (topic: string) => Promise<string | null>;
}) {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const { id: subjectId } = useCurrentSubject();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['research-backlog', subjectId],
    queryFn: async (): Promise<ResearchBacklogEntry[]> => {
      const res = await apiFetch('/api/research-backlog?status=open');
      if (!res.ok) return [];
      const json = (await res.json()) as { entries: ResearchBacklogEntry[] };
      return json.entries;
    },
    enabled: !!subjectId,
    staleTime: 15_000,
  });

  const entries = data ?? [];

  async function refetch() {
    await queryClient.invalidateQueries({ queryKey: ['research-backlog', subjectId] });
  }

  async function handleResearch(entry: ResearchBacklogEntry) {
    if (researchBusy || !subjectId) return;
    const originSubjectId = subjectId;
    setPendingId(entry.id);
    setError(null);
    try {
      const jobId = await onResearch(entry.question);
      if (!jobId) return;
      await apiFetch(`/api/research-backlog/${entry.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(researchBacklogPatchBody('researched', originSubjectId, jobId)),
      });
      await refetch();
    } catch {
      setError('Research backlog could not be updated.');
    } finally {
      setPendingId(null);
    }
  }

  async function handleDismiss(entry: ResearchBacklogEntry) {
    if (!subjectId) return;
    const originSubjectId = subjectId;
    setPendingId(entry.id);
    try {
      await apiFetch(`/api/research-backlog/${entry.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(researchBacklogPatchBody('dismissed', originSubjectId)),
      });
      await refetch();
    } finally {
      setPendingId(null);
    }
  }

  if (isLoading || entries.length === 0) return null;

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-medium uppercase tracking-wider text-foreground-tertiary px-3 mb-1">
        Research backlog ({entries.length})
      </h2>
      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}
      <div className="space-y-0.5">
        {entries.map((entry) => {
          const busy = pendingId === entry.id;
          return (
            <div
              key={entry.id}
              className="flex items-start gap-3 px-3 py-2.5 rounded-md hover:bg-subtle transition-colors"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Tag tone="neutral" size="sm">
                    {entry.source === 'ask-ai' ? 'Ask AI' : 'Manual'}
                  </Tag>
                  <span className="text-xs text-foreground-tertiary">
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="text-sm text-foreground-secondary">{entry.question}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  intent="secondary"
                  size="sm"
                  onClick={() => handleResearch(entry)}
                  loading={busy}
                  disabled={researchBusy}
                >
                  {!busy && <Search className="h-3 w-3" />}
                  Research
                </Button>
                <Button
                  intent="ghost"
                  size="sm"
                  onClick={() => handleDismiss(entry)}
                  disabled={busy || researchBusy}
                >
                  <X className="h-3 w-3" />
                  Dismiss
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
