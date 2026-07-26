'use client';
import { useCallback } from 'react';
import { useApiFetch } from '@/lib/api-fetch';
import { useUIStore } from '@/stores/ui-store';
import type { EvidenceKind, EvidenceStrength } from '@/lib/contracts';

export interface AppendEvidencePayload {
  slug: string;
  kind: EvidenceKind;
  anchor?: string;
  /** 仅 `quiz-correct` 会被服务端采纳（决策 5 的不对称）。 */
  strength?: EvidenceStrength;
  detail?: unknown;
}

/**
 * 追加一条掌握度证据。**best-effort**：失败只 `console.error`，绝不阻断阅读。
 *
 * 不用 `useMutation`：调用方需要的只是「发出去」，没有 loading/error UI，
 * 也没有任何需要失效的 query（掌握度是读时派生，`/api/mastery` 各自按需取）。
 */
export function useAppendEvidence(): (payload: AppendEvidencePayload) => void {
  const apiFetch = useApiFetch();
  // POST 不自动注入 subjectId，按约定在 body 显式带。
  const subjectId = useUIStore((s) => s.currentSubjectId);

  return useCallback(
    (payload: AppendEvidencePayload) => {
      void apiFetch('/api/evidence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, subjectId: subjectId ?? undefined }),
      })
        .then((res) => {
          if (!res.ok) console.error(`[evidence] ${payload.kind} → ${res.status}`);
        })
        .catch((error) => console.error('[evidence] request failed', error));
    },
    [apiFetch, subjectId],
  );
}
