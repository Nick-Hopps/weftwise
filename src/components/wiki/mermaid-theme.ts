import type { MermaidConfig } from 'mermaid';

/* secondary 家族 = 品牌经线靛（warp），与全局 --base-warp-* 对齐。 */
const LIGHT_THEME = {
  background: '#ffffff',
  primaryColor: '#ffffff',
  primaryTextColor: '#29292d',
  primaryBorderColor: '#d7d7dc',
  secondaryColor: '#eef1f7',
  secondaryTextColor: '#323c5a',
  secondaryBorderColor: '#93a3cf',
  tertiaryColor: '#f6f5f2',
  tertiaryTextColor: '#52525b',
  tertiaryBorderColor: '#e4e4e7',
  lineColor: '#85858f',
  textColor: '#29292d',
  edgeLabelBackground: '#ffffff',
  clusterBkg: '#f6f5f2',
  clusterBorder: '#e4e4e7',
  noteBkgColor: '#f6f5f2',
  noteBorderColor: '#d7d7dc',
} as const;

const DARK_THEME = {
  background: '#1a1a1d',
  primaryColor: '#242428',
  primaryTextColor: '#ededed',
  primaryBorderColor: '#48484f',
  secondaryColor: '#262b38',
  secondaryTextColor: '#c6d2ec',
  secondaryBorderColor: '#6f84b8',
  tertiaryColor: '#202023',
  tertiaryTextColor: '#d4d4d8',
  tertiaryBorderColor: '#3a3a41',
  lineColor: '#94949e',
  textColor: '#ededed',
  edgeLabelBackground: '#1a1a1d',
  clusterBkg: '#202023',
  clusterBorder: '#3a3a41',
  noteBkgColor: '#202023',
  noteBorderColor: '#48484f',
} as const;

export function createMermaidConfig(darkMode: boolean): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    themeVariables: {
      ...(darkMode ? DARK_THEME : LIGHT_THEME),
      fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
      fontSize: '14px',
    },
    flowchart: {
      curve: 'monotoneX',
      nodeSpacing: 34,
      rankSpacing: 54,
      padding: 10,
      useMaxWidth: true,
    },
  };
}
