import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'maintenance-settings-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

describe('maintenance settings', () => {
  it('默认值：关、24h、5 页、无上次扫描', async () => {
    const settings = await import('../settings-repo');
    expect(settings.getMaintenanceEnabled()).toBe(false);
    expect(settings.getMaintenanceSweepIntervalHours()).toBe(24);
    expect(settings.getMaintenanceMaxPagesPerSweep()).toBe(5);
    expect(settings.getMaintenanceLastSweepAt()).toBeNull();
  });

  it('写后可读回', async () => {
    const settings = await import('../settings-repo');
    settings.setMaintenanceEnabled(true);
    settings.setMaintenanceMaxPagesPerSweep(3);
    const iso = new Date().toISOString();
    settings.setMaintenanceLastSweepAt(iso);
    expect(settings.getMaintenanceEnabled()).toBe(true);
    expect(settings.getMaintenanceMaxPagesPerSweep()).toBe(3);
    expect(settings.getMaintenanceLastSweepAt()).toBe(iso);
  });

  it('边界值：sweepIntervalHours roundtrip', async () => {
    const settings = await import('../settings-repo');
    settings.setMaintenanceSweepIntervalHours(1);
    expect(settings.getMaintenanceSweepIntervalHours()).toBe(1);
    settings.setMaintenanceSweepIntervalHours(168);
    expect(settings.getMaintenanceSweepIntervalHours()).toBe(168);
  });

  it('超界值：拒绝非法输入', async () => {
    const settings = await import('../settings-repo');
    expect(() => settings.setMaintenanceSweepIntervalHours(0)).toThrow();
    expect(() => settings.setMaintenanceSweepIntervalHours(169)).toThrow();
    expect(() => settings.setMaintenanceMaxPagesPerSweep(0)).toThrow();
    expect(() => settings.setMaintenanceMaxPagesPerSweep(51)).toThrow();
  });
});
