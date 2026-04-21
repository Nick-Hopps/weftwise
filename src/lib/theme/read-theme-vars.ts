/**
 * Read semantic CSS variables from `:root` at runtime. Used by JS-driven
 * libraries (Cytoscape, canvas) that cannot consume Tailwind classes.
 *
 * Tokens are stored as `R G B` triples (no commas, no "rgb(...)" wrapper) so
 * they compose with `<alpha-value>` in Tailwind. `readThemeColor` converts a
 * triple to an actual CSS color string suitable for third-party libraries.
 */

export type ThemeSnapshot = {
  canvas: string;
  node: string;
  nodeBorder: string;
  orphan: string;
  edge: string;
  label: string;
  active: string;
  accent: string;
  border: string;
};

function toRgb(triple: string, alpha = 1): string {
  const t = triple.trim();
  if (!t) return alpha === 1 ? '#000000' : `rgba(0,0,0,${alpha})`;
  return alpha === 1 ? `rgb(${t.replace(/\s+/g, ',')})` : `rgba(${t.replace(/\s+/g, ',')},${alpha})`;
}

export function readThemeColor(cssVarName: string, alpha = 1): string {
  if (typeof window === 'undefined') return '#000000';
  const raw = getComputedStyle(document.documentElement).getPropertyValue(cssVarName);
  return toRgb(raw, alpha);
}

export function readGraphTheme(): ThemeSnapshot {
  return {
    canvas:     readThemeColor('--color-graph-canvas'),
    node:       readThemeColor('--color-graph-node'),
    nodeBorder: readThemeColor('--color-graph-node-border'),
    orphan:     readThemeColor('--color-graph-orphan'),
    edge:       readThemeColor('--color-graph-edge'),
    label:      readThemeColor('--color-graph-label'),
    active:     readThemeColor('--color-graph-active'),
    accent:     readThemeColor('--color-accent-primary'),
    border:     readThemeColor('--color-border-default'),
  };
}
