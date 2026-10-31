import { passkey } from '@better-auth/passkey'
import { betterAuthProvider } from '@caldera/auth'
import { mail } from '@caldera/mail'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { twoFactor } from 'better-auth/plugins'
import * as schema from './db/schema.js'
import { ResetPasswordEmail } from './mail/reset-password.js'
import { VerifyEmailEmail } from './mail/verify-email.js'
import { confirmPassword } from './middleware.js'
import { User } from './models/user.js'

/**
 * Sign-in, sessions and passwords: Better Auth (https://better-auth.com), on the app's own users table.
 * The pages post to the app's routes (src/routes/auth.ts, settings.ts), which call `c.var.auth.api`.
 * After changing plugins, run `caldera auth:schema` to update src/db/auth-schema.ts.
 */
export const auth = betterAuthProvider({
  // c.var.user is a row from the User model.
  userModel: User,
  create: ({ db, env, config, request }) =>
    betterAuth({
      baseURL: env.APP_URL,
      secret: env.APP_KEY,
      trustedOrigins: [env.APP_URL],
      // The tables are the exports of src/db/schema.ts (users, and Better Auth's from auth-schema.ts).
      database: drizzleAdapter(db as never, { provider: 'sqlite', schema }),
      user: {
        modelName: 'users',
        // Unverified addresses change at once; verified ones only after the link sent to the new one.
        changeEmail: { enabled: true, updateEmailWithoutVerification: true },
        deleteUser: { enabled: true },
      },
      advanced: { database: { generateId: 'uuid' } },
      emailAndPassword: {
        enabled: true,
        minPasswordLength: 8,
        requireEmailVerification: config.auth.mustVerifyEmail,
        revokeSessionsOnPasswordReset: true,
        sendResetPassword: async ({ user, url }) => {
          await mail.to(user.email).send(ResetPasswordEmail, { name: user.name, url })
        },
      },
      emailVerification: {
        sendOnSignUp: config.auth.mustVerifyEmail,
        autoSignInAfterVerification: true,
        sendVerificationEmail: async ({ user, url }) => {
          await mail.to(user.email).send(VerifyEmailEmail, { name: user.name, url })
        },
      },
      // Both are always installed (so turning them off in src/config/auth.ts never locks anyone out
      // of a second factor they set up); the config decides what the pages offer.
      plugins: [
        // Authenticator apps and recovery codes. Sign-in asks for a code at /two-factor-challenge;
        // ten failed codes lock the account for 15 minutes.
        twoFactor({ issuer: config.app.name }),
        // WebAuthn, for this site's own host name. Using a passkey (signing in, or on /confirm-password)
        // counts as confirming the password for the settings behind mw.passwordConfirmed().
        passkey({
          rpID: new URL(env.APP_URL).hostname,
          rpName: config.app.name,
          origin: env.APP_URL,
          authentication: {
            afterVerification: async () => {
              const c = request()
              if (c) confirmPassword(c as never)
            },
          },
        }),
      ],
    }),
})
