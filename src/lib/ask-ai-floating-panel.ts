export interface AskAiPoint {
  x: number;
  y: number;
}

export interface AskAiSize {
  width: number;
  height: number;
}

export const ASK_AI_SAFE_MARGIN = 16;
export const ASK_AI_SHEET_DISMISS_DISTANCE = 96;
export const ASK_AI_SHEET_DISMISS_VELOCITY = 0.75;

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
