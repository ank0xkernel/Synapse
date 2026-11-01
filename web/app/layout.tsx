import type { Metadata, Viewport } from 'next';
import { Red_Hat_Display, Red_Hat_Mono, Red_Hat_Text } from 'next/font/google';
import './tokens.css';
import './ui.css';

// Self-hosted at build time by next/font; no request to Google at runtime.
const display = Red_Hat_Display({ subsets: ['latin'], weight: ['300', '400', '500'], variable: '--font-rh-display', display: 'swap' });
const text = Red_Hat_Text({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-rh-text', display: 'swap' });
const mono = Red_Hat_Mono({ subsets: ['latin'], weight: ['400'], variable: '--font-rh-mono', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Synapse', template: '%s - Synapse' },
  description: 'Your resume, job descriptions and interview context, prepared once and ready for the Synapse desktop app.'
};
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4f5f9' },
    { media: '(prefers-color-scheme: dark)', color: '#05060b' }
  ],
  colorScheme: 'light dark'
};

// Applies a pinned theme before first paint so there is no flash. Static string, no user input.
const THEME_SCRIPT = "try{var t=localStorage.getItem('synapse-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${text.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <a className="skip" href="#main">Skip to content</a>
        {children}
      </body>
    </html>
  );
}
