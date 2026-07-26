import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, type ReactElement } from 'react';

// page-renderer.tsx 等 .tsx 模块经 esbuild 转译为 React.createElement，需要全局 React。
Object.assign(globalThis, { React });

vi.mock('@/components/wiki/wiki-link', () => ({
  default: ({ href, children }: { href?: string; children?: React.ReactNode }) =>
    React.createElement('a', { href }, children),
}));

import { renderMarkdown } from '@/lib/markdown-client';
import PageRenderer from '../page-renderer';
import { EditorPreview } from '../editor-preview';

const toHtml = (el: ReactElement) => renderToStaticMarkup(el);

const QUIZ_MD = [
  '> [!quiz] ❓ 自测',
  '> 为什么反向传播需要保存中间激活值？',
  '>',
  '> ---',
  '>',
  '> 因为链式法则求梯度时要用到每层的输入。',
].join('\n');

/**
 * 存量页形态（v6 及以前的 enricher 产物）：没有 `---`，直接自评。
 * 接缝的正/负断言都用它——有答案的形态里判分按钮还额外被「揭晓」门控，
 * 用它做负断言就分不清「没按钮」是因为缺 interactive 还是因为没揭晓。
 */
const LEGACY_QUIZ_MD = '> [!quiz] ❓ 自测\n> 为什么反向传播需要保存中间激活值？';

const INTERACTIVE = { pageSlug: 'backprop', subjectSlug: 'ml' };

/** 判分按钮的稳定标识；不依赖文案，避免 i18n 改动让隔离断言失效。 */
const GRADE_MARKER = 'data-quiz-grade';

describe('interactive 接缝：只有阅读页能发证据（决策 9）', () => {
  it('不传 interactive —— Chat 消息路径不含判分按钮', () => {
    // message-list.tsx 直接调 renderMarkdown，没有页面身份。
    expect(toHtml(renderMarkdown(LEGACY_QUIZ_MD))).not.toContain(GRADE_MARKER);
  });

  it('不传 interactive —— Source 查看器 / URL 阅读模式路径不含判分按钮', () => {
    // source-viewer.tsx / url-source-preview.tsx 同样直接调 renderMarkdown。
    expect(toHtml(renderMarkdown(LEGACY_QUIZ_MD, undefined, { math: true }))).not.toContain(GRADE_MARKER);
  });

  it('不传 interactive —— 编辑器预览（经 PageRenderer 的那条路径）不含判分按钮', () => {
    // 这条最容易漏：EditorPreview 就是 <PageRenderer content slug titleSlugMap />。
    // 只要 PageRenderer 敢用自己的 slug 就地构造 interactive，编辑器预览立刻长出判分按钮。
    const html = toHtml(createElement(EditorPreview, { source: LEGACY_QUIZ_MD, slug: 'backprop' }));
    expect(html).toContain('data-callout="quiz"');
    expect(html).not.toContain(GRADE_MARKER);
  });

  it('PageRenderer 不传 interactive 时同样没有按钮（能力必须由外层显式授予）', () => {
    const html = toHtml(
      createElement(PageRenderer, { content: LEGACY_QUIZ_MD, slug: 'backprop', subjectSlug: 'ml' }),
    );
    expect(html).not.toContain(GRADE_MARKER);
  });

  it('传 interactive —— 阅读页渲染判分按钮', () => {
    const html = toHtml(renderMarkdown(LEGACY_QUIZ_MD, undefined, { interactive: INTERACTIVE }));
    expect(html).toContain(GRADE_MARKER);
  });

  it('有答案时判分按钮被「揭晓」门控（决策 5：先答 → 揭晓 → 判分）', () => {
    // 没看到标准答案就先点「我答对了」，那条证据没有客观参照，
    // 与存量页的自评没有区别——但它会被记成 strong。所以顺序必须强制。
    const html = toHtml(renderMarkdown(QUIZ_MD, undefined, { interactive: INTERACTIVE }));
    expect(html).toContain('data-quiz-reveal');
    expect(html).not.toContain(GRADE_MARKER);
  });

  it('PageRenderer 把 interactive 原样透传（自身不构造）', () => {
    const html = toHtml(
      createElement(PageRenderer, {
        content: LEGACY_QUIZ_MD,
        slug: 'backprop',
        subjectSlug: 'ml',
        interactive: INTERACTIVE,
      }),
    );
    expect(html).toContain(GRADE_MARKER);
  });
});

describe('答案折叠：六个消费方一视同仁（「不剧透」是内容呈现决定）', () => {
  it('不传 interactive 时答案仍被折叠且有展开开关', () => {
    const html = toHtml(renderMarkdown(QUIZ_MD));
    expect(html).toContain('data-quiz-reveal');
    expect(html).toContain('data-quiz-answer');
    // 折叠 = 隐藏，不是不渲染（展开无需二次解析）
    expect(html).toMatch(/data-quiz-answer[^>]*hidden/);
  });

  it('传 interactive 时折叠行为一致', () => {
    const html = toHtml(renderMarkdown(QUIZ_MD, undefined, { interactive: INTERACTIVE }));
    expect(html).toContain('data-quiz-reveal');
    expect(html).toMatch(/data-quiz-answer[^>]*hidden/);
  });

  it('无答案的存量页不渲染展开开关，也不渲染答案容器', () => {
    const html = toHtml(renderMarkdown(LEGACY_QUIZ_MD, undefined, { interactive: INTERACTIVE }));
    expect(html).not.toContain('data-quiz-reveal');
    expect(html).not.toContain('data-quiz-answer');
    // 但自评仍然可用——存量页退化为自评形态，不是没有交互
    expect(html).toContain(GRADE_MARKER);
  });

  it('非 quiz callout 完全不受影响', () => {
    const html = toHtml(
      renderMarkdown('> [!pitfall] ⚠ 常见误区\n> 别这么写。', undefined, { interactive: INTERACTIVE }),
    );
    expect(html).toContain('data-callout="pitfall"');
    expect(html).not.toContain(GRADE_MARKER);
    expect(html).not.toContain('data-quiz-reveal');
  });
});
