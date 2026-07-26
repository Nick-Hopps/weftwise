import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let previousDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'page-identity-move-'));
  previousDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = previousDb;
  rmSync(dir, { recursive: true, force: true });
});

describe('migratePageIdentityCaches', () => {
  it('幂等迁移来源、向量、成熟度、rendition 与掌握度证据，并可反向迁移', async () => {
    const { getRawDb } = await import('../../db/client');
    const { migratePageIdentityCaches } = await import('../page-identity-migration');
    const db = getRawDb();
    db.prepare(`
      INSERT INTO subjects (id, slug, name, description, created_at, updated_at)
      VALUES ('s1', 'general-move', 'General', '', 'now', 'now')
    `).run();
    db.prepare(`INSERT INTO page_sources VALUES ('s1','old-page','source-1')`).run();
    db.prepare(`
      INSERT INTO page_embeddings VALUES ('s1','old-page','m','h',1,?, 'now')
    `).run(Buffer.from([1]));
    db.prepare(`
      INSERT INTO page_maturity VALUES ('s1','old-page',3,'then',7,'next','active',2,'now')
    `).run();
    db.prepare(`
      INSERT INTO page_renditions VALUES ('s1','old-page','h',2,'rendered','m','now','{"mastered":[]}')
    `).run();
    db.prepare(`
      INSERT INTO page_rendition_assets VALUES ('asset-1','s1','old-page','image/png','YQ==','now')
    `).run();
    db.prepare(`
      INSERT INTO page_evidence
        (user_id,subject_id,slug,kind,polarity,strength,anchor,detail_json,created_at)
      VALUES ('local','s1','old-page','quiz-correct','positive','strong','q1',NULL,'now')
    `).run();

    migratePageIdentityCaches('s1', { fromSlug: 'old-page', toSlug: 'new-page' });
    migratePageIdentityCaches('s1', { fromSlug: 'old-page', toSlug: 'new-page' });

    for (const [table, column] of [
      ['page_sources', 'page_slug'],
      ['page_embeddings', 'slug'],
      ['page_maturity', 'slug'],
      ['page_renditions', 'slug'],
      ['page_rendition_assets', 'slug'],
      ['page_evidence', 'slug'],
    ]) {
      expect(db.prepare(`SELECT ${column} AS slug FROM ${table}`).all())
        .toEqual([{ slug: 'new-page' }]);
    }

    // 显式列清单漏掉 known_concepts_json 的话，改名一次就把地图快照静默抹成 NULL——
    // 纠错入口全消失、stale 退回旧两项，且不报任何错。
    expect(db.prepare(`SELECT known_concepts_json AS j FROM page_renditions`).all())
      .toEqual([{ j: '{"mastered":[]}' }]);

    migratePageIdentityCaches('s1', { fromSlug: 'new-page', toSlug: 'old-page' });
    expect(db.prepare(`SELECT page_slug AS slug FROM page_sources`).all())
      .toEqual([{ slug: 'old-page' }]);
    expect(db.prepare(`SELECT slug FROM page_maturity`).all())
      .toEqual([{ slug: 'old-page' }]);
    expect(db.prepare(`SELECT slug FROM page_rendition_assets`).all())
      .toEqual([{ slug: 'old-page' }]);
  });
});
