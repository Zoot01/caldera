import { defineNotification } from '@caldera/notifications'
import { z } from 'zod'
import { WelcomeEmail } from '../mail/welcome.js'

/**
 * `await notify(user, Welcome, { name: user.name, url })`: an email, and an entry in the user's inbox
 * (`await inbox(user).list()`). Queued: one job per channel, once the transaction commits.
 */
export const Welcome = defineNotification({
  name: 'users.welcome',
  payload: z.object({ name: z.string(), url: z.url() }),
  channels: {
    // To the user's mail route (UserNotifiable in src/models/user.ts).
    mail: (_to, props) => ({ mail: WelcomeEmail, props }),
    database: {
      schema: z.object({ message: z.string(), url: z.url() }),
      data: (_to, { url }) => ({ message: 'Welcome aboard!', url }),
    },
  },
  queue: true,
})
