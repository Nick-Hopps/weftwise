export interface MessageScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export interface MessageScrollFollowState {
  followsBottom: boolean;
  previousScrollTop: number;
}

export const MESSAGE_FOLLOW_THRESHOLD = 48;
export const MESSAGE_BOTTOM_EPSILON = 1;

/** 仅当读者仍贴近消息底部时，流式输出才应继续自动跟随。 */
export function isNearMessageListBottom(
  metrics: MessageScrollMetrics,
  threshold = MESSAGE_FOLLOW_THRESHOLD,
): boolean {
  const distance = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return distance <= threshold;
}

/**
 * 用户向上滚动时立即脱离自动跟随；脱离后必须真正回到底部才恢复。
 * `MESSAGE_BOTTOM_EPSILON` 仅用于吸收浏览器的亚像素舍入误差。
 */
export function updateMessageScrollFollowState(
  state: MessageScrollFollowState,
  metrics: MessageScrollMetrics,
): MessageScrollFollowState {
  const scrolledUp = metrics.scrollTop < state.previousScrollTop;
  const reachedBottom = isNearMessageListBottom(metrics, MESSAGE_BOTTOM_EPSILON);

  return {
    followsBottom: scrolledUp ? false : reachedBottom || state.followsBottom,
    previousScrollTop: metrics.scrollTop,
  };
}

/** 在浏览器应用默认滚动前识别向上滚轮意图，避免被下一次流式更新抢先拉回底部。 */
export function shouldPauseMessageFollowForWheel(deltaY: number): boolean {
  return deltaY < 0;
}

/** 手指向下移动时，触控滚动的内容方向向上。 */
export function didTouchGestureScrollUp(previousY: number, currentY: number): boolean {
  return currentY > previousY;
}
