import { Shell } from '@/components/layout/shell';
import { ErrorBoundary } from '@/components/error-boundary';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Shell>
      <ErrorBoundary>{children}</ErrorBoundary>
    </Shell>
  );
}
