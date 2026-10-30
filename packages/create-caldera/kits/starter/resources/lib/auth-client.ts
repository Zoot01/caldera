import { passkeyClient } from '@better-auth/passkey/client'
import { createAuthClient } from 'better-auth/client'

let client: ReturnType<typeof create> | undefined
const create = () => createAuthClient({ baseURL: window.location.origin, basePath: '/api/auth', plugins: [passkeyClient()] })

/**
 * Better Auth in the browser, only for what must happen there: passkeys (WebAuthn needs the
 * browser's authenticator). Everything else posts to the app's own routes. Created on first use, so
 * pages that import it still render on the server.
 */
export const authClient = () => (client ??= create())

/** Whether this browser can use passkeys at all. */
export const supportsPasskeys = () => typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function'
