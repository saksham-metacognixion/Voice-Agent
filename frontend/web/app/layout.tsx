import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { Providers } from '@/src/providers';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Oraly', template: '%s · Oraly' },
  description:
    'Oraly is the plug-and-play platform for AI voice agents that answer, act and get it done for your business.',
  applicationName: 'Oraly',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Lets `env(safe-area-inset-bottom)` report the home indicator, which the §12.5 bottom tab bar pads for.
  viewportFit: 'cover',
  themeColor: [
    // Soft White and Deep Navy — the two brand surfaces (docs/brand.md).
    { media: '(prefers-color-scheme: light)', color: '#f7f8fb' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0f1a' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={inter.variable}>
      <body className="min-h-dvh font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
