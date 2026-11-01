import { defineConfig } from '@caldera-js/core'

export const storage = defineConfig('storage', (env) => ({
  default: env.FILES ? ('r2' as const) : env.S3_BUCKET ? ('s3' as const) : ('local' as const),
  disks: {
    // Private files on this machine. Temporary and upload URLs are signed with APP_KEY and served by
    // the app (storageRoutes in src/http.ts), so direct uploads work in development too. They're
    // relative links; add `url: env.APP_URL` to `serve` for links sent outside a page (emails).
    local: { driver: 'local', root: env.STORAGE_ROOT, serve: { key: env.APP_KEY } },
    // Public files, served as they are from public/storage at /storage.
    public: { driver: 'local', root: 'public/storage', publicUrl: '/storage' },
    // R2 on Workers (the FILES binding).
    ...(env.FILES ? { r2: { driver: 'r2', bucket: env.FILES } } : {}),
    ...(env.S3_BUCKET
      ? {
          s3: {
            driver: 's3',
            bucket: env.S3_BUCKET,
            region: env.S3_REGION,
            ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
            accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
            secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
          },
        }
      : {}),
  },
  // Signs direct-upload tokens and the file refs they answer (uploadRoutes, zupload).
  uploadSecret: env.APP_KEY,
}))
