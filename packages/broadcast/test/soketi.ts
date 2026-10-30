import { execFileSync, spawnSync } from 'node:child_process'

/** True when Docker is running (Soketi runs in a container); machines without it skip the Soketi tests. */
export const hasDocker = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0

export const SOKETI_APP = { appId: 'caldera-app', key: 'caldera-key', secret: 'caldera-secret' }

/**
 * A throwaway Soketi (a Pusher-compatible server) in Docker, published on a free 127.0.0.1 port,
 * with client events on, as a real realtime server for the tests.
 */
export async function startSoketi(): Promise<{ host: string; port: number; stop(): Promise<void> }> {
  const id = execFileSync('docker', [
    'run', '-d', '--rm', '-p', '127.0.0.1::6001',
    '-e', `SOKETI_DEFAULT_APP_ID=${SOKETI_APP.appId}`,
    '-e', `SOKETI_DEFAULT_APP_KEY=${SOKETI_APP.key}`,
    '-e', `SOKETI_DEFAULT_APP_SECRET=${SOKETI_APP.secret}`,
    '-e', 'SOKETI_DEFAULT_APP_ENABLE_CLIENT_MESSAGES=true',
    'quay.io/soketi/soketi:1.6-16-debian',
  ]).toString().trim()
  const stop = async () => void spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' })
  const port = Number(/:(\d+)\s*$/.exec(execFileSync('docker', ['port', id, '6001']).toString().split('\n')[0]!)![1])
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return { host: '127.0.0.1', port, stop }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  await stop()
  throw new Error('Soketi did not start')
}
