'use client';
import { useCallback, useRef } from 'react';
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

/** 服务端在写入 style-bearing 证据后顺带跑一遍风格 reducer 的结果。 */
export interface AppendEvidenceResult {
  style?: { changed?: boolean; version?: number };
}

/**
 * 追加一条掌握度证据。**best-effort**：失败只 `console.error`，绝不阻断阅读。
 *
 * 不用 `useMutation`：调用方需要的只是「发出去」，没有 loading/error UI，
 * 掌握度本身也是读时派生（`/api/mastery` 各自按需取）。
 *
 * **刻意不在这里碰 react-query**：本 hook 被 `<QuizBlock>` 使用，而 QuizBlock 出现在
 * `renderMarkdown` 的全部六个消费方里——在这里 `useQueryClient()` 会让正文渲染硬依赖
 * QueryClientProvider。需要失效缓存的调用方（`LensFeedback`）自己传 `onRecorded`。
 */
export function useAppendEvidence(
  onRecorded?: (result: AppendEvidenceResult) => void,
): (payload: AppendEvidencePayload) => void {
  const apiFetch = useApiFetch();
  // POST 不自动注入 subjectId，按约定在 body 显式带。
  const subjectId = useUIStore((s) => s.currentSubjectId);
  // ref 持有：调用方常传内联箭头函数，直接进依赖会让 callback 每次渲染都换身份。
  const onRecordedRef = useRef(onRecorded);
  onRecordedRef.current = onRecorded;

  return useCallback(
    (payload: AppendEvidencePayload) => {
      void apiFetch('/api/evidence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, subjectId: subjectId ?? undefined }),
      })
        .then(async (res) => {
          if (!res.ok) {
            console.error(`[evidence] ${payload.kind} → ${res.status}`);
            return;
          }
          onRecordedRef.current?.((await res.json()) as AppendEvidenceResult);
        })
        .catch((error) => console.error('[evidence] request failed', error));
    },
    [apiFetch, subjectId],
  );
}
