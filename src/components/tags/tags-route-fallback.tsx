import { Hash } from 'lucide-react';
import {
  WorkspacePage,
  WorkspacePageHeader,
  WorkspaceSummary,
  WorkspaceToolbar,
} from '@/components/ui/workspace-page';

export function TagsRouteFallback() {
  return (
    <WorkspacePage>
      <WorkspacePageHeader
        icon={<Hash className="h-5 w-5 text-foreground-tertiary" aria-hidden />}
        title="Tags"
        description={<span className="inline-block h-4 w-44 animate-pulse rounded-sm bg-subtle" />}
      />
      <WorkspaceSummary className="grid-cols-2 gap-px bg-border-subtle sm:grid-cols-4">
        {[1, 2, 3, 4].map((item) => (
          <div key={item} className="h-[68px] animate-pulse bg-surface px-4 py-3.5" />
        ))}
      </WorkspaceSummary>
      <WorkspaceToolbar>
        <div className="h-8 animate-pulse rounded-md bg-subtle" />
      </WorkspaceToolbar>
      <div className="divide-y divide-border-subtle border-y border-border-subtle">
        {[1, 2, 3, 4, 5].map((item) => (
          <div key={item} className="h-16 animate-pulse bg-subtle/60" />
        ))}
      </div>
    </WorkspacePage>
  );
}
