import { describe, expect, it } from 'vitest';
import { computeNextVersion } from '../compute-next-version';

describe('computeNextVersion — beta 阶段（major = 0）', () => {
  it('feat 自增 minor 且 patch 归零', () => {
    expect(computeNextVersion('0.1.0', 'feat: 新增页面证据工具')).toBe('0.2.0');
    expect(computeNextVersion('0.1.3', 'feat: 新增页面证据工具')).toBe('0.2.0');
  });

  it('fix 自增 patch', () => {
    expect(computeNextVersion('0.2.0', 'fix: 修复任务终态竞态')).toBe('0.2.1');
    expect(computeNextVersion('0.2.1', 'fix: 修复任务终态竞态')).toBe('0.2.2');
  });

  it('破坏性变更在 beta 阶段仍只自增 minor，不动 major', () => {
    expect(computeNextVersion('0.3.2', 'feat!: 重构存储格式')).toBe('0.4.0');
    expect(
      computeNextVersion('0.3.2', 'feat: 重构存储格式\n\nBREAKING CHANGE: vault 目录结构变更'),
    ).toBe('0.4.0');
  });

  it('识别带 scope 的前缀', () => {
    expect(computeNextVersion('0.1.0', 'feat(search): 支持混合检索')).toBe('0.2.0');
    expect(computeNextVersion('0.1.0', 'fix(worker): 修复租约过期')).toBe('0.1.1');
  });
});

describe('computeNextVersion — 稳定阶段（major ≥ 1）', () => {
  it('破坏性变更自增 major', () => {
    expect(computeNextVersion('1.2.3', 'feat!: 移除旧接口')).toBe('2.0.0');
    expect(
      computeNextVersion('1.2.3', 'fix: 调整默认值\n\nBREAKING CHANGE: 默认行为变更'),
    ).toBe('2.0.0');
  });

  it('feat 自增 minor，fix 自增 patch', () => {
    expect(computeNextVersion('1.2.3', 'feat: 新增导出')).toBe('1.3.0');
    expect(computeNextVersion('1.2.3', 'fix: 修复导出')).toBe('1.2.4');
  });
});

describe('computeNextVersion — 不触发自增', () => {
  it('其他提交类型返回 null', () => {
    expect(computeNextVersion('0.1.0', 'docs: 同步架构文档')).toBeNull();
    expect(computeNextVersion('0.1.0', 'merge: 合并 feat/xxx：某特性')).toBeNull();
    expect(computeNextVersion('0.1.0', 'revert: 撤销某合并')).toBeNull();
    expect(computeNextVersion('0.1.0', 'chore: 更新依赖')).toBeNull();
  });

  it('无 Conventional Commit 前缀返回 null', () => {
    expect(computeNextVersion('0.1.0', '随手改点东西')).toBeNull();
    expect(computeNextVersion('0.1.0', 'feature: 不是合法前缀')).toBeNull();
    expect(computeNextVersion('0.1.0', 'feat 缺冒号')).toBeNull();
  });

  it('当前版本不是纯 x.y.z 时防御性返回 null', () => {
    expect(computeNextVersion('0.1.0-beta.1', 'feat: 新增导出')).toBeNull();
    expect(computeNextVersion('', 'feat: 新增导出')).toBeNull();
    expect(computeNextVersion('1.2', 'feat: 新增导出')).toBeNull();
  });
});
