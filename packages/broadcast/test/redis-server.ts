import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'

/** True when a local `redis-server` can be started (CI images without it skip the Redis tests). */
export const hasRedis = spawnSync('redis-server', ['--version']).status === 0

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

/**
 * A throwaway Redis with no persistence, on a free port. Test files run in parallel, so another one
 * may grab the same port between picking it and binding it. Redis binds 127.0.0.1 only (like the
 * other test servers), so that collision is a bind error, not a silent connection to someone else's
 * server, and it simply tries another port.
 */
export async function startRedis(): Promise<{ url: string; stop(): Promise<void> }> {
  for (let attempt = 1; ; attempt++) {
    const port = await freePort()
    const child: ChildProcess = spawn('redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const started = await new Promise<boolean>((resolve) => {
      child.stdout!.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('Ready to accept connections')) resolve(true)
      })
      child.once('exit', () => resolve(false))
    })
    if (started) {
      return {
        url: `redis://127.0.0.1:${port}`,
        stop: () =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null) return resolve()
            child.once('exit', () => resolve())
            child.kill('SIGTERM')
          }),
      }
    }
    if (attempt >= 5) throw new Error(`redis-server could not start (last port ${port})`)
  }
}
