'use client';

/** 四个任务导向入口：桌面为侧栏，移动端为横向分类导航。 */

import { cn } from '@/lib/cn';
import { APP_VERSION, SETTINGS_CATEGORIES, type CategoryId } from './settings-categories';

interface SettingsNavProps {
  active: CategoryId;
  onSelect: (id: CategoryId) => void;
}

export function SettingsNav({ active, onSelect }: SettingsNavProps) {
  return (
    <nav
      aria-label="Settings categories"
      className={cn(
        'flex shrink-0 flex-col border-b border-border bg-subtle/40 px-2 py-1.5',
        'md:w-48 md:border-b-0 md:border-r md:p-3',
      )}
    >
      <ul className="flex gap-0.5 overflow-x-auto md:block md:space-y-1 md:overflow-visible">
        {SETTINGS_CATEGORIES.map((category) => {
          const Icon = category.icon;
          const isActive = category.id === active;
          return (
            <li key={category.id} className="shrink-0 md:w-full">
              <button
                type="button"
                onClick={() => onSelect(category.id)}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'group flex min-h-9 items-center gap-2 rounded-md px-2 text-left focus-ring',
                  'transition-colors duration-fast ease-standard md:w-full md:px-2.5',
                  isActive
                    ? 'bg-accent-subtle text-accent-strong'
                    : 'text-foreground-secondary hover:bg-subtle hover:text-foreground',
                )}
              >
                <Icon className="hidden h-4 w-4 shrink-0 md:block" aria-hidden />
                <span className="block text-sm font-medium">{category.label}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-auto hidden border-t border-border px-2 pt-3 md:block">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-foreground-secondary">weftwise 织识</span>
          <span className="text-[11px] tabular-nums text-foreground-tertiary">v{APP_VERSION}</span>
        </div>
      </div>
    </nav>
  );
}
