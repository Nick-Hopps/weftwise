'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { useUIStore } from '@/stores/ui-store';
import { isRememberablePath, withSubjectParam } from '@/lib/subject-nav';

/** 切换 subject 时需失效的 React Query key（按前缀子树失效）。*/
const INVALIDATE_KEYS = [
  'pages',
  'search',
  'graph',
  'jobs',
  'backlinks',
  'context',
  'frontmatter',
  'lens',
] as const;

/**
 * 统一的"切换到某 subject"动作：在切换边界记录离开页、写 store + cookie、
 * 失效相关查询、恢复目标 subject 的上次页面（无则回退 navigateTo / 仪表盘）、刷新 SSR。
 * 切换器与管理页卡片共用，保证行为一致。
 */
export function useSwitchSubject() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id: currentSubjectId, setCurrentSubject } = useCurrentSubject();

  return useCallback(
    (subject: { id: string; slug: string }, opts?: { navigateTo?: string }) => {
      // 选中的就是当前 subject：不记录、不恢复记忆页；仅在显式 navigateTo 时导航
      // （⌘O 重选当前 subject → no-op 留在原页；管理页点 active 卡片 → 仍按 navigateTo 去仪表盘）。
      if (currentSubjectId === subject.id) {
        if (opts?.navigateTo) {
          router.push(opts.navigateTo);
          router.refresh();
        }
        return;
      }

      const { lastPageBySubject, rememberPage } = useUIStore.getState();

      // 1) 记录离开的 subject 的当前页（仅可记忆路径；从 live location 读，保证最新）。
      const fromPath = typeof window !== 'undefined' ? window.location.pathname : '';
      if (currentSubjectId && isRememberablePath(fromPath)) {
        rememberPage(currentSubjectId, fromPath);
      }

      // 2) 切换 store + cookie。
      setCurrentSubject({ id: subject.id, slug: subject.slug });

      // 3) 失效相关查询。
      for (const key of INVALIDATE_KEYS) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }

      // 4) 计算恢复目标并导航：记住的页优先（补 ?s= 让 SSR 显式定位），否则回退 navigateTo / 仪表盘。
      const remembered = lastPageBySubject[subject.id];
      const target = remembered
        ? withSubjectParam(remembered, subject.slug)
        : (opts?.navigateTo ?? '/');
      router.push(target);
      router.refresh();
    },
    [queryClient, router, currentSubjectId, setCurrentSubject],
  );
}
