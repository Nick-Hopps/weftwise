import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        canvas:   'rgb(var(--color-bg-canvas) / <alpha-value>)',
        surface:  'rgb(var(--color-bg-surface) / <alpha-value>)',
        subtle:   'rgb(var(--color-bg-subtle) / <alpha-value>)',
        elevated: 'rgb(var(--color-bg-elevated) / <alpha-value>)',
        overlay:  'rgb(var(--color-bg-overlay) / <alpha-value>)',

        foreground: {
          DEFAULT:   'rgb(var(--color-fg-primary) / <alpha-value>)',
          secondary: 'rgb(var(--color-fg-secondary) / <alpha-value>)',
          tertiary:  'rgb(var(--color-fg-tertiary) / <alpha-value>)',
          disabled:  'rgb(var(--color-fg-disabled) / <alpha-value>)',
          inverse:   'rgb(var(--color-fg-inverse) / <alpha-value>)',
        },

        border: {
          DEFAULT: 'rgb(var(--color-border-default) / <alpha-value>)',
          subtle:  'rgb(var(--color-border-subtle) / <alpha-value>)',
          strong:  'rgb(var(--color-border-strong) / <alpha-value>)',
          accent:  'rgb(var(--color-border-accent) / <alpha-value>)',
        },

        accent: {
          DEFAULT: 'rgb(var(--color-accent-primary) / <alpha-value>)',
          hover:   'rgb(var(--color-accent-primary-hover) / <alpha-value>)',
          active:  'rgb(var(--color-accent-primary-active) / <alpha-value>)',
          subtle:  'rgb(var(--color-accent-subtle) / <alpha-value>)',
          fg:      'rgb(var(--color-accent-fg) / <alpha-value>)',
          strong:  'rgb(var(--color-accent-strong-fg) / <alpha-value>)',
        },

        success: {
          DEFAULT: 'rgb(var(--color-success-fg) / <alpha-value>)',
          bg:      'rgb(var(--color-success-bg) / <alpha-value>)',
          border:  'rgb(var(--color-success-border) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'rgb(var(--color-warning-fg) / <alpha-value>)',
          bg:      'rgb(var(--color-warning-bg) / <alpha-value>)',
          border:  'rgb(var(--color-warning-border) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'rgb(var(--color-danger-fg) / <alpha-value>)',
          bg:      'rgb(var(--color-danger-bg) / <alpha-value>)',
          border:  'rgb(var(--color-danger-border) / <alpha-value>)',
        },
        info: {
          DEFAULT: 'rgb(var(--color-info-fg) / <alpha-value>)',
        },

        input: {
          bg:            'rgb(var(--color-input-bg) / <alpha-value>)',
          border:        'rgb(var(--color-input-border) / <alpha-value>)',
          'border-focus':'rgb(var(--color-input-border-focus) / <alpha-value>)',
          placeholder:   'rgb(var(--color-input-placeholder) / <alpha-value>)',
        },

        focus: {
          ring: 'rgb(var(--color-focus-ring) / <alpha-value>)',
        },

        prose: {
          heading:   'rgb(var(--color-prose-heading) / <alpha-value>)',
          body:      'rgb(var(--color-prose-body) / <alpha-value>)',
          muted:     'rgb(var(--color-prose-muted) / <alpha-value>)',
          code:      'rgb(var(--color-code-fg) / <alpha-value>)',
          'code-bg': 'rgb(var(--color-code-bg) / <alpha-value>)',
          quote:     'rgb(var(--color-quote-border) / <alpha-value>)',
        },

        graph: {
          canvas:        'rgb(var(--color-graph-canvas) / <alpha-value>)',
          node:          'rgb(var(--color-graph-node) / <alpha-value>)',
          'node-border':'rgb(var(--color-graph-node-border) / <alpha-value>)',
          orphan:        'rgb(var(--color-graph-orphan) / <alpha-value>)',
          edge:          'rgb(var(--color-graph-edge) / <alpha-value>)',
          label:         'rgb(var(--color-graph-label) / <alpha-value>)',
          active:        'rgb(var(--color-graph-active) / <alpha-value>)',
        },
      },

      spacing: {
        header:          'var(--header-height)',
        sidebar:         'var(--sidebar-width)',
        'context-panel': 'var(--context-panel-width)',
      },

      maxWidth: {
        content: 'var(--content-max-width)',
      },

      fontFamily: {
        sans: ['var(--font-inter)', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-jetbrains-mono)', 'JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        display: ['var(--font-space-grotesk)', 'Space Grotesk', 'var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },

      fontSize: {
        xs:    ['12px', { lineHeight: '16px' }],
        sm:    ['13px', { lineHeight: '18px' }],
        base:  ['14px', { lineHeight: '20px' }],
        md:    ['15px', { lineHeight: '24px' }],
        lg:    ['16px', { lineHeight: '24px' }],
        xl:    ['20px', { lineHeight: '28px' }],
        '2xl': ['24px', { lineHeight: '32px' }],
        '3xl': ['30px', { lineHeight: '36px' }],
      },

      borderRadius: {
        none:    '0',
        sm:      'var(--radius-sm)',
        DEFAULT: 'var(--radius-md)',
        md:      'var(--radius-md)',
        lg:      'var(--radius-lg)',
        xl:      'var(--radius-xl)',
        full:    'var(--radius-full)',
      },

      boxShadow: {
        xs:    'var(--shadow-xs)',
        sm:    'var(--shadow-sm)',
        md:    'var(--shadow-md)',
        lg:    'var(--shadow-lg)',
        focus: '0 0 0 3px rgb(var(--color-focus-ring) / 0.35)',
      },

      transitionDuration: {
        fast: 'var(--duration-fast)',
        base: 'var(--duration-base)',
        slow: 'var(--duration-slow)',
      },

      transitionTimingFunction: {
        standard: 'var(--ease-standard)',
      },

      keyframes: {
        'fade-in':        { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        'slide-down':     { '0%': { transform: 'translateY(-4px)', opacity: '0' }, '100%': { transform: 'translateY(0)', opacity: '1' } },
        'slide-left':     { '0%': { transform: 'translateX(8px)', opacity: '0' }, '100%': { transform: 'translateX(0)', opacity: '1' } },
        'slide-in-right': { '0%': { transform: 'translateX(100%)' }, '100%': { transform: 'translateX(0)' } },
      },
      animation: {
        'fade-in':        'fade-in var(--duration-fast) var(--ease-standard)',
        'slide-down':     'slide-down var(--duration-base) var(--ease-standard)',
        'slide-left':     'slide-left var(--duration-base) var(--ease-standard)',
        'slide-in-right': 'slide-in-right var(--duration-base) var(--ease-standard)',
      },

      zIndex: {
        header:  'var(--z-header)',
        overlay: 'var(--z-overlay)',
        sheet:   'var(--z-sheet)',
        command: 'var(--z-command)',
        tooltip: 'var(--z-tooltip)',
      },
    },
  },
  plugins: [],
};

export default config;
