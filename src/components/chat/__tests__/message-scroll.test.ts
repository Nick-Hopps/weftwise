import { describe, expect, it } from 'vitest';
import {
  didTouchGestureScrollUp,
  isNearMessageListBottom,
  shouldPauseMessageFollowForWheel,
  updateMessageScrollFollowState,
} from '@/components/chat/message-scroll';

describe('isNearMessageListBottom', () => {
  it('treats positions inside the follow threshold as attached to the bottom', () => {
    expect(isNearMessageListBottom({
      scrollTop: 552,
      clientHeight: 400,
      scrollHeight: 1000,
    })).toBe(true);
  });

  it('stops following after the user scrolls beyond the threshold', () => {
    expect(isNearMessageListBottom({
      scrollTop: 500,
      clientHeight: 400,
      scrollHeight: 1000,
    })).toBe(false);
  });

  it('allows callers to choose a stricter threshold', () => {
    expect(isNearMessageListBottom({
      scrollTop: 580,
      clientHeight: 400,
      scrollHeight: 1000,
    }, 16)).toBe(false);
  });
});

describe('updateMessageScrollFollowState', () => {
  it('stops following as soon as the user scrolls upward, even inside the bottom threshold', () => {
    expect(updateMessageScrollFollowState({
      followsBottom: true,
      previousScrollTop: 600,
    }, {
      scrollTop: 599,
      clientHeight: 400,
      scrollHeight: 1000,
    })).toEqual({
      followsBottom: false,
      previousScrollTop: 599,
    });
  });

  it('stays paused while the user scrolls downward but has not reached the bottom', () => {
    expect(updateMessageScrollFollowState({
      followsBottom: false,
      previousScrollTop: 500,
    }, {
      scrollTop: 580,
      clientHeight: 400,
      scrollHeight: 1000,
    })).toEqual({
      followsBottom: false,
      previousScrollTop: 580,
    });
  });

  it('resumes following only after the user returns to the bottom', () => {
    expect(updateMessageScrollFollowState({
      followsBottom: false,
      previousScrollTop: 580,
    }, {
      scrollTop: 600,
      clientHeight: 400,
      scrollHeight: 1000,
    })).toEqual({
      followsBottom: true,
      previousScrollTop: 600,
    });
  });
});

describe('shouldPauseMessageFollowForWheel', () => {
  it('pauses immediately for an upward wheel gesture', () => {
    expect(shouldPauseMessageFollowForWheel(-1)).toBe(true);
  });

  it('does not pause for downward or stationary wheel input', () => {
    expect(shouldPauseMessageFollowForWheel(1)).toBe(false);
    expect(shouldPauseMessageFollowForWheel(0)).toBe(false);
  });
});

describe('didTouchGestureScrollUp', () => {
  it('detects a downward finger movement that scrolls content upward', () => {
    expect(didTouchGestureScrollUp(120, 140)).toBe(true);
  });

  it('ignores upward or stationary finger movement', () => {
    expect(didTouchGestureScrollUp(140, 120)).toBe(false);
    expect(didTouchGestureScrollUp(120, 120)).toBe(false);
  });
});
