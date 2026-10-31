const isDev = process.env.NODE_ENV !== 'production';

const csp = [
  "default-src 'self'",
  // Next injects inline bootstrap scripts; no eval in production.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
  "frame-src 'self'",
  "object-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

const common = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' }
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: { root: import.meta.dirname },
  serverExternalPackages: ['pdf-parse', 'pg'],
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Every page and API route except the PDF stream.
        source: '/((?!api/resumes/[^/]+/file).*)',
        headers: [...common, { key: 'Content-Security-Policy', value: csp }, { key: 'X-Frame-Options', value: 'DENY' }]
      },
      {
        // Same-origin framing only, so the resume page can embed it.
        source: '/api/resumes/:id/file',
        headers: [
          ...common,
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' }
        ]
      }
    ];
  }
};

export default nextConfig;
