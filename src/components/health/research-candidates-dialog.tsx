'use client';

/**
 * ResearchCandidatesDialog —— research job 完成后展示候选 URL 清单供人工确认。
 * 只在本组件内维护勾选状态；确认走现成 POST /api/ingest { urls }（零改动该端点）。
 */
import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import type { ResearchCandidate } from '@/lib/contracts';
import { Button } from '@/components/ui/button';
import { Tag } from '@/components/ui/tag';

// 与 server/services/research-plan.ts::defaultChecked 语义一致的客户端镜像
// （"server-only" 屏障：客户端组件不得 import src/server/**，故此处小函数本地复刻）。
function defaultChecked(candidate: ResearchCandidate): boolean {
  return candidate.score === 3;
}

export function ResearchCandidatesDialog({
  candidates,
  onClose,
  onConfirm,
  confirming,
}: {
  candidates: ResearchCandidate[];
  onClose: () => void;
  onConfirm: (urls: string[]) => void;
  confirming: boolean;
}) {
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(candidates.filter(defaultChecked).map((c) => c.url)),
  );

  const selectedUrls = useMemo(() => candidates.filter((c) => checked.has(c.url)).map((c) => c.url), [candidates, checked]);

  function toggle(url: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-command flex items-start justify-center pt-[10vh] bg-overlay/40 backdrop-blur-sm animate-fade-in"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="research-candidates-title"
        className="w-full max-w-2xl mx-4 flex flex-col bg-surface rounded-lg shadow-lg border border-border overflow-hidden animate-slide-down max-h-[76vh]"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 id="research-candidates-title" className="text-sm font-semibold text-foreground">
            Research candidates ({candidates.length})
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-foreground-tertiary hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {candidates.length === 0 ? (
            <p className="text-sm text-foreground-tertiary italic py-6 text-center">
              No candidates found — try a different topic or check web search coverage.
            </p>
          ) : (
            candidates.map((c) => (
              <label
                key={c.url}
                className="flex items-start gap-3 px-2 py-2 rounded-md hover:bg-subtle cursor-pointer"
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={checked.has(c.url)}
                  onChange={() => toggle(c.url)}
                />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm font-medium text-accent hover:underline truncate"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {c.title || c.url}
                    </a>
                    {c.score !== null ? (
                      <Tag tone={c.score >= 3 ? 'success' : c.score >= 2 ? 'neutral' : 'warning'} size="sm">
                        score {c.score}
                      </Tag>
                    ) : (
                      <Tag tone="neutral" size="sm">unscored</Tag>
                    )}
                  </div>
                  <p className="text-xs text-foreground-tertiary truncate">{c.url}</p>
                  <p className="text-sm text-foreground-secondary line-clamp-2">{c.snippet}</p>
                  {c.reason && <p className="text-xs text-foreground-tertiary italic">{c.reason}</p>}
                </div>
              </label>
            ))
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border">
          <span className="text-xs text-foreground-tertiary">
            {selectedUrls.length} selected
          </span>
          <div className="flex items-center gap-2">
            <Button intent="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              intent="primary"
              onClick={() => onConfirm(selectedUrls)}
              loading={confirming}
              disabled={selectedUrls.length === 0}
            >
              Ingest {selectedUrls.length > 0 ? selectedUrls.length : ''}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
