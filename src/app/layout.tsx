import type { Metadata } from 'next';
import { Inter, JetBrains_Mono, LXGW_WenKai_TC, Space_Grotesk } from 'next/font/google';
import './globals.css';
import '@uiw/react-md-editor/markdown-editor.css';
import '@uiw/react-markdown-preview/markdown.css';
import 'katex/dist/katex.min.css';
import { Providers } from '@/components/providers';

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

export const metadata: Metadata = {
  title: {
    default: 'weftwise 织识',
    template: '%s · weftwise',
  },
  description:
    'weftwise (织识) — LLM agents weave everything you read into a living, cross-linked personal wiki. Knowledge, woven.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable} ${lxgwWenKai.variable} ${spaceGrotesk.variable}`}
      data-color-mode="light"
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
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
