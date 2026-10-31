const isDev = process.env.NODE_ENV !== 'production';

// Private Blob objects are reached only through short-lived signed URLs on this host family; uploads go to the Blob API.
const BLOB_FILES = 'https://*.private.blob.vercel-storage.com';
const BLOB_API = 'https://vercel.com/api/blob';

const csp = [
  "default-src 'self'",
  // Next injects inline bootstrap scripts; no eval in production.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${BLOB_FILES}`,
  "font-src 'self'",
  `connect-src 'self' ${BLOB_API}${isDev ? ' ws: wss:' : ''}`,
  `frame-src 'self' ${BLOB_FILES}`,
  "object-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

const common = [
  ...(isDev ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]),
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
