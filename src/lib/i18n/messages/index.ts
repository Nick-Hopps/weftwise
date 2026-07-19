import { en } from './en';
import { zhCN } from './zh-CN';

export { type MessageKey } from './en';

export const messages = {
  en,
  'zh-CN': zhCN,
} as const;
