import type { BroadcastPayload } from '@caldera/events'
import { useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import type { BroadcastRegister } from './broadcaster.js'
import type { ChannelDefinition, ChannelParams } from './channel.js'
import { membersOf, subscribe, type Member, type Subscription } from './client.js'

type Channels = BroadcastRegister extends { channels: infer C } ? C : Record<string, ChannelDefinition<string, 'public' | 'private' | 'presence', any, any, any>>
type Events = BroadcastRegister extends { events: infer E } ? E : Record<string, never>
/** Every channel pattern in src/channels. */
export type ChannelPattern = keyof Channels & string
type Def<P extends ChannelPattern> = Channels[P]
type ClientEventsOf<P extends ChannelPattern> = Def<P> extends ChannelDefinition<any, any, any, any, infer CE> ? CE : {}
type MemberOf<P extends ChannelPattern> = Def<P> extends ChannelDefinition<any, any, any, infer M, any> ? M : unknown
type PresencePattern = { [P in ChannelPattern]: Def<P> extends ChannelDefinition<any, 'presence', any, any, any> ? P : never }[ChannelPattern]

export interface ChannelHandlers<P extends ChannelPattern> {
  /** Broadcast events, by name, with their payload (`with`'s result) typed. */
  on?: { [E in keyof Events]?: (data: BroadcastPayload<Events[E]>) => void }
  /** Client events from other browsers (`clientEvents`). Untrusted: another user's browser sent it. */
  whispers?: { [W in keyof ClientEventsOf<P>]?: (data: ClientEventsOf<P>[W] extends z.ZodType ? z.output<ClientEventsOf<P>[W]> : unknown, from: { userId?: string }) => void }
}

export interface ChannelState<P extends ChannelPattern> {
  /** True once the server accepted the subscription. */
  subscribed: boolean
  /** Set when joining failed (refused by the channel's authorize, or the server). */
  error: unknown
  /** Sends a client event to everyone else on this channel. */
  whisper<W extends keyof ClientEventsOf<P> & string>(event: W, data: ClientEventsOf<P>[W] extends z.ZodType ? z.input<ClientEventsOf<P>[W]> : unknown): void
}

/**
 * Listens on a channel while the component is mounted:
 * `useChannel('posts.{post}', { post: post.id }, { on: { 'post.updated': (p) => router.reload() } })`.
 * Components using the same channel share one subscription. Without a realtime server, nothing happens.
 */
export function useChannel<P extends ChannelPattern>(pattern: P, params: ChannelParams<P>, handlers: ChannelHandlers<P> = {}): ChannelState<P> {
  return useSubscription(pattern, params, handlers, false).state
}

export interface PresenceState<P extends ChannelPattern> extends ChannelState<P> {
  /** Everyone on the channel, this user included, with what `member()` returned. */
  members: Member<MemberOf<P>>[]
}

/** A presence channel: who's here, live. `const { members, whisper } = usePresence('rooms.{room}', { room })`. */
export function usePresence<P extends PresencePattern>(pattern: P, params: ChannelParams<P>, handlers: ChannelHandlers<P> = {}): PresenceState<P> {
  const { state, members } = useSubscription(pattern, params, handlers, true)
  return { ...state, members: members as Member<MemberOf<P>>[] }
}

function useSubscription<P extends ChannelPattern>(pattern: P, params: ChannelParams<P>, handlers: ChannelHandlers<P>, presence: boolean) {
  const [subscribed, setSubscribed] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [members, setMembers] = useState<Member[]>([])
  // The latest handlers, so inline functions don't resubscribe on every render.
  const latest = useRef(handlers)
  latest.current = handlers
  const subscription = useRef<Subscription | undefined>(undefined)
  const key = JSON.stringify(params)

  useEffect(() => {
    const joined = subscribe(pattern, params as Record<string, string | number>)
    subscription.current = joined
    if (!joined) return
    const stops: (() => void)[] = []
    const refreshMembers = () => presence && setMembers(membersOf(joined))
    stops.push(
      joined.listen('pusher:subscription_succeeded', () => (setSubscribed(true), setError(null), refreshMembers())),
      joined.listen('pusher:subscription_error', (failure) => setError(failure)),
    )
    if (presence) stops.push(joined.listen('pusher:member_added', refreshMembers), joined.listen('pusher:member_removed', refreshMembers))
    // Already joined by another component: no subscription_succeeded will come.
    if (joined.channel.subscribed) (setSubscribed(true), refreshMembers())
    for (const event of Object.keys(latest.current.on ?? {})) {
      stops.push(joined.listen(event, (data) => (latest.current.on as Record<string, ((data: unknown) => void) | undefined> | undefined)?.[event]?.(data)))
    }
    for (const event of Object.keys(latest.current.whispers ?? {})) {
      stops.push(
        joined.listen(`client-${event}`, (data, meta) =>
          (latest.current.whispers as Record<string, ((data: unknown, from: { userId?: string }) => void) | undefined> | undefined)?.[event]?.(data, meta.user_id ? { userId: meta.user_id } : {}),
        ),
      )
    }
    return () => {
      for (const stop of stops) stop()
      joined.leave()
      subscription.current = undefined
      setSubscribed(false)
    }
    // Resubscribes when the channel or its parameters change; handler changes are read through `latest`.
  }, [pattern, key, presence])

  return {
    state: {
      subscribed,
      error,
      whisper: (event: string, data: unknown) => void subscription.current?.whisper(event, data),
    } as ChannelState<P>,
    members,
  }
}
