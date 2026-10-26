import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans_Arabic, Inter } from 'next/font/google';
import { localeBootScript } from '@/src/i18n';
import { Providers } from '@/src/providers';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
// Arabic glyphs only; Latin text keeps Inter (the stack in @portal/config's preset).
const arabic = IBM_Plex_Sans_Arabic({ subsets: ['arabic'], weight: ['400', '500', '600', '700'], variable: '--font-arabic', display: 'swap' });

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
    // `lang` and `dir` are the stored language's before first paint (the script below); the
    // static HTML itself is English and left to right.
    <html lang="en" dir="ltr" suppressHydrationWarning className={`${inter.variable} ${arabic.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: localeBootScript }} />
      </head>
      <body className="min-h-dvh font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
