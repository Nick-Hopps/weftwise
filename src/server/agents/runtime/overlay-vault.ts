import fs from 'node:fs';
import type { ChangesetEntry } from '@/lib/contracts';
import type { OverlayVault } from '../types';
import { scanWikiPages } from '../../wiki/wiki-store';
import { parseFrontmatter } from '../../wiki/frontmatter';
import { vaultPath } from '../../config/env';

interface OverlayEntry {
  subjectSlug: string;
  slug: string;
  title: string;
  summary: string;
  body: string;
  raw: string;
  deleted: boolean;
}

function pathToSubjectSlug(path: string): { subjectSlug: string; slug: string } | null {
  const m = path.match(/^wiki\/([^/]+)\/(.+?)\.md$/);
  if (!m) return null;
  return { subjectSlug: m[1], slug: m[2] };
}

function entryToOverlay(entry: ChangesetEntry): OverlayEntry | null {
  const parts = pathToSubjectSlug(entry.path);
  if (!parts) return null;
  if (entry.action === 'delete') {
    return { ...parts, title: '', summary: '', body: '', raw: '', deleted: true };
  }
  const raw = entry.content ?? '';
  // 经修复版 parseFrontmatter 解析（容错 LLM 全角冒号 key + 绕过 gray-matter 缓存中毒），
  // 不可直接 matter(raw)——否则非法 frontmatter 会在 putEntries 抛错，
  // 令 resume rehydrate 检查点时整个 ingest job failed。
  const { data, body } = parseFrontmatter(raw);
  return {
    ...parts,
    title: data.title || parts.slug,
    summary: data.summary ?? '',
    body,
    raw,
    deleted: false,
  };
}

function readDiskMarkdown(subjectSlug: string, slug: string): string | null {
  try {
    return fs.readFileSync(vaultPath('wiki', subjectSlug, `${slug}.md`), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

interface ScannedPageLike {
  subjectSlug: string;
  slug: string;
  content: string;
}

export function createOverlayVault(opts: { subjectSlug: string }): OverlayVault {
  const entries = new Map<string, OverlayEntry>();
  const key = (subjectSlug: string, slug: string) => `${subjectSlug}::${slug}`;

  const overlay: OverlayVault = {
    async readPage(subjectSlug, slug) {
      const o = entries.get(key(subjectSlug, slug));
      if (o) return o.deleted ? null : { markdown: o.raw };
      const md = readDiskMarkdown(subjectSlug, slug);
      return md === null ? null : { markdown: md };
    },

    async search(subjectSlug, query) {
      const q = query.toLowerCase();
      const overlayHits: Array<{ slug: string; title: string; summary: string; source: 'overlay' | 'store' }> = [];
      for (const o of entries.values()) {
        if (o.subjectSlug !== subjectSlug || o.deleted) continue;
        const hay = `${o.slug} ${o.title} ${o.summary} ${o.body}`.toLowerCase();
        if (hay.includes(q)) {
          overlayHits.push({ slug: o.slug, title: o.title, summary: o.summary, source: 'overlay' });
        }
      }
      const scanned = scanWikiPages(subjectSlug) as ScannedPageLike[];
      const storeHits: Array<{ slug: string; title: string; summary: string; source: 'overlay' | 'store' }> = [];
      for (const page of scanned) {
        // Skip pages already covered by overlay (overlay wins)
        if (entries.has(key(subjectSlug, page.slug))) continue;
        const { data } = parseFrontmatter(page.content);
        const title = data.title || page.slug;
        const summary = data.summary ?? '';
        // Include raw content (which contains frontmatter YAML) so keys like "summary:" are searchable
        const hay = `${page.slug} ${title} ${summary} ${page.content}`.toLowerCase();
        if (hay.includes(q)) {
          storeHits.push({ slug: page.slug, title, summary, source: 'store' });
        }
      }
      return [...overlayHits, ...storeHits];
    },

    putEntries(es) {
      for (const e of es) {
        const o = entryToOverlay(e);
        if (o) entries.set(key(o.subjectSlug, o.slug), o);
      }
    },

    snapshot() {
      const snap = createOverlayVault(opts);
      const synth: ChangesetEntry[] = [];
      for (const v of entries.values()) {
        synth.push(
          v.deleted
            ? { action: 'delete', path: `wiki/${v.subjectSlug}/${v.slug}.md`, content: null }
            : { action: 'create', path: `wiki/${v.subjectSlug}/${v.slug}.md`, content: v.raw },
        );
      }
      snap.putEntries(synth);
      return snap;
    },
  };
  return overlay;
}
