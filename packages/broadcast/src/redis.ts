import type { HubCluster } from './hub.js'

interface RedisLike {
  hset(key: string, field: string, value: string): Promise<unknown>
  hdel(key: string, ...fields: string[]): Promise<number>
  hgetall(key: string): Promise<Record<string, string>>
  sadd(key: string, member: string): Promise<unknown>
  srem(key: string, member: string): Promise<unknown>
  smembers(key: string): Promise<string[]>
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>
  del(key: string): Promise<unknown>
  mget(...keys: string[]): Promise<(string | null)[]>
  publish(channel: string, message: string): Promise<unknown>
  subscribe(channel: string): Promise<unknown>
  on(event: 'message', listener: (channel: string, message: string) => void): unknown
  quit(): Promise<unknown>
}

export interface RedisClusterOptions {
  /** redis://… (ioredis must be installed). */
  url: string
  /** Keys and the pub/sub channel are per app. */
  appId: string
  /**
   * Seconds a node counts as alive after its last heartbeat. Presence members of a node that stopped
   * (a crash, a deploy) leave this long after it does. Default 30.
   */
  nodeTtlSeconds?: number
}

/**
 * Several hubs (`caldera broadcast:serve` on many machines, behind one load balancer) acting as one:
 * publishes and whispers reach subscribers on every node over Redis pub/sub, and presence lives in
 * Redis hashes, so members are the same everywhere. Each node keeps a heartbeat key; a node that stops
 * without saying so has its members removed (and announced) once it expires.
 */
export async function redisCluster(options: RedisClusterOptions): Promise<HubCluster & { readonly nodeId: string; close(): Promise<void> }> {
  const { default: Redis } = (await import('ioredis')) as unknown as { default: new (url: string, options?: object) => RedisLike }
  const commands = new Redis(options.url, { maxRetriesPerRequest: 3 })
  const subscriber = new Redis(options.url, { maxRetriesPerRequest: 3 })
  const prefix = `caldera:broadcast:${options.appId}`
  const ttl = options.nodeTtlSeconds ?? 30
  const nodeId = crypto.randomUUID()
  const framesChannel = `${prefix}:frames`
  const presenceKey = (channel: string) => `${prefix}:presence:${channel}`
  const channelsKey = `${prefix}:presence-channels`
  const nodeKey = (id: string) => `${prefix}:node:${id}`
  const handlers: ((channel: string, frame: string, except?: string) => void)[] = []
  const deliverHere = (channel: string, frame: string, except?: string) => {
    for (const handler of handlers) handler(channel, frame, except)
  }

  const beat = () => commands.set(nodeKey(nodeId), '1', 'EX', ttl)
  await beat()
  await subscriber.subscribe(framesChannel)
  subscriber.on('message', (_channel, message) => {
    const parsed = JSON.parse(message) as { from: string; channel: string; frame: string; except?: string }
    if (parsed.from !== nodeId) deliverHere(parsed.channel, parsed.frame, parsed.except)
  })

  // Fields are `<node>|<socket>`; a field whose node's heartbeat expired belongs to a node that stopped.
  const read = async (channel: string) => {
    const fields = await commands.hgetall(presenceKey(channel))
    const nodes = [...new Set(Object.keys(fields).map((field) => field.split('|')[0]!))]
    const alive = new Set(nodes.length ? (await commands.mget(...nodes.map(nodeKey))).flatMap((value, i) => (value ? [nodes[i]!] : [])) : [])
    const live = new Map<string, unknown>()
    const dead: { field: string; userId: string }[] = []
    for (const [field, json] of Object.entries(fields)) {
      const member = JSON.parse(json) as { userId: string; userInfo: unknown }
      if (alive.has(field.split('|')[0]!)) live.set(member.userId, member.userInfo)
      else dead.push({ field, userId: member.userId })
    }
    return { live, dead }
  }

  // Removes stopped nodes' members, announcing each user who has no connection left anywhere.
  const sweep = async () => {
    for (const channel of await commands.smembers(channelsKey)) {
      const { live, dead } = await read(channel)
      for (const { field, userId } of dead) {
        // Only the node that actually removed the field announces it.
        if ((await commands.hdel(presenceKey(channel), field)) && !live.has(userId)) {
          const frame = JSON.stringify({ event: 'pusher_internal:member_removed', channel, data: JSON.stringify({ user_id: userId }) })
          deliverHere(channel, frame)
          await commands.publish(framesChannel, JSON.stringify({ from: nodeId, channel, frame }))
        }
      }
      if (!live.size && !dead.length) await commands.srem(channelsKey, channel)
    }
  }
  const timer = setInterval(() => {
    void beat().then(sweep).catch((error: unknown) => console.error('[caldera] broadcast cluster heartbeat failed', error))
  }, Math.max(250, (ttl * 1000) / 3))
  timer.unref?.()

  return {
    nodeId,
    async members(channel) {
      return (await read(channel)).live
    },
    async join(channel, socketId, member) {
      await commands.hset(presenceKey(channel), `${nodeId}|${socketId}`, JSON.stringify(member))
      await commands.sadd(channelsKey, channel)
    },
    async leave(channel, socketId) {
      await commands.hdel(presenceKey(channel), `${nodeId}|${socketId}`)
    },
    fanOut(channel, frame, except) {
      void commands.publish(framesChannel, JSON.stringify({ from: nodeId, channel, frame, ...(except ? { except } : {}) })).catch((error: unknown) => console.error('[caldera] broadcast cluster publish failed', error))
    },
    onFrame(handler) {
      handlers.push(handler)
    },
    async close() {
      clearInterval(timer)
      await commands.del(nodeKey(nodeId))
      await Promise.all([commands.quit(), subscriber.quit()])
    },
  }
}
