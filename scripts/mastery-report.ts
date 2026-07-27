/**
 * CLI script — **只读**打印逐页掌握度的四态分布与判定归因。
 *
 * Usage:
 *   npm run mastery:report
 *   npm run mastery:report -- --subject=general
 *   npx tsx scripts/mastery-report.ts [--subject=<slug>] [--top=5]
 *
 * 为什么需要它：spec ① 留下三个明说「接入真实数据后再调」的常量
 * （`READ_DWELL_MS` / `NEGATIVE_WINDOW_DAYS` / 规则 3 的 strength 门槛）和一条遗留观察
 * （「若 `struggling` 恒 0，改为累计 ≥3 条弱负证据判 `struggling`」）。没有观测面，
 * 这些常量的调整会退化为凭感觉；`seed-mastery-evidence` 是**造**数据的，不是**看**数据的。
 *
 * 只打四态计数回答不了那些问题，所以本脚本消费 `explainMastery` 的判定归因，
 * 与线上判定共用同一段逻辑——两份判定分头演化，报告就会开始撒谎。
 *
 * 不写库、不调 LLM。
 */

import { listSubjects, getBySlug } from '../src/server/db/repos/subjects-repo';
import { getAllPages, isMetaPage } from '../src/server/db/repos/pages-repo';
import { listForSubject } from '../src/server/db/repos/evidence-repo';
import {
  summarizeMasteryReport,
  type MasteryReport,
  type MasteryReportInput,
} from '../src/server/profile/mastery-report';
import { NEGATIVE_WINDOW_DAYS, STREAK_MIN_GAP_HOURS } from '../src/server/profile/mastery';
import type { Subject } from '../src/lib/contracts';

const USER_ID = 'local';

function flag(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function pct(n: number, total: number): string {
  return total === 0 ? '—' : `${((n / total) * 100).toFixed(0)}%`;
}

/**
 * 终端显示宽度：CJK / 全角字符占两列。
 * `String.padEnd` 按码点算，中文标签与 slug 会把列对齐整个打乱。
 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    width +=
      (cp >= 0x1100 && cp <= 0x115f) || // 谚文字母
      (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 部首 · 假名 · 汉字
      (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
      (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 兼容形式
      (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII
      (cp >= 0xffe0 && cp <= 0xffe6)
        ? 2
        : 1;
  }
  return width;
}

/** `key: value` 对齐成两列，避免宽窄不一的输出难以扫读。 */
function rows(pairs: Array<[string, string | number]>, indent = '  '): string {
  const width = Math.max(...pairs.map(([k]) => displayWidth(k)));
  return pairs
    .map(([k, v]) => `${indent}${k}${' '.repeat(width - displayWidth(k))}  ${v}`)
    .join('\n');
}

function printSubject(subject: Subject, report: MasteryReport, topN: number): void {
  const totalPages =
    report.states.unknown + report.states.exposed + report.states.mastered + report.states.struggling;

  console.log(`\n━━━ ${subject.name} (${subject.slug}) ━━━`);
  console.log(`  ${totalPages} 页可读 · ${report.pagesWithEvidence} 页有证据 · ${report.evidenceRows} 条证据`);

  if (report.evidenceRows === 0) {
    console.log('  （无证据；全部页面恒为 unknown）');
    return;
  }

  console.log('\n  四态分布');
  console.log(
    rows(
      (['unknown', 'exposed', 'mastered', 'struggling'] as const).map((s) => [
        s,
        `${report.states[s]}  ${pct(report.states[s], totalPages)}`,
      ]),
      '    ',
    ),
  );

  console.log('\n  判定归因');
  console.log(
    rows(
      [
        ['mastered high / low', `${report.masteredConfidence.high} / ${report.masteredConfidence.low}`],
        ['被 strength 门槛挡下', report.blockedByStrengthGate],
        ['已过期回落 exposed', report.expiredPositives],
        ['当前该复习', report.dueForReview],
        ['只有弱负证据', report.weakNegativeOnly],
      ],
      '    ',
    ),
  );
  // 逐项对应一个待调旋钮：low 占比高 → E2 注入几乎全被降级进「一句话回顾」段；
  // 门槛挡下多 → 规则 3 太严；过期多 → 复习闭环没跟上；
  // 只有弱负证据的多 → 遗留观察「弱负证据累计 ≥3 判 struggling」值得启用。

  const struggling = Object.entries(report.strugglingByKind);
  if (struggling.length > 0) {
    console.log('\n  struggling 成因（强负证据）');
    console.log(rows(struggling.sort((a, b) => b[1] - a[1]), '    '));
  }

  console.log('\n  证据 kind 分布');
  console.log(
    rows(
      Object.entries(report.evidenceByKind).sort((a, b) => b[1] - a[1]),
      '    ',
    ),
  );

  for (const state of ['mastered', 'struggling', 'exposed'] as const) {
    const top = report.topByState[state];
    if (top.length === 0) continue;
    console.log(`\n  ${state} 证据最多的 ${Math.min(topN, top.length)} 页`);
    console.log(rows(top.map((p) => [p.slug, `${p.evidenceCount} 条`]), '    '));
  }
}

function main(): void {
  const slug = flag('subject');
  const topN = Number(flag('top') ?? 5);

  const subjects = slug
    ? [getBySlug(slug)].filter((s): s is Subject => {
        if (!s) console.error(`找不到 subject: ${slug}`);
        return Boolean(s);
      })
    : listSubjects();

  if (subjects.length === 0) {
    console.log('没有可报告的 subject。');
    return;
  }

  const now = new Date();
  console.log(`掌握度报告 @ ${now.toISOString()}`);
  console.log(`判定参数：连击最小间隔 ${STREAK_MIN_GAP_HOURS}h · 强负证据窗口 ${NEGATIVE_WINDOW_DAYS} 天`);

  for (const subject of subjects) {
    // 与 `/api/mastery` 同口径排除 meta 页：index/log 谈不上「掌握」。
    const readable = new Set(
      getAllPages(subject.id).filter((p) => !isMetaPage(p)).map((p) => p.slug),
    );
    const pages: MasteryReportInput[] = [];
    for (const [pageSlug, evidence] of listForSubject(USER_ID, subject.id)) {
      // 证据指向已删页：跳过（生命周期闭合应已清理，出现即值得单独排查）。
      if (!readable.has(pageSlug)) continue;
      pages.push({ slug: pageSlug, evidence });
    }
    printSubject(subject, summarizeMasteryReport(pages, readable.size, now, topN), topN);
  }
  console.log('');
}

main();
