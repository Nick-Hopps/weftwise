import { describe, expect, it, vi } from 'vitest';
import { wikiImageInsertTool } from '../wiki-image-insert';

describe('wiki.image.insert', () => {
  it('只委托运行时绑定的选区提案能力并通知 UI', async () => {
    const action = { actionId: 'image-action' };
    const previewImageInsert = vi.fn().mockResolvedValue(action);
    const onPendingAction = vi.fn();
    const input = {
      prompt: '展示数据从输入到输出的转换过程',
      alt: '输入经过三步转换得到输出',
      aspectRatio: '4:3' as const,
    };

    const result = await wikiImageInsertTool.handler(input, {
      previewImageInsert,
      onPendingAction,
    } as never);

    expect(result).toBe(action);
    expect(previewImageInsert).toHaveBeenCalledWith(input);
    expect(onPendingAction).toHaveBeenCalledWith(action);
    expect(wikiImageInsertTool.sideEffect).toBe('propose');
  });

  it('模型输入 strict 拒绝 page slug 和选区位置', () => {
    expect(wikiImageInsertTool.inputSchema.safeParse({
      prompt: '画图',
      alt: '图',
      slug: 'secret-page',
      blockStart: 0,
    }).success).toBe(false);
  });
});
