import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import '@uiw/react-md-editor/markdown-editor.css';
import '@uiw/react-markdown-preview/markdown.css';
import { Providers } from '@/components/providers';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'LLM Wiki',
  description: 'LLM-powered personal knowledge management wiki',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning className={inter.variable} data-color-mode="light">
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
