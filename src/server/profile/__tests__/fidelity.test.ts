import { describe, it, expect } from 'vitest';
import { checkLinkSubset } from '../fidelity';

describe('checkLinkSubset', () => {
  const canon = '见 [[Alpha]] 和 [[Beta|别名]]，以及 [[other:Gamma]]。';

  it('重塑省略部分链接 → ok', () => {
    expect(checkLinkSubset(canon, '只保留 [[Alpha]]。').ok).toBe(true);
  });
  it('重塑保留全部链接 → ok', () => {
    expect(checkLinkSubset(canon, '[[Alpha]] [[Beta]] [[other:Gamma]]').ok).toBe(true);
  });
  it('重塑新增不存在的链接 → 不 ok 且报告 offending', () => {
    const r = checkLinkSubset(canon, '[[Alpha]] 还有 [[Delta]]');
    expect(r.ok).toBe(false);
    expect(r.offending.join()).toContain('Delta');
  });
  it('无链接正文 → ok', () => {
    expect(checkLinkSubset('纯文本', '依然纯文本').ok).toBe(true);
  });
});
