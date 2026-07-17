import type {
  ConversationMessage,
  UserMessageReference,
  WikiCitation,
} from '@/lib/contracts';

export type Citation = WikiCitation;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  references?: UserMessageReference[];
  citations?: Citation[];
  activity?: { tool: string; label: string }[];
}

export function createOutgoingUserMessage(
  content: string,
  references: UserMessageReference[],
): ChatMessage {
  return {
    role: 'user',
    content,
    ...(references.length > 0 ? { references } : {}),
  };
}

export function chatMessageFromConversation(message: ConversationMessage): ChatMessage {
  if (message.role === 'user') {
    return createOutgoingUserMessage(message.content, message.references ?? []);
  }
  return {
    role: 'assistant',
    content: message.content,
    citations: message.citations ?? [],
  };
}
