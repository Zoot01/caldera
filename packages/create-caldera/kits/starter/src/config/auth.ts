import { defineConfig } from '@caldera-js/core'

export const auth = defineConfig('auth', () => ({
  // Where people land after signing in or registering.
  home: '/dashboard',
  // true: new accounts get a verification link, and routes with `mw.verified()` (the dashboard and
  // settings) send unverified people to /verify-email until they click it.
  mustVerifyEmail: false,
  // Two-factor sign-in (an authenticator app, with recovery codes), turned on per person in Security
  // settings. false hides it and refuses its routes.
  twoFactor: true,
  // Passkeys (Face ID, Touch ID, Windows Hello, security keys): added in Security settings, then used
  // to sign in without a password. false hides them and refuses their routes.
  passkeys: true,
  // Settings that need the password again within this long (`mw.passwordConfirmed()`).
  passwordTimeoutSeconds: 3 * 60 * 60,
}))
