import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Plausible } from '@/components/analytics/Plausible';
import { siteConfig } from '@/lib/site';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  title: {
    default: siteConfig.name,
    template: `%s — ${siteConfig.name}`,
  },
  description: siteConfig.description,
  applicationName: siteConfig.name,
  authors: [{ name: siteConfig.author }],
  // Private, allowlisted app — keep it out of search indexes.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#faf6ee',
  colorScheme: 'light dark',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="paper">
      <head>
        {/*
          Fonts are loaded via <link> rather than next/font/google so the
          production build never has to reach the Google Fonts CDN at build
          time (some sandboxes block it). Newsreader = display, Hanken
          Grotesk = UI/body; both are wired into the @theme tokens.
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- intentional:
            a stylesheet <link> avoids a build-time Google Fonts fetch (some
            sandboxes block the CDN); the font applies app-wide via the root layout. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&display=swap"
        />
      </head>
      <body>
        <Plausible />
        {children}
      </body>
    </html>
  );
}
