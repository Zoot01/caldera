import { notify } from '@caldera-js/notifications'
import { setupApp } from '@caldera-js/testing'
import { it } from 'vitest'
import { app } from '../src/app.js'
import { User } from '../src/models/user.js'
import { Welcome } from '../src/notifications/welcome.js'

const t = setupApp(app)

// t.fake() records instead of delivering (no mail, no rows) and is undone after the test.
it('sends the welcome notification by mail and to the inbox', async () => {
  const notifications = t.fake('notifications')
  const ann = await User.create({ name: 'Ann', email: 'ann@example.test' })
  await notify(ann, Welcome, { name: ann.name, url: 'http://localhost:3000' })
  notifications.assertSentTo(ann, Welcome, (payload, channels) => payload.name === 'Ann' && channels.join() === 'mail,database')
})
