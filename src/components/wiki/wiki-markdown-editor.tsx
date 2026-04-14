'use client';

import { useDeferredValue, useMemo } from 'react';
import MDEditor, { commands, type ICommand } from '@uiw/react-md-editor';
import { renderMarkdown } from '@/lib/markdown-client';

interface WikiMarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  titleSlugMap?: Record<string, string>;
  previewClassName?: string;
}

const wikiLinkCommand: ICommand = {
  name: 'wikilink',
  keyCommand: 'wikilink',
  buttonProps: { 'aria-label': 'Insert Wiki Link', title: 'Insert Wiki Link' },
  icon: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  ),
  execute: (state, api) => {
    const selected = state.selectedText || '';
    api.replaceSelection(`[[${selected}]]`);
  },
};

const editorCommands = [
  commands.bold,
  commands.italic,
  commands.strikethrough,
  commands.hr,
  commands.divider,
  commands.group([commands.heading1, commands.heading2, commands.heading3, commands.heading4], {
    name: 'heading',
    groupName: 'heading',
    buttonProps: { 'aria-label': 'Insert heading' },
  }),
  commands.divider,
  commands.link,
  commands.quote,
  commands.code,
  commands.codeBlock,
  commands.image,
  wikiLinkCommand,
  commands.divider,
  commands.unorderedListCommand,
  commands.orderedListCommand,
  commands.checkedListCommand,
];

export default function WikiMarkdownEditor({
  value,
  onChange,
  titleSlugMap,
  previewClassName = '',
}: WikiMarkdownEditorProps) {
  const deferredValue = useDeferredValue(value);
  const preview = useMemo(
    () => renderMarkdown(deferredValue, titleSlugMap),
    [deferredValue, titleSlugMap],
  );

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.2fr_0.8fr]">
      {/* Editor Panel */}
      <div className="wiki-editor-container overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
        <MDEditor
          value={value}
          onChange={(v) => onChange(v ?? '')}
          preview="edit"
          commands={editorCommands}
          visibleDragbar={false}
          height={640}
          textareaProps={{
            placeholder: 'Write Markdown with frontmatter and [[wikilinks]]...',
            spellCheck: false,
          }}
        />
      </div>

      {/* Preview Panel */}
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
        <div className="border-b border-zinc-200 px-4 py-2 text-xs font-semibold uppercase tracking-widest text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          Preview
        </div>
        <div className="max-h-[640px] overflow-y-auto p-5" aria-live="polite">
          <div className={previewClassName}>{preview}</div>
        </div>
      </div>
    </div>
  );
}
