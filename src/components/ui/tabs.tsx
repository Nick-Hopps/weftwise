'use client';

import { createContext, useCallback, useContext, useId, useRef } from 'react';
import { cn } from '@/lib/cn';

type TabsContextValue = {
  value: string;
  onValueChange: (value: string) => void;
  idPrefix: string;
  /** Ordered triggers so arrow-key navigation can cycle focus. */
  registerTrigger: (value: string, el: HTMLButtonElement | null) => void;
};

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabs() {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error('Tabs.* must be used inside <Tabs>');
  return ctx;
}

type TabsProps = {
  value: string;
  onValueChange: (value: string) => void;
  children: React.ReactNode;
  className?: string;
};

export function Tabs({ value, onValueChange, children, className }: TabsProps) {
  const idPrefix = useId();
  const triggersRef = useRef(new Map<string, HTMLButtonElement>());

  const registerTrigger = useCallback((val: string, el: HTMLButtonElement | null) => {
    if (el) triggersRef.current.set(val, el);
    else triggersRef.current.delete(val);
  }, []);

  return (
    <TabsContext.Provider value={{ value, onValueChange, idPrefix, registerTrigger }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex items-center gap-0.5 h-8 p-0.5 rounded-md bg-subtle',
        className,
      )}
      {...props}
    />
  );
}

type TabsTriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  value: string;
};

export function TabsTrigger({ className, value, children, ...props }: TabsTriggerProps) {
  const { value: active, onValueChange, idPrefix, registerTrigger } = useTabs();
  const isActive = active === value;
  const triggersRef = useRef<HTMLButtonElement>(null);

  // Arrow-key navigation: Left/Right cycle focus + activate.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    const list = e.currentTarget.parentElement;
    if (!list) return;
    const siblings = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])'));
    if (siblings.length === 0) return;
    const idx = siblings.indexOf(e.currentTarget);
    let nextIdx = idx;
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % siblings.length;
    else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + siblings.length) % siblings.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = siblings.length - 1;
    e.preventDefault();
    const target = siblings[nextIdx];
    target.focus();
    target.click();
  };

  return (
    <button
      ref={(el) => {
        triggersRef.current = el;
        registerTrigger(value, el);
      }}
      type="button"
      role="tab"
      id={`${idPrefix}-${value}-trigger`}
      aria-selected={isActive}
      aria-controls={`${idPrefix}-${value}-panel`}
      data-state={isActive ? 'active' : 'inactive'}
      tabIndex={isActive ? 0 : -1}
      onClick={() => onValueChange(value)}
      onKeyDown={handleKeyDown}
      className={cn(
        'inline-flex items-center justify-center px-3 h-7 rounded-sm',
        'text-sm font-medium whitespace-nowrap',
        'transition-colors duration-fast ease-standard',
        'focus-ring',
        isActive
          ? 'bg-surface text-foreground shadow-xs'
          : 'text-foreground-secondary hover:text-foreground',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

type TabsContentProps = React.HTMLAttributes<HTMLDivElement> & {
  value: string;
  /** When true, panel stays mounted but hidden; useful for preserving streaming state. */
  keepMounted?: boolean;
};

export function TabsContent({ className, value, keepMounted, children, ...props }: TabsContentProps) {
  const { value: active, idPrefix } = useTabs();
  const isActive = active === value;
  if (!isActive && !keepMounted) return null;
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-${value}-panel`}
      aria-labelledby={`${idPrefix}-${value}-trigger`}
      hidden={!isActive}
      className={cn(isActive ? 'block' : 'hidden', className)}
      {...props}
    >
      {children}
    </div>
  );
}
