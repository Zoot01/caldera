import { RootProvider } from 'fumadocs-ui/provider/next';
import type { Metadata } from 'next';
import { Geist_Mono, Instrument_Sans } from 'next/font/google';
import './global.css';

// The starter kit's type: Instrument Sans for text, Geist Mono for code.
const sans = Instrument_Sans({ subsets: ['latin'], variable: '--font-instrument-sans' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' });

export const metadata: Metadata = {
  title: { template: '%s · Caldera', default: 'Caldera: the TypeScript framework for web apps' },
  description: 'A Laravel-inspired TypeScript framework: routing, a database, auth, queues, mail, realtime and more, ready on day one.',
  icons: { icon: '/favicon.svg' },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col font-sans">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
