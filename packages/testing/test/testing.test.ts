import { describe, expect, it } from 'vitest'
import { setupApp } from '../src/index.js'
import { app, http } from './fixture/app.js'

process.chdir(new URL('./fixture/', import.meta.url).pathname)
const t = setupApp(app)

describe('the database', () => {
  it('is migrated from drizzle/ and starts empty', async () => {
    const client = t.client(http)
    ;(await client.get('/api/posts')).assertOk().assertJson({ posts: [] })
    ;(await client.post('/api/posts', { json: { title: 'First post' } })).assertCreated().assertJsonPath('post.title', 'First post')
    ;(await client.get('/api/posts')).assertJson({ posts: [{ id: 1, title: 'First post' }] })
  })

  it('is rolled back after each test', async () => {
    ;(await t.client(http).get('/api/posts')).assertJson({ posts: [] })
  })

  it('is the file’s own temporary database, not the dev one', () => {
    expect(String((t.app as { env: { DATABASE_URL: string } }).env.DATABASE_URL)).toMatch(/^file:.*caldera-test-.*\.db$/)
  })
})

describe('responses', () => {
  it('asserts statuses and the error envelope', async () => {
    const client = t.client(http)
    ;(await client.get('/api/nope')).assertNotFound().assertJson({ error: { code: 'not_found' } })
    await expect(async () => (await client.get('/api/posts')).assertCreated()).rejects.toThrow(/GET \/api\/posts: expected status 201, got 200/)
  })

  it('asserts validation errors from the JSON envelope', async () => {
    const res = await t.client(http).post('/api/posts', { json: { title: 'x' } })
    await res.assertValidationErrors(['title'])
    await res.assertValidationErrors({ title: />=3 characters/ })
    await expect(res.assertValidationErrors(['body'])).rejects.toThrow(/expected a validation error for "body"/)
  })

  it('shows diffs when JSON doesn’t match', async () => {
    const res = await t.client(http).get('/api/posts')
    await expect(async () => res.assertJson({ posts: [{ title: 'missing' }] })).rejects.toThrow(/GET \/api\/posts: expect/)
  })
})

describe('Inertia pages and forms', () => {
  it('visits pages, taking the asset version from the server', async () => {
    const res = await t.client(http).visit('/posts')
    res.assertOk().assertInertia('Posts/Index', { posts: [], appName: 'fixture' })
    res.assertInertia('Posts/Index', (props) => expect(props.posts).toEqual([]))
    expect(() => res.assertInertia('Posts/Show')).toThrow(/expected the Inertia page Posts\/Show, got Posts\/Index/)
  })

  it('reads a first load’s HTML page too', async () => {
    ;(await t.client(http).get('/posts')).assertInertia('Posts/Index')
  })

  it('follows a failed form back to the page and reads its errors, keeping the session', async () => {
    const browser = t.client(http).inertia()
    await browser.get('/posts/create')
    const failed = await browser.post('/posts', { form: { title: 'x' } })
    failed.assertRedirect('/posts/create')
    await failed.assertValidationErrors({ title: '>=3 characters' })
    const ok = await browser.post('/posts', { form: { title: 'Long enough' } })
    await ok.assertRedirect('/posts/create').assertNoValidationErrors()
    const page = (await ok.followRedirect()).page()
    expect(page.flash).toEqual({ success: 'Created.' })
  })
})

describe('fakes', () => {
  it('fakes a service for one test', async () => {
    const mail = t.fake('mail')
    await t.services.mail.to('ann@example.test').send({ kind: 'caldera.mail', name: 'x' } as never, {} as never).catch(() => undefined)
    expect(mail.sent()).toHaveLength(0)
  })

  it('restores it after the test', () => {
    expect(() => t.services.mail.outbox()).not.toThrow()
  })
})

describe('actingAs', () => {
  it('adds the Better Auth session cookie for the user to every request', async () => {
    const { TestClient } = await import('../src/index.js')
    const seen: string[] = []
    const auth = {
      $context: Promise.resolve({
        secret: 'secret-0123456789-0123456789-0123',
        authCookies: { sessionToken: { name: 'better-auth.session_token' } },
        internalAdapter: { findUserById: async (id: string) => (id === 'u1' ? { id } : null), createSession: async () => ({ token: 'tok' }) },
      }),
    }
    const client = new TestClient({ request: (_url, init) => (seen.push(new Headers(init?.headers).get('cookie') ?? ''), new Response('ok')) }, { services: { auth } })
    await client.actingAs({ id: 'u1' })
    await client.get('/')
    expect(seen[0]).toMatch(/^better-auth\.session_token=tok\.[\w%+/=-]+$/)
    await expect(new TestClient({ request: () => new Response() }).actingAs({ id: 'u1' })).rejects.toThrow(/needs the app’s Better Auth instance/)
  })
})
