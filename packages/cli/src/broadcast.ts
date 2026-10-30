import { createRequire } from 'node:module'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CalderaError } from '@caldera/core'
import { loadApp, projectEnv } from './describe.js'
import { loadModels } from './models.js'
import { channelFiles, eventFiles, exportsOfKind, type Project } from './project.js'

interface ChannelLike {
  pattern: string
  type: 'public' | 'private' | 'presence'
  options: { bind?: Record<string, unknown>; member?: unknown; clientEvents?: Record<string, unknown>; guests?: boolean }
  source?: { file: string; line: number }
}
interface EventLike {
  name: string
  broadcast?: { as?: string; queue?: boolean; with?: unknown }
}
interface BroadcasterLike {
  authorize(request: { channel: string; user: unknown; gate?: unknown }): Promise<unknown>
  manager: { describe(): { default: string; instances: { name: string; driver: string; capabilities: unknown }[] } }
}

/** Every channel exported from src/channels, with its export name and file. */
export async function loadChannels(project: Project): Promise<{ file: string; exportName: string; channel: ChannelLike }[]> {
  const found = []
  for (const file of channelFiles(project)) {
    for (const { exportName, value } of exportsOfKind<ChannelLike>(await project.load(file), 'caldera.channel')) found.push({ file, exportName, channel: value })
  }
  return found
}

/** Events in src/events that broadcast. */
export async function loadBroadcastEvents(project: Project): Promise<{ file: string; exportName: string; event: EventLike }[]> {
  const found = []
  for (const file of eventFiles(project)) {
    for (const { exportName, value } of exportsOfKind<EventLike>(await project.load(file), 'caldera.event')) if (value.broadcast) found.push({ file, exportName, event: value })
  }
  return found
}

/**
 * The warning both platform checks give when the app broadcasts events but its connection there
 * delivers nothing (log, null): browsers wouldn't hear them.
 */
export async function broadcastNowhere(project: Project, broadcast: { default?: string; connections?: Record<string, { driver?: string } | undefined> } | undefined, platform: string) {
  const driver = broadcast?.connections?.[broadcast.default ?? '']?.driver
  if (driver !== 'log' && driver !== 'null') return []
  const events = await loadBroadcastEvents(project)
  if (!events.length) return []
  return [
    {
      code: 'broadcast_nowhere',
      severity: 'warning' as const,
      message: `On ${platform} the broadcast connection is "${broadcast!.default}" (${driver}), so ${events.map((e) => e.event.broadcast!.as ?? e.event.name).join(', ')} reach no browser. Set BROADCAST_CONNECTION (pusher, server, cloudflare).`,
      file: 'src/config/broadcast.ts',
    },
  ]
}

/** Models in src/models that broadcast their writes (`defineModel(…, { broadcast })`). */
export async function loadBroadcastModels(project: Project): Promise<{ file: string; exportName: string; events: string[] }[]> {
  const { models } = await loadModels(project)
  return models.flatMap((m) => {
    const events = (m.model as unknown as { describe(): { broadcast: string[] | null } }).describe().broadcast
    return events ? [{ file: m.file, exportName: m.exportName, events }] : []
  })
}

/** `caldera broadcast:list`: channels (who may join, and where), broadcast events, and the connection. */
export async function listBroadcasts(project: Project) {
  const channels = (await loadChannels(project)).map(({ channel, exportName, file }) => ({
    pattern: channel.pattern,
    type: channel.type,
    export: exportName,
    params: [...channel.pattern.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!),
    bindings: Object.fromEntries(Object.entries(channel.options.bind ?? {}).map(([param, binder]) => [param, typeof binder === 'function' ? 'custom' : ((binder as { name?: string }).name ?? 'model')])),
    guests: Boolean(channel.options.guests),
    member: Boolean(channel.options.member),
    clientEvents: Object.keys(channel.options.clientEvents ?? {}),
    file: channel.source ? `${relativeTo(project, channel.source.file)}:${channel.source.line}` : file,
  }))
  const events = (await loadBroadcastEvents(project)).map(({ event, exportName, file }) => ({
    name: event.name,
    as: event.broadcast!.as ?? event.name,
    export: exportName,
    queued: Boolean(event.broadcast!.queue),
    // Without `with`, every field of the payload reaches every subscriber.
    with: Boolean(event.broadcast!.with),
    file,
  }))
  // Model broadcasting: each event, sent after a write commits, always with `with` (it's required).
  for (const { exportName, file, events: names } of await loadBroadcastModels(project)) {
    for (const name of names) events.push({ name, as: name, export: `${exportName} (model)`, queued: false, with: true, file })
  }
  return { schemaVersion: 1 as const, channels, events }
}

/**
 * Who may join a channel, and why: the channel's authorize() run for one user (by id, through the
 * `user` model), or for a guest. What `caldera mcp`'s broadcast_authorize returns.
 */
