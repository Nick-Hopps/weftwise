'use client';

/**
 * 掌握度模式的证据面板 —— 这类功能错了是**隐形的**（用户只会觉得「重塑版怎么突然
 * 看不懂了」，不会归因到地图），所以必须能看到系统认为你懂什么、依据是哪几条证据。
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, X } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { useApiFetch } from '@/lib/api-fetch';
import { useI18n } from '@/components/i18n-provider';
import type { MasteryVerdict } from '@/lib/contracts';

interface MasteryInspectorProps {
  slug: string;
  subjectSlug?: string;
  onClose: () => void;
}

export function MasteryInspector({ slug, subjectSlug, onClose }: MasteryInspectorProps) {
  const { t } = useI18n();
  const apiFetch = useApiFetch();
  const [verdict, setVerdict] = useState<MasteryVerdict | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setVerdict(null);
    setError(null);

    apiFetch(`/api/mastery?slug=${encodeURIComponent(slug)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`mastery ${res.status}`);
        const data = (await res.json()) as { mastery: MasteryVerdict };
        if (!cancelled) setVerdict(data.mastery);
      })
      .catch((err) => {
        // 面板显示错误行，图本身不受影响。
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    return () => { cancelled = true; };
  }, [apiFetch, slug]);

  const href = subjectSlug ? `/wiki/${slug}?s=${subjectSlug}` : `/wiki/${slug}`;

  return (
    <aside
      aria-label={t('graph.mastery.inspector')}
      className="absolute bottom-4 left-5 z-10 w-80 max-h-[60%] overflow-y-auto rounded-md bg-surface/95 ring-1 ring-border/60 shadow-md text-xs"
    >
      <header className="sticky top-0 flex items-center justify-between gap-2 px-3 py-2 border-b border-border-subtle bg-surface/95">
        <span className="font-medium text-foreground truncate">{slug}</span>
        <div className="flex items-center gap-1 shrink-0">
          <Link
            href={href}
            aria-label={t('graph.mastery.openPage')}
            title={t('graph.mastery.openPage')}
            className="p-1 text-foreground-tertiary hover:text-link transition-colors duration-fast"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
          <IconButton size="sm" onClick={onClose} aria-label={t('graph.mastery.closeInspector')}>
            <X />
          </IconButton>
        </div>
      </header>

      <div className="px-3 py-2.5 space-y-2">
        {error && <p className="text-danger">{t('graph.mastery.loadFailed')}</p>}

        {!error && !verdict && (
          <div className="h-3 w-2/3 rounded bg-subtle animate-pulse" />
        )}

        {verdict && (
          <>
            <p className="text-foreground-secondary">
              {t(`graph.mastery.${verdict.state}`)}
              <span className="mx-1.5 text-foreground-disabled">·</span>
              {t(`graph.mastery.confidence.${verdict.confidence}`)}
            </p>

            {verdict.expiresAt && (
              <p className="text-foreground-tertiary">
                {t('graph.mastery.expires', { date: formatDate(verdict.expiresAt) })}
              </p>
            )}

            {verdict.recent.length === 0 ? (
              <p className="text-foreground-tertiary italic">{t('graph.mastery.noEvidence')}</p>
            ) : (
              <ul className="space-y-1.5 pt-1 border-t border-border-subtle">
                {verdict.recent.map((row, i) => (
                  <li key={`${row.createdAt}-${i}`} className="flex items-baseline justify-between gap-2">
                    <span className="text-foreground-secondary">
                      {/* kind 必须映射成人话——这是给 vault 主人看的解释面，不是日志；
                          把原始枚举值直接上屏等于没解释。 */}
                      {t(`evidence.kind.${row.kind}`)}
                      {row.anchor && (
                        <span className="text-foreground-tertiary"> · {row.anchor}</span>
                      )}
                    </span>
                    <time className="shrink-0 tabular-nums text-foreground-tertiary">
                      {formatDate(row.createdAt)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}
