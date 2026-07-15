import type { MermaidConfig } from 'mermaid';

const LIGHT_THEME = {
  background: '#ffffff',
  primaryColor: '#ffffff',
  primaryTextColor: '#29292d',
  primaryBorderColor: '#d7d7dc',
  secondaryColor: '#f2f1ff',
  secondaryTextColor: '#3f3eb8',
  secondaryBorderColor: '#8d89f2',
  tertiaryColor: '#f7f7f6',
  tertiaryTextColor: '#52525b',
  tertiaryBorderColor: '#e4e4e7',
  lineColor: '#85858f',
  textColor: '#29292d',
  edgeLabelBackground: '#ffffff',
  clusterBkg: '#f7f7f6',
  clusterBorder: '#e4e4e7',
  noteBkgColor: '#f7f7f6',
  noteBorderColor: '#d7d7dc',
} as const;

const DARK_THEME = {
  background: '#1a1a1a',
  primaryColor: '#242426',
  primaryTextColor: '#ededed',
  primaryBorderColor: '#48484f',
  secondaryColor: '#292942',
  secondaryTextColor: '#cccafa',
  secondaryBorderColor: '#7772e8',
  tertiaryColor: '#202022',
  tertiaryTextColor: '#d4d4d8',
  tertiaryBorderColor: '#3a3a3f',
  lineColor: '#94949e',
  textColor: '#ededed',
  edgeLabelBackground: '#1a1a1a',
  clusterBkg: '#202022',
  clusterBorder: '#3a3a3f',
  noteBkgColor: '#202022',
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
