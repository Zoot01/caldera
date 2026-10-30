import { join } from 'node:path'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { SOKETI_APP } from './soketi.js'

/**
 * The hub as a Durable Object in workerd (Miniflare), listening on a real port so pusher-js can
 * connect, with the app id, key and secret the other servers use.
 */
export async function startWorkerdHub(): Promise<{ host: string; port: number; url: URL; stop(): Promise<void> }> {
  const result = await build({
    entryPoints: [join(import.meta.dirname, 'fixtures/hub-worker.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    write: false,
    logLevel: 'silent',
  })
  const mf = new Miniflare({
    modules: true,
    script: result.outputFiles[0]!.text,
    compatibilityDate: '2026-07-30',
    durableObjects: { BROADCAST_HUB: 'BroadcastHub' },
    bindings: { BROADCAST_APP_ID: SOKETI_APP.appId, BROADCAST_KEY: SOKETI_APP.key, BROADCAST_SECRET: SOKETI_APP.secret },
    host: '127.0.0.1',
    port: 0,
  })
  const url = await mf.ready
  return { host: url.hostname, port: Number(url.port), url, stop: () => mf.dispose() }
}
