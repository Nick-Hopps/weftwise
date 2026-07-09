/**
 * 设置分类元数据 —— 两栏式 Settings 的单一来源。
 * 被 settings-dialog（默认选中）、settings-nav（导航列表）、
 * settings-content（分类标题）共用，避免三者循环依赖与漂移。
 */

import { Palette, Languages, Bot, Globe, Info, RefreshCw, Brain, BarChart3, type LucideIcon } from 'lucide-react';

export type CategoryId =
  | 'appearance'
  | 'language'
  | 'cognitive-lens'
  | 'agents'
  | 'web-search'
  | 'maintenance'
  | 'usage'
  | 'about';

export interface SettingsCategory {
  id: CategoryId;
  label: string;
  icon: LucideIcon;
}

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'language', label: 'Language', icon: Languages },
  { id: 'cognitive-lens', label: 'Cognitive Lens', icon: Brain },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'web-search', label: 'Web search', icon: Globe },
  { id: 'maintenance', label: 'Maintenance', icon: RefreshCw },
  { id: 'usage', label: 'Usage', icon: BarChart3 },
  { id: 'about', label: 'About', icon: Info },
];

export const DEFAULT_CATEGORY: CategoryId = 'appearance';
