import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

vi.mock('@/components/wiki/wiki-link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href?: string; children?: unknown }) =>
      React.createElement('a', { href }, children as React.ReactNode),
  };
});

import { renderMarkdown } from '../markdown-client';
import { fnv1a } from '../stable-hash';

const toHtml = (el: ReactElement) => renderToStaticMarkup(el);

/** v7 形态：问题 → `---` → 答案，全部在同一个 blockquote 内。 */
const WITH_ANSWER = [
  '> [!quiz] ❓ 自测',
  '> 为什么反向传播需要保存前向过程的中间激活值？',
  '>',
  '> ---',
  '>',
  '> 因为链式法则求梯度时要用到每层的输入。',
].join('\n');

/** 存量形态：只有问题，没有分隔符。 */
const WITHOUT_ANSWER = [
  '> [!quiz] ❓ 自测',
  '> 为什么反向传播需要保存前向过程的中间激活值？',
].join('\n');

function quizId(html: string): string | null {
  return /data-quiz-id="([^"]+)"/.exec(html)?.[1] ?? null;
}

describe('createRemarkQuiz —— 答案切分', () => {
  it('有 `---` 时切出答案段并包进 data-quiz-answer 容器', () => {
    const html = toHtml(renderMarkdown(WITH_ANSWER));
    expect(html).toContain('data-callout="quiz"');
    expect(html).toContain('data-quiz-answer');
    // 问题留在容器外，答案在容器内
    const answerPart = html.slice(html.indexOf('data-quiz-answer'));
    expect(answerPart).toContain('链式法则');
    expect(answerPart).not.toContain('为什么反向传播');
  });

  it('无 `---` 时原样放行（存量页形态），不产生答案容器', () => {
    const html = toHtml(renderMarkdown(WITHOUT_ANSWER));
    expect(html).toContain('data-callout="quiz"');
    expect(html).not.toContain('data-quiz-answer');
    expect(html).toContain('为什么反向传播');
  });

  it('多个 `---` 只按第一个切，其余留在答案段内', () => {
    const md = [
      '> [!quiz] ❓ 自测',
      '> 问题',
      '>',
      '> ---',
      '>',
      '> 答案第一段',
      '>',
      '> ---',
      '>',
      '> 答案第二段',
    ].join('\n');
    const html = toHtml(renderMarkdown(md));
    const answerPart = html.slice(html.indexOf('data-quiz-answer'));
    expect(answerPart).toContain('答案第一段');
    expect(answerPart).toContain('答案第二段');
    expect(html.match(/data-quiz-answer/g)).toHaveLength(1);
  });

  it('非 quiz callout 不受影响', () => {
    const md = [
      '> [!pitfall] ⚠ 常见误区',
      '> 前半',
      '>',
      '> ---',
      '>',
      '> 后半',
    ].join('\n');
    const html = toHtml(renderMarkdown(md));
    expect(html).toContain('data-callout="pitfall"');
    expect(html).not.toContain('data-quiz-answer');
    expect(html).not.toContain('data-quiz-id');
  });

  it('普通 blockquote 与顶层 `---` 都不被误当作 quiz', () => {
    const html = toHtml(renderMarkdown('前文\n\n---\n\n> 普通引用'));
    expect(html).not.toContain('data-quiz-id');
    expect(html).not.toContain('data-quiz-answer');
  });
});

describe('createRemarkQuiz —— quiz 身份（决策 7）', () => {
  it('data-quiz-id 是问题段文本的 fnv1a', () => {
    // 「问题段」= 决策 6 切分后的前半，含 callout 标题（`[!quiz]` 与图标已被
    // callout 插件剥掉，`自测` 与问题同属一个段落）；空白全部剔除，重排版不改身份。
    const html = toHtml(renderMarkdown(WITH_ANSWER));
    expect(quizId(html)).toBe(fnv1a('自测为什么反向传播需要保存前向过程的中间激活值？'));
  });

  it('问题段重排版（换行位置变化）不改变身份', () => {
    const reflowed = WITH_ANSWER.replace(
      '> 为什么反向传播需要保存前向过程的中间激活值？',
      '> 为什么反向传播需要保存\n> 前向过程的中间激活值？',
    );
    expect(quizId(toHtml(renderMarkdown(reflowed))))
      .toBe(quizId(toHtml(renderMarkdown(WITH_ANSWER))));
  });

  it('只改写答案不改变 quiz 身份', () => {
    // enricher 重跑时润色答案措辞，不应该让「他答对过」这件事失效。
    const rewrittenAnswer = WITH_ANSWER.replace(
      '因为链式法则求梯度时要用到每层的输入。',
      '链式法则在反传时要用到每层的输入，丢弃后只能重算。',
    );
    expect(quizId(toHtml(renderMarkdown(rewrittenAnswer))))
      .toBe(quizId(toHtml(renderMarkdown(WITH_ANSWER))));
  });

  it('改写问题则改变 quiz 身份（题目改了就是新题，旧证据自然失效）', () => {
    const rewrittenQuestion = WITH_ANSWER.replace(
      '为什么反向传播需要保存前向过程的中间激活值？',
      '反向传播为什么不能丢弃中间激活值？',
    );
    expect(quizId(toHtml(renderMarkdown(rewrittenQuestion))))
      .not.toBe(quizId(toHtml(renderMarkdown(WITH_ANSWER))));
  });

  it('无答案形态同样带 quiz id，且与有答案形态的同一问题一致', () => {
    expect(quizId(toHtml(renderMarkdown(WITHOUT_ANSWER))))
      .toBe(quizId(toHtml(renderMarkdown(WITH_ANSWER))));
  });
});

describe('createRemarkQuiz —— 与 selectionBlocks 的顺序约束（决策 6）', () => {
  it('同时启用时顶层块 offset 不变', () => {
    const md = `前面一段。\n\n${WITH_ANSWER}\n\n后面一段。`;
    const withQuizOnly = toHtml(renderMarkdown(md, undefined, { selectionBlocks: true }));

    // quiz 只重构 blockquote **内部**，不影响顶层块的 UTF-16 offset。
    // 若插件排在 selectionBlocks 之前、插入了没有 position 的包装节点，这里会漂移。
    const offsets = [...withQuizOnly.matchAll(/data-md-block-start="(\d+)"/g)].map((m) => m[1]);
    expect(offsets).toEqual(['0', String(md.indexOf('> [!quiz]')), String(md.lastIndexOf('后面一段。'))]);
  });

  it('quiz 容器本身也拿到块级锚点，选区追问仍可定位到它', () => {
    const md = `${WITH_ANSWER}`;
    const html = toHtml(renderMarkdown(md, undefined, { selectionBlocks: true }));
    expect(html).toContain('data-md-block-start="0"');
    expect(html).toContain('data-quiz-answer');
  });
});
