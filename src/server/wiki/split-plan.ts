/**
 * 把 LLM 产出的拆分页清单整理为可落盘的页：派生唯一 slug、保证恰一个 primary。
 * 纯函数、无副作用。详见 docs/superpowers/specs/2026-06-22-page-split-design.md。
 */
import { deriveUniqueSlug } from './page-identity';

export interface LlmSplitPage {
  title: string;
  body: string;
  summary: string;
  isPrimary: boolean;
}

export interface PlannedSplitPage extends LlmSplitPage {
  slug: string;
}

export function planSplitPages(
  pages: LlmSplitPage[],
  existingSlugs: Set<string>,
  sourceSlug: string,
): PlannedSplitPage[] {
  // 冲突集合：现有页 ∪ A 自己的 slug（要删，但不复用）∪ 已分配的新 slug
  const taken = new Set<string>([...existingSlugs, sourceSlug]);
  const planned: PlannedSplitPage[] = [];

  let primaryAssigned = false;
  for (const p of pages) {
    const slug = deriveUniqueSlug(p.title, taken);
    taken.add(slug);

    let isPrimary = false;
    if (p.isPrimary && !primaryAssigned) {
      isPrimary = true;
      primaryAssigned = true;
    }
    planned.push({ ...p, isPrimary, slug });
  }

  // LLM 未标任何 primary → 第一个兜底为 primary
  if (!primaryAssigned && planned.length > 0) {
    planned[0] = { ...planned[0], isPrimary: true };
  }

  return planned;
}
