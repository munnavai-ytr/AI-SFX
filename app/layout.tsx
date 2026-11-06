import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { RootErrorBoundary } from '@/components/ErrorBoundary';
import { ToastProvider } from '@/components/Toast';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const viewport: Viewport = {
  themeColor: '#0B0D12',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export const metadata: Metadata = {
  title: 'SFX AI — Intelligent Sound Effects',
  description: 'AI-powered sound effects for video creators. Step 1: project setup, video management, and API key testing.',
  openGraph: {
    title: 'SFX AI — Intelligent Sound Effects',
    description: 'AI-powered sound effects for video creators. Step 1: project setup, video management, and API key testing.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'SFX AI — Intelligent Sound Effects',
    description: 'AI-powered sound effects for video creators. Step 1: project setup, video management, and API key testing.',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable} dark`}>
      <body className="bg-[var(--ink)] text-[var(--text)] antialiased font-sans" suppressHydrationWarning>
        <RootErrorBoundary>
          <ToastProvider>
            {children}
          </ToastProvider>
        </RootErrorBoundary>
      </body>
    </html>
  );
}
