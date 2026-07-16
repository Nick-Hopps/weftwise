import { describe, expect, it } from 'vitest';
import {
  clampAskAiPosition,
  positionAskAiFromAnchor,
  shouldDismissAskAiSheet,
} from '@/lib/ask-ai-floating-panel';

describe('clampAskAiPosition', () => {
  it('keeps the panel inside the viewport safe area', () => {
    expect(clampAskAiPosition(
      { x: 900, y: -20 },
      { width: 440, height: 600 },
      { width: 1200, height: 800 },
    )).toEqual({ x: 744, y: 16 });
  });

  it('pins an oversized panel to the safe origin', () => {
    expect(clampAskAiPosition(
      { x: 40, y: 40 },
      { width: 700, height: 900 },
      { width: 600, height: 700 },
    )).toEqual({ x: 16, y: 16 });
  });
});

describe('positionAskAiFromAnchor', () => {
  it('opens after and below an anchor when space is available', () => {
    expect(positionAskAiFromAnchor(
      { x: 300, y: 200 },
      { width: 440, height: 500 },
      { width: 1200, height: 900 },
    )).toEqual({ x: 316, y: 216 });
  });

  it('flips before and above an anchor near the viewport edge', () => {
    expect(positionAskAiFromAnchor(
      { x: 1180, y: 880 },
      { width: 440, height: 500 },
      { width: 1200, height: 900 },
    )).toEqual({ x: 724, y: 364 });
  });
});

describe('shouldDismissAskAiSheet', () => {
  it('dismisses after crossing the distance threshold', () => {
    expect(shouldDismissAskAiSheet(96, 0.1)).toBe(true);
  });

  it('dismisses a short but fast downward swipe', () => {
    expect(shouldDismissAskAiSheet(40, 0.85)).toBe(true);
  });

  it('returns a short slow drag to the open state', () => {
    expect(shouldDismissAskAiSheet(70, 0.2)).toBe(false);
  });
});
