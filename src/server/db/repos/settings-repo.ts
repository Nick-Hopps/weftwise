import { eq } from 'drizzle-orm';
import { getDb } from '../client';
import { appSettings } from '../schema';
import { DEFAULT_WIKI_LANGUAGE, WikiLanguageSchema } from '@/lib/contracts';

const KEY_WIKI_LANGUAGE = 'wikiLanguage';

function readKey(key: string): string | undefined {
  const db = getDb();
  const row = db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .get();
  return row?.value;
}

function writeKey(key: string, value: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.insert(appSettings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: now },
    })
    .run();
}

/**
 * Returns the configured wiki language. Falls back to DEFAULT_WIKI_LANGUAGE
 * when no row has been written yet. Reads the DB on every call so changes
 * made via the settings dialog take effect on the next LLM task without a
 * worker restart.
 */
export function getWikiLanguage(): string {
  return readKey(KEY_WIKI_LANGUAGE) ?? DEFAULT_WIKI_LANGUAGE;
}

/**
 * Persists a new wiki language. Validates via WikiLanguageSchema (throws on
 * empty / whitespace / over-long input). Returns the canonical (trimmed) value.
 */
export function setWikiLanguage(value: string): string {
  const validated = WikiLanguageSchema.parse(value);
  writeKey(KEY_WIKI_LANGUAGE, validated);
  return validated;
}
