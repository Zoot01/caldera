import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** True when Postgres's own tools are installed (`brew install postgresql`); tests skip otherwise. */
export const hasPostgres = spawnSync('pg_ctl', ['--version']).status === 0 && spawnSync('initdb', ['--version']).status === 0

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

/** A throwaway Postgres cluster in a temp folder, on a free port (retrying if another test took it). */
export async function startPostgres(): Promise<{ url: string; stop(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'caldera-pg-'))
  const data = join(dir, 'data')
  const init = spawnSync('initdb', ['-D', data, '-U', 'caldera', '--auth=trust', '--no-sync', '-E', 'UTF8'], { encoding: 'utf8' })
  if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr}`)
  for (let attempt = 1; ; attempt++) {
    const port = await freePort()
    const start = spawnSync('pg_ctl', ['-D', data, '-l', join(dir, 'log'), '-w', '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`, 'start'], { encoding: 'utf8' })
    if (start.status === 0) {
      return {
        url: `postgres://caldera@127.0.0.1:${port}/postgres`,
        async stop() {
          spawnSync('pg_ctl', ['-D', data, '-m', 'immediate', 'stop'])
          rmSync(dir, { recursive: true, force: true })
        },
      }
    }
    if (attempt >= 5) throw new Error(`postgres could not start: ${start.stderr || start.stdout}`)
  }
}
