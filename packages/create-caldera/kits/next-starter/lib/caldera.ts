import 'server-only'
import { authenticate, type AuthUser, type Gate } from '@caldera-js/auth'
import type { Broadcaster } from '@caldera-js/broadcast'
import { startSession, type Session } from '@caldera-js/http'
import type { RequestI18n } from '@caldera-js/i18n'
import { requestContext, services } from '@caldera-js/next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { app } from '../src/app'

// One instance each, so requestContext's per-render cache finds the same arguments every time.
const session = startSession()
const user = authenticate({ required: false })

export type Context = {
  user: AuthUser | null
  session: Session
  gate: Gate
  i18n: RequestI18n
  broadcast: Broadcaster
}

/**
 * This request's Caldera context in a Server Component: the user, the session, the gate, i18n. The
 * app's middleware runs once per render on the request's headers; it reads, it never sets cookies
 * (server actions change things, through the app's routes: app/actions).
 */
export async function context(): Promise<Context> {
  await services(app)
  return requestContext<Context>(app, session, user)
}

/** The signed-in user, or null. */
export async function currentUser() {
  return (await context()).user
}

/** The signed-in user. Guests go to /login, and come back to this page after signing in. */
export async function requireUser() {
  const user = await currentUser()
  if (!user) {
    const path = (await headers()).get('x-pathname') ?? app.config.auth.home
    redirect(`/login?redirect=${encodeURIComponent(path)}`)
  }
  // With mustVerifyEmail (src/config/auth.ts), unverified people verify first.
  if (app.config.auth.mustVerifyEmail && !user.emailVerified) redirect('/verify-email')
  return user
}

/** For the sign-in pages: signed-in people go home. */
export async function requireGuest() {
  if (await currentUser()) redirect(app.config.auth.home)
}

/** What the last route flashed: `.with('success', '…')`, `.with('status', '…')`. */
export async function flash() {
  return (await context()).session.flashed() as { success?: string; error?: string; status?: string }
}

/** The app's settings (src/config), for pages. */
export const config = () => app.config
