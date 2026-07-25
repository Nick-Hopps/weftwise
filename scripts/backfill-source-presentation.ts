/**
 * CLI script — 为存量网页来源回填展示元数据（标题 / 描述）。
 *
 * Usage:
 *   npm run db:backfill-source-presentation
 *   npx tsx scripts/backfill-source-presentation.ts [--dry-run]
 *
 * 背景：Ingest 的联网核查阶段会把被引用的网页导入为 `web-<host>-<hash>.md` 快照
 * Source。2026-07-26 之前这些 Source 没有持久化标题/描述，左侧 Sources 列表只能显示
 * 机器文件名。本脚本按导入格式（首行 `# <标题>`、次段 `Source: <url>`）确定性解析
 * raw 正文，把标题与正文首段写回 sidecar 与 SQLite metadata cache。
 *
 * 安全性：只写展示字段，不改 filename / contentHash / raw 文件，不做 git commit，
 * 已有标题的 Source 直接跳过，因此可以安全重复执行。
 */

import { listSubjects } from '../src/server/db/repos/subjects-repo';
import { listSourcesForSubject } from '../src/server/db/repos/sources-repo';
import { readSourcePresentation, type SourcePresentation } from '../src/server/sources/source-presentation';
import { getRawSourceContent, updateSourcePresentation } from '../src/server/sources/source-store';

const WEB_SNAPSHOT_FILENAME = /^web-.+\.md$/;

/**
 * 解析 `buildWebSourceImports` 写出的网页快照正文；不符合该格式返回 null。
 * 格式：`# <标题>` + 空行 + `Source: <url>` + 空行 + 正文。
 */
export function parseWebSnapshotPresentation(raw: string): SourcePresentation | null {
  const lines = raw.split('\n');
  const heading = lines[0]?.startsWith('# ') ? lines[0].slice(2).trim() : null;
  if (heading === null) return null;

  const sourceLineIndex = lines.findIndex((line) => /^Source:\s*https?:\/\/\S+/i.test(line.trim()));
  if (sourceLineIndex === -1) return null;
  const url = lines[sourceLineIndex].trim().replace(/^Source:\s*/i, '');

  const body = lines.slice(sourceLineIndex + 1).join('\n');
  const description = body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .find((paragraph) => paragraph.length > 0);

  return {
    title: heading || hostnameForDisplay(url),
    description: description || undefined,
  };
}

function hostnameForDisplay(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '') || url;
  } catch {
    return url;
  }
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  let scanned = 0;
  let updated = 0;

  for (const subject of listSubjects()) {
    for (const source of listSourcesForSubject(subject.id)) {
      if (!WEB_SNAPSHOT_FILENAME.test(source.filename)) continue;
      scanned += 1;
      if (readSourcePresentation(source).title) continue;

      const raw = getRawSourceContent(subject.slug, source.filename);
      if (!raw) {
        console.warn(`跳过 ${source.filename}：raw 文件缺失（${subject.slug}）`);
        continue;
      }
      const presentation = parseWebSnapshotPresentation(raw);
      if (!presentation) {
        console.warn(`跳过 ${source.filename}：正文不符合网页快照格式`);
        continue;
      }

      console.log(`[${subject.slug}] ${source.filename} → ${presentation.title}`);
      if (!dryRun) updateSourcePresentation(source.id, presentation);
      updated += 1;
    }
  }

  console.log('');
  console.log(`网页快照来源 ${scanned} 个，${dryRun ? '待回填' : '已回填'} ${updated} 个。`);
  if (dryRun) console.log('（--dry-run：未写入任何文件或数据库）');
}

if (process.argv[1] && process.argv[1].endsWith('backfill-source-presentation.ts')) {
  main();
}
