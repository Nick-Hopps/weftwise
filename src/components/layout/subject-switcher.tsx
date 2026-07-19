'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { Check, Layers, Plus, Settings } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import type { SubjectListEntry } from '@/lib/contracts';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { useSwitchSubject } from '@/hooks/use-switch-subject';
import { useUIStore } from '@/stores/ui-store';
import { Kbd } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/cn';
import { useI18n } from '@/components/i18n-provider';

async function fetchSubjects(): Promise<SubjectListEntry[]> {
  const res = await apiFetch('/api/subjects');
  if (!res.ok) return [];
  return res.json();
}

export function SubjectSwitcher() {
  const { t } = useI18n();
  const router = useRouter();
  const switchSubject = useSwitchSubject();
  const openSubjectDialog = useUIStore((s) => s.openSubjectDialog);
  const { id: currentSubjectId, slug: currentSubjectSlug } = useCurrentSubject();

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const { data: subjects = [] } = useQuery({
    queryKey: ['subjects'],
    queryFn: fetchSubjects,
    staleTime: 30_000,
  });

  const currentName =
    subjects.find((s) => s.id === currentSubjectId)?.name ??
    currentSubjectSlug.charAt(0).toUpperCase() + currentSubjectSlug.slice(1);

  // ⌘O / Ctrl+O global hotkey to toggle the popover.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleSelect = useCallback(
    (subject: SubjectListEntry) => {
      setOpen(false);
      switchSubject({ id: subject.id, slug: subject.slug });
    },
    [switchSubject],
  );

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('subjects.switch', { name: currentName })}
        className={cn(
          'inline-flex items-center gap-2 h-8 px-2.5 rounded-md text-xs',
          'bg-canvas border border-border text-foreground',
          'hover:bg-subtle hover:border-border-strong transition-colors focus-ring',
        )}
      >
        <Layers className="h-3.5 w-3.5 text-foreground-tertiary" />
        <span className="hidden sm:inline font-medium max-w-[160px] truncate">
          {currentName}
        </span>
        <Kbd>⌘O</Kbd>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('subjects.label')}
          className={cn(
            'absolute left-0 top-full mt-1.5 z-tooltip w-72',
            'bg-surface border border-border rounded-md shadow-lg overflow-hidden',
            'animate-fade-in',
          )}
        >
          <Command label={t('subjects.label')} shouldFilter>
            <div className="px-3 h-10 flex items-center border-b border-border">
              <Command.Input
                autoFocus
                placeholder={t('subjects.search')}
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-foreground-tertiary focus:outline-none"
              />
            </div>
            <Command.List className="max-h-72 overflow-y-auto py-1">
              <Command.Empty className="px-3 py-6 text-center text-xs text-foreground-tertiary">
                {t('subjects.emptyShort')}
              </Command.Empty>
              {subjects.map((subject) => (
                <Command.Item
                  key={subject.id}
                  value={`subject ${subject.slug} ${subject.name}`}
                  onSelect={() => handleSelect(subject)}
                  className={cn(
                    'flex items-center gap-2 px-3 h-9 mx-1 rounded-md cursor-pointer',
                    'aria-selected:bg-subtle text-sm text-foreground',
                  )}
                >
                  <Layers className="h-3.5 w-3.5 text-foreground-tertiary shrink-0" />
                  <span className="flex-1 min-w-0 truncate">{subject.name}</span>
                  <span className="text-[11px] text-foreground-tertiary tabular-nums">
                    {subject.pageCount}
                  </span>
                  {subject.id === currentSubjectId && (
                    <Check className="h-3.5 w-3.5 text-accent shrink-0" />
                  )}
                </Command.Item>
              ))}
              <Separator className="my-1" />
              <Command.Item
                value="action-new-subject"
                onSelect={() => {
                  setOpen(false);
                  openSubjectDialog({ mode: 'create' });
                }}
                className="flex items-center gap-2 px-3 h-9 mx-1 rounded-md cursor-pointer aria-selected:bg-subtle text-sm text-foreground-secondary"
              >
                <Plus className="h-3.5 w-3.5" />
                <span className="flex-1">{t('subjects.newEllipsis')}</span>
              </Command.Item>
              <Command.Item
                value="action-manage-subjects"
                onSelect={() => {
                  setOpen(false);
                  router.push('/subjects');
                }}
                className="flex items-center gap-2 px-3 h-9 mx-1 rounded-md cursor-pointer aria-selected:bg-subtle text-sm text-foreground-secondary"
              >
                <Settings className="h-3.5 w-3.5" />
                <span className="flex-1">{t('subjects.manage')}</span>
              </Command.Item>
            </Command.List>
          </Command>
        </div>
      )}
    </div>
  );
}
