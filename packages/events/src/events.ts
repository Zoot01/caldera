import { CalderaError, defineProvider, type RegisteredServices } from '@caldera/core'
import type { z } from 'zod'

export interface EventDefinition<P extends z.ZodType = z.ZodType> {
  readonly kind: 'caldera.event'
  /** Stable id, e.g. `user.registered`. */
  readonly name: string
  readonly payload: P
}
export type AnyEvent = EventDefinition<any>
export type EventInput<E> = E extends EventDefinition<infer P> ? z.input<P> : never
export type EventPayload<E> = E extends EventDefinition<infer P> ? z.output<P> : never

export function defineEvent<P extends z.ZodType>(options: { name: string; payload: P }): EventDefinition<P> {
  if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(options.name)) {
    throw new CalderaError('event_name_invalid', `Event name "${options.name}" should be a stable id like "user.registered".`)
  }
  return { kind: 'caldera.event', name: options.name, payload: options.payload }
}

export interface ListenerContext {
  readonly event: string
  readonly services: RegisteredServices
}

/**
 * A listener that queues a job instead of running in the emitting process: `SendWelcome.fromEvent(map)`
 * from `@caldera/queue`. It is the job, so it has the job's retries, backoff and uniqueness.
 */
export interface QueuedListener {
  readonly kind: 'caldera.queued-listener'
  readonly job: { readonly name: string }
  map(payload: unknown): unknown
}

export interface ListenerDefinition<E extends AnyEvent = AnyEvent> {
  readonly kind: 'caldera.listener'
  readonly event: E
  /** For introspection (`caldera` lists listeners by name). Defaults to the job's name, or `anonymous`. */
  readonly name: string
  readonly handle?: (payload: EventPayload<E>, context: ListenerContext) => unknown
  readonly queued?: QueuedListener
}
export type AnyListener = ListenerDefinition<any>

/**
 * Listens to an event: with a function (runs in the emitting process, in order), or a queued job
 * (`Job.fromEvent(...)`). Export the result from a file in `src/listeners`; `caldera generate` registers it.
 */
export function listen<E extends AnyEvent>(
  event: E,
  handler: ((payload: EventPayload<E>, context: ListenerContext) => unknown) | QueuedListener,
  options: { name?: string } = {},
): ListenerDefinition<E> {
  if (typeof handler === 'function') return { kind: 'caldera.listener', event, name: options.name ?? (handler.name || 'anonymous'), handle: handler }
  return { kind: 'caldera.listener', event, name: options.name ?? handler.job.name, queued: handler }
}

export interface EmitOptions {
  /** Emit only once the surrounding database transaction commits (dropped on rollback). */
  afterCommit?: boolean
}

export interface EventsFake {
  emitted<E extends AnyEvent>(event?: E): { event: string; payload: EventPayload<E> }[]
  assertEmitted<E extends AnyEvent>(event: E, match?: (payload: EventPayload<E>) => boolean, times?: number): void
  assertNotEmitted<E extends AnyEvent>(event: E, match?: (payload: EventPayload<E>) => boolean): void
  assertNothingEmitted(): void
  restore(): void
}

export interface Events {
  /** Validates the payload, then runs listeners in order (queued ones are dispatched). A throwing listener stops the rest. */
  emit<E extends AnyEvent>(event: E, payload: EventInput<E>, options?: EmitOptions): Promise<{ listeners: number }>
  /** Runs function listeners until one returns something other than undefined, and returns that. */
  until<E extends AnyEvent, R = unknown>(event: E, payload: EventInput<E>): Promise<R | undefined>
  register(...listeners: AnyListener[]): void
  listenersFor(event: AnyEvent | string): readonly AnyListener[]
  /** Records emitted events without running listeners: all events, or only those listed. */
  fake(events?: readonly AnyEvent[]): EventsFake
  services: RegisteredServices
}

interface QueueLike {
  dispatch(job: unknown, payload: unknown, options?: { afterCommit?: boolean }): Promise<unknown>
}

