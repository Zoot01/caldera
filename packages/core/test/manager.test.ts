import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { BootError, CapabilityError, createManager, defineDriver, parseDuration } from '../src/index.js'

interface Store {
  name: string
  url?: string
}
interface Caps {
  locks: boolean
  atomicCounters: boolean
}

const close = vi.fn()
const memory = defineDriver<Store, Caps>({ name: 'memory', capabilities: { locks: true, atomicCounters: true }, create: (_c, ctx) => ({ name: ctx.name }) })
const remote = defineDriver<Store, Caps, { url: string; locks?: boolean }>({
  name: 'remote',
  schema: z.object({ url: z.url(), locks: z.boolean().default(false) }),
  capabilities: (cfg) => ({ locks: cfg.locks ?? false, atomicCounters: false }),
  create: (cfg, ctx) => ({ name: ctx.name, url: cfg.url }),
  close,
})

const config = { default: 'local', instances: { local: { driver: 'memory' }, shared: { driver: 'remote', url: 'https://cache.example.test' } } } as const

describe('createManager', () => {
  it('creates instances lazily, once', () => {
    const create = vi.fn(memory.create)
    const manager = createManager({ kind: 'cache', drivers: [{ ...memory, create }, remote], config })
    expect(create).not.toHaveBeenCalled()
    expect(manager.use()).toBe(manager.use('local'))
    expect(create).toHaveBeenCalledTimes(1)
    expect(manager.use('shared')).toEqual({ name: 'shared', url: 'https://cache.example.test' })
  })

  it('validates every instance config at creation, naming the instance and field', () => {
    const bad = { default: 'shared', instances: { shared: { driver: 'remote', url: 'not a url' } } } as const
    expect(() => createManager({ kind: 'cache', drivers: [remote], config: bad })).toThrow(/cache\.shared \(remote\): url: Invalid URL/)
    expect(() => createManager({ kind: 'cache', drivers: [remote], config: { default: 'x', instances: { x: { driver: 'nope' } } } })).toThrow(/unknown driver "nope"\. Available: remote/)
    // @ts-expect-error the default must be one of the instances
    expect(() => createManager({ kind: 'cache', drivers: [memory], config: { default: 'other', instances: { local: { driver: 'memory' } } } })).toThrow(BootError)
  })

  it('checks capabilities, from config where the driver says so', () => {
    const manager = createManager({ kind: 'cache', drivers: [memory, remote], config })
    expect(() => manager.require('locks')).not.toThrow()
    expect(() => manager.require('locks', { name: 'shared', hint: 'Use Redis for locks.' })).toThrow(CapabilityError)
    expect(() => manager.require('locks', { name: 'shared', hint: 'Use Redis for locks.' })).toThrow(`The "cache.shared (remote)" driver doesn't support locks. Use Redis for locks.`)
  })

  it('types instance names', () => {
    const manager = createManager({ kind: 'cache', drivers: [memory, remote], config })
    // @ts-expect-error not a configured instance
    expect(() => manager.use('missing')).toThrow(/no instance named "missing"/)
  })

  it('describes itself, and purges (closing) instances', async () => {
    const manager = createManager({ kind: 'cache', drivers: [memory, remote], config })
    manager.use('shared')
    expect(manager.describe()).toEqual({
      kind: 'cache',
      default: 'local',
      instances: [
        { name: 'local', driver: 'memory', default: true, capabilities: { locks: true, atomicCounters: true }, created: false },
        { name: 'shared', driver: 'remote', default: false, capabilities: { locks: false, atomicCounters: false }, created: true },
      ],
    })
    const first = manager.use('shared')
    await manager.purge()
    expect(close).toHaveBeenCalledWith(first)
    expect(manager.use('shared')).not.toBe(first)
  })

  it('lets composite drivers use other instances, and catches cycles', () => {
    const failover = defineDriver<Store, Caps, { stores: string[] }>({
      name: 'failover',
      capabilities: { locks: false, atomicCounters: false },
      create: (cfg, ctx) => ({ name: cfg.stores.map((s) => ctx.instance(s).name).join('+') }),
    })
    const manager = createManager({
      kind: 'cache',
      drivers: [memory, failover],
      config: { default: 'both', instances: { both: { driver: 'failover', stores: ['a', 'b'] }, a: { driver: 'memory' }, b: { driver: 'memory' }, loop: { driver: 'failover', stores: ['loop'] } } },
    })
    expect(manager.use().name).toBe('a+b')
    expect(() => manager.use('loop')).toThrow(/refers to itself/)
  })
})

it('drops instances that config leaves out, so a default pointing at one fails clearly', () => {
  const redisUrl: string | undefined = undefined
  const instances = { local: { driver: 'memory' }, ...(redisUrl ? { shared: { driver: 'remote', url: redisUrl } } : {}) }
  const manager = createManager({ kind: 'cache', drivers: [memory, remote], config: { default: 'local', instances } })
  expect(manager.describe().instances.map((i) => i.name)).toEqual(['local'])
  expect(() => createManager({ kind: 'cache', drivers: [memory], config: { default: 'shared' as 'local', instances } })).toThrow(/default "shared" isn't one of the configured instances \(local\)/)
})

it('parses durations, including milliseconds', () => {
  expect(parseDuration('500ms')).toBe(0.5)
  expect(parseDuration('1.5h')).toBe(5400)
  expect(() => parseDuration('soon')).toThrow(/duration/)
})
