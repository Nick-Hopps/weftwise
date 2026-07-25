/**
 * 本地 Vitest 用例分析与 HTML 报告。
 *
 * Usage:
 *   npm run test:report
 *   npm run test:report -- --output /tmp/test-report.html
 *   npm run test:report -- --no-run --results /tmp/vitest.json
 *   npm run test:report -- --coverage-summary coverage/coverage-summary.json
 *   npm run test:report -- --coverage
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export type TestStatus = 'passed' | 'failed' | 'pending' | 'todo' | 'skipped' | 'not-run';

export interface StaticTestCase {
  id: string;
  feature: string;
  file: string;
  relativeFile: string;
  title: string;
  ancestorTitles: string[];
  line: number;
}

export interface TestCaseRecord extends StaticTestCase {
  status: TestStatus;
  durationMs: number | null;
  failureMessages: string[];
  dynamicallyDiscovered?: boolean;
}

export interface CodeCoverage {
  covered: number;
  total: number;
  percent: number | null;
}

export interface FeatureSummary {
  name: string;
  cases: TestCaseRecord[];
  discovered: number;
  executed: number;
  passed: number;
  failed: number;
  pending: number;
  passRate: number | null;
  caseCoverage: number | null;
  codeCoverage: CodeCoverage | null;
}

export interface TestReport {
  generatedAt: string;
  command: string;
  runExitCode: number | null;
  runOutput: string;
  features: FeatureSummary[];
  totals: {
    discovered: number;
    executed: number;
    passed: number;
    failed: number;
    pending: number;
    passRate: number | null;
    caseCoverage: number | null;
    codeCoverage: CodeCoverage | null;
  };
}

interface VitestAssertionResult {
  ancestorTitles?: unknown;
  fullName?: unknown;
  title?: unknown;
  status?: unknown;
  duration?: unknown;
  failureMessages?: unknown;
}

interface VitestFileResult {
  name?: unknown;
  assertionResults?: unknown;
}

interface VitestJsonReport {
  testResults?: unknown;
}

interface CoverageMetric {
  total?: unknown;
  covered?: unknown;
  pct?: unknown;
}

interface CoverageFileSummary {
  lines?: CoverageMetric;
}

interface CoverageSummaryJson {
  total?: CoverageFileSummary;
  [file: string]: unknown;
}

interface CliOptions {
  output: string;
  results: string | null;
  coverageSummary: string | null;
  coverage: boolean;
  noRun: boolean;
  testArgs: string[];
}

const TEST_FILE_RE = /\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');

function normalizePath(file: string): string {
  return file.replaceAll('\\', '/');
}

function featureFromRelativePath(relativeFile: string): string {
  const normalized = normalizePath(relativeFile).replace(/^\.\//, '');
  const segments = normalized.split('/');
  const testIndex = segments.indexOf('__tests__');
  if (testIndex >= 0) {
    const before = segments.slice(0, testIndex);
    if (before[0] === 'scripts' && before.length === 1) return 'scripts';
    if (before[0] === 'src' || before[0] === 'scripts') before.shift();
    return before.join('/') || 'root';
  }
  const withoutFile = segments.slice(0, -1);
  if (withoutFile[0] === 'src' || withoutFile[0] === 'scripts') withoutFile.shift();
  return withoutFile.join('/') || 'root';
}

export function featureForFile(file: string, rootDir = PROJECT_ROOT): string {
  return featureFromRelativePath(relative(rootDir, file));
}

function featureOverride(source: string): string | null {
  for (const line of source.split(/\r?\n/).slice(0, 30)) {
    const match = line.match(/^\s*(?:\/\/|\/\*+|\*)\s*@feature\s*:\s*(.+?)\s*(?:\*\/)?\s*$/);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function callName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return callName(expression.expression);
  return null;
}

function stringLiteral(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

export function scanTestSource(file: string, source: string, rootDir = PROJECT_ROOT): StaticTestCase[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const feature = featureOverride(source) ?? featureForFile(file, rootDir);
  const describes: Array<{ start: number; end: number; title: string }> = [];
  const tests: Array<{ node: ts.CallExpression; title: string }> = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      const title = stringLiteral(node.arguments[0]);
      if (title && (name === 'describe' || name === 'suite')) {
        describes.push({ start: node.getStart(sourceFile), end: node.end, title });
      } else if (title && (name === 'it' || name === 'test')) {
        tests.push({ node, title });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return tests.map(({ node, title }, index) => {
    const ancestorTitles = describes
      .filter((range) => range.start < node.getStart(sourceFile) && node.end <= range.end)
      .sort((a, b) => a.start - b.start)
      .map((range) => range.title);
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const relativeFile = normalizePath(relative(rootDir, file));
    return {
      id: `${relativeFile}:${line}:${index}`,
      feature,
      file,
      relativeFile,
      title,
      ancestorTitles,
      line,
    };
  });
}

export function scanTestFiles(rootDir = PROJECT_ROOT): StaticTestCase[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'coverage') continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (TEST_FILE_RE.test(entry.name) && (absolute.includes('/__tests__/') || absolute.includes('/scripts/'))) files.push(absolute);
    }
  };
  walk(rootDir);
  return files.flatMap((file) => scanTestSource(file, readFileSync(file, 'utf8'), rootDir));
}

function statusOf(value: unknown): TestStatus {
  switch (value) {
    case 'passed': return 'passed';
    case 'failed': return 'failed';
    case 'pending': return 'pending';
    case 'todo': return 'todo';
    case 'skipped': return 'skipped';
    default: return 'not-run';
  }
}

function isExecuted(status: TestStatus): boolean {
  return status === 'passed' || status === 'failed';
}

function rate(covered: number, total: number): number | null {
  return total === 0 ? null : covered / total;
}

function emptyCoverage(): CodeCoverage {
  return { covered: 0, total: 0, percent: null };
}

function mergeCoverage(a: CodeCoverage, b: CodeCoverage): CodeCoverage {
  const total = a.total + b.total;
  const covered = a.covered + b.covered;
  return { covered, total, percent: rate(covered, total) };
}

function coverageForFeature(file: string, rootDir: string, features: string[]): string {
  const normalized = normalizePath(relative(rootDir, file));
  const candidates = features.filter((feature) => {
    const prefixes = feature === 'scripts' ? ['scripts'] : [`src/${feature}`, `scripts/${feature}`];
    return prefixes.some((prefix) => normalized.startsWith(`${prefix}/`));
  });
  return candidates.sort((a, b) => b.length - a.length)[0] ?? featureFromRelativePath(normalized);
}

export function aggregateCodeCoverage(
  raw: unknown,
  rootDir = PROJECT_ROOT,
  features: string[] = [],
): Map<string, CodeCoverage> {
  const result = new Map<string, CodeCoverage>();
  if (!raw || typeof raw !== 'object') return result;
  for (const [file, value] of Object.entries(raw as CoverageSummaryJson)) {
    if (file === 'total' || !value || typeof value !== 'object') continue;
    const lines = (value as CoverageFileSummary).lines;
    const total = Number((lines as CoverageMetric | undefined)?.total);
    const covered = Number((lines as CoverageMetric | undefined)?.covered);
    if (!Number.isFinite(total) || !Number.isFinite(covered) || total < 0 || covered < 0) continue;
    const feature = coverageForFeature(isAbsolute(file) ? file : resolve(rootDir, file), rootDir, features);
    result.set(feature, mergeCoverage(result.get(feature) ?? emptyCoverage(), { total, covered, percent: rate(covered, total) }));
  }
  return result;
}

export function buildReport(
  inventory: StaticTestCase[],
  rawResults: unknown,
  options: { rootDir?: string; command?: string; runExitCode?: number | null; runOutput?: string; coverage?: unknown } = {},
): TestReport {
  const rootDir = options.rootDir ?? PROJECT_ROOT;
  const command = options.command ?? 'vitest run --reporter=json';
  const byFile = new Map<string, StaticTestCase[]>();
  for (const test of inventory) byFile.set(normalizePath(test.file), [...(byFile.get(normalizePath(test.file)) ?? []), test]);
  const records = new Map<string, TestCaseRecord[]>();
  const report = (rawResults && typeof rawResults === 'object' ? rawResults : {}) as VitestJsonReport;
  for (const fileResult of Array.isArray(report.testResults) ? report.testResults : []) {
    if (!fileResult || typeof fileResult !== 'object') continue;
    const file = String((fileResult as VitestFileResult).name ?? '');
    const candidates = [...(byFile.get(normalizePath(file)) ?? byFile.get(normalizePath(resolve(rootDir, file))) ?? [])];
    const queues = new Map<string, StaticTestCase[]>();
    for (const candidate of candidates) {
      const key = [...candidate.ancestorTitles, candidate.title].join('\u0000');
      queues.set(key, [...(queues.get(key) ?? []), candidate]);
    }
    const assertions = Array.isArray((fileResult as VitestFileResult).assertionResults)
      ? (fileResult as VitestFileResult).assertionResults as VitestAssertionResult[]
      : [];
    for (const assertion of assertions) {
      const ancestorTitles = Array.isArray(assertion.ancestorTitles) ? assertion.ancestorTitles.map(String) : [];
      const title = String(assertion.title ?? assertion.fullName ?? 'Unnamed test');
      const key = [...ancestorTitles, title].join('\u0000');
      const staticTest = queues.get(key)?.shift();
      const fallback: StaticTestCase = staticTest ?? {
        id: `${normalizePath(file)}:${records.size}:${title}`,
        feature: featureForFile(isAbsolute(file) ? file : resolve(rootDir, file), rootDir),
        file: isAbsolute(file) ? file : resolve(rootDir, file),
        relativeFile: normalizePath(relative(rootDir, isAbsolute(file) ? file : resolve(rootDir, file))),
        title,
        ancestorTitles,
        line: 0,
      };
      const record: TestCaseRecord = {
        ...fallback,
        status: statusOf(assertion.status),
        durationMs: Number.isFinite(Number(assertion.duration)) ? Number(assertion.duration) : null,
        failureMessages: Array.isArray(assertion.failureMessages) ? assertion.failureMessages.map(String) : [],
        dynamicallyDiscovered: !staticTest,
      };
      const fileKey = normalizePath(fallback.file);
      records.set(fileKey, [...(records.get(fileKey) ?? []), record]);
    }
  }

  for (const test of inventory) {
    const fileKey = normalizePath(test.file);
    const matched = records.get(fileKey)?.some((record) => record.id === test.id);
    if (!matched) {
      records.set(fileKey, [...(records.get(fileKey) ?? []), { ...test, status: 'not-run', durationMs: null, failureMessages: [] }]);
    }
  }

  const featureNames = [...new Set([...inventory.map((test) => test.feature), ...[...records.values()].flat().map((test) => test.feature)])].sort();
  const coverage = aggregateCodeCoverage(options.coverage, rootDir, featureNames);
  const features = featureNames.map((name): FeatureSummary => {
    const cases = [...records.values()].flat().filter((test) => test.feature === name).sort((a, b) => a.relativeFile.localeCompare(b.relativeFile) || a.line - b.line || a.title.localeCompare(b.title));
    const passed = cases.filter((test) => test.status === 'passed').length;
    const failed = cases.filter((test) => test.status === 'failed').length;
    const pending = cases.filter((test) => !isExecuted(test.status)).length;
    const executed = passed + failed;
    return {
      name, cases, discovered: cases.length, executed, passed, failed, pending,
      passRate: rate(passed, executed), caseCoverage: rate(executed, cases.length),
      codeCoverage: coverage.get(name) ?? null,
    };
  });
  const allCases = features.flatMap((feature) => feature.cases);
  const passed = allCases.filter((test) => test.status === 'passed').length;
  const failed = allCases.filter((test) => test.status === 'failed').length;
  const executed = passed + failed;
  const codeCoverage = features.reduce<CodeCoverage | null>((sum, feature) => {
    if (!feature.codeCoverage) return sum;
    return mergeCoverage(sum ?? emptyCoverage(), feature.codeCoverage);
  }, null);
  return {
    generatedAt: new Date().toISOString(), command, runExitCode: options.runExitCode ?? null,
    runOutput: options.runOutput ?? '', features,
    totals: { discovered: allCases.length, executed, passed, failed, pending: allCases.length - executed, passRate: rate(passed, executed), caseCoverage: rate(executed, allCases.length), codeCoverage },
  };
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function percent(value: number | null): string {
  return value === null ? '未采集' : `${(value * 100).toFixed(2)}%`;
}

function statusLabel(status: TestStatus): string {
  return ({ passed: '通过', failed: '失败', pending: '待定', todo: 'TODO', skipped: '跳过', 'not-run': '未执行' })[status];
}

export function renderHtml(report: TestReport): string {
  const failedRun = report.runExitCode !== null && report.runExitCode !== 0;
  const featureRows = report.features.map((feature) => `
    <section class="feature" id="feature-${encodeURIComponent(feature.name)}">
      <div class="feature-head"><h2>${escapeHtml(feature.name)}</h2><div class="metrics"><span>通过率 <b>${percent(feature.passRate)}</b></span><span>用例覆盖率 <b>${percent(feature.caseCoverage)}</b></span><span>代码行覆盖率 <b>${feature.codeCoverage ? percent(feature.codeCoverage.percent) : '未采集'}</b></span><span>${feature.passed}/${feature.executed} 通过</span></div></div>
      <details open><summary>测试用例（${feature.discovered}）</summary>
        <table><thead><tr><th>状态</th><th>用例</th><th>文件</th><th>耗时</th><th>错误</th></tr></thead><tbody>
          ${feature.cases.map((test) => `<tr><td><span class="status ${test.status}">${statusLabel(test.status)}</span></td><td>${escapeHtml([...test.ancestorTitles, test.title].join(' › '))}</td><td>${escapeHtml(test.relativeFile)}${test.line ? `:${test.line}` : ''}</td><td>${test.durationMs === null ? '—' : `${test.durationMs.toFixed(1)} ms`}</td><td class="error">${escapeHtml(test.failureMessages.join('\n'))}</td></tr>`).join('')}
        </tbody></table>
      </details>
    </section>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Weftwise 测试报告</title><style>
    :root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f7fb;color:#172033}body{margin:0;padding:32px;max-width:1440px;margin-inline:auto}header{margin-bottom:24px}h1{margin:0 0 8px;font-size:28px}p{color:#5f6b7a}.banner{padding:12px 16px;border-left:4px solid #dc2626;background:#fee2e2;color:#7f1d1d;margin:16px 0}.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:28px}.card{background:#fff;border:1px solid #dde3ee;border-radius:8px;padding:16px}.card b{display:block;font-size:24px;margin-top:6px}.feature{background:#fff;border:1px solid #dde3ee;border-radius:8px;margin:16px 0;overflow:hidden}.feature-head{display:flex;gap:16px;align-items:center;justify-content:space-between;padding:16px;border-bottom:1px solid #edf0f5}.feature-head h2{margin:0;font-size:18px}.metrics{display:flex;gap:14px;flex-wrap:wrap;color:#5f6b7a;font-size:13px}.metrics b{color:#172033}details{padding:0 16px 16px}summary{cursor:pointer;padding:14px 0;font-weight:600}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:9px;border-top:1px solid #edf0f5;vertical-align:top}th{color:#5f6b7a;font-weight:600}.status{display:inline-block;padding:3px 8px;border-radius:999px;font-weight:600;font-size:12px}.passed{background:#dcfce7;color:#166534}.failed{background:#fee2e2;color:#991b1b}.pending,.todo,.skipped,.not-run{background:#fef3c7;color:#92400e}.error{white-space:pre-wrap;color:#991b1b;max-width:500px}code{font-size:12px;word-break:break-all}@media(prefers-color-scheme:dark){:root{background:#111827;color:#e5e7eb}.card,.feature{background:#1f2937;border-color:#374151}.feature-head{border-color:#374151}.metrics b{color:#e5e7eb}th,td{border-color:#374151}.banner{background:#451a1a;color:#fecaca}}@media(max-width:760px){body{padding:18px}.feature-head{align-items:flex-start;flex-direction:column}table{display:block;overflow-x:auto;white-space:nowrap}}
  </style></head><body><header><h1>Weftwise 测试报告</h1><p>生成时间：${escapeHtml(report.generatedAt)}<br>命令：<code>${escapeHtml(report.command)}</code></p>${failedRun ? `<div class="banner">Vitest 退出码为 ${report.runExitCode}，报告仍已生成。请展开失败用例查看错误。</div>` : ''}</header><div class="summary"><div class="card">功能数<b>${report.features.length}</b></div><div class="card">用例通过率<b>${percent(report.totals.passRate)}</b><small>${report.totals.passed}/${report.totals.executed} 已执行用例通过</small></div><div class="card">用例执行覆盖率<b>${percent(report.totals.caseCoverage)}</b><small>${report.totals.executed}/${report.totals.discovered} 个清单用例有结果</small></div><div class="card">代码行覆盖率<b>${report.totals.codeCoverage ? percent(report.totals.codeCoverage.percent) : '未采集'}</b>${report.totals.codeCoverage ? `<small>${report.totals.codeCoverage.covered}/${report.totals.codeCoverage.total} 行</small>` : '<small>未找到 coverage-summary.json</small>'}</div></div>${featureRows}${report.runOutput ? `<details><summary>运行器输出</summary><pre>${escapeHtml(report.runOutput)}</pre></details>` : ''}</body></html>`;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { output: join(PROJECT_ROOT, 'test-report.html'), results: null, coverageSummary: null, coverage: false, noRun: false, testArgs: [] };
  const separator = argv.indexOf('--');
  const ownArgs = separator >= 0 ? argv.slice(0, separator) : argv;
  options.testArgs = separator >= 0 ? argv.slice(separator + 1) : [];
  for (let index = 0; index < ownArgs.length; index += 1) {
    const arg = ownArgs[index];
    if (arg === '--no-run') options.noRun = true;
    else if (arg === '--coverage') options.coverage = true;
    else if (arg === '--output' || arg === '-o') options.output = resolve(ownArgs[++index] ?? options.output);
    else if (arg === '--results') options.results = resolve(ownArgs[++index] ?? '');
    else if (arg === '--coverage-summary') options.coverageSummary = resolve(ownArgs[++index] ?? '');
  }
  return options;
}

function loadJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  const inventory = scanTestFiles(PROJECT_ROOT);
  let resultsPath = options.results;
  let tempDir: string | null = null;
  let runExitCode: number | null = null;
  let runOutput = '';
  try {
    if (!options.noRun) {
      tempDir = mkdtempSync(join(tmpdir(), 'weftwise-test-report-'));
      resultsPath = resultsPath ?? join(tempDir, 'vitest.json');
      const vitestBin = join(PROJECT_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest');
      const commandArgs = ['run', ...(options.coverage ? ['--coverage'] : []), ...options.testArgs, '--reporter=json', `--outputFile=${resultsPath}`];
      const result = spawnSync(vitestBin, commandArgs, { cwd: PROJECT_ROOT, encoding: 'utf8' });
      runExitCode = result.status ?? 1;
      runOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    }
    if ((!resultsPath || !existsSync(resultsPath)) && options.noRun) {
      throw new Error(`找不到 Vitest JSON 结果：${resultsPath ?? '(未指定)'}`);
    }
    const coveragePath = options.coverageSummary ?? join(PROJECT_ROOT, 'coverage', 'coverage-summary.json');
    const coverage = existsSync(coveragePath) ? loadJson(coveragePath) : undefined;
    const report = buildReport(inventory, resultsPath && existsSync(resultsPath) ? loadJson(resultsPath) : { testResults: [] }, { rootDir: PROJECT_ROOT, runExitCode, runOutput, coverage, command: `vitest ${options.noRun ? '结果复用' : 'run'}${options.coverage ? ' --coverage' : ''} --reporter=json` });
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, renderHtml(report), 'utf8');
    console.log(`测试报告已导出：${options.output}`);
    console.log(`功能 ${report.features.length} 个，用例通过率 ${percent(report.totals.passRate)}，用例执行覆盖率 ${percent(report.totals.caseCoverage)}，代码行覆盖率 ${report.totals.codeCoverage ? percent(report.totals.codeCoverage.percent) : '未采集'}`);
    return runExitCode ?? 0;
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

const invokedFile = process.argv[1] ? resolve(process.argv[1]) : '';
const thisFile = resolve(fileURLToPath(import.meta.url));
if (invokedFile === thisFile) {
  runCli().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(`测试报告生成失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
