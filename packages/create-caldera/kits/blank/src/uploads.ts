import { defineUpload } from '@caldera/storage'

/**
 * Kinds of direct upload (browser → bucket), served by uploadRoutes in src/http.ts. In a page:
 * `const { upload, progress } = useUpload('avatar')` from '@caldera/storage/react'; send the file it
 * resolves with, check it with `zupload(avatar)` in the route's defineRequest, and store
 * `await claimUpload(file)`, which moves it into `directory` (once: a second claim is refused).
 */
export const avatar = defineUpload('avatar', {
  rules: { maxSize: '2mb', mimes: ['image/*'], image: { maxWidth: 4000, maxHeight: 4000 } },
  directory: 'avatars',
})

export const uploads = [avatar]
