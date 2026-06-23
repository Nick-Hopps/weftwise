import { describe, it, expect } from 'vitest';
import { z } from 'zod';

const BodySchema = z.object({ slug: z.string().trim().min(1) });

describe('re-enrich body schema', () => {
  it('接受非空 slug', () => {
    expect(BodySchema.safeParse({ slug: 'eigenvalues' }).success).toBe(true);
  });
  it('拒绝空 slug', () => {
    expect(BodySchema.safeParse({ slug: '' }).success).toBe(false);
  });
});
