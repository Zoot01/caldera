import { defineChannel } from '@caldera/broadcast'

// Each user's own channel (\`private-users.<id>\`), for things only they should see: notifications,
// their exports finishing. Joining needs a signed-in user (\`c.var.user\`, from @caldera/auth).
export const UserChannel = defineChannel('users.{id}', {
  authorize: ({ user, params }) => String(user.id) === params.id,
})
