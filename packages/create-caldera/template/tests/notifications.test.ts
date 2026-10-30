import { notify } from '@caldera/notifications'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { app } from '../src/app.js'
import { Welcome } from '../src/notifications/welcome.js'

const env = { APP_KEY: 'test-key-0123456789-0123456789-0123', DATABASE_URL: ':memory:' }
const ann = { id: 'u1', name: 'Ann', email: 'ann@example.test', createdAt: new Date(), updatedAt: new Date() }

beforeAll(() => app.boot({ env }))
afterAll(() => app.shutdown())

// fake() records sends without delivering: no mail, no rows. Assert on who got what, over which channels.
it('sends the welcome notification by mail and to the inbox', async () => {
  const fake = app.services.notifications.fake()
  await notify(ann, Welcome, { name: ann.name, url: 'http://localhost:3000' })
  fake.assertSentTo(ann, Welcome, (payload, channels) => payload.name === 'Ann' && channels.join() === 'mail,database')
  fake.restore()
})

