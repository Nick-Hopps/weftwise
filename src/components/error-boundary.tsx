'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/components/i18n-provider';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

function DefaultErrorFallback({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-[200px] flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-danger-bg">
        <AlertTriangle className="h-5 w-5 text-danger" aria-hidden />
      </div>
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">{t('errorBoundary.title')}</h2>
        <p className="max-w-md text-sm text-foreground-secondary">
          {error?.message || t('errorBoundary.description')}
        </p>
      </div>
      <Button intent="primary" size="base" onClick={onRetry}>{t('errorBoundary.retry')}</Button>
    </div>
  );
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return <DefaultErrorFallback error={this.state.error} onRetry={() => this.setState({ hasError: false, error: null })} />;
    }

    return this.props.children;
  }
}
