export interface UnifiedDiffEntry {
  action: 'create' | 'update' | 'delete';
  path: string;
  before: string | null;
  after: string | null;
}

const CONTEXT_LINES = 3;

function splitLines(value: string | null): string[] {
  if (value === null || value.length === 0) return [];
  return value.split('\n');
}

function range(start: number, count: number): string {
  return count === 0 ? '0,0' : `${start + 1},${count}`;
}

function diffEntry(entry: UnifiedDiffEntry): string {
  const before = splitLines(entry.before);
  const after = splitLines(entry.after);

  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix += 1;
  }

  const contextStart = Math.max(0, prefix - CONTEXT_LINES);
  const beforeChangeEnd = before.length - suffix;
  const afterChangeEnd = after.length - suffix;
  const beforeEnd = Math.min(before.length, beforeChangeEnd + CONTEXT_LINES);
  const afterEnd = Math.min(after.length, afterChangeEnd + CONTEXT_LINES);
  const oldPath = entry.before === null ? '/dev/null' : `a/${entry.path}`;
  const newPath = entry.after === null ? '/dev/null' : `b/${entry.path}`;
  const lines = [
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    `@@ -${range(contextStart, beforeEnd - contextStart)} +${range(contextStart, afterEnd - contextStart)} @@`,
  ];

  for (let index = contextStart; index < prefix; index += 1) {
    lines.push(` ${before[index]}`);
  }
  for (let index = prefix; index < beforeChangeEnd; index += 1) {
    lines.push(`-${before[index]}`);
  }
  for (let index = prefix; index < afterChangeEnd; index += 1) {
    lines.push(`+${after[index]}`);
  }
  for (let index = 0; index < Math.min(CONTEXT_LINES, suffix); index += 1) {
    lines.push(` ${before[beforeChangeEnd + index]}`);
  }

  return `${lines.join('\n')}\n`;
}

export function buildUnifiedDiff(entries: UnifiedDiffEntry[]): string {
  return entries
    .filter((entry) => entry.before !== entry.after)
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(diffEntry)
    .join('\n');
}
