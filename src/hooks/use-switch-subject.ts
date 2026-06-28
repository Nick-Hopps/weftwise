'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useCurrentSubject } from '@/hooks/use-current-subject';

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
 * 统一的"切换到某 subject"动作：写 store + cookie（经 setCurrentSubject）、
 * 失效相关查询、可选导航、刷新 SSR。切换器与管理页卡片共用，保证行为一致。
 */
export function useSwitchSubject() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { setCurrentSubject } = useCurrentSubject();

  return useCallback(
    (subject: { id: string; slug: string }, opts?: { navigateTo?: string }) => {
      setCurrentSubject({ id: subject.id, slug: subject.slug });
      for (const key of INVALIDATE_KEYS) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
      if (opts?.navigateTo) {
        router.push(opts.navigateTo);
      }
      // 服务端组件（仪表盘 / wiki 页）按 cookie + ?s= 读取激活 subject，刷新当前路由让其重渲染。
      router.refresh();
    },
    [queryClient, router, setCurrentSubject],
  );
}
