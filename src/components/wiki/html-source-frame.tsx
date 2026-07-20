'use client';

import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { HtmlSafety } from '@/lib/contracts';
import { useI18n } from '@/components/i18n-provider';

interface HtmlSourceFrameProps {
  /** 本地 `/api/sources/<id>/raw` 或链接型 Source 的远程 URL。 */
  src: string;
  title: string;
  /** 服务端启发式扫描结论；缺省按 safe 处理。 */
  safety?: HtmlSafety;
  /** true 时 src 是远程网页：默认禁脚本，用户显式确认后才放行。 */
  remote?: boolean;
  /** 施加在根容器上的尺寸/定位类，沿用各调用点原 iframe 的类名。 */
  className?: string;
}

/**
 * HTML source 预览的统一渲染：
 * - safe（或用户点了「仍然运行」）→ sandbox="allow-scripts"，放行页面自带脚本。
 * - suspicious 且未放行 → 顶部警告条 + sandbox=""（锁死，脚本被浏览器弱化）。
 *
 * 安全边界靠 iframe 的 opaque origin（sandbox 永不含 allow-same-origin）+ raw 路由
 * 的 CSP，不依赖此处的启发式判定。
 *
 * 本地 HTML 调用方应传入服务端计算的 `safety`；远程 URL 必须传 `remote=true`，
 * 此时即使没有 safety 也默认禁用脚本。
 */
export function HtmlSourceFrame({ src, title, safety, remote = false, className }: HtmlSourceFrameProps) {
  const { t } = useI18n();
  const [forceRun, setForceRun] = useState(false);
  const suspicious = remote || safety?.risk === 'suspicious';
  const runScripts = !suspicious || forceRun;

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {suspicious && !forceRun && (
        <div className="shrink-0 border-b border-danger-border bg-danger-bg px-4 py-3 text-xs text-danger">
          <div className="flex items-center gap-2 font-semibold">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            {remote
              ? t('wiki.html.remoteWarning')
              : t('wiki.html.unsafeWarning')}
          </div>
          {safety && safety.signals.length > 0 && (
            <ul className="mt-1.5 ml-6 list-disc space-y-0.5 text-danger/90">
              {safety.signals.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() => setForceRun(true)}
            className="mt-2 inline-flex h-7 items-center rounded-md border border-danger/40 px-2.5 font-medium text-danger transition-colors hover:bg-danger/12 focus-ring"
          >
            {t('wiki.html.runScripts')}
          </button>
        </div>
      )}
      <iframe
        key={runScripts ? 'run' : 'safe'}
        src={src}
        title={title}
        sandbox={runScripts ? 'allow-scripts' : ''}
        referrerPolicy="no-referrer"
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>
  );
}
