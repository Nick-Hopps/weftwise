'use client';

import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { HtmlSafety } from '@/lib/contracts';

interface HtmlSourceFrameProps {
  /** /api/sources/<id>/raw */
  src: string;
  title: string;
  /** 服务端启发式扫描结论；缺省按 safe 处理。 */
  safety?: HtmlSafety;
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
 */
export function HtmlSourceFrame({ src, title, safety, className }: HtmlSourceFrameProps) {
  const [forceRun, setForceRun] = useState(false);
  const suspicious = safety?.risk === 'suspicious';
  const runScripts = !suspicious || forceRun;

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {suspicious && !forceRun && (
        <div className="shrink-0 border-b border-danger-border bg-danger-bg px-4 py-3 text-xs text-danger">
          <div className="flex items-center gap-2 font-semibold">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            检测到潜在危险脚本，已禁用页面交互
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
            我了解风险，仍然运行脚本
          </button>
        </div>
      )}
      <iframe
        key={runScripts ? 'run' : 'safe'}
        src={src}
        title={title}
        sandbox={runScripts ? 'allow-scripts' : ''}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>
  );
}
