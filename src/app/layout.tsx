import type { Metadata } from 'next';
import { Inter, JetBrains_Mono, LXGW_WenKai_TC, Space_Grotesk } from 'next/font/google';
import './globals.css';
import '@uiw/react-md-editor/markdown-editor.css';
import '@uiw/react-markdown-preview/markdown.css';
import 'katex/dist/katex.min.css';
import { Providers } from '@/components/providers';
import { getServerI18n, getServerLocale } from '@/lib/i18n/server';
import { getBodyFontSize } from '@/server/db/repos/settings-repo';
import {
  BODY_FONT_SIZE_CSS_VARIABLE,
  bodyFontSizeCssValue,
} from '@/lib/body-font-size';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

const lxgwWenKai = LXGW_WenKai_TC({
  weight: ['400', '700'],
  variable: '--font-lxgw-wenkai',
  display: 'swap',
  preload: false,
});

// Display face — used for the brand wordmark only (kept off body/prose).
const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-space-grotesk',
  display: 'swap',
  weight: ['500', '600', '700'],
});

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return {
    title: {
      default: t('metadata.title'),
      template: '%s · weftwise',
    },
    description: t('metadata.description'),
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getServerLocale();
  const bodyFontSize = getBodyFontSize();
  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable} ${lxgwWenKai.variable} ${spaceGrotesk.variable}`}
      data-color-mode="light"
      style={{
        [BODY_FONT_SIZE_CSS_VARIABLE]: bodyFontSizeCssValue(bodyFontSize),
      } as React.CSSProperties}
    >
      <head>
        {/* Apply both Tailwind dark class and @uiw data-color-mode before first paint */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var d=JSON.parse(localStorage.getItem('ui-store'));var dark=!!(d&&d.state&&d.state.darkMode);document.documentElement.classList.toggle('dark',dark);document.documentElement.setAttribute('data-color-mode',dark?'dark':'light')}catch(e){document.documentElement.setAttribute('data-color-mode','light')}})()`,
          }}
        />
      </head>
      <body>
        <Providers initialLocale={locale}>{children}</Providers>
      </body>
    </html>
  );
}
