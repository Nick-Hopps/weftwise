import { describe, it, expect } from 'vitest';
import {
  SUBJECT_ARCHIVE_FORMAT_VERSION,
  buildManifest,
  parseManifest,
  validateEntryPath,
  mapEntryToVaultRelPath,
  ArchiveError,
} from '../subject-archive-core';
import type { Subject } from '@/lib/contracts';

const subject: Subject = {
  id: 'id-1',
  slug: 'physics',
  name: 'Physics',
  description: 'desc',
  augmentationLevel: 'standard',
  createdAt: '2026-07-17T00:00:00.000Z',
  updatedAt: '2026-07-17T00:00:00.000Z',
};

describe('buildManifest / parseManifest', () => {
  it('round-trips subject metadata', () => {
    const manifest = buildManifest(subject, '2026-07-17T01:00:00.000Z');
    const parsed = parseManifest(JSON.stringify(manifest));
    expect(parsed.formatVersion).toBe(SUBJECT_ARCHIVE_FORMAT_VERSION);
    expect(parsed.subject).toEqual({
      slug: 'physics',
      name: 'Physics',
      description: 'desc',
      augmentationLevel: 'standard',
    });
    expect(parsed.exportedAt).toBe('2026-07-17T01:00:00.000Z');
  });

  it('rejects invalid JSON', () => {
    expect(() => parseManifest('not-json')).toThrowError(ArchiveError);
    try {
      parseManifest('not-json');
    } catch (e) {
      expect((e as ArchiveError).code).toBe('invalid-manifest');
    }
  });

  it('rejects missing subject fields', () => {
    const bad = JSON.stringify({ formatVersion: 1, exportedAt: 'x', subject: { slug: 'a' } });
    expect(() => parseManifest(bad)).toThrowError(ArchiveError);
  });

  it('rejects unsupported formatVersion', () => {
    const manifest = buildManifest(subject, 'x');
    const bad = JSON.stringify({ ...manifest, formatVersion: 999 });
    try {
      parseManifest(bad);
      expect.unreachable();
    } catch (e) {
      expect((e as ArchiveError).code).toBe('unsupported-version');
    }
  });

  it('rejects manifest whose subject slug is not kebab-case', () => {
    const manifest = buildManifest(subject, 'x');
    const bad = JSON.stringify({
      ...manifest,
      subject: { ...manifest.subject, slug: '../evil' },
    });
    expect(() => parseManifest(bad)).toThrowError(ArchiveError);
  });
});

describe('validateEntryPath', () => {
  it('accepts files under whitelisted dirs', () => {
    expect(validateEntryPath('wiki/index.md')).toBe('wiki/index.md');
    expect(validateEntryPath('raw/some file.pdf')).toBe('raw/some file.pdf');
    expect(validateEntryPath('assets/a/b.png')).toBe('assets/a/b.png');
    expect(validateEntryPath('sources/abc.json')).toBe('sources/abc.json');
  });

  it('accepts manifest.json at root', () => {
    expect(validateEntryPath('manifest.json')).toBe('manifest.json');
  });

  it('normalizes backslashes', () => {
    expect(validateEntryPath('wiki\\sub\\page.md')).toBe('wiki/sub/page.md');
  });

  it('rejects traversal, absolute and out-of-whitelist paths', () => {
    expect(validateEntryPath('../evil.md')).toBeNull();
    expect(validateEntryPath('wiki/../../evil.md')).toBeNull();
    expect(validateEntryPath('/etc/passwd')).toBeNull();
    expect(validateEntryPath('other/file.md')).toBeNull();
    expect(validateEntryPath('rootfile.md')).toBeNull();
    expect(validateEntryPath('wiki/')).toBeNull();
    expect(validateEntryPath('')).toBeNull();
  });
});

describe('mapEntryToVaultRelPath', () => {
  it('maps archive dirs onto subject-scoped vault paths', () => {
    expect(mapEntryToVaultRelPath('wiki/index.md', 'phys')).toBe('wiki/phys/index.md');
    expect(mapEntryToVaultRelPath('raw/doc.pdf', 'phys')).toBe('raw/phys/doc.pdf');
    expect(mapEntryToVaultRelPath('assets/img.png', 'phys')).toBe('assets/phys/img.png');
    expect(mapEntryToVaultRelPath('sources/s.json', 'phys')).toBe(
      '.llm-wiki/sources/phys/s.json',
    );
  });

  it('returns null for manifest.json and unknown dirs', () => {
    expect(mapEntryToVaultRelPath('manifest.json', 'phys')).toBeNull();
    expect(mapEntryToVaultRelPath('other/x.md', 'phys')).toBeNull();
  });
});
