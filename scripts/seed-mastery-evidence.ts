/**
 * CLI script — 给一个 subject 种入覆盖四态的掌握度证据，供两个消费面（重塑注入 /
 * Graph 图层）在真实采集链路接通之前就能被验证。
 *
 * Usage:
 *   npm run db:seed-mastery-evidence -- general
 *   npx tsx scripts/seed-mastery-evidence.ts general [--reset]
 *
 *   --reset  先清空该 subject 的既有证据（重复实验用）
 *
 * 背景：`page_evidence` 是纯 append-only 表、无 LLM 参与，直接 INSERT 若干行就能驱动
 * 两个消费面。这让「先做消费面、再决定采集链路投入多少」成为可能。
 *
 * 脚本跑完自己调 `deriveMastery` 打印各页判定，输出即自验证——不需要另外查库确认。
 */

import { getBySlug } from '../src/server/db/repos/subjects-repo';
import { getAllPages, isMetaPage } from '../src/server/db/repos/pages-repo';
import { getRawDb } from '../src/server/db/client';
import {
  appendEvidence,
  listForPage,
  type AppendEvidenceInput,
} from '../src/server/db/repos/evidence-repo';
import { deriveMastery } from '../src/server/profile/mastery';

const USER_ID = 'local';
const DAY_MS = 86_400_000;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString();
}

/** 五种情形，覆盖四态 + 「过期的 mastered 回落 exposed」这条易退化的分支。 */
const SCENARIOS: Array<{
  label: string;
  expected: string;
  evidence: (slug: string) => Omit<AppendEvidenceInput, 'userId' | 'subjectId'>[];
}> = [
  {
    label: 'mastered（两条近期判分答对）',
    expected: 'mastered/high',
    evidence: () => [
      { slug: '', kind: 'quiz-correct', strength: 'strong', anchor: 'q1', createdAt: daysAgo(2) },
      { slug: '', kind: 'quiz-correct', strength: 'strong', anchor: 'q2', createdAt: daysAgo(1) },
    ],
  },
  {
    label: 'exposed（只读完过）',
    expected: 'exposed/low',
    evidence: () => [{ slug: '', kind: 'page-read', createdAt: daysAgo(1) }],
  },
  {
    label: 'struggling（近期选区追问）',
    expected: 'struggling/low',
    evidence: () => [{ slug: '', kind: 'selection-ask', anchor: '某一节', createdAt: daysAgo(1) }],
  },
  {
    label: '过期 mastered（应回落 exposed，不是 unknown）',
    expected: 'exposed/low',
    // 连击 1 → 失效 +4 天；放到 10 天前必定已过期。
    evidence: () => [
      { slug: '', kind: 'quiz-correct', strength: 'strong', anchor: 'q1', createdAt: daysAgo(10) },
    ],
  },
  {
    label: 'unknown（不种任何证据）',
    expected: 'unknown/none',
    evidence: () => [],
  },
];

function main(): void {
  const args = process.argv.slice(2);
  const reset = args.includes('--reset');
  const subjectSlug = args.find((a) => !a.startsWith('--'));

  if (!subjectSlug) {
    console.error('Usage: npm run db:seed-mastery-evidence -- <subject-slug> [--reset]');
    process.exit(1);
  }

  const subject = getBySlug(subjectSlug);
  if (!subject) {
    console.error(`Subject "${subjectSlug}" not found.`);
    process.exit(1);
  }

  const pages = getAllPages(subject.id).filter((p) => !isMetaPage(p));
  if (pages.length < SCENARIOS.length) {
    console.error(
      `Subject "${subjectSlug}" only has ${pages.length} non-meta pages; ` +
        `need at least ${SCENARIOS.length}.`,
    );
    process.exit(1);
  }

  if (reset) {
    const { changes } = getRawDb()
      .prepare(`DELETE FROM page_evidence WHERE user_id = ? AND subject_id = ?`)
      .run(USER_ID, subject.id);
    console.log(`Cleared ${changes} existing evidence rows.\n`);
  }

  const now = new Date();
  console.log(`Seeding mastery evidence into "${subject.slug}":\n`);

  SCENARIOS.forEach((scenario, i) => {
    const page = pages[i];
    for (const row of scenario.evidence(page.slug)) {
      appendEvidence({ ...row, slug: page.slug, userId: USER_ID, subjectId: subject.id });
    }

    // 自验证：立刻按真实派生函数回读，输出即验收依据。
    const verdict = deriveMastery(listForPage(USER_ID, subject.id, page.slug), now);
    const actual = `${verdict.state}/${verdict.confidence}`;
    const ok = actual === scenario.expected ? '✓' : '✗';

    console.log(`${ok} ${page.slug}`);
    console.log(`    ${scenario.label}`);
    console.log(`    expected ${scenario.expected}, got ${actual}`);
    if (verdict.expiresAt) console.log(`    expires ${verdict.expiresAt}`);
    console.log();
  });

  console.log('Open the wiki page or the fullscreen graph to see the two surfaces.');
}

main();
