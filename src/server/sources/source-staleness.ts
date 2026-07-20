import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Source } from '@/lib/contracts';
import { vaultPath } from '../config/env';
import { readUrlSourceReference } from './url-source';

function sourcePathsToCheck(subjectSlug: string, filename: string): string[] {
  const safeFilename = basename(filename);
  return [
    vaultPath('raw', subjectSlug, safeFilename),
    vaultPath('raw', safeFilename),
  ];
}

/** 判断来源原文件是否缺失或已偏离入库时的内容哈希。 */
export function isSourceStale(
  subjectSlug: string,
  source: Pick<Source, 'filename' | 'contentHash'> & Partial<Pick<Source, 'metadataJson'>>,
): boolean {
  if (
    typeof source.metadataJson === 'string'
    && readUrlSourceReference({ metadataJson: source.metadataJson })
  ) {
    return false;
  }
  const path = sourcePathsToCheck(subjectSlug, source.filename).find(existsSync);
  if (!path) return true;

  const diskHash = createHash('sha256')
    .update(readFileSync(path))
    .digest('hex')
    .slice(0, 16);
  return diskHash !== source.contentHash;
}
