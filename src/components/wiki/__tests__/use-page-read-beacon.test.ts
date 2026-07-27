import { describe, it, expect } from 'vitest';
import {
  advanceReadBeacon,
  initialReadBeaconState,
  markPageReadOnce,
  readBeaconKey,
  shouldFireReadBeacon,
  READ_DWELL_MS,
  READ_PROGRESS_THRESHOLD,
  type ReadBeaconState,
} from '../use-page-read-beacon';

/** 一次滚动/尺寸观测：内容不足一屏时 `scrollable:false`。 */
function observe(state: ReadBeaconState, scrollable: boolean, progress: number): ReadBeaconState {
  return advanceReadBeacon(state, { scrollable, progress });
}

function dwell(state: ReadBeaconState, ms = READ_DWELL_MS): ReadBeaconState {
  return advanceReadBeacon(state, { visibleMsDelta: ms });
}

describe('read beacon 状态机', () => {
  it('初始状态：没到底、不足一屏未知、零停留、不触发', () => {
    const s = initialReadBeaconState();
    expect(s).toEqual({ visibleMs: 0, scrolledToBottom: false, fitsInViewport: false });
    expect(shouldFireReadBeacon(s)).toBe(false);
  });

  it('两个条件都要满足（已定决策 3：读完 + 停留 ≥30s）', () => {
    const bottomOnly = observe(initialReadBeaconState(), true, 100);
    expect(shouldFireReadBeacon(bottomOnly)).toBe(false);

    const dwellOnly = dwell(initialReadBeaconState());
    expect(shouldFireReadBeacon(dwellOnly)).toBe(false);

    expect(shouldFireReadBeacon(dwell(bottomOnly))).toBe(true);
  });

  it('停留时间累加，恰好到阈值即可触发', () => {
    let s = observe(initialReadBeaconState(), true, 100);
    for (let i = 0; i < READ_DWELL_MS / 1000 - 1; i++) {
      s = dwell(s, 1000);
      expect(shouldFireReadBeacon(s)).toBe(false);
    }
    s = dwell(s, 1000);
    expect(s.visibleMs).toBe(READ_DWELL_MS);
    expect(shouldFireReadBeacon(s)).toBe(true);
  });

  it('到底判定留 2% 余量（浏览器 scrollHeight 舍入不总能到 100）', () => {
    expect(observe(initialReadBeaconState(), true, READ_PROGRESS_THRESHOLD).scrolledToBottom).toBe(true);
    expect(observe(initialReadBeaconState(), true, READ_PROGRESS_THRESHOLD - 0.1).scrolledToBottom).toBe(false);
  });

  it('不修改传入状态（纯函数）', () => {
    const s = initialReadBeaconState();
    advanceReadBeacon(s, { scrollable: true, progress: 100, visibleMsDelta: 5000 });
    expect(s).toEqual({ visibleMs: 0, scrolledToBottom: false, fitsInViewport: false });
  });
});

/**
 * 决策 3 的矩阵。`scrolledToBottom` 与 `fitsInViewport` 必须分开：
 * 前者是**已发生的事实**（滚到过底），粘性正确；后者是**当下的属性**（一眼看完），
 * 内容变长它就不再成立，必须每次重算。混成一个粘性变量会让首帧误判永久生效。
 */
describe('read beacon：滚到底 vs 不足一屏（决策 3）', () => {
  it('始终不足一屏 → 发出（真·短页确实读完了）', () => {
    const s = dwell(observe(initialReadBeaconState(), false, 100));
    expect(shouldFireReadBeacon(s)).toBe(true);
  });

  it('首帧不足一屏 → 内容变长变可滚动 → 用户没滚 → 不发', () => {
    // 本任务要修的那条：图片 / mermaid / KaTeX 尚未布局时进入页面，
    // calculateReadingProgress 对不可滚动容器返回 100，粘性标记「到底」。
    // 内容加载完页面变长，用户只看了开头，30 秒后照样发一条 page-read。
    let s = observe(initialReadBeaconState(), false, 100);
    s = observe(s, true, 5);
    s = dwell(s);
    expect(shouldFireReadBeacon(s)).toBe(false);
  });

  it('首帧不足一屏 → 变长 → 用户滚到底 → 发出', () => {
    let s = observe(initialReadBeaconState(), false, 100);
    s = observe(s, true, 5);
    s = observe(s, true, 100);
    expect(shouldFireReadBeacon(dwell(s))).toBe(true);
  });

  it('一直可滚动，滚到底后往回翻 → 仍发出（粘性保住）', () => {
    let s = observe(initialReadBeaconState(), true, 100);
    s = observe(s, true, 10);
    expect(s.scrolledToBottom).toBe(true);
    expect(shouldFireReadBeacon(dwell(s))).toBe(true);
  });

  it('一直可滚动，从没滚到底 → 不发', () => {
    let s = observe(initialReadBeaconState(), true, 0);
    s = observe(s, true, 40);
    expect(shouldFireReadBeacon(dwell(s))).toBe(false);
  });

  it('内容变长后 fitsInViewport 被撤销，scrolledToBottom 不被撤销', () => {
    const short = observe(initialReadBeaconState(), false, 100);
    expect(short).toMatchObject({ fitsInViewport: true, scrolledToBottom: false });

    const grown = observe(short, true, 5);
    expect(grown).toMatchObject({ fitsInViewport: false, scrolledToBottom: false });

    const readToEnd = observe(grown, true, 100);
    const shrunkAgain = observe(readToEnd, true, 0);
    expect(shrunkAgain.scrolledToBottom).toBe(true);
  });

  it('只累加停留、不带观测的 tick 不改变两个判定位', () => {
    const s = observe(initialReadBeaconState(), false, 100);
    expect(dwell(s, 1000)).toMatchObject({ fitsInViewport: true, scrolledToBottom: false });
  });
});

describe('会话内去重', () => {
  it('同一页只标记成功一次', () => {
    const key = readBeaconKey('ml', 'dedupe-a');
    expect(markPageReadOnce(key)).toBe(true);
    expect(markPageReadOnce(key)).toBe(false);
    expect(markPageReadOnce(key)).toBe(false);
  });

  it('不同页互不影响', () => {
    expect(markPageReadOnce(readBeaconKey('ml', 'dedupe-b'))).toBe(true);
    expect(markPageReadOnce(readBeaconKey('ml', 'dedupe-c'))).toBe(true);
  });

  it('同 slug 跨 subject 是两页', () => {
    // 复合 key 必须含 subject——跨 subject 同名 slug 在本项目是合法的。
    expect(markPageReadOnce(readBeaconKey('ml', 'shared-slug'))).toBe(true);
    expect(markPageReadOnce(readBeaconKey('math', 'shared-slug'))).toBe(true);
  });
});
