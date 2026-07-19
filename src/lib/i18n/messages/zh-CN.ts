import type { MessageKey } from './en';

export const zhCN = {
  'common.items': '{count} 项',
  'metadata.title': 'weftwise 织识',
  'metadata.description': 'weftwise（织识）用 LLM 智能体将你读过的一切编织成持续生长、相互链接的个人知识库。',
} as const satisfies Record<MessageKey, string>;
