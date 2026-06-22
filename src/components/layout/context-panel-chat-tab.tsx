'use client';

import { ChatInterface } from '@/components/chat/chat-interface';
import { ConversationSwitcher } from '@/components/chat/conversation-switcher';

/**
 * Chat tab content for the unified Context Panel.
 *
 * Always mounted once first opened so SSE streams survive tab switches —
 * the parent `ContextPanel` hides it via `hidden` attribute rather than
 * unmounting.
 */
export function ContextPanelChatTab() {
  return (
    <div className="flex flex-col h-full">
      <ConversationSwitcher />
      <div className="min-h-0 flex-1">
        <ChatInterface variant="embedded" hideHeader />
      </div>
    </div>
  );
}
