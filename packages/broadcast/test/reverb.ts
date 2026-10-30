import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { SOKETI_APP } from './soketi.js'

/** A Laravel app with Reverb installed (`composer require laravel/reverb`); the Reverb tests run only with one. */
export const reverbDir = process.env.CALDERA_REVERB_DIR

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

/** Laravel Reverb (`php artisan reverb:start`), with the app id, key and secret the other servers use. */
export async function startReverb(): Promise<{ host: string; port: number; stop(): Promise<void> }> {
  const port = await freePort()
  const child = spawn('php', ['artisan', 'reverb:start', '--host=127.0.0.1', `--port=${port}`], {
    cwd: reverbDir!,
    env: { ...process.env, REVERB_APP_ID: SOKETI_APP.appId, REVERB_APP_KEY: SOKETI_APP.key, REVERB_APP_SECRET: SOKETI_APP.secret, BROADCAST_CONNECTION: 'reverb' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stop = () =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve()
      child.once('exit', () => resolve())
      child.kill('SIGTERM')
    })
  for (let i = 0; i < 100; i++) {
    try {
      // Reverb answers HTTP on its port once it's listening.
      await fetch(`http://127.0.0.1:${port}/up`)
      return { host: '127.0.0.1', port, stop }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  await stop()
  throw new Error('Reverb did not start')
}
