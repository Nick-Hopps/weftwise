'use client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useUIStore } from '@/stores/ui-store';
import type { UserProfileDTO, StylePrefs } from '@/lib/contracts';

export function useProfile() {
  const apiFetch = useApiFetch();
  return useQuery({
    queryKey: ['profile'],
    queryFn: async (): Promise<{ profile: UserProfileDTO; onboarded: boolean }> => {
      const res = await apiFetch('/api/profile');
      if (!res.ok) throw new Error(`profile ${res.status}`);
      return res.json();
    },
  });
}

export function useUpdateProfile() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: {
      backgroundSummary?: string;
      stylePrefs?: StylePrefs;
      markOnboarded?: boolean;
    }) => {
      const res = await apiFetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`profile PUT ${res.status}`);
      return res.json() as Promise<{ profile: UserProfileDTO }>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile'] });
      qc.invalidateQueries({ queryKey: ['lens'] }); // 画像变 → 重塑缓存键变 → 重取
    },
  });
}

export function useSendSignal() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  // POST 不自动注入 subjectId，按约定在 body 显式带（route 仍有 cookie 兜底）。
  const subjectId = useUIStore((s) => s.currentSubjectId);
  return useMutation({
    mutationFn: async (payload: { type: string; slug?: string }) => {
      const res = await apiFetch('/api/profile/signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, subjectId: subjectId ?? undefined }),
      });
      if (!res.ok) throw new Error(`signal ${res.status}`);
      return res.json() as Promise<{ changed: boolean; version: number }>;
    },
    onSuccess: (data) => {
      if (data.changed) {
        qc.invalidateQueries({ queryKey: ['profile'] });
        qc.invalidateQueries({ queryKey: ['lens'] });
      }
    },
  });
}
