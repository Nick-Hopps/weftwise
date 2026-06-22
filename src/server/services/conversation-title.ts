const MAX_TITLE_LEN = 60;

/** 从首个用户问题派生会话标题：取首行、折叠空白、trim、截 ≤60；空则兜底。 */
export function deriveConversationTitle(question: string): string {
  const firstLine = (question ?? '').split('\n')[0] ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return 'New conversation';
  return collapsed.slice(0, MAX_TITLE_LEN);
}
