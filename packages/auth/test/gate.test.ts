import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import { createGate } from '../src/index.js'
import { calls, Post, setup, viewBilling, viewStatus } from './fixtures.js'

let s: Awaited<ReturnType<typeof setup>>
beforeEach(async () => {
  s = await setup()
})

describe('gate', () => {
  it('checks model abilities with typed names and arguments', async () => {
    const gate = createGate({ user: s.ann })
    expect(await gate.can(Post, 'update', s.draft)).toBe(true)
    expect(await gate.can(Post, 'create')).toBe(false)
    expect(await createGate({ user: s.bob }).can(Post, 'update', s.draft)).toBe(false)
    // @ts-expect-error unknown ability
    void (() => gate.can(Post, 'publish', s.draft))
    // @ts-expect-error update needs the row
    void (() => gate.can(Post, 'update'))
    // @ts-expect-error create takes no row
    void (() => gate.can(Post, 'create', s.draft))
    // @ts-expect-error reserved keys aren't abilities
    void (() => gate.can(Post, 'before'))
  })

  it('lets before() short-circuit every ability', async () => {
    const result = await createGate({ user: s.admin }).inspect(Post, 'delete', s.draft)
    expect(result).toEqual({ allowed: true, status: 200, source: 'before' })
  })

  it('denies guests with 401 unless an ability allows guests', async () => {
    const guest = createGate({ user: null })
    expect(await guest.inspect(Post, 'update', s.draft)).toMatchObject({ allowed: false, status: 401, source: 'guest' })
    expect(await guest.can(Post, 'view', s.live)).toBe(true)
    expect(await guest.inspect(Post, 'view', s.draft)).toMatchObject({ allowed: false, status: 404 })
  })

  it('throws errors whose codes map to 401, 403 and 404', async () => {
    await expect(createGate({ user: null }).authorize(Post, 'update', s.draft)).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(createGate({ user: s.ann }).authorize(Post, 'create')).rejects.toMatchObject({ code: 'forbidden', message: 'Upgrade to publish.' })
    await expect(createGate({ user: s.bob }).authorize(Post, 'delete', s.draft)).rejects.toMatchObject({ code: 'not_found', message: 'Not found.' })
  })

  it('memoizes checks per request and annotates lists with one prefetch', async () => {
    const gate = createGate({ user: s.ann })
    await gate.can(Post, 'update', s.draft)
    await gate.can(Post, 'update', s.draft)
    expect(calls.update).toBe(1)

    const annotated = await gate.annotate(Post, [s.draft, s.live], ['update', 'delete'])
    expectTypeOf(annotated[0]!.can).toEqualTypeOf<{ update: boolean; delete: boolean }>()
    expect(annotated.map((p) => p.can)).toEqual([
      { update: true, delete: true },
      { update: true, delete: true },
    ])
    expect(calls.prefetch).toBe(1)
    expect(calls.update).toBe(2) // draft was already memoized
  })

  it('supports abilities not tied to a model, and checks for other users', async () => {
    const gate = createGate({ user: s.ann })
    expect(await gate.can(viewBilling)).toBe(false)
    expect(await gate.forUser(s.bob).can(viewBilling)).toBe(true)
    expect(await createGate({ user: null }).can(viewStatus)).toBe(true)
    expect(await createGate({ user: null }).inspect(viewBilling)).toMatchObject({ status: 401 })
  })

  it('denies abilities with no definition at runtime', async () => {
    const inspect = createGate({ user: s.ann }).inspect as (...args: unknown[]) => Promise<unknown>
    const result = await inspect(Post, 'archive', s.draft)
    expect(result).toMatchObject({ allowed: false, source: 'missing' })
  })
})
