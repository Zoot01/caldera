import { authenticate, authRoutes } from '@caldera/auth'
import { broadcastRoutes } from '@caldera/broadcast'
import { errorHandler, ForbiddenError, notFoundHandler, originCheck, securityHeaders, startSession } from '@caldera/http'
import { mailPreviewRoutes } from '@caldera/mail'
import { cronRoutes } from '@caldera/schedule'
import { storageRoutes, uploadRoutes } from '@caldera/storage'
import { errorPage } from '@caldera/inertia'
import { Hono } from 'hono'
import { router } from '../.caldera/routes.gen.js'
import { app } from './app.js'
import { inertia } from './inertia.js'
import { passwordConfirmed } from './middleware.js'
import { uploads } from './uploads.js'

/** The HTTP app: security defaults, Caldera services on c.var, the session, pages, then your routes. */
export const http = new Hono()
  .use(securityHeaders())
  .use(originCheck())
  .use(app.middleware())
  .use(startSession())
  // Who's signed in, on every request: c.var.user (null for guests). `mw.auth()` requires it.
  .use(authenticate({ required: false }))
  .use(inertia.middleware())
  // Vercel Cron (and other HTTP crons) call /_caldera/cron; it's refused until CRON_SECRET is set.
  .route('/', cronRoutes({ secret: () => app.config.app.cronSecret }))
  // Signed file links and uploads for the local disk, and direct uploads (src/uploads.ts).
  .route('/', storageRoutes())
  .route('/', uploadRoutes({ uploads }))
  // Browsers ask here before joining a private or presence channel (src/channels decides).
  .route('/', broadcastRoutes())
  // Mail previews and the outbox, outside production only.
  .route('/', mailPreviewRoutes({ enabled: () => process.env.NODE_ENV !== 'production' }))
  // Adding a passkey (the Security page calls Better Auth for it) needs the password typed recently,
  // like the page itself.
  .use('/api/auth/passkey/generate-register-options', async (c, next) => {
    if (c.var.user && !passwordConfirmed(c)) throw new ForbiddenError('Confirm your password first.')
    await next()
  })
  // Better Auth's own endpoints: emailed links (verify email, reset password) land here.
  .route('/', authRoutes('/api/auth'))
  .route('/', router.app)
  // People get resources/pages/Error.tsx (with the status); API clients get the JSON error.
  .onError(errorHandler({ loginUrl: '/login', page: errorPage() }))
  .notFound(notFoundHandler({ page: errorPage() }))
