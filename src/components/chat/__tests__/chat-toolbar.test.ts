import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatToolbar } from '@/components/chat/chat-toolbar';

describe('ChatToolbar', () => {
  it('keeps conversation, new, clear and save actions in one stable region', () => {
    const html = renderToStaticMarkup(React.createElement(ChatToolbar, {
      conversationSwitcher: React.createElement('button', null, 'Current conversation'),
      saveAction: React.createElement('button', { 'aria-label': 'Save last answer to Wiki' }),
      canClear: true,
      onClear: () => {},
      onNewConversation: () => {},
    }));

    expect(html).toContain('data-ask-ai-toolbar="true"');
    expect(html).toContain('Current conversation');
    expect(html).toContain('aria-label="New conversation"');
    expect(html).toContain('aria-label="Clear conversation view"');
    expect(html).toContain('aria-label="Save last answer to Wiki"');
  });

  it('disables clear without removing its toolbar slot', () => {
    const html = renderToStaticMarkup(React.createElement(ChatToolbar, {
      conversationSwitcher: React.createElement('span', null, 'New conversation'),
      saveAction: React.createElement('button', { disabled: true, 'aria-label': 'Save last answer to Wiki' }),
      canClear: false,
      onClear: () => {},
      onNewConversation: () => {},
    }));

    expect(html).toContain('aria-label="Clear conversation view"');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});
