/**
 * 设置一级入口与组内分区的单一来源。
 * 一级入口按用户任务组织，原有设置模块作为 section 收纳，避免分类粒度漂移。
 */

import { BarChart3, Bot, Brain, Settings2, type LucideIcon } from 'lucide-react';

export type CategoryId = 'general' | 'personalization' | 'automation' | 'usage';

export type SettingsSectionId =
  | 'appearance'
  | 'language'
  | 'cognitive-lens'
  | 'agents'
  | 'web-search'
  | 'maintenance'
  | 'usage';

export interface SettingsCategory {
  id: CategoryId;
  label: string;
  description: string;
  icon: LucideIcon;
}

export const APP_VERSION = '0.1.0';

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Appearance and content defaults',
    icon: Settings2,
  },
  {
    id: 'personalization',
    label: 'Personalization',
    description: 'How pages adapt to you',
    icon: Brain,
  },
  {
    id: 'automation',
    label: 'Automation',
    description: 'Agents, grounding, and upkeep',
    icon: Bot,
  },
  {
    id: 'usage',
    label: 'Usage',
    description: 'LLM activity and tokens',
    icon: BarChart3,
  },
];

export const SETTINGS_SECTIONS = {
  general: ['appearance', 'language'],
  personalization: ['cognitive-lens'],
  automation: ['agents', 'web-search', 'maintenance'],
  usage: ['usage'],
} satisfies Record<CategoryId, SettingsSectionId[]>;

export const DEFAULT_CATEGORY: CategoryId = 'general';
