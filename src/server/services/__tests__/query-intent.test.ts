import { describe, expect, it, vi } from 'vitest';
import {
  classifyQueryIntent,
  queryModeForIntent,
  resolveDirectReenrichTarget,
  type QueryIntentClassification,
} from '../query-intent';

const targetNone = { reference: 'none' as const, slug: null };

function classification(
  intent: QueryIntentClassification['intent'],
  targetPage: QueryIntentClassification['targetPage'] = targetNone,
): QueryIntentClassification {
  return { intent, targetPage };
}

describe('classifyQueryIntent', () => {
  it('使用 query 任务的一次结构化调用分类普通请求', async () => {
    const result = classification('propose');
    const generate = vi.fn().mockResolvedValue(result);

    await expect(classifyQueryIntent(
      '把 Wiki 页面 old-page 移动到 new-page',
      { phase: 'request', hasSelection: false, hasCurrentPage: false },
      { generate },
    )).resolves.toEqual(result);

    expect(generate).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith(
      'query',
      expect.anything(),
      expect.stringMatching(/direct-reenrich[\s\S]*reset-request/i),
      expect.stringContaining('把 Wiki 页面 old-page 移动到 new-page'),
      {},
      { schemaRetries: 1 },
    );
  });

  it('保留结构化 Re-enrich 当前页与显式 slug 目标', async () => {
    const current = classification('direct-reenrich', {
      reference: 'current-page',
      slug: null,
    });
    const explicit = classification('direct-reenrich', {
      reference: 'slug',
      slug: 'linear-algebra',
    });

    await expect(classifyQueryIntent('重新丰富当前页面', {
      phase: 'request', hasSelection: false, hasCurrentPage: true,
    }, { generate: vi.fn().mockResolvedValue(current) })).resolves.toEqual(current);
    await expect(classifyQueryIntent('Re-enrich linear-algebra', {
      phase: 'request', hasSelection: false, hasCurrentPage: true,
    }, { generate: vi.fn().mockResolvedValue(explicit) })).resolves.toEqual(explicit);
  });

  it('普通请求中不接受确认态结果，并把无选区配图收窄为 read', async () => {
    for (const output of [classification('reset-confirm'), classification('image-insert')]) {
      await expect(classifyQueryIntent('继续', {
        phase: 'request', hasSelection: false, hasCurrentPage: false,
      }, { generate: vi.fn().mockResolvedValue(output) }))
        .resolves.toEqual(classification('read'));
    }
  });

  it.each([
    ['reset-confirm', 'reset-confirm'],
    ['reset-cancel', 'reset-cancel'],
    ['reset-unclear', 'reset-unclear'],
  ] as const)('确认上下文保留 %s', async (modelIntent, expected) => {
    await expect(classifyQueryIntent('回复', {
      phase: 'reset-confirmation', hasSelection: false, hasCurrentPage: false,
    }, { generate: vi.fn().mockResolvedValue(classification(modelIntent)) }))
      .resolves.toEqual(classification(expected));
  });

  it('确认上下文中的非确认结果收窄为 reset-unclear', async () => {
    await expect(classifyQueryIntent('顺便解释一下页面', {
      phase: 'reset-confirmation', hasSelection: false, hasCurrentPage: false,
    }, { generate: vi.fn().mockResolvedValue(classification('propose')) }))
      .resolves.toEqual(classification('reset-unclear'));
  });

  it.each([
    [{ phase: 'request', hasSelection: false, hasCurrentPage: false } as const, classification('read')],
    [{ phase: 'reset-confirmation', hasSelection: false, hasCurrentPage: false } as const, classification('reset-unclear')],
  ])('分类失败按上下文保守回退：%j', async (context, fallback) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const generate = vi.fn().mockRejectedValue(new Error('provider unavailable'));

    await expect(classifyQueryIntent('任意输入', context, { generate }))
      .resolves.toEqual(fallback);
    expect(warn).toHaveBeenCalledWith(
      '[query-intent] structured classification failed; using conservative fallback',
      'provider unavailable',
    );
    warn.mockRestore();
  });
});

describe('queryModeForIntent', () => {
  it.each([
    ['read', 'read'],
    ['propose', 'propose'],
    ['direct-reenrich', 'propose'],
    ['image-insert', 'image-insert'],
    ['reset-request', 'read'],
  ] as const)('%s 映射为 %s', (intent, mode) => {
    expect(queryModeForIntent(classification(intent))).toBe(mode);
  });
});

describe('resolveDirectReenrichTarget', () => {
  it('把 current-page 引用解析为可信当前 slug', () => {
    expect(resolveDirectReenrichTarget(classification('direct-reenrich', {
      reference: 'current-page', slug: null,
    }), 'page-a')).toBe('page-a');
  });

  it('返回结构化显式 slug', () => {
    expect(resolveDirectReenrichTarget(classification('direct-reenrich', {
      reference: 'slug', slug: 'linear-algebra',
    }), 'page-a')).toBe('linear-algebra');
  });

  it.each([
    [classification('read'), 'page-a'],
    [classification('direct-reenrich', { reference: 'current-page', slug: null }), undefined],
    [classification('direct-reenrich', { reference: 'slug', slug: null }), 'page-a'],
    [classification('direct-reenrich', { reference: 'none', slug: null }), 'page-a'],
  ])('无有效直接目标时返回 null', (intent, currentPageSlug) => {
    expect(resolveDirectReenrichTarget(intent, currentPageSlug)).toBeNull();
  });
});
