'use client';
import { useState } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSendSignal } from '@/hooks/use-profile';
import { useI18n } from '@/components/i18n-provider';

/** 阅读页底部反馈：太难/太浅 → 信号，喂回画像学习闭环。 */
export function LensFeedback({ slug }: { slug: string }) {
  const { t } = useI18n();
  const send = useSendSignal();
  const [sent, setSent] = useState<string | null>(null);

  const fire = (type: 'too_hard' | 'too_easy') => {
    send.mutate({ type, slug });
    setSent(type === 'too_hard' ? 'too hard' : 'too easy');
  };

  return (
    <div className="mx-auto w-full px-6 pb-12 max-w-[var(--reading-max-width)]">
      <div className="flex items-center gap-3 border-t border-border pt-6 text-xs text-foreground-tertiary">
        <span>{t('wiki.lens.question')}</span>
        <Button intent="outline" size="sm" onClick={() => fire('too_hard')} disabled={send.isPending}>
          <ThumbsDown className="h-3.5 w-3.5" /> {t('wiki.lens.tooHard')}
        </Button>
        <Button intent="outline" size="sm" onClick={() => fire('too_easy')} disabled={send.isPending}>
          <ThumbsUp className="h-3.5 w-3.5" /> {t('wiki.lens.tooEasy')}
        </Button>
        {sent && <span className="text-accent-strong">{t(sent === 'too hard' ? 'wiki.lens.loggedHard' : 'wiki.lens.loggedEasy')}</span>}
      </div>
    </div>
  );
}
