import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AugmentationLevelSchema } from '@/lib/contracts';

// 镜像路由内的 PatchSubjectSchema（含 augmentationLevel），验证契约。
const PatchSubjectSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  augmentationLevel: AugmentationLevelSchema.optional(),
});

describe('PatchSubjectSchema augmentationLevel', () => {
  it('接受合法 level', () => {
    expect(PatchSubjectSchema.safeParse({ augmentationLevel: 'deep' }).success).toBe(true);
  });
  it('拒绝非法 level', () => {
    expect(PatchSubjectSchema.safeParse({ augmentationLevel: 'turbo' }).success).toBe(false);
  });
  it('允许只改 augmentationLevel（name/description 可缺省）', () => {
    const r = PatchSubjectSchema.safeParse({ augmentationLevel: 'off' });
    expect(r.success && r.data.augmentationLevel).toBe('off');
  });
});
