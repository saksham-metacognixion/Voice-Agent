import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Voice Agent Admin',
  description: 'Staff console.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
