import { authenticate, authRoutes } from '@caldera/auth'
import { broadcastRoutes } from '@caldera/broadcast'
import { errorHandler, ForbiddenError, notFoundHandler, originCheck, securityHeaders, startSession } from '@caldera/http'
import { mailPreviewRoutes } from '@caldera/mail'
import { cronRoutes } from '@caldera/schedule'
import { storageRoutes } from '@caldera/storage'
import { Hono } from 'hono'
import { router } from '../.caldera/routes.gen'
import { app } from './app'
import { passwordConfirmed } from './route-middleware'

/**
 * The API, mounted by app/api/[[...route]]/route.ts at /api: security defaults, Caldera services on
 * c.var, the session, then your routes. Next renders the pages.
 */
export const http = new Hono()
  .basePath('/api')
  // Next sets its own CSP for pages; these are JSON responses.
  .use(securityHeaders({ csp: false }))
  .use(originCheck())
  .use(app.middleware())
  .use(startSession())
  // Who's signed in, on every request: c.var.user (null for guests). `mw.auth()` requires it.
  .use(authenticate({ required: false }))
  // Vercel Cron calls /api/_caldera/cron; it's refused until CRON_SECRET is set.
  .route('/', cronRoutes({ secret: () => app.config.app.cronSecret }))
  // Signed file links for the local disk (/_caldera/files, rewritten here by next.config.ts).
  .route('/', storageRoutes())
  // Browsers ask here before joining a private or presence channel: /api/_caldera/broadcast/auth.
  .route('/', broadcastRoutes())
  // Mail previews and the outbox, outside production only: /_caldera/mail. The browser tests serve a
  // production build and read the outbox, so they turn them on with MAIL_PREVIEWS=true.
  .route('/', mailPreviewRoutes({ enabled: () => process.env.NODE_ENV !== 'production' || process.env.MAIL_PREVIEWS === 'true' }))
  // Adding a passkey (the Security page calls Better Auth for it) needs the password typed recently,
  // like the page itself.
  .use('/auth/passkey/generate-register-options', async (c, next) => {
    if (c.var.user && !passwordConfirmed(c)) throw new ForbiddenError('Confirm your password first.')
    await next()
  })
  // Better Auth's own endpoints (/api/auth/*): emailed links (verify email, reset password) land here.
  .route('/', authRoutes('/auth'))
  // Pages show what a route flashed, then clear it with this (components/flash-toasts.tsx): rendering a
  // page can't change the session, and any call to the app writes it without what was read.
  .post('/_caldera/flash', (c) => c.body(null, 204))
  .route('/', router.app)
  .onError(errorHandler())
  .notFound(notFoundHandler())

/** For the typed client in client components: `createClient<AppType>()`. A type only. */
export type AppType = typeof router.app
