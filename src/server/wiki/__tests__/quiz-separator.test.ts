import { describe, it, expect } from 'vitest';
import { findQuizSeparatorViolations, repairQuizSeparator } from '../quiz-separator';

const FM = `---\ntitle: 蒙古帝国\nsummary: 草原帝国的兴衰\ntags: [历史]\n---\n`;

/** 守约形态：`---` 前后各有一个空 `>` 行 */
const OK_QUIZ = [
  '> [!quiz] ❓ 自测',
  '> 为什么窝阔台之死会中止蒙古对欧洲的入侵？',
  '>',
  '> ---',
  '>',
  '> 因为新任大汗须由忽里勒台大会选出，前线统帅必须返回本土参与推选。',
].join('\n');

describe('findQuizSeparatorViolations — 不误判', () => {
  it('守约形态零违规', () => {
    expect(findQuizSeparatorViolations(`${FM}\n${OK_QUIZ}\n`)).toEqual([]);
  });

  it('只有问题、没有答案的存量形态零违规（205 处既有设计，不是 bug）', () => {
    const md = '> [!quiz] ❓ 自测\n> 为什么反向传播要保存中间激活值？\n';
    expect(findQuizSeparatorViolations(md)).toEqual([]);
  });

  it('问题 + 提示两段但无答案标签 → 不判违规（防「子节点数>2」这类易误判启发式）', () => {
    const md = [
      '> [!quiz] ❓ 自测',
      '> 为什么反向传播要保存中间激活值？',
      '>',
      '> 提示：想想链式法则要用到什么。',
    ].join('\n');
    expect(findQuizSeparatorViolations(md)).toEqual([]);
  });

  it('非 quiz callout 内的 `---` 不受影响', () => {
    const md = '> [!pitfall] ⚠ 常见误区\n> 前半段\n>\n> ---\n>\n> 后半段\n';
    expect(findQuizSeparatorViolations(md)).toEqual([]);
  });

  it('正文（非 callout）里的 `---` 与「答：」不受影响', () => {
    const md = '## 小节\n\n答：这是正文里的一句话。\n\n---\n\n下一段。\n';
    expect(findQuizSeparatorViolations(md)).toEqual([]);
  });
});

describe('findQuizSeparatorViolations — missing-separator（有答案标签、无分隔符）', () => {
  const cases: Array<[string, string]> = [
    ['答：', '> 答：因为新任大汗须由忽里勒台大会选出。'],
    ['答:', '> 答: 因为新任大汗须由忽里勒台大会选出。'],
    ['答案：', '> 答案：因为新任大汗须由忽里勒台大会选出。'],
    ['参考答案：', '> 参考答案：因为新任大汗须由忽里勒台大会选出。'],
    ['A:', '> A: Because the new khan must be elected by the kurultai.'],
    ['Answer:', '> Answer: Because the new khan must be elected by the kurultai.'],
    ['**答：**（强调包裹）', '> **答：** 因为新任大汗须由忽里勒台大会选出。'],
  ];

  for (const [label, answerLine] of cases) {
    it(`识别标签 ${label}`, () => {
      const md = ['> [!quiz] 检验理解', '> 问：为什么会中止入侵？', answerLine].join('\n');
      const found = findQuizSeparatorViolations(md);
      expect(found).toHaveLength(1);
      expect(found[0].reason).toBe('missing-separator');
      expect(found[0].line).toBe(1);
      expect(found[0].head).toContain('检验理解');
    });
  }

  it('答案写成列表项（`> - 答案：`）同样识别', () => {
    const md = [
      '> [!quiz] ❓ 自测',
      '> 如果预计工时 3 天但实际平均 5 天，管理者该做什么？',
      '> - 答案：把偏差反馈到排期估算环节，用真实数据校准未来同类任务。',
    ].join('\n');
    const found = findQuizSeparatorViolations(md);
    expect(found.map((v) => v.reason)).toEqual(['missing-separator']);
  });

  it('选择题：分隔符锚定到无歧义的「答案：」，不切在选项 `- A:` 上', () => {
    const md = [
      '> [!quiz] ❓ 自测',
      '> 下面哪个是子空间？',
      '> - A: $\\{(x,y) : x + y = 1\\}$',
      '> - B: $\\{(x,y) : x + y = 0\\}$',
      '>',
      '> 答案：B —— A 不含零元。',
    ].join('\n');
    const out = repairQuizSeparator(md);
    expect(out.content).toBe([
      '> [!quiz] ❓ 自测',
      '> 下面哪个是子空间？',
      '> - A: $\\{(x,y) : x + y = 1\\}$',
      '> - B: $\\{(x,y) : x + y = 0\\}$',
      '>',
      '> ---',
      '>',
      '> 答案：B —— A 不含零元。',
    ].join('\n'));
    expect(findQuizSeparatorViolations(out.content)).toEqual([]);
  });

  it('答案是独立段落（分段形态）同样识别', () => {
    const md = ['> [!quiz] ❓ 自测', '> 问：为什么？', '>', '> 答：因为忽里勒台。'].join('\n');
    expect(findQuizSeparatorViolations(md).map((v) => v.reason)).toEqual(['missing-separator']);
  });

  it('三段形态（问题 + 提示 + 答案）同样识别', () => {
    const md = [
      '> [!quiz] ❓ 自测',
      '> 问：为什么？',
      '>',
      '> 提示：想想政治传统。',
      '>',
      '> 答：因为忽里勒台。',
    ].join('\n');
    expect(findQuizSeparatorViolations(md).map((v) => v.reason)).toEqual(['missing-separator']);
  });
});

