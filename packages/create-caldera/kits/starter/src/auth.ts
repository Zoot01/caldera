import { betterAuthProvider } from '@caldera/auth'
import { mail } from '@caldera/mail'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { account, session, users, verification } from './db/schema.js'
import { ResetPasswordEmail } from './mail/reset-password.js'
import { VerifyEmailEmail } from './mail/verify-email.js'
import { User } from './models/user.js'

/**
 * Sign-in, sessions and passwords: Better Auth (https://better-auth.com), on the app's own users table.
 * The pages post to the app's routes (src/routes/auth.ts, settings.ts), which call `c.var.auth.api`.
 * After changing plugins, run `caldera auth:schema` to update src/db/auth-schema.ts.
 */
export const auth = betterAuthProvider({
  // c.var.user is a row from the User model.
  userModel: User,
  create: ({ db, env, config }) =>
    betterAuth({
      baseURL: env.APP_URL,
      secret: env.APP_KEY,
      trustedOrigins: [env.APP_URL],
      database: drizzleAdapter(db as never, { provider: 'sqlite', schema: { users, session, account, verification } }),
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
    }),
})
