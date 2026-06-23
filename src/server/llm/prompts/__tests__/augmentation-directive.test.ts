import { describe, it, expect } from 'vitest';
import { renderAugmentationDirective } from '../prompt-context';

describe('renderAugmentationDirective', () => {
  it('每档都含 AUGMENTATION LEVEL 块且文案不同', () => {
    const light = renderAugmentationDirective('light');
    const standard = renderAugmentationDirective('standard');
    const deep = renderAugmentationDirective('deep');
    for (const d of [light, standard, deep]) {
      expect(d).toContain('=== AUGMENTATION LEVEL ===');
    }
    expect(light).not.toBe(standard);
    expect(standard).not.toBe(deep);
  });
  it('light 强调稀疏，deep 强调充分', () => {
    expect(renderAugmentationDirective('light').toLowerCase()).toContain('spars');
    expect(renderAugmentationDirective('deep').toLowerCase()).toContain('generous');
  });
});
