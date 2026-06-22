import { getRawDb } from '../client';
import type { Conversation, ConversationMessage } from '@/lib/contracts';

interface RawConv {
  id: string;
  subject_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}
interface RawMsg {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  citations_json: string | null;
  created_at: string;
}

function mapConv(r: RawConv): Conversation {
  return {
    id: r.id,
    subjectId: r.subject_id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapMsg(r: RawMsg): ConversationMessage {
  let citations: ConversationMessage['citations'] = null;
  if (r.citations_json) {
    try {
      const parsed = JSON.parse(r.citations_json);
      if (Array.isArray(parsed)) citations = parsed;
    } catch {
      citations = null;
    }
  }
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role === 'assistant' ? 'assistant' : 'user',
    content: r.content,
    citations,
    createdAt: r.created_at,
  };
}

export function createConversation(subjectId: string, title: string): Conversation {
  const now = new Date().toISOString();
  const conv: Conversation = {
    id: crypto.randomUUID(),
    subjectId,
    title,
    createdAt: now,
    updatedAt: now,
  };
  getRawDb()
    .prepare(
      `INSERT INTO conversations (id, subject_id, title, created_at, updated_at) VALUES (?,?,?,?,?)`,
    )
    .run(conv.id, conv.subjectId, conv.title, conv.createdAt, conv.updatedAt);
  return conv;
}

export function listConversations(subjectId: string): Conversation[] {
  const rows = getRawDb()
    .prepare(
      `SELECT id, subject_id, title, created_at, updated_at FROM conversations
       WHERE subject_id = ? ORDER BY updated_at DESC, rowid DESC`,
    )
    .all(subjectId) as RawConv[];
  return rows.map(mapConv);
}

export function getConversation(id: string): Conversation | null {
  const r = getRawDb()
    .prepare(`SELECT id, subject_id, title, created_at, updated_at FROM conversations WHERE id = ?`)
    .get(id) as RawConv | undefined;
  return r ? mapConv(r) : null;
}

export function renameConversation(id: string, title: string): void {
  getRawDb()
    .prepare(`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`)
    .run(title, new Date().toISOString(), id);
}

export function deleteConversation(id: string): void {
  getRawDb().prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
}

export function appendMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  citationsJson: string | null,
): ConversationMessage {
  const msg: RawMsg = {
    id: crypto.randomUUID(),
    conversation_id: conversationId,
    role,
    content,
    citations_json: citationsJson,
    created_at: new Date().toISOString(),
  };
  getRawDb()
    .prepare(
      `INSERT INTO messages (id, conversation_id, role, content, citations_json, created_at) VALUES (?,?,?,?,?,?)`,
    )
    .run(msg.id, msg.conversation_id, msg.role, msg.content, msg.citations_json, msg.created_at);
  return mapMsg(msg);
}

export function listMessages(conversationId: string): ConversationMessage[] {
  const rows = getRawDb()
    .prepare(
      `SELECT id, conversation_id, role, content, citations_json, created_at FROM messages
       WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(conversationId) as RawMsg[];
  return rows.map(mapMsg);
}

export function touchConversation(id: string): void {
  getRawDb()
    .prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}
