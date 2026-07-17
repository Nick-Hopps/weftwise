import { describe, expect, it } from 'vitest';
import {
  chatMessageFromConversation,
  createOutgoingUserMessage,
} from '@/components/chat/chat-message';
import type { ConversationMessage, UserMessageReference } from '@/lib/contracts';

const reference: UserMessageReference = {
  pageSlug: 'page-a',
  subjectSlug: 'general',
  section: '原理',
  excerpt: '引用原文',
};

describe('createOutgoingUserMessage', () => {
  it('keeps the sent references on the optimistic user message', () => {
    expect(createOutgoingUserMessage('解释它', [reference])).toEqual({
      role: 'user',
      content: '解释它',
      references: [reference],
    });
  });
});

describe('chatMessageFromConversation', () => {
  it('restores persisted references only for a user message', () => {
    const message: ConversationMessage = {
      id: 'm1',
      conversationId: 'c1',
      role: 'user',
      content: '解释它',
      references: [reference],
      citations: null,
      createdAt: '2026-07-17T00:00:00Z',
    };

    expect(chatMessageFromConversation(message)).toEqual({
      role: 'user',
      content: '解释它',
      references: [reference],
    });
  });

  it('restores persisted citations only for an assistant message', () => {
    const message: ConversationMessage = {
      id: 'm2',
      conversationId: 'c1',
      role: 'assistant',
      content: '回答',
      references: null,
      citations: [{ pageSlug: 'source-a', excerpt: '证据' }],
      createdAt: '2026-07-17T00:00:01Z',
    };

    expect(chatMessageFromConversation(message)).toEqual({
      role: 'assistant',
      content: '回答',
      citations: [{ pageSlug: 'source-a', excerpt: '证据' }],
    });
  });
});
