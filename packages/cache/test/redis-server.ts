import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'

/** True when a local `redis-server` can be started (CI images without it skip the Redis tests). */
export const hasRedis = spawnSync('redis-server', ['--version']).status === 0

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer().listen(0, () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

/** A throwaway Redis with no persistence, on a free port. */
export async function startRedis(): Promise<{ url: string; stop(): Promise<void> }> {
  const port = await freePort()
  const child: ChildProcess = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('Ready to accept connections')) resolve()
    })
    child.once('exit', (code) => reject(new Error(`redis-server exited with ${code}`)))
  })
  return {
    url: `redis://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.kill('SIGTERM')
      }),
  }
}
