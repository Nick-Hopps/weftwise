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
});
