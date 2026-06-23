'use client';

/**
 * SettingsDialog —— 对话框容器：持有 app-settings 的 query/mutation 与
 * Esc 关闭逻辑；内容区渲染拆分到 settings-content.tsx，行级原语在
 * settings-rows.tsx。server 端 app_settings 表是唯一真实源，不写 Zustand。
 */

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-fetch';
import { useUIStore } from '@/stores/ui-store';
import { IconButton } from '@/components/ui/icon-button';
import type { AppSettings } from '@/lib/contracts';
import { SettingsContent } from './settings-content';
import { SettingsNav } from './settings-nav';
import { DEFAULT_CATEGORY, type CategoryId } from './settings-categories';

/** PUT /api/settings 的共用请求体逻辑（部分字段更新）。 */
async function putSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const res = await apiFetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PUT /api/settings → ${res.status}${text ? `: ${text}` : ''}`);
  }
  return (await res.json()) as AppSettings;
}

export function SettingsDialog() {
  const isOpen = useUIStore((s) => s.settingsDialogOpen);
  const close = useUIStore((s) => s.closeSettingsDialog);
  const darkMode = useUIStore((s) => s.darkMode);
  const toggleDarkMode = useUIStore((s) => s.toggleDarkMode);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const resetSidebarWidth = useUIStore((s) => s.resetSidebarWidth);

  const queryClient = useQueryClient();

  const settingsQuery = useQuery<AppSettings>({
    queryKey: ['app-settings'],
    queryFn: async () => {
      const res = await apiFetch('/api/settings');
      if (!res.ok) throw new Error(`GET /api/settings → ${res.status}`);
      return (await res.json()) as AppSettings;
    },
    enabled: isOpen,
    staleTime: 30_000,
  });

  const [languageDraft, setLanguageDraft] = useState('');
  const [active, setActive] = useState<CategoryId>(DEFAULT_CATEGORY);

  // 每次打开弹窗回到默认分类，行为可预期。
  useEffect(() => {
    if (isOpen) setActive(DEFAULT_CATEGORY);
  }, [isOpen]);

  useEffect(() => {
    if (settingsQuery.data) {
      setLanguageDraft(settingsQuery.data.wikiLanguage);
    }
  }, [settingsQuery.data]);

  const saveLanguage = useMutation({
    mutationFn: (value: string) => putSettings({ wikiLanguage: value }),
    onSuccess: (data) => {
      queryClient.setQueryData(['app-settings'], data);
      setLanguageDraft(data.wikiLanguage);
    },
  });

  const savePartial = useMutation({
    mutationFn: (patch: Partial<AppSettings>) => putSettings(patch),
    onSuccess: (data) => {
      queryClient.setQueryData(['app-settings'], data);
    },
  });

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, close]);

  if (!isOpen) return null;

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      className="fixed inset-0 z-command flex items-start justify-center pt-[15vh] bg-overlay/40 backdrop-blur-sm animate-fade-in"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        className="flex h-[70vh] max-h-[560px] w-full max-w-3xl mx-4 flex-col bg-surface rounded-lg shadow-lg border border-border overflow-hidden animate-slide-down"
      >
        <div className="flex items-center justify-between h-12 shrink-0 px-4 border-b border-border">
          <h2 id="settings-dialog-title" className="text-sm font-semibold text-foreground">
            Settings
          </h2>
          <IconButton size="sm" onClick={close} aria-label="Close settings">
            <X />
          </IconButton>
        </div>

        <div className="flex min-h-0 flex-1">
          <SettingsNav active={active} onSelect={setActive} />

          <SettingsContent
            active={active}
            darkMode={darkMode}
            toggleDarkMode={toggleDarkMode}
            sidebarWidth={sidebarWidth}
            resetSidebarWidth={resetSidebarWidth}
            settings={settingsQuery.data}
            settingsLoading={settingsQuery.isLoading}
            languageDraft={languageDraft}
            setLanguageDraft={setLanguageDraft}
            saveLanguage={saveLanguage}
            savePartial={savePartial}
          />
        </div>
      </div>
    </div>
  );
}
