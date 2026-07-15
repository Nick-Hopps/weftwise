import { describe, expect, it } from 'vitest';
import { createMermaidConfig } from '@/components/wiki/mermaid-theme';

describe('createMermaidConfig', () => {
  it('uses compact curved flowcharts and a restrained light palette', () => {
    const config = createMermaidConfig(false);
    expect(config.theme).toBe('base');
    expect(config.flowchart).toMatchObject({
      curve: 'monotoneX',
      nodeSpacing: 34,
      rankSpacing: 54,
      padding: 10,
    });
    expect(config.themeVariables).toMatchObject({
      primaryColor: '#ffffff',
      lineColor: '#85858f',
    });
  });

  it('switches generated SVG colors for dark mode', () => {
    const light = createMermaidConfig(false);
    const dark = createMermaidConfig(true);
    expect(dark.themeVariables?.primaryColor).toBe('#242426');
    expect(dark.themeVariables?.primaryTextColor).toBe('#ededed');
    expect(dark.themeVariables?.primaryColor).not.toBe(light.themeVariables?.primaryColor);
  });
});