describe('findQuizSeparatorViolations — setext-separator（写了 --- 但缺空行）', () => {
  it('`---` 紧跟问题行被解析成 setext 标题 → 判违规', () => {
    const md = ['> [!quiz] ❓ 自测', '> 问：为什么？', '> ---', '> 答：因为忽里勒台。'].join('\n');
    const found = findQuizSeparatorViolations(md);
    expect(found).toHaveLength(1);
    expect(found[0].reason).toBe('setext-separator');
  });

  it('setext 优先于 missing-separator 判定（同时具备两个特征时归因到根因）', () => {
    const md = ['> [!quiz] 自测', '> 问：为什么？', '> ---', '> 答：因为忽里勒台。'].join('\n');
    expect(findQuizSeparatorViolations(md)[0].reason).toBe('setext-separator');
  });
});

describe('findQuizSeparatorViolations — 多块混合', () => {
  it('一页多个 quiz：只报受损的，行号指向各自 blockquote 起始行', () => {
    const md = [
      FM,
      '## 一',
      '',
      OK_QUIZ,
      '',
      '## 二',
      '',
      '> [!quiz] 检验理解',
      '> 问：为什么？',
      '> 答：因为忽里勒台。',
      '',
    ].join('\n');
    const found = findQuizSeparatorViolations(md);
    expect(found).toHaveLength(1);
    expect(found[0].head).toContain('检验理解');
    expect(md.split('\n')[found[0].line - 1]).toBe('> [!quiz] 检验理解');
  });
});

describe('repairQuizSeparator — 不改动无需修复的内容', () => {
  it('守约形态逐字节不变', () => {
    const md = `${FM}\n${OK_QUIZ}\n`;
    const out = repairQuizSeparator(md);
    expect(out.content).toBe(md);
    expect(out.repaired).toEqual([]);
  });

  it('纯问题形态逐字节不变', () => {
    const md = '> [!quiz] ❓ 自测\n> 为什么反向传播要保存中间激活值？\n';
    expect(repairQuizSeparator(md).content).toBe(md);
  });
});

