import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IngestAuthDialog } from '../ingest-auth-dialog';

vi.mock('@/components/ui/button', async () => {
  const ReactModule = await import('react');
  return {
    Button: (allProps: React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement> & {
      loading?: boolean; intent?: string; size?: string;
    }>) => {
      const { children, ...props } = allProps;
      delete props.loading;
      delete props.intent;
      delete props.size;
      return ReactModule.createElement('button', props, children);
    },
    buttonVariants: () => '',
  };
});
vi.mock('@/components/ui/icon-button', async () => {
  const ReactModule = await import('react');
  return {
    IconButton: (allProps: React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement> & {
      intent?: string; size?: string;
    }>) => {
      const { children, ...props } = allProps;
      delete props.intent;
      delete props.size;
      return ReactModule.createElement('button', props, children);
    },
  };
});
vi.mock('@/components/ui/input', async () => {
  const ReactModule = await import('react');
  return {
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) =>
      ReactModule.createElement('input', props),
  };
});

describe('IngestAuthDialog', () => {
  it('显示精确认证 origin、登录入口与默认遮蔽的受控凭证字段', () => {
    const html = renderToStaticMarkup(React.createElement(IngestAuthDialog, {
      open: true,
      jobId: 'job-1',
      challenge: {
        status: 401,
        authOrigin: 'https://example.com',
        sourceId: 'source-1',
      },
      onClose: vi.fn(),
      onAuthenticated: vi.fn(),
    }));

    expect(html).toContain('URL sign-in required');
    expect(html).toContain('https://example.com');
    expect(html).toContain('Open sign-in page');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('Cookie header');
    expect(html).toContain('Authorization header');
    expect(html.match(/type="password"/g)).toHaveLength(2);
    expect(html).toContain('Authenticate &amp; retry');
    expect(html).toContain('Encrypted');
  });

  it('closed 时不渲染内容', () => {
    const html = renderToStaticMarkup(React.createElement(IngestAuthDialog, {
      open: false,
      jobId: 'job-1',
      challenge: null,
      onClose: vi.fn(),
      onAuthenticated: vi.fn(),
    }));
    expect(html).toBe('');
  });
});
