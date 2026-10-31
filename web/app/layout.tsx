import type { Metadata, Viewport } from 'next';
import './tokens.css';
import './ui.css';

export const metadata: Metadata = {
  title: { default: 'Synapse', template: '%s - Synapse' },
  description: 'Your resume, job descriptions and interview context, prepared once and ready for the Synapse desktop app.'
};
export const viewport: Viewport = { themeColor: '#0b0b0e', colorScheme: 'dark' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">Skip to content</a>
        {children}
      </body>
    </html>
  );
}