export function createEvents(options: { listeners?: readonly AnyListener[] } = {}): Events {
  const byEvent = new Map<string, AnyListener[]>()
  const definitions = new Map<string, AnyEvent>()
  let fake: { only: Set<string> | null; recorded: { event: string; payload: unknown }[] } | undefined

  const register = (listener: AnyListener) => {
    const other = definitions.get(listener.event.name)
    if (other && other !== listener.event) throw new CalderaError('event_duplicate', `Two different events are named "${listener.event.name}".`)
    definitions.set(listener.event.name, listener.event)
    const list = byEvent.get(listener.event.name) ?? []
    if (!list.includes(listener)) list.push(listener)
    byEvent.set(listener.event.name, list)
  }
  for (const listener of options.listeners ?? []) register(listener)

  const run = async (event: AnyEvent, payload: unknown) => {
    const listeners = byEvent.get(event.name) ?? []
    for (const listener of listeners) {
      if (listener.handle) await listener.handle(payload, { event: event.name, services: events.services })
      else if (listener.queued) await queue().dispatch(listener.queued.job, listener.queued.map(payload))
    }
    return { listeners: listeners.length }
  }

  const events: Events = {
    services: {} as RegisteredServices,
    register(...list) {
      for (const listener of list) register(listener)
    },
    listenersFor: (event) => byEvent.get(typeof event === 'string' ? event : event.name) ?? [],
    async emit(event, input, opts = {}) {
      // Validated where it's emitted, so a bad payload fails there, not inside some listener.
      const payload = event.payload.parse(input)
      if (fake && (!fake.only || fake.only.has(event.name))) {
        const record = () => void fake?.recorded.push({ event: event.name, payload })
        if (opts.afterCommit) await afterCommit(record)
        else record()
        return { listeners: 0 }
      }
      if (opts.afterCommit) {
        let result = { listeners: 0 }
        await afterCommit(async () => {
          result = await run(event, payload)
        })
        return result
      }
      return run(event, payload)
    },
    async until(event, input) {
      const payload = event.payload.parse(input)
      for (const listener of byEvent.get(event.name) ?? []) {
        if (!listener.handle) continue
        const result = await listener.handle(payload, { event: event.name, services: events.services })
        if (result !== undefined) return result as never
      }
      return undefined
    },
    fake(only) {
      const state = { only: only ? new Set(only.map((e) => e.name)) : null, recorded: [] as { event: string; payload: unknown }[] }
      fake = state
      const matching = <E extends AnyEvent>(event: E, match?: (payload: EventPayload<E>) => boolean) =>
        state.recorded.filter((r) => r.event === event.name && (!match || match(r.payload as EventPayload<E>)))
      return {
        emitted: (event) => state.recorded.filter((r) => !event || r.event === event.name) as never,
        assertEmitted(event, match, times) {
          const found = matching(event, match).length
          if (times === undefined ? found === 0 : found !== times) {
            throw new CalderaError('assertion_failed', `Expected "${event.name}" to be emitted${match ? ' with a matching payload' : ''} ${times ?? 'at least once'} time(s); it was ${found}.`)
          }
        },
        assertNotEmitted(event, match) {
          const found = matching(event, match).length
          if (found) throw new CalderaError('assertion_failed', `Expected "${event.name}" not to be emitted${match ? ' with a matching payload' : ''}; it was ${found} time(s).`)
        },
        assertNothingEmitted() {
          if (state.recorded.length) throw new CalderaError('assertion_failed', `Expected no events; got ${state.recorded.map((r) => r.event).join(', ')}.`)
        },
        restore() {
          if (fake === state) fake = undefined
        },
      }
    },
  }
  return events
}

// The app's queue and database, as @caldera/queue and @caldera/db register them, read without depending on them.
function queue(): QueueLike {
  const found = (globalThis as { [key: symbol]: unknown })[Symbol.for('caldera.queue.default')] as QueueLike | undefined
  if (!found) throw new CalderaError('no_queue', 'A queued listener needs a queue: add queueProvider() from @caldera/queue to the app.')
  return found
}

async function afterCommit(callback: () => Promise<void> | void) {
  const resolver = (globalThis as { [key: symbol]: unknown })[Symbol.for('caldera.db.defaultDatabase')] as (() => { afterCommit(cb: () => unknown): Promise<void> }) | undefined
  let db: { afterCommit(cb: () => unknown): Promise<void> } | undefined
  try {
    db = resolver?.()
  } catch {
    db = undefined
  }
  if (db) await db.afterCommit(callback)
  else await callback()
}

const DEFAULT = Symbol.for('caldera.events.default')
const registry = globalThis as { [DEFAULT]?: Events }

export function setDefaultEvents(events: Events | undefined) {
  registry[DEFAULT] = events
}

export function defaultEvents(): Events {
  const events = registry[DEFAULT]
  if (!events) throw new CalderaError('no_events', 'No events are configured. Add eventsProvider() to the app, or use c.var.events.')
  return events
}

/** `await emit(UserRegistered, { userId })`, on the app's events. */
export function emit<E extends AnyEvent>(event: E, payload: EventInput<E>, options?: EmitOptions) {
  return defaultEvents().emit(event, payload, options)
}

/** `await until(Event, payload)`: the first function listener's answer. */
export function until<E extends AnyEvent, R = unknown>(event: E, payload: EventInput<E>) {
  return defaultEvents().until<E, R>(event, payload)
}

/**
 * Registers `events` with your listeners: `eventsProvider({ listeners })`, with `listeners` from
 * `.caldera/listeners.gen.ts` (generated from `src/listeners`). Listeners get the app's services.
 */
export function eventsProvider(options: { listeners?: readonly AnyListener[] } = {}) {
  return defineProvider({
    name: 'events',
    register: () => {
      const events = createEvents(options)
      setDefaultEvents(events)
      return { events }
    },
    boot: ({ services }) => {
      services.events.services = services as never
    },
  })
}
