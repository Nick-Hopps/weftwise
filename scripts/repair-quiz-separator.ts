/**
 * CLI script — 为存量 `[!quiz]` callout 补上缺失的答案分隔符。
 *
 * Usage:
 *   npm run vault:repair-quiz-separator              # dry-run，只打印报告
 *   npm run vault:repair-quiz-separator -- --apply   # 落盘并同步索引
 *
 * 背景：阅读页的 quiz 折叠只认 blockquote 内的 `thematicBreak`（`markdown-client.ts`）。
 * enricher 有概率漏写那行 `---`，答案就直接摊在问题旁边剧透。判定与修复复用
 * `server/wiki/quiz-separator.ts`（与 enricher 护栏同一纯函数），本脚本只负责遍历、
 * 报告与落盘。设计稿见 `docs/specs/2026-07-28-quiz-answer-separator-guard.md`。
 *
 * 安全性：
 * - 默认 dry-run，必须显式 `--apply` 才写文件。
 * - 只在受损 quiz 块内插入 `>` / `> ---` 行，正文其余部分逐字节保留；幂等，可重复执行。
 * - `--apply` 全程持 `acquireVaultLock()`（跨进程文件锁）—— worker 与 Next.js 路由都是
 *   独立进程，vault 是个**并发写入**的仓库（实测跑 dev 时 re-enrich job 会在旁边改页）。
 *   不持锁就可能读到旧内容再覆盖掉 Saga 刚提交的版本，故扫描与落盘都在锁内完成。
 * - 落盘后按 subject 分组调 `indexTouchedPages` 同步 `content_hash` 与 FTS body。
 * - **不做任何 git 操作** —— vault 工作区常有不相关的未提交改动，提交时机留给使用者。
 *
 * ⚠️ 因为不 commit，修复只存在于工作区。若在提交前有 Saga 失败触发 `restoreToHead`，
 * 这批未提交改动会被一并丢弃 —— 落盘后请尽快审阅并提交。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { scanWikiPages } from '../src/server/wiki/wiki-store';
import { indexTouchedPages } from '../src/server/wiki/indexer';
import { acquireVaultLock } from '../src/server/wiki/vault-mutex';
import { listSubjects } from '../src/server/db/repos/subjects-repo';
import {
  findQuizSeparatorViolations,
  repairQuizSeparator,
  type QuizSeparatorViolation,
} from '../src/server/wiki/quiz-separator';

interface FileRepair {
  subjectSlug: string;
  slug: string;
  /** vault 相对路径，如 `wiki/world-history/mongol-empire.md` */
  relativePath: string;
  absPath: string;
  repaired: QuizSeparatorViolation[];
  before: string;
  after: string;
}

function collectRepairs(): FileRepair[] {
  const repairs: FileRepair[] = [];
  // 复用 scanWikiPages 而不是自己 glob：「哪些文件算 wiki 页」只该有一个判定处
  for (const page of scanWikiPages()) {
    const out = repairQuizSeparator(page.content);
    if (out.repaired.length === 0) continue;
    repairs.push({
      subjectSlug: page.subjectSlug,
      slug: page.slug,
      relativePath: page.relativePath,
      absPath: page.path,
      repaired: out.repaired,
      before: page.content,
      after: out.content,
    });
  }
  return repairs.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/**
 * 逐块打印插入式 diff（修复只做插入，故 after 是 before 的超序列 —— 双指针同步即可
 * 精确标出新增行，不必引入 LCS）。`+` 是新增行，` ` 是逐字保留的原行。
 */
function report(repairs: FileRepair[]): void {
  for (const file of repairs) {
    console.log(`\n${file.relativePath}`);
    const before = file.before.split('\n');
    const after = file.after.split('\n');

    for (const v of file.repaired) {
      console.log(`  L${v.line} [${v.reason}] ${v.head}`);
      // 把 before 的 blockquote 起始行对齐到 after 中的同一行（前面若已有插入会整体后移）
      let b = 0;
      let a = 0;
      while (b < v.line - 1) {
        if (before[b] === after[a]) b += 1;
        a += 1;
      }
      // 打印该块：从起始行起，直到引用块结束（连续两个非引用行即止）
      let printed = 0;
      while (a < after.length && printed < 12) {
        const isInsert = before[b] !== after[a];
        const line = after[a];
        if (!isInsert && !line.trimStart().startsWith('>') && printed > 0) break;
        console.log(`    ${isInsert ? '+' : ' '} ${line}`);
        if (!isInsert) b += 1;
        a += 1;
        printed += 1;
      }
    }
  }
}

function summarize(repairs: FileRepair[]): void {
  report(repairs);
  const blockCount = repairs.reduce((sum, f) => sum + f.repaired.length, 0);
  console.log('');
  console.log(`受损 quiz ${blockCount} 处，分布在 ${repairs.length} 个文件。`);
}

function reindex(repairs: FileRepair[]): void {
  const subjectIdBySlug = new Map(listSubjects().map((s) => [s.slug, s.id]));
  const slugsBySubject = new Map<string, string[]>();
  for (const file of repairs) {
    const list = slugsBySubject.get(file.subjectSlug) ?? [];
    list.push(file.slug);
    slugsBySubject.set(file.subjectSlug, list);
  }

  for (const [subjectSlug, slugs] of slugsBySubject) {
    const subjectId = subjectIdBySlug.get(subjectSlug);
    if (!subjectId) {
      console.warn(`跳过索引同步：数据库里没有 subject "${subjectSlug}"（${slugs.length} 页）`);
      continue;
    }
    indexTouchedPages(subjectId, slugs);
    console.log(`已重建索引：${subjectSlug} ${slugs.length} 页`);
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  if (!apply) {
    // dry-run 不持锁：只读，且报告本身就可能因并发写入过时，不值得阻塞 worker
    const repairs = collectRepairs();
    if (repairs.length === 0) {
      console.log('没有需要修复的 quiz 分隔符。');
      return;
    }
    summarize(repairs);
    console.log('（dry-run：未写入任何文件；加 --apply 落盘）');
    return;
  }

  const release = await acquireVaultLock();
  try {
    // 扫描必须在锁内重做：dry-run 之后 worker 可能又改过页，用旧快照落盘会覆盖它的提交
    const repairs = collectRepairs();
    if (repairs.length === 0) {
      console.log('没有需要修复的 quiz 分隔符。');
      return;
    }
    summarize(repairs);

    for (const file of repairs) writeFileSync(file.absPath, file.after, 'utf8');
    console.log(`已写入 ${repairs.length} 个文件。`);

    reindex(repairs);

    // 落盘后复验：用同一套判定确认归零，而不是"应该修好了"
    const leftover = repairs.flatMap((file) => (
      findQuizSeparatorViolations(readFileSync(file.absPath, 'utf8')).map((v) => `${file.relativePath}:${v.line}`)
    ));
    if (leftover.length > 0) {
      console.error(`复验失败，仍有 ${leftover.length} 处违规：\n${leftover.join('\n')}`);
      process.exitCode = 1;
      return;
    }
    console.log('复验通过：被改动文件内已无受损 quiz。');
    console.log('未执行 git 操作 —— 请尽快 `git -C <vault> diff` 审阅并提交（未提交的修复会被 Saga 回滚丢弃）。');
  } finally {
    await release();
  }
}

if (process.argv[1] && process.argv[1].endsWith('repair-quiz-separator.ts')) {
  void main();
}
