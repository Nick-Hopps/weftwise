import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readSkill(id: string): string {
  return readFileSync(resolve(process.cwd(), `examples/skills/${id}.md`), 'utf8');
}
function versionOf(src: string): number {
  const m = src.match(/^version:\s*(\d+)\s*$/m);
  return m ? Number(m[1]) : -1;
}

describe('ingest-writer skill 契约（v6 讲解者）', () => {
  const src = readSkill('ingest-writer');
  it('版本抬到 6', () => {
    expect(versionOf(src)).toBe(6);
  });
  it('消费 expositionDirective 输入', () => {
    expect(src).toContain('expositionDirective');
  });
  it('转为讲解者（含 teaching/explain 字样）', () => {
    expect(src).toMatch(/teach|explain|exposit/i);
  });
  it('删除旧的"不得超出 chunk"硬约束', () => {
    expect(src).not.toContain('Do not invent facts not present in the chunks');
    expect(src).not.toContain('plain encyclopedic prose only');
  });
  it('保留 no-callout 指令（[!type] 禁令，避免与 enricher 冲突）', () => {
    expect(src).toContain('[!type]');
  });
  it('保留 no-translate 规则', () => {
    expect(src).toContain('Do NOT translate');
  });
});

describe('ingest-enricher skill 契约（v4 学习脚手架 + mermaid 语法守则）', () => {
  const src = readSkill('ingest-enricher');
  it('版本抬到 4', () => {
    expect(versionOf(src)).toBe(4);
  });
  it('移除 intuition / example 两类（已属 writer 正文）', () => {
    expect(src).not.toContain('[!intuition]');
    expect(src).not.toContain('[!example]');
  });
  it('保留 quiz / pitfall / diagram / background 四类脚手架', () => {
    expect(src).toContain('[!quiz]');
    expect(src).toContain('[!pitfall]');
    expect(src).toContain('[!diagram]');
    expect(src).toContain('[!background]');
  });
  it('含 mermaid 语法守则（生成时纠错）', () => {
    expect(src).toMatch(/Mermaid 语法守则/);
    // 两类真实失败模式：未加引号的特殊字符标签 + 行尾空格
    expect(src).toContain('B["极小多项式 p(z)"]');
    expect(src).toMatch(/行尾/);
  });
});

describe('ingest-verifier triage/apply 契约（核查正文 + apply mermaid 兜底）', () => {
  const triage = readSkill('ingest-verifier-triage');
  const apply = readSkill('ingest-verifier-apply');
  it('triage 抬到 v2 且不再限定"仅 callout"', () => {
    expect(versionOf(triage)).toBe(2);
    expect(triage).not.toContain('Only consider claims inside');
    expect(triage).toMatch(/prose/i);
  });
  it('apply 抬到 v3 且允许修正正文断言', () => {
    expect(versionOf(apply)).toBe(3);
    expect(apply).not.toContain('Only change content inside');
    expect(apply).toMatch(/prose|anywhere/i);
  });
  it('apply 含 mermaid 语法兜底规则', () => {
    expect(apply).toMatch(/[Mm]ermaid 语法兜底/);
    expect(apply).toContain('B["极小多项式 p(z)"]');
  });
});
