import type {
  ConversationMessage,
  UserMessageReference,
  WebCitation,
  WikiCitation,
} from '@/lib/contracts';
import { splitAnswerCitations } from '@/lib/wiki-citation';

export type Citation = WikiCitation;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  references?: UserMessageReference[];
  citations?: Citation[];
  webCitations?: WebCitation[];
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
  // 持久化时 wiki 与 web 条目混存同一数组，恢复时按判别字段拆回两侧。
  const { wiki, web } = splitAnswerCitations(message.citations);
  return {
    role: 'assistant',
    content: message.content,
    citations: wiki,
    // 与 user references 一致：无网页来源时不带该键，保持消息对象形状最小
    ...(web.length > 0 ? { webCitations: web } : {}),
  };
}
