import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const globalsCss = readFileSync(
  new URL('../../../app/globals.css', import.meta.url),
  'utf8',
);

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = globalsCss.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm'));
  if (!match) throw new Error(`Missing CSS block: ${selector}`);
  return match[1];
}

function declaration(block: string, token: string): string {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`${escaped}:\\s*([^;]+);`));
  if (!match) throw new Error(`Missing CSS declaration: ${token}`);
  return match[1].trim().replace(/\s+/g, ' ');
}

describe('theme token semantic contract', () => {
  const root = cssBlock(':root');
  const dark = cssBlock('.dark');

  it('uses warp indigo for light-theme actions, focus, selection, and active graph state', () => {
    expect(declaration(root, '--color-border-accent')).toBe('var(--base-warp-500)');
    expect(declaration(root, '--color-accent-primary')).toBe('var(--base-warp-500)');
    expect(declaration(root, '--color-accent-primary-hover')).toBe('var(--base-warp-600)');
    expect(declaration(root, '--color-accent-primary-active')).toBe('var(--base-warp-700)');
    expect(declaration(root, '--color-accent-subtle')).toBe('var(--base-warp-50)');
    expect(declaration(root, '--color-accent-strong-fg')).toBe('var(--base-warp-700)');
    expect(declaration(root, '--color-input-border-focus')).toBe('var(--base-warp-500)');
    expect(declaration(root, '--color-focus-ring')).toBe('var(--base-warp-500)');
    expect(declaration(root, '--color-selection-bg')).toBe('var(--base-warp-100)');
    expect(declaration(root, '--color-graph-active')).toBe('var(--base-warp-500)');
  });

  it('uses warp indigo for dark-theme actions and interaction feedback', () => {
    expect(declaration(dark, '--color-border-accent')).toBe('var(--base-warp-400)');
    expect(declaration(dark, '--color-accent-primary')).toBe('var(--base-warp-400)');
    expect(declaration(dark, '--color-accent-primary-hover')).toBe('var(--base-warp-200)');
    expect(declaration(dark, '--color-accent-primary-active')).toBe('var(--base-warp-500)');
    expect(declaration(dark, '--color-accent-subtle')).toBe('31 35 47');
    expect(declaration(dark, '--color-accent-strong-fg')).toBe('var(--base-warp-200)');
    expect(declaration(dark, '--color-input-border-focus')).toBe('var(--base-warp-400)');
    expect(declaration(dark, '--color-focus-ring')).toBe('var(--base-warp-400)');
    expect(declaration(dark, '--color-selection-bg')).toBe('var(--color-accent-subtle)');
    expect(declaration(dark, '--color-graph-active')).toBe('var(--base-warp-400)');
  });

  it('keeps brand weft and danger red independent from normal interaction colors', () => {
    expect(declaration(root, '--brand-weft')).toBe('217 72 47');
    expect(declaration(dark, '--brand-weft')).toBe('255 107 77');
    expect(declaration(root, '--color-danger-fg')).toBe('var(--base-danger-600)');
    expect(declaration(root, '--color-danger-bg')).toBe('var(--base-danger-50)');
    expect(declaration(root, '--color-danger-border')).toBe('var(--base-danger-500)');
  });
});
