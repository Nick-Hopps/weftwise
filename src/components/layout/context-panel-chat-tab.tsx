'use client';

import { memo } from 'react';
import { ChatInterface } from '@/components/chat/chat-interface';

/**
 * Chat tab content for the unified Context Panel.
 *
 * Always mounted once first opened so SSE streams survive tab switches —
 * the parent `ContextPanel` hides it via `hidden` attribute rather than
 * unmounting.
 */
export const ContextPanelChatTab = memo(function ContextPanelChatTab() {
  return (
    <ChatInterface variant="embedded" hideHeader />
  );
});
