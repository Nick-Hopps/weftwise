export interface AskAiPoint {
  x: number;
  y: number;
}

export interface AskAiSize {
  width: number;
  height: number;
}

export interface AskAiRect {
  position: AskAiPoint;
  size: AskAiSize;
}

export const ASK_AI_SAFE_MARGIN = 16;
export const ASK_AI_MIN_SIZE: AskAiSize = { width: 360, height: 420 };
export const ASK_AI_SHEET_DISMISS_DISTANCE = 96;
export const ASK_AI_SHEET_DISMISS_VELOCITY = 0.75;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampAskAiPosition(
  position: AskAiPoint,
  panel: AskAiSize,
  viewport: AskAiSize,
  margin = ASK_AI_SAFE_MARGIN,
): AskAiPoint {
  const maxX = Math.max(margin, viewport.width - panel.width - margin);
  const maxY = Math.max(margin, viewport.height - panel.height - margin);
  return {
    x: Math.min(maxX, Math.max(margin, position.x)),
    y: Math.min(maxY, Math.max(margin, position.y)),
  };
}

/** 从右边/下边调整桌面面板尺寸，保持左上角不动并留出视口安全区。 */
export function resizeAskAiSize(
  size: AskAiSize,
  delta: AskAiSize,
  position: AskAiPoint,
  viewport: AskAiSize,
  margin = ASK_AI_SAFE_MARGIN,
): AskAiSize {
  const maxWidth = Math.max(0, viewport.width - position.x - margin);
  const maxHeight = Math.max(0, viewport.height - position.y - margin);
  const minWidth = Math.min(ASK_AI_MIN_SIZE.width, maxWidth);
  const minHeight = Math.min(ASK_AI_MIN_SIZE.height, maxHeight);
  return {
    width: clamp(size.width + delta.width, minWidth, maxWidth),
    height: clamp(size.height + delta.height, minHeight, maxHeight),
  };
}

/** 窗口变小时先收缩面板，再把完整矩形拉回视口安全区。 */
export function fitAskAiRectToViewport(
  rect: AskAiRect,
  viewport: AskAiSize,
  margin = ASK_AI_SAFE_MARGIN,
): AskAiRect {
  const availableWidth = Math.max(0, viewport.width - margin * 2);
  const availableHeight = Math.max(0, viewport.height - margin * 2);
  const size = {
    width: Math.min(rect.size.width, availableWidth),
    height: Math.min(rect.size.height, availableHeight),
  };
  return {
    position: clampAskAiPosition(rect.position, size, viewport, margin),
    size,
  };
}

/** 桌面空白处双击：触发点就是候选左上角，仅在越界时收回安全区。 */
export function positionAskAiAtTrigger(
  trigger: AskAiPoint,
  panel: AskAiSize,
  viewport: AskAiSize,
  margin = ASK_AI_SAFE_MARGIN,
): AskAiPoint {
  return clampAskAiPosition(trigger, panel, viewport, margin);
}

/** 无锚点且没有历史位置时，按面板实际尺寸在安全区内居中。 */
export function centerAskAiPosition(
  panel: AskAiSize,
  viewport: AskAiSize,
  margin = ASK_AI_SAFE_MARGIN,
): AskAiPoint {
  return clampAskAiPosition(
    {
      x: (viewport.width - panel.width) / 2,
      y: (viewport.height - panel.height) / 2,
    },
    panel,
    viewport,
    margin,
  );
}

export function positionAskAiFromAnchor(
  anchor: AskAiPoint,
  panel: AskAiSize,
  viewport: AskAiSize,
  margin = ASK_AI_SAFE_MARGIN,
): AskAiPoint {
  const preferred = { x: anchor.x + margin, y: anchor.y + margin };
  const overflowsRight = preferred.x + panel.width > viewport.width - margin;
  const overflowsBottom = preferred.y + panel.height > viewport.height - margin;
  const candidate = {
    x: overflowsRight ? anchor.x - panel.width - margin : preferred.x,
    y: overflowsBottom ? anchor.y - panel.height - margin : preferred.y,
  };
  return clampAskAiPosition(candidate, panel, viewport, margin);
}

export function shouldDismissAskAiSheet(distance: number, velocity: number): boolean {
  return distance >= ASK_AI_SHEET_DISMISS_DISTANCE || velocity >= ASK_AI_SHEET_DISMISS_VELOCITY;
}
