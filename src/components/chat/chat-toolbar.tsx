'use client';

import React from 'react';
import { MessageSquarePlus, Trash2 } from 'lucide-react';
import { iconButtonVariants } from '@/components/ui/icon-button';
import { useI18n } from '@/components/i18n-provider';

interface ChatToolbarProps {
  conversationSwitcher: React.ReactNode;
  saveAction: React.ReactNode;
  canClear: boolean;
  onClear: () => void;
  onNewConversation: () => void;
}

/** Ask AI 的稳定功能区：会话选择和回答动作不再分散到内容区。 */
export function ChatToolbar({
  conversationSwitcher,
  saveAction,
  canClear,
  onClear,
  onNewConversation,
}: ChatToolbarProps) {
  const { t } = useI18n();
  return (
    <div
      data-ask-ai-toolbar
      className="flex h-10 shrink-0 items-center gap-1 border-b border-border-subtle px-2.5"
    >
      <div className="min-w-0 flex-1">{conversationSwitcher}</div>
      <div className="flex shrink-0 items-center gap-0.5 border-l border-border-subtle pl-1.5">
        <button
          type="button"
          aria-label={t('chat.newConversation')}
          data-tip={t('chat.newConversation')}
          className={`${iconButtonVariants({ size: 'sm' })} tip tip-b`}
          onClick={onNewConversation}
        >
          <MessageSquarePlus className="h-3 w-3" />
        </button>
        <button
          type="button"
          aria-label={t('chat.clearConversation')}
          data-tip={t('common.clear')}
          className={`${iconButtonVariants({ size: 'sm' })} tip tip-b`}
          disabled={!canClear}
          onClick={onClear}
        >
          <Trash2 className="h-3 w-3" />
        </button>
        {saveAction}
      </div>
    </div>
  );
}