describe('repairQuizSeparator — missing-separator', () => {
  it('答案与问题同段（软换行）：拆段并插入分隔符', () => {
    const md = ['> [!quiz] 检验理解', '> 问：为什么？', '> 答：因为忽里勒台。', ''].join('\n');
    const out = repairQuizSeparator(md);
    expect(out.repaired).toHaveLength(1);
    expect(out.content).toBe(
      ['> [!quiz] 检验理解', '> 问：为什么？', '>', '> ---', '>', '> 答：因为忽里勒台。', ''].join('\n'),
    );
    expect(findQuizSeparatorViolations(out.content)).toEqual([]);
  });

  it('答案已是独立段落：只插入分隔符，不产生连续空 `>` 行', () => {
    const md = ['> [!quiz] ❓ 自测', '> 问：为什么？', '>', '> 答：因为忽里勒台。', ''].join('\n');
    const out = repairQuizSeparator(md);
    expect(out.content).toBe(
      ['> [!quiz] ❓ 自测', '> 问：为什么？', '>', '> ---', '>', '> 答：因为忽里勒台。', ''].join('\n'),
    );
    expect(findQuizSeparatorViolations(out.content)).toEqual([]);
  });

  it('三段形态：分隔符插在答案段前，提示段留在问题侧', () => {
    const md = [
      '> [!quiz] ❓ 自测',
      '> 问：为什么？',
      '>',
      '> 提示：想想政治传统。',
      '>',
      '> 答：因为忽里勒台。',
      '',
    ].join('\n');
    const out = repairQuizSeparator(md);
    expect(out.content).toBe(
      [
        '> [!quiz] ❓ 自测',
        '> 问：为什么？',
        '>',
        '> 提示：想想政治传统。',
        '>',
        '> ---',
        '>',
        '> 答：因为忽里勒台。',
        '',
      ].join('\n'),
    );
    expect(findQuizSeparatorViolations(out.content)).toEqual([]);
  });
});

describe('repairQuizSeparator — setext-separator', () => {
  it('为已有的 `---` 前后补空 `>` 行（零猜测路径，不依赖答案标签）', () => {
    const md = ['> [!quiz] ❓ 自测', '> 问：为什么？', '> ---', '> 答：因为忽里勒台。', ''].join('\n');
    const out = repairQuizSeparator(md);
    expect(out.repaired.map((v) => v.reason)).toEqual(['setext-separator']);
    expect(out.content).toBe(
      ['> [!quiz] ❓ 自测', '> 问：为什么？', '>', '> ---', '>', '> 答：因为忽里勒台。', ''].join('\n'),
    );
    expect(findQuizSeparatorViolations(out.content)).toEqual([]);
  });

  it('缺空行但无任何答案标签时也能修（与语言无关）', () => {
    const md = ['> [!quiz] Self-check', '> Why does it work?', '> ---', '> Because of the chain rule.', ''].join('\n');
    const out = repairQuizSeparator(md);
    expect(out.repaired.map((v) => v.reason)).toEqual(['setext-separator']);
    expect(findQuizSeparatorViolations(out.content)).toEqual([]);
  });
});

describe('repairQuizSeparator — 幂等与多块', () => {
  it('幂等：repair(repair(x)) === repair(x)', () => {
    const md = ['> [!quiz] 检验理解', '> 问：为什么？', '> 答：因为忽里勒台。', ''].join('\n');
    const once = repairQuizSeparator(md).content;
    const twice = repairQuizSeparator(once);
    expect(twice.content).toBe(once);
    expect(twice.repaired).toEqual([]);
  });

  it('一页多块：守约的逐字不动，受损的各自修好', () => {
    const md = [
      FM,
      '## 一',
      '',
      OK_QUIZ,
      '',
      '## 二',
      '',
      '> [!quiz] 检验理解',
      '> 问：为什么？',
      '> 答：因为忽里勒台。',
      '',
      '## 三',
      '',
      '> [!quiz] 自测',
      '> 问：还有呢？',
      '> ---',
      '> 答：没有了。',
      '',
    ].join('\n');
    const out = repairQuizSeparator(md);
    expect(out.repaired.map((v) => v.reason)).toEqual(['missing-separator', 'setext-separator']);
    expect(findQuizSeparatorViolations(out.content)).toEqual([]);
    // 守约块与正文其余部分逐字保留
    expect(out.content).toContain(OK_QUIZ);
    expect(out.content).toContain(FM);
  });
});
