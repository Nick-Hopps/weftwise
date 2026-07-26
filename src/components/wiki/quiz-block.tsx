'use client';

import {
  Children,
  cloneElement,
  isValidElement,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import { CalloutIcon } from './callout-icon';
import { useI18n } from '@/components/i18n-provider';
import { useAppendEvidence } from '@/hooks/use-evidence';
import type { EvidenceKind, EvidenceStrength } from '@/lib/contracts';

/**
 * 阅读页独占的能力：发证据。由**最外层知道语境的调用方**显式授予，
 * 不能由中间层或展示层推断（决策 9）。
 */
export interface QuizInteractiveContext {
  pageSlug: string;
  subjectSlug: string;
  /**
   * 被当作已掌握、因而**未展开解释**的 slug（当前 subject 的裸 slug）。
   * 只在重塑视图传——canonical 没有「跳过解释」这回事。
   */
  assumedKnown?: string[];
}

export interface QuizBlockProps extends React.ComponentPropsWithoutRef<'div'> {
  /** 问题段内容 hash，quiz 的跨会话身份（决策 7）。 */
  quizId: string;
  /** 缺省即「没有发证据的能力」——不是运行时判空，是根本拿不到 pageSlug。 */
  interactive?: QuizInteractiveContext;
}

/**
 * 决策 5 的 strength 不对称——同一个交互，正向降权、负向不降权：
 *
 * | 场景 | kind | strength | 理由 |
 * |---|---|---|---|
 * | 揭晓答案后判对 | `quiz-correct` | strong | 有客观参照 |
 * | 无答案自评「我答对了」 | `quiz-correct` | **weak** | 自我拔高偏差；误判 mastered 代价最大 |
 * | 判错（两种形态同权） | `quiz-wrong` | strong | 主动承认答错，无拔高动机 |
 *
 * `strength` 返回 undefined 时由服务端按 kind 取缺省（quiz-correct → weak）。
 */
export function quizEvidenceFor(
  outcome: 'correct' | 'wrong',
  hasAnswer: boolean,
): { kind: EvidenceKind; strength?: EvidenceStrength } {
  if (outcome === 'wrong') return { kind: 'quiz-wrong' };
  return { kind: 'quiz-correct', strength: hasAnswer ? 'strong' : undefined };
}

function isAnswerElement(child: ReactNode): child is ReactElement<{ hidden?: boolean }> {
  return (
    isValidElement(child) &&
    (child.props as Record<string, unknown>)['data-quiz-answer'] !== undefined
  );
}

/**
 * `[!quiz]` callout 的渲染形态。
 *
 * - **答案折叠在六个消费方都生效**：「不剧透」是内容呈现决定，不是某个页面的 UI 状态。
 * - **判分按钮只有阅读页有**：只有它拿得到 `interactive`。
 * - 兼容有 / 无答案两种形态：存量页（v6 及以前的 enricher 产物）没有 `---`，
 *   退化为直接自评，不是没有交互。
 */
export function QuizBlock({ quizId, interactive, children, ...rest }: QuizBlockProps) {
  const { t } = useI18n();
  const appendEvidence = useAppendEvidence();
  const [revealed, setRevealed] = useState(false);
  const [graded, setGraded] = useState<'correct' | 'wrong' | null>(null);

  // 折叠用 `hidden` 属性而非不渲染：展开无需二次解析，语义也由平台正确暴露给辅助技术。
  let hasAnswer = false;
  const body = Children.map(children, (child) => {
    if (!isAnswerElement(child)) return child;
    hasAnswer = true;
    return cloneElement(child, { hidden: !revealed });
  });

  // 有答案时，判分必须排在揭晓之后（决策 5：先答 → 揭晓 → 判分）。没看过标准答案
  // 就点「我答对了」，那条证据没有客观参照，却会被记成 strong。
  const canGrade = Boolean(interactive) && (!hasAnswer || revealed);

  const grade = (outcome: 'correct' | 'wrong') => {
    setGraded(outcome);
    if (!interactive) return;
    appendEvidence({
      ...quizEvidenceFor(outcome, hasAnswer),
      slug: interactive.pageSlug,
      anchor: quizId,
      detail: { graded: hasAnswer },
    });
  };

  return (
    // `rest` 里带着 selectionBlocks 打的 data-md-block-*，吞掉它选区追问就锚不到这一块。
    <div {...rest} data-quiz-id={quizId}>
      <CalloutIcon type="quiz" />
      {body}

      {hasAnswer && !revealed && (
        <button
          type="button"
          data-quiz-reveal
          onClick={() => setRevealed(true)}
          className="mt-2 inline-flex items-center gap-1 text-xs text-foreground-tertiary transition-colors duration-fast hover:text-foreground-secondary"
        >
          <ChevronDown className="h-3.5 w-3.5" />
          {t('wiki.quiz.reveal')}
        </button>
      )}

      {canGrade && (
        <div className="mt-3 flex items-center gap-2 border-t border-border-subtle pt-3 text-xs">
          {graded ? (
            <span className="text-foreground-tertiary">
              {t(graded === 'correct' ? 'wiki.quiz.loggedCorrect' : 'wiki.quiz.loggedWrong')}
            </span>
          ) : (
            <>
              <span className="text-foreground-tertiary">{t('wiki.quiz.question')}</span>
              <button
                type="button"
                data-quiz-grade="correct"
                onClick={() => grade('correct')}
                className="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-foreground-secondary transition-colors duration-fast hover:bg-subtle"
              >
                <Check className="h-3.5 w-3.5" />
                {t('wiki.quiz.gotItRight')}
              </button>
              <button
                type="button"
                data-quiz-grade="wrong"
                onClick={() => grade('wrong')}
                className="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-foreground-secondary transition-colors duration-fast hover:bg-subtle"
              >
                <X className="h-3.5 w-3.5" />
                {t('wiki.quiz.gotItWrong')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
