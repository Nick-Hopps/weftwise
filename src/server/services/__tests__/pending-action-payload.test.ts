import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  hashPendingActionPayload,
  normalizePreviewInput,
} from '../pending-action-payload';

describe('pending-action payload', () => {
  it('对象 key 顺序不影响 canonical JSON 与 hash', () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } }))
      .toBe('{"a":{"c":3,"d":4},"b":2}');

    const left = hashPendingActionPayload({
      conversationId: 'c1',
      subjectId: 's1',
      operation: 'delete',
      payload: { slug: 'a' },
    });
    const right = hashPendingActionPayload({
      subjectId: 's1',
      conversationId: 'c1',
      payload: { slug: 'a' },
      operation: 'delete',
    });

    expect(left).toBe(right);
  });

  it('规范化输入写入服务端 effectiveAt 并裁剪字符串', () => {
    expect(normalizePreviewInput(
      { operation: 'delete', payload: { slug: '  page-a  ' } },
      '2026-07-11T00:00:00.000Z',
    )).toEqual({
      operation: 'delete',
      payload: {
        slug: 'page-a',
        effectiveAt: '2026-07-11T00:00:00.000Z',
      },
    });
  });

  it('规范化 create/update/patch/reenrich 的字段', () => {
    expect(normalizePreviewInput({
      operation: 'create',
      payload: { title: '  标题  ', body: '正文', tags: [' one ', 'two'] },
    }, '2026-07-11T00:00:00.000Z')).toMatchObject({
      operation: 'create',
      payload: { title: '标题', body: '正文', tags: ['one', 'two'] },
    });

    expect(normalizePreviewInput({
      operation: 'update',
      payload: { slug: ' a ', title: ' 新标题 ', body: '新正文' },
    }, '2026-07-11T00:00:00.000Z')).toMatchObject({
      operation: 'update',
      payload: { slug: 'a', title: '新标题', body: '新正文' },
    });

    expect(normalizePreviewInput({
      operation: 'patch',
      payload: { slug: ' a ', edits: [{ oldString: 'old', newString: 'new' }] },
    }, '2026-07-11T00:00:00.000Z')).toMatchObject({
      operation: 'patch',
      payload: { slug: 'a', edits: [{ oldString: 'old', newString: 'new' }] },
    });

    expect(normalizePreviewInput({
      operation: 'reenrich', payload: { slug: ' a ' },
    }, '2026-07-11T00:00:00.000Z')).toMatchObject({
      operation: 'reenrich', payload: { slug: 'a' },
    });
  });

  it('拒绝 undefined 与非有限数字', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(/unsupported/i);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/finite/i);
  });

  it('规范化 metadata-patch 四类字段并写入 effectiveAt', () => {
    expect(normalizePreviewInput({
      operation: 'metadata-patch',
      payload: {
        slug: ' page-a ',
        title: ' 新标题 ',
        summary: ' 新摘要 ',
        tags: [' one ', 'two'],
        aliases: [' Alias A ', 'Alias B'],
      },
    } as never, '2026-07-13T00:00:00.000Z')).toEqual({
      operation: 'metadata-patch',
      payload: {
        slug: 'page-a',
        title: '新标题',
        summary: '新摘要',
        tags: ['one', 'two'],
        aliases: ['Alias A', 'Alias B'],
        effectiveAt: '2026-07-13T00:00:00.000Z',
      },
    });
  });

  it('metadata 列表沿用窄写内核的 identity 去重与数量上限', () => {
    expect(normalizePreviewInput({
      operation: 'metadata-patch',
      payload: {
        slug: 'page-a',
        tags: [' One ', 'one', ''],
        aliases: ['Foo Bar', 'foo-bar'],
      },
    }, '2026-07-13T00:00:00.000Z')).toMatchObject({
      payload: { tags: ['One'], aliases: ['Foo Bar'] },
    });

    expect(() => normalizePreviewInput({
      operation: 'metadata-patch',
      payload: {
        slug: 'page-a',
        tags: Array.from({ length: 33 }, (_, index) => `tag-${index}`),
      },
    }, '2026-07-13T00:00:00.000Z')).toThrow(/32/);
  });

  it('规范化 link-ensure 标识字段，逐字保留 oldString/displayText', () => {
    expect(normalizePreviewInput({
      operation: 'link-ensure',
      payload: {
        sourceSlug: ' source ',
        targetSubjectSlug: ' other-subject ',
        targetSlug: ' target ',
        oldString: '  唯一锚点  ',
        displayText: '  展示文本  ',
        mode: 'retarget',
      },
    } as never, '2026-07-13T00:00:00.000Z')).toEqual({
      operation: 'link-ensure',
      payload: {
        sourceSlug: 'source',
        targetSubjectSlug: 'other-subject',
        targetSlug: 'target',
        oldString: '  唯一锚点  ',
        displayText: '  展示文本  ',
        mode: 'retarget',
        effectiveAt: '2026-07-13T00:00:00.000Z',
      },
    });
  });

  it('新 operation 两层 strict，metadata 空提交与非法 link mode 均拒绝', () => {
    const timestamp = '2026-07-13T00:00:00.000Z';
    expect(() => normalizePreviewInput({
      operation: 'metadata-patch', payload: { slug: 'a', body: '禁止字段' },
    } as never, timestamp)).toThrow();
    expect(() => normalizePreviewInput({
      operation: 'metadata-patch', payload: { slug: 'a' }, extra: true,
    } as never, timestamp)).toThrow();
    expect(() => normalizePreviewInput({
      operation: 'link-ensure',
      payload: { sourceSlug: 'a', targetSlug: 'b', oldString: 'B', mode: 'invalid' },
    } as never, timestamp)).toThrow();
    expect(() => normalizePreviewInput({
      operation: 'link-ensure',
      payload: {
        sourceSlug: 'a', targetSlug: 'b', oldString: 'B', mode: 'link', unknown: true,
      },
    } as never, timestamp)).toThrow();
  });

  it('新 operation 规范化后 canonical hash 稳定且 operation 参与 hash', () => {
    const effectiveAt = '2026-07-13T00:00:00.000Z';
    const normalized = normalizePreviewInput({
      operation: 'metadata-patch', payload: { slug: ' a ', tags: [' x '] },
    } as never, effectiveAt);
    const left = hashPendingActionPayload({
      conversationId: 'c1', subjectId: 's1',
      operation: normalized.operation, payload: normalized.payload,
    });
    const right = hashPendingActionPayload({
      subjectId: 's1', conversationId: 'c1', payload: normalized.payload,
      operation: normalized.operation,
    });
    expect(left).toBe(right);
    expect(left).not.toBe(hashPendingActionPayload({
      conversationId: 'c1', subjectId: 's1',
      operation: 'link-ensure', payload: normalized.payload,
    }));
  });
});
