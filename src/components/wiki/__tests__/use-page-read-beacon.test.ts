import { describe, it, expect } from 'vitest';
import {
  advanceReadBeacon,
  initialReadBeaconState,
  markPageReadOnce,
  readBeaconKey,
  shouldFireReadBeacon,
  READ_DWELL_MS,
  READ_PROGRESS_THRESHOLD,
} from '../use-page-read-beacon';

describe('read beacon 状态机', () => {
  it('初始状态：没到底、零停留、不触发', () => {
    const s = initialReadBeaconState();
    expect(s).toEqual({ visibleMs: 0, reachedBottom: false });
    expect(shouldFireReadBeacon(s)).toBe(false);
  });

  it('两个条件都要满足（已定决策 3：滚动到底 + 停留 ≥30s）', () => {
    // 只到底不够——扫一眼拉到底不算读过
    const bottomOnly = advanceReadBeacon(initialReadBeaconState(), { progress: 100 });
    expect(shouldFireReadBeacon(bottomOnly)).toBe(false);

    // 只停留也不够——开着不看同样不算
    const dwellOnly = advanceReadBeacon(initialReadBeaconState(), { visibleMsDelta: READ_DWELL_MS });
    expect(shouldFireReadBeacon(dwellOnly)).toBe(false);

    const both = advanceReadBeacon(bottomOnly, { visibleMsDelta: READ_DWELL_MS });
    expect(shouldFireReadBeacon(both)).toBe(true);
  });

  it('停留时间累加，恰好到阈值即可触发', () => {
    let s = advanceReadBeacon(initialReadBeaconState(), { progress: 100 });
    for (let i = 0; i < READ_DWELL_MS / 1000 - 1; i++) {
      s = advanceReadBeacon(s, { visibleMsDelta: 1000 });
      expect(shouldFireReadBeacon(s)).toBe(false);
    }
    s = advanceReadBeacon(s, { visibleMsDelta: 1000 });
    expect(s.visibleMs).toBe(READ_DWELL_MS);
    expect(shouldFireReadBeacon(s)).toBe(true);
  });

  it('到底判定留 2% 余量（浏览器 scrollHeight 舍入不总能到 100）', () => {
    expect(advanceReadBeacon(initialReadBeaconState(), { progress: READ_PROGRESS_THRESHOLD }).reachedBottom).toBe(true);
    expect(advanceReadBeacon(initialReadBeaconState(), { progress: READ_PROGRESS_THRESHOLD - 0.1 }).reachedBottom).toBe(false);
  });

  it('到过底就算数：读完往回翻不撤销', () => {
    const atBottom = advanceReadBeacon(initialReadBeaconState(), { progress: 100 });
    const scrolledBack = advanceReadBeacon(atBottom, { progress: 10 });
    expect(scrolledBack.reachedBottom).toBe(true);
  });

  it('不修改传入状态（纯函数）', () => {
    const s = initialReadBeaconState();
    advanceReadBeacon(s, { progress: 100, visibleMsDelta: 5000 });
    expect(s).toEqual({ visibleMs: 0, reachedBottom: false });
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
