import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const VISIBLE_ATTRIBUTES = new Set([
  'alt',
  'aria-label',
  'description',
  'label',
  'loadingLabel',
  'placeholder',
  'retryLabel',
  'title',
]);

const ALLOWED_LITERALS = new Set([
  'ESC',
  'Esc',
  'URL:',
  'cause:',
  'finishReason:',
  'frontend-architecture',
  'response:',
  'tvly-…',
  'usage:',
  'v',
  'weftwise',
  'weftwise 织识',
  '织识',
  '⌘I',
  '⌘J',
  '⌘K',
  '⌘O',
]);

interface Finding {
  file: string;
  line: number;
  kind: string;
  text: string;
}

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    if (!absolute.endsWith('.tsx') || absolute.includes('/__tests__/')) return [];
    return [absolute];
  });
}

function normalizedVisibleText(value: string): string | null {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || !/[A-Za-z\p{Script=Han}]/u.test(text)) return null;
  return text;
}

function renderedStrings(expression: ts.Expression | undefined): string[] {
  if (!expression) return [];
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return [expression.text];
  }
  if (ts.isTemplateExpression(expression)) {
    return [expression.head.text, ...expression.templateSpans.map((span) => span.literal.text)];
  }
  if (ts.isConditionalExpression(expression)) {
    return [...renderedStrings(expression.whenTrue), ...renderedStrings(expression.whenFalse)];
  }
  if (ts.isParenthesizedExpression(expression)) return renderedStrings(expression.expression);
  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind;
    if (
      operator === ts.SyntaxKind.BarBarToken
      || operator === ts.SyntaxKind.QuestionQuestionToken
      || operator === ts.SyntaxKind.PlusToken
    ) {
      return [...renderedStrings(expression.left), ...renderedStrings(expression.right)];
    }
  }
  return [];
}

function auditFile(root: string, filename: string): Finding[] {
  const source = ts.createSourceFile(
    filename,
    fs.readFileSync(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const findings: Finding[] = [];

  function record(node: ts.Node, kind: string, raw: string) {
    const text = normalizedVisibleText(raw);
    if (!text || ALLOWED_LITERALS.has(text)) return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({
      file: path.relative(root, filename),
      line: line + 1,
      kind,
      text,
    });
  }

  function visit(node: ts.Node) {
    if (ts.isJsxText(node)) record(node, 'text', node.text);

    if (
      ts.isJsxExpression(node)
      && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      for (const text of renderedStrings(node.expression)) record(node, 'expression', text);
    }

    if (
      ts.isJsxAttribute(node)
      && ts.isIdentifier(node.name)
      && VISIBLE_ATTRIBUTES.has(node.name.text)
    ) {
      if (node.initializer && ts.isStringLiteral(node.initializer)) {
        record(node, node.name.text, node.initializer.text);
      } else if (node.initializer && ts.isJsxExpression(node.initializer)) {
        for (const text of renderedStrings(node.initializer.expression)) {
          record(node, node.name.text, text);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(source);
  return findings;
}

describe('UI i18n source coverage', () => {
  it('does not render unapproved hard-coded product copy', () => {
    const root = process.cwd();
    const findings = [path.join(root, 'src/app'), path.join(root, 'src/components')]
      .flatMap(sourceFiles)
      .flatMap((filename) => auditFile(root, filename))
      .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);

    expect(findings.map((finding) =>
      `${finding.file}:${finding.line} [${finding.kind}] ${finding.text}`,
    )).toEqual([]);
  });
});
