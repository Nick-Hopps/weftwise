import { afterAll, describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureVaultRepo,
  getVaultGit,
  parseGitLog,
} from '../git-service';

const US = '\x1f'; // unit separator，与 --pretty=format:%x1f 一致
const previousVaultPath = process.env.VAULT_PATH;
let vaultDir: string | null = null;

afterAll(() => {
  process.env.VAULT_PATH = previousVaultPath;
  if (vaultDir) rmSync(vaultDir, { recursive: true, force: true });
});

describe('parseGitLog', () => {
  it('解析多条提交为 {sha,date,message}', () => {
    const raw = [
      `abc123${US}2026-06-22T10:00:00+08:00${US}[subject:general] 编辑 Foo`,
      `def456${US}2026-06-21T09:30:00+08:00${US}[subject:general] 摄入 3 页`,
    ].join('\n');
    expect(parseGitLog(raw)).toEqual([
      { sha: 'abc123', date: '2026-06-22T10:00:00+08:00', message: '[subject:general] 编辑 Foo' },
      { sha: 'def456', date: '2026-06-21T09:30:00+08:00', message: '[subject:general] 摄入 3 页' },
    ]);
  });

  it('空输入返回空数组', () => {
    expect(parseGitLog('')).toEqual([]);
  });

  it('忽略尾部/中间空行', () => {
    const raw = `abc${US}2026-06-22T10:00:00Z${US}msg one\n\n`;
    const out = parseGitLog(raw);
    expect(out).toHaveLength(1);
    expect(out[0].message).toBe('msg one');
  });

  it('message 中的空格与标点保真', () => {
    const raw = `s1${US}2026-06-22T10:00:00Z${US}[subject:general] 拆分 A → B, C`;
    expect(parseGitLog(raw)[0].message).toBe('[subject:general] 拆分 A → B, C');
  });

  it('初始化 vault 时排除维护备份目录', async () => {
    vaultDir = mkdtempSync(join(tmpdir(), 'git-service-vault-'));
    process.env.VAULT_PATH = vaultDir;

    await ensureVaultRepo();
    const exclude = readFileSync(join(vaultDir, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude.split(/\r?\n/)).toContain('.llm-wiki/maintenance/');
    expect(readFileSync(join(vaultDir, '.llm-wiki', 'README.md'), 'utf-8'))
      .toContain('Initialized by weftwise.');

    const maintenanceDir = join(vaultDir, '.llm-wiki', 'maintenance', 'pending');
    mkdirSync(maintenanceDir, { recursive: true });
    writeFileSync(join(maintenanceDir, 'manifest.json'), '{}');
    const status = await getVaultGit().status();
    expect(status.files.map((file) => file.path)).not.toContain(
      '.llm-wiki/maintenance/pending/manifest.json',
    );
  });
});
