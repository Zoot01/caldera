import { defineConfig } from '@caldera/core'

export const auth = defineConfig('auth', () => ({
  // Where people land after signing in or registering.
  home: '/dashboard',
  // true: new accounts get a verification link, and routes with `mw.verified()` (the dashboard and
  // settings) send unverified people to /verify-email until they click it.
  mustVerifyEmail: false,
  // Settings that need the password again within this long (`mw.passwordConfirmed()`).
  passwordTimeoutSeconds: 3 * 60 * 60,
}))
