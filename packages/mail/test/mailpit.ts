import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'

const IMAGE = 'axllent/mailpit:latest'
export const hasDocker = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

/** Mailpit (a real SMTP server with an HTTP API to read what it got) in Docker, on free ports. */
export async function startMailpit(): Promise<{ smtpUrl: string; api: string; stop(): void }> {
  if (spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status !== 0) spawnSync('docker', ['pull', '-q', IMAGE], { stdio: 'ignore' })
  for (let attempt = 1; ; attempt++) {
    const [smtp, http] = [await freePort(), await freePort()]
    const run = spawnSync('docker', ['run', '-d', '--rm', '-p', `127.0.0.1:${smtp}:1025`, '-p', `127.0.0.1:${http}:8025`, IMAGE], { encoding: 'utf8' })
    const id = run.stdout.trim()
    if (run.status === 0 && id) {
      const api = `http://127.0.0.1:${http}`
      for (let i = 0; i < 60; i++) {
        if ((await fetch(`${api}/api/v1/messages`).catch(() => undefined))?.ok) return { smtpUrl: `smtp://127.0.0.1:${smtp}`, api, stop: () => void spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' }) }
        await new Promise((r) => setTimeout(r, 250))
      }
      spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' })
    }
    if (attempt >= 5) throw new Error(`Mailpit didn't start: ${run.stderr}`)
  }
}
