import type { NextConfig } from 'next'

const config: NextConfig = {
  // Server packages with native code or Node-only internals stay out of the bundle.
  serverExternalPackages: ['@libsql/client', 'libsql', 'bullmq', 'ioredis', 'nodemailer', 'msgpackr', 'better-sqlite3'],
  // Caldera's own URLs (signed file links, uploads, mail previews) live under /_caldera; Next ignores
  // folders starting with `_`, so they're served by the API route handler.
  async rewrites() {
    return [{ source: '/_caldera/:path*', destination: '/api/_caldera/:path*' }]
  },
}

export default config
