import { getRawDb } from '../client';

export interface StoredRendition {
  subjectId: string;
  slug: string;
  canonicalHash: string;
  profileVersion: number;
  renderedMd: string;
  model: string | null;
  updatedAt: string;
}

export interface RenditionAssetInput {
  id: string;
  mediaType: string;
  dataBase64: string;
}

interface RenditionRow {
  subject_id: string;
  slug: string;
  canonical_hash: string;
  profile_version: number;
  rendered_md: string;
  model: string | null;
  updated_at: string;
}

function toStored(row: RenditionRow): StoredRendition {
  return {
    subjectId: row.subject_id,
    slug: row.slug,
    canonicalHash: row.canonical_hash,
    profileVersion: row.profile_version,
    renderedMd: row.rendered_md,
    model: row.model,
    updatedAt: row.updated_at,
  };
}

/** 返回该页最后一次成功版本；canonical/画像变化由调用方标为 stale，不隐藏旧版本。 */
export function getLatestRendition(subjectId: string, slug: string): StoredRendition | null {
  const row = getRawDb().prepare(`
    SELECT subject_id, slug, canonical_hash, profile_version, rendered_md, model, updated_at
    FROM page_renditions WHERE subject_id = ? AND slug = ?
  `).get(subjectId, slug) as RenditionRow | undefined;
  return row ? toStored(row) : null;
}

/** 完整生成成功后才调用；正文与图片原子替换，失败自动回滚旧版本。 */
export function replaceRendition(row: {
  subjectId: string;
  slug: string;
  canonicalHash: string;
  profileVersion: number;
  renderedMd: string;
  model: string | null;
  assets: RenditionAssetInput[];
}): void {
  const sqlite = getRawDb();
  const now = new Date().toISOString();
  const replace = sqlite.transaction(() => {
    sqlite.prepare(`DELETE FROM page_rendition_assets WHERE subject_id = ? AND slug = ?`)
      .run(row.subjectId, row.slug);
    sqlite.prepare(`
      INSERT INTO page_renditions
        (subject_id, slug, canonical_hash, profile_version, rendered_md, model, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subject_id, slug) DO UPDATE SET
        canonical_hash = excluded.canonical_hash,
        profile_version = excluded.profile_version,
        rendered_md = excluded.rendered_md,
        model = excluded.model,
        updated_at = excluded.updated_at
    `).run(
      row.subjectId,
      row.slug,
      row.canonicalHash,
      row.profileVersion,
      row.renderedMd,
      row.model,
      now,
    );
    const insertAsset = sqlite.prepare(`
      INSERT INTO page_rendition_assets
        (id, subject_id, slug, media_type, data_base64, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const asset of row.assets) {
      insertAsset.run(asset.id, row.subjectId, row.slug, asset.mediaType, asset.dataBase64, now);
    }
  });
  replace.immediate();
}

export function getRenditionAsset(id: string): { mediaType: string; dataBase64: string } | null {
  const row = getRawDb().prepare(`
    SELECT media_type, data_base64 FROM page_rendition_assets WHERE id = ?
  `).get(id) as { media_type: string; data_base64: string } | undefined;
  return row ? { mediaType: row.media_type, dataBase64: row.data_base64 } : null;
}

export function deleteBySubject(subjectId: string): void {
  const sqlite = getRawDb();
  const remove = sqlite.transaction(() => {
    sqlite.prepare(`DELETE FROM page_rendition_assets WHERE subject_id = ?`).run(subjectId);
    sqlite.prepare(`DELETE FROM page_renditions WHERE subject_id = ?`).run(subjectId);
  });
  remove.immediate();
}
