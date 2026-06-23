'use client';

/**
 * SettingsNav —— 两栏式 Settings 的左侧分类导航栏。
 * 纯展示：遍历 SETTINGS_CATEGORIES 渲染按钮列表，选中项高亮，
 * 点击经 onSelect 回传给 SettingsDialog 切换右侧内容。
 */

import { cn } from '@/lib/cn';
import { SETTINGS_CATEGORIES, type CategoryId } from './settings-categories';

interface SettingsNavProps {
  active: CategoryId;
  onSelect: (id: CategoryId) => void;
}

export function SettingsNav({ active, onSelect }: SettingsNavProps) {
  return (
    <nav
      aria-label="Settings categories"
      className="w-44 shrink-0 overflow-y-auto border-r border-border bg-subtle/40 p-2"
    >
      <ul className="space-y-0.5">
        {SETTINGS_CATEGORIES.map((cat) => {
          const Icon = cat.icon;
          const isActive = cat.id === active;
          return (
            <li key={cat.id}>
              <button
                type="button"
                onClick={() => onSelect(cat.id)}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm',
                  'transition-colors duration-fast ease-standard focus-ring',
                  isActive
                    ? 'bg-accent-subtle text-accent-strong font-medium'
                    : 'text-foreground-secondary hover:bg-subtle hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{cat.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
