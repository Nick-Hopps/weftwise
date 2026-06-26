'use client';
import { useState } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSendSignal } from '@/hooks/use-profile';

/** 阅读页底部反馈：太难/太浅 → 信号，喂回画像学习闭环。 */
export function LensFeedback({ slug }: { slug: string }) {
  const send = useSendSignal();
  const [sent, setSent] = useState<string | null>(null);

  const fire = (type: 'too_hard' | 'too_easy') => {
    send.mutate({ type, slug });
    setSent(type === 'too_hard' ? '太难' : '太浅');
  };

  return (
    <div className="mx-auto w-full px-6 pb-12 max-w-[var(--reading-max-width)]">
      <div className="flex items-center gap-3 border-t border-border pt-6 text-xs text-foreground-tertiary">
        <span>这页的讲法对你合适吗？</span>
        <Button intent="outline" size="sm" onClick={() => fire('too_hard')} disabled={send.isPending}>
          <ThumbsDown className="h-3.5 w-3.5" /> 太难
        </Button>
        <Button intent="outline" size="sm" onClick={() => fire('too_easy')} disabled={send.isPending}>
          <ThumbsUp className="h-3.5 w-3.5" /> 太浅
        </Button>
        {sent && <span className="text-accent-strong">已记录「{sent}」，将调整后续呈现</span>}
      </div>
    </div>
  );
}
