import fs from 'node:fs';
import path from 'node:path';

const VAULT_MAINTENANCE_EXCLUDE = '.llm-wiki/maintenance/';

/**
 * reset/delete 的补偿备份必须留在 vault 挂载点内，但不属于知识库内容。
 * 使用 repo-local exclude 避免改动用户 vault 的 `.gitignore`。
 */
export function ensureVaultRuntimeExcludes(vaultPath: string): void {
  const gitDir = path.join(vaultPath, '.git');
  // 不要为尚未初始化的 vault 预创建 `.git`；ensureVaultRepo 会在 git init 后补齐。
  if (!fs.existsSync(gitDir)) return;
  const excludePath = path.join(gitDir, 'info', 'exclude');
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const current = fs.existsSync(excludePath)
    ? fs.readFileSync(excludePath, 'utf-8')
    : '';
  const lines = current.split(/\r?\n/);
  if (lines.includes(VAULT_MAINTENANCE_EXCLUDE)) return;
  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(excludePath, `${prefix}${VAULT_MAINTENANCE_EXCLUDE}\n`, 'utf-8');
}
