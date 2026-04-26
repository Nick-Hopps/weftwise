import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkillsFromDir } from '../loader';

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'skill-loader-'));
}

describe('loader', () => {
  it('parses a valid skill', async () => {
    const dir = mkTmp();
    writeFileSync(join(dir, 'planner.md'), [
      '---',
      'id: planner',
      'name: Planner',
      'description: Plans pages',
      'version: 1',
      'tools: [vault.read]',
      'canDispatch: []',
      '---',
      '',
      '# System',
      'Hello',
      '',
    ].join('\n'));
    const { skills, degraded } = await loadSkillsFromDir(dir);
    expect(degraded).toEqual([]);
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe('planner');
    expect(skills[0].systemPrompt.trim()).toContain('# System');
  });

  it('rejects id mismatch with filename', async () => {
    const dir = mkTmp();
    writeFileSync(join(dir, 'planner.md'), [
      '---',
      'id: not-planner',
      'name: X',
      'description: x',
      'version: 1',
      '---',
      'body',
    ].join('\n'));
    const { skills, degraded } = await loadSkillsFromDir(dir);
    expect(skills).toEqual([]);
    expect(degraded).toHaveLength(1);
    expect(degraded[0].errors[0]).toMatch(/filename/i);
  });

  it('compiles outputSchema JSON-Schema string into a zod schema', async () => {
    const dir = mkTmp();
    writeFileSync(join(dir, 'writer.md'), [
      '---',
      'id: writer',
      'name: W',
      'description: w',
      'version: 1',
      'outputSchema: |',
      '  { "type": "object", "properties": { "x": { "type": "number" } }, "required": ["x"] }',
      '---',
      'body',
    ].join('\n'));
    const { skills, degraded } = await loadSkillsFromDir(dir);
    expect(degraded).toEqual([]);
    expect(skills[0].outputSchema).toBeDefined();
    const parse = skills[0].outputSchema!.safeParse({ x: 1 });
    expect(parse.success).toBe(true);
    const fail = skills[0].outputSchema!.safeParse({ x: 'no' });
    expect(fail.success).toBe(false);
  });

  it('reports unknown frontmatter keys as degraded', async () => {
    const dir = mkTmp();
    writeFileSync(join(dir, 'extra.md'), [
      '---',
      'id: extra',
      'name: X',
      'description: x',
      'version: 1',
      'someUnknownField: yes',
      '---',
      'body',
    ].join('\n'));
    const { skills, degraded } = await loadSkillsFromDir(dir);
    expect(skills).toEqual([]);
    expect(degraded).toHaveLength(1);
  });
});
