'use client';

import { useState } from 'react';
import { History as HistoryIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { Tag } from '@/components/ui/tag';
import type { HistoryEntry } from '@/lib/contracts';
import { OperationDiff } from './operation-diff';
import { RevertButton } from './revert-button';

const TYPE_LABELS: Record<string, string> = {
  ingest: '摄入',
  'save-to-wiki': '保存',
  merge: '合并',
  split: '拆分',
  edit: '编辑',
  delete: '删除',
};

function Row({ entry }: { entry: HistoryEntry }) {
  const [open, setOpen] = useState(false);
  const typeLabel = TYPE_LABELS[entry.type] ?? entry.type;
  const when = entry.date ? new Date(entry.date).toLocaleString() : '—';
  const shown = entry.affectedPages.slice(0, 5);
  const extra = entry.affectedPages.length - shown.length;

  return (
    <li className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-subtle"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Tag tone={entry.status === 'reverted' ? 'neutral' : 'accent'} size="sm">
            {typeLabel}
          </Tag>
          {entry.status === 'reverted' && (
            <span className="text-xs text-foreground-tertiary">已回滚</span>
          )}
          <span className="truncate text-sm text-foreground">
            {shown.map((p) => p.slug).join(', ') || '（无页面变更）'}
            {extra > 0 ? ` +${extra}` : ''}
          </span>
        </span>
        <span className="shrink-0 text-xs tabular-nums text-foreground-tertiary">{when}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-border px-3 py-3">
          <OperationDiff operationId={entry.id} />
          <RevertButton entry={entry} />
        </div>
      )}
    </li>
  );
}

export function OperationList() {
  const apiFetch = useApiFetch();
  const { id: subjectId } = useCurrentSubject();

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ['history', subjectId],
    queryFn: async () => {
      const res = await apiFetch('/api/history');
      if (!res.ok) return [] as HistoryEntry[];
      return (await res.json()) as HistoryEntry[];
    },
    enabled: !!subjectId,
    staleTime: 10_000,
  });

  return (
    <div className="mx-auto w-full max-w-content space-y-6 px-6 py-8">
      <header>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
          <HistoryIcon className="h-5 w-5 text-foreground-tertiary" />
          History
        </h1>
        <p className="mt-1 text-sm text-foreground-secondary">
          本主题的每一次写操作。展开查看 diff 或回滚。
        </p>
      </header>

      {!subjectId || isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-md bg-subtle" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <p className="text-sm italic text-foreground-tertiary">No operations yet.</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <Row key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </div>
  );
}