export async function authorizeChannel(project: Project, request: { channel: string; userId?: string | number }) {
  const app = (await loadApp(project)) as Awaited<ReturnType<typeof loadApp>> & { services: Record<string, unknown> }
  await app.boot({ env: projectEnv(project) })
  try {
    const broadcaster = app.services.broadcast as BroadcasterLike | undefined
    if (!broadcaster) throw new CalderaError('no_broadcast', 'The app has no broadcastProvider (src/app.ts).')
    let user: unknown = null
    if (request.userId !== undefined) {
      const model = (await loadModels(project)).models.find((m) => m.model.name === 'user')
      if (!model) throw new CalderaError('no_user_model', 'No model named "user" in src/models, to load the user from.')
      user = await (model.model as unknown as { find(id: string | number): Promise<unknown> }).find(request.userId)
      if (!user) throw new CalderaError('not_found', `No user ${request.userId}.`)
    }
    let gate: unknown
    try {
      const { createGate } = await project.importPackage<{ createGate(options: { user: unknown }): unknown }>('@caldera/auth')
      gate = createGate({ user })
    } catch {
      gate = undefined
    }
    return { schemaVersion: 1 as const, user: request.userId ?? null, ...((await broadcaster.authorize({ channel: request.channel, user, ...(gate ? { gate } : {}) })) as object) }
  } finally {
    await app.shutdown()
  }
}

export interface HubSettings {
  connection: string
  appId: string
  key: string
  secret: string
  host: string
  port: number
}

/**
 * The pusher-protocol server a connection points at, from the app's config: what `caldera
 * broadcast:serve` runs and `caldera dev` starts. The connection must use the pusher driver with a `host`.
 */
export async function hubSettings(project: Project, options: { connection?: string } = {}): Promise<HubSettings> {
  const app = (await loadApp(project)) as Awaited<ReturnType<typeof loadApp>> & { config: Record<string, any> }
  await app.boot({ env: projectEnv(project) })
  try {
    const config = app.config.broadcast as { default: string; connections: Record<string, Record<string, unknown> | undefined> } | undefined
    if (!config) throw new CalderaError('no_broadcast_config', 'No broadcast config (src/config/broadcast.ts).')
    const name = options.connection ?? config.default
    const connection = config.connections[name]
    if (!connection) throw new CalderaError('broadcast_connection_missing', `No broadcast connection "${name}".`)
    if (connection.driver !== 'pusher' || !connection.host) {
      throw new CalderaError('broadcast_not_self_hosted', `The "${name}" connection uses the ${String(connection.driver)} driver${connection.driver === 'pusher' ? ' without a host (hosted Pusher)' : ''}: there's no server to run. Point a pusher connection at a host (BROADCAST_HOST) to serve it yourself.`)
    }
    // The same secret the app signs with: set, or derived from APP_KEY (by the app's own @caldera/broadcast).
    const { resolveSecret } = await importFromProject<{ resolveSecret(config: { secret?: unknown; appKey?: unknown }, where: string): Promise<string> }>(project.root, '@caldera/broadcast')
    const secret = await resolveSecret({ secret: connection.secret, appKey: connection.appKey }, `The "${name}" broadcast connection`)
    return { connection: name, appId: String(connection.appId), key: String(connection.key), secret, host: String(connection.host), port: Number(connection.port ?? 6001) }
  } finally {
    await app.shutdown()
  }
}

/** `caldera broadcast:serve`: the app's realtime server, from the project's own @caldera/broadcast. */
export async function serveBroadcast(project: Project, options: { connection?: string; host?: string; port?: number } = {}) {
  const settings = await hubSettings(project, options)
  const { startBroadcastServer } = await importFromProject<{ startBroadcastServer(options: Record<string, unknown>): Promise<{ port: number; close(): Promise<void> }> }>(project.root, '@caldera/broadcast/server')
  const server = await startBroadcastServer({ appId: settings.appId, key: settings.key, secret: settings.secret, port: options.port ?? settings.port, host: options.host ?? '127.0.0.1' })
  return { settings, server }
}

/**
 * For `caldera dev`: runs the app's realtime server when its broadcast connection points at this
 * machine and nothing is listening there yet (Soketi, Reverb or another `broadcast:serve`).
 */
export async function startDevBroadcastServer(project: Project): Promise<{ port: number; close(): Promise<void> } | undefined> {
  let settings: HubSettings
  try {
    settings = await hubSettings(project)
  } catch {
    return undefined
  }
  if (!['127.0.0.1', 'localhost', '0.0.0.0', '::1'].includes(settings.host)) return undefined
  if (await listening(settings.port)) return undefined
  const { startBroadcastServer } = await importFromProject<{ startBroadcastServer(options: Record<string, unknown>): Promise<{ port: number; close(): Promise<void> }> }>(project.root, '@caldera/broadcast/server')
  return startBroadcastServer({ appId: settings.appId, key: settings.key, secret: settings.secret, port: settings.port, host: '127.0.0.1' })
}

/** Imports a package's built JS as the project resolves it (no TypeScript loader). */
async function importFromProject<T>(root: string, specifier: string): Promise<T> {
  let resolved: string
  try {
    resolved = createRequire(join(root, 'package.json')).resolve(specifier)
  } catch (error) {
    throw new CalderaError('missing_dependency', `Can't load ${specifier} from this project (is ${specifier.split('/').slice(0, 2).join('/')} installed and built?): ${(error as Error).message.split('\n')[0]}`, { package: specifier })
  }
  return (await import(pathToFileURL(resolved).href)) as T
}

const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    socket.once('connect', () => (socket.destroy(), resolve(true)))
    socket.once('error', () => resolve(false))
  })

const relativeTo = (project: Project, file: string) => (file.startsWith(project.root) ? file.slice(project.root.length + 1) : file)
