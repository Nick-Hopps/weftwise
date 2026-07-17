import { describe, expect, it } from 'vitest';
import {
  ASK_AI_MIN_SIZE,
  centerAskAiPosition,
  clampAskAiPosition,
  fitAskAiRectToViewport,
  positionAskAiAtTrigger,
  positionAskAiFromAnchor,
  resizeAskAiSize,
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

describe('positionAskAiAtTrigger', () => {
  it('uses the double-click point as the panel top-left when it fits', () => {
    expect(positionAskAiAtTrigger(
      { x: 300, y: 200 },
      { width: 440, height: 500 },
      { width: 1200, height: 900 },
    )).toEqual({ x: 300, y: 200 });
  });

  it('keeps the panel operable when the trigger is near a viewport edge', () => {
    expect(positionAskAiAtTrigger(
      { x: 1180, y: 880 },
      { width: 440, height: 500 },
      { width: 1200, height: 900 },
    )).toEqual({ x: 744, y: 384 });
  });
});

describe('centerAskAiPosition', () => {
  it('centers a panel when no previous position exists', () => {
    expect(centerAskAiPosition(
      { width: 440, height: 500 },
      { width: 1200, height: 900 },
    )).toEqual({ x: 380, y: 200 });
  });

  it('pins an oversized panel to the safe origin', () => {
    expect(centerAskAiPosition(
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

describe('resizeAskAiSize', () => {
  it('resizes width and height independently', () => {
    expect(resizeAskAiSize(
      { width: 440, height: 600 },
      { width: 120, height: 80 },
      { x: 120, y: 100 },
      { width: 1200, height: 900 },
    )).toEqual({ width: 560, height: 680 });
  });

  it('keeps both dimensions above the usable minimum', () => {
    expect(resizeAskAiSize(
      { width: 440, height: 600 },
      { width: -1000, height: -1000 },
      { x: 120, y: 100 },
      { width: 1200, height: 900 },
    )).toEqual(ASK_AI_MIN_SIZE);
  });

  it('stops expansion at the viewport safe margin', () => {
    expect(resizeAskAiSize(
      { width: 440, height: 600 },
      { width: 1000, height: 1000 },
      { x: 150, y: 120 },
      { width: 1200, height: 900 },
    )).toEqual({ width: 1034, height: 764 });
  });

  it('does not restore the normal minimum when a short viewport cannot fit it', () => {
    expect(resizeAskAiSize(
      { width: 440, height: 368 },
      { width: 0, height: 100 },
      { x: 16, y: 16 },
      { width: 1024, height: 400 },
    )).toEqual({ width: 440, height: 368 });
  });
});

describe('fitAskAiRectToViewport', () => {
  it('shrinks an oversized panel before clamping its position', () => {
    expect(fitAskAiRectToViewport(
      { position: { x: 200, y: 120 }, size: { width: 1200, height: 900 } },
      { width: 1000, height: 800 },
    )).toEqual({
      position: { x: 16, y: 16 },
      size: { width: 968, height: 768 },
    });
  });

  it('preserves a valid size while pulling the panel back into view', () => {
    expect(fitAskAiRectToViewport(
      { position: { x: 700, y: 500 }, size: { width: 600, height: 600 } },
      { width: 1000, height: 800 },
    )).toEqual({
      position: { x: 384, y: 184 },
      size: { width: 600, height: 600 },
    });
  });
});
