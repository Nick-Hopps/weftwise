'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { SectionLabel } from '@/components/ui/panel';
import { useI18n } from '@/components/i18n-provider';
import { useApiFetch } from '@/lib/api-fetch';
import { useUIStore } from '@/stores/ui-store';
import type { MasteryDueResult } from '@/lib/contracts';

const DAY_MS = 86_400_000;

/**
 * 逾期整天数（下取整，最小 0）。
 *
 * 「今天到期」与「逾期 1 天」的区别对读者是有意义的（前者是节律内，后者已经开始遗忘），
 * 而小时级精度没有意义——间隔重复的最小档位就是 1 天。
 */
export function overdueDays(dueAt: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(dueAt).getTime()) / DAY_MS));
}

/**
 * 「该复习了」清单。
 *
 * 这是 `dueAt` 的第一个消费者。决策 4 的双倍有效期本就是对「系统里没有任何机制提示
 * 用户回去重答」的**补偿**而非替代——没有这个面，`mastered` 只会静默过期回落。
 *
 * **空 / 失败整体不渲染**：它是锦上添花的提醒，不该给首页添噪，也不该在冷启动
 * （零证据）时占位——那会破坏「零证据零回归」。
 */
export function DueForReview() {
  const { t } = useI18n();
  const apiFetch = useApiFetch();
  const subjectId = useUIStore((s) => s.currentSubjectId);

  const query = useQuery<MasteryDueResult>({
    queryKey: ['mastery-due', subjectId],
    queryFn: async () => {
      const res = await apiFetch('/api/mastery?due=1');
      if (!res.ok) throw new Error(`GET /api/mastery?due=1 → ${res.status}`);
      return (await res.json()) as MasteryDueResult;
    },
    staleTime: 60_000,
  });

  const data = query.data;
  if (!data || data.entries.length === 0) return null;

  const now = new Date();
  const remaining = data.total - data.entries.length;

  return (
    <section aria-labelledby="due-for-review-heading">
      <div className="mb-3 flex items-center justify-between">
        <SectionLabel id="due-for-review-heading">{t('dashboard.review.title')}</SectionLabel>
        <span className="font-mono text-xs text-foreground-tertiary">{data.total}</span>
      </div>
      <p className="mb-3 text-xs text-foreground-tertiary">{t('dashboard.review.hint')}</p>
      <ul className="divide-y divide-border-subtle border-y border-border-subtle">
        {data.entries.map((entry) => {
          const days = overdueDays(entry.dueAt, now);
          return (
            <li key={entry.slug}>
              <Link
                href={`/wiki/${encodeURIComponent(entry.slug)}`}
                className="group flex min-h-12 items-center gap-3 px-2 py-2 transition-colors hover:bg-subtle focus-ring sm:px-3"
              >
                <RotateCcw
                  className="h-3.5 w-3.5 shrink-0 text-foreground-tertiary transition-colors group-hover:text-accent"
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground transition-colors group-hover:text-accent-strong">
                  {entry.title}
                </span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-foreground-tertiary">
                  {days === 0
                    ? t('dashboard.review.dueToday')
                    : t('dashboard.review.overdueDays', { count: days })}
                </span>
              </Link>
            </li>
          );
        })}
        {remaining > 0 && (
          <li className="px-2 py-2 text-xs text-foreground-tertiary sm:px-3">
            {t('dashboard.review.more', { count: remaining })}
          </li>
        )}
      </ul>
    </section>
  );
}
