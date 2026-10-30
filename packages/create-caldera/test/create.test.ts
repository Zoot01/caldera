import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProject, detectPackageManager, packageManagerVersion } from '../src/index.js'

const repo = join(import.meta.dirname, '../../..')
let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'create-caldera-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const offline = { install: false, git: false, env: { PATH: '' } }

describe('createProject', () => {
  it('writes the bundled template with the name filled in and a fresh APP_KEY', () => {
    const result = createProject({ directory: join(base, 'My App'), ...offline, packageManager: 'pnpm' })
    const dir = result.directory
    expect(result.name).toBe('my-app')
    for (const file of ['.gitignore', '.env', '.env.example', 'AGENTS.md', 'src/app.ts', 'src/http.ts', 'src/routes/home.ts', 'tests/home.test.ts']) {
      expect(existsSync(join(dir, file)), file).toBe(true)
    }
    expect(existsSync(join(dir, '_gitignore'))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name).toBe('my-app')
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toContain('pnpm dev')
    const key = readFileSync(join(dir, '.env'), 'utf8').match(/^APP_KEY=(.+)$/m)![1]!
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const other = createProject({ directory: join(base, 'second'), ...offline })
    expect(readFileSync(join(other.directory, '.env'), 'utf8')).not.toContain(key)
    expect(readFileSync(join(dir, '.env.example'), 'utf8')).toContain('APP_KEY=\n')
    // pnpm 11 fails installs with unapproved build scripts; esbuild's is approved up front.
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('esbuild: true')
    // bullmq's msgpackr-extract has a build script too; declined, or pnpm 11 fails the install.
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('msgpackr-extract: false')
    expect(existsSync(join(other.directory, 'pnpm-workspace.yaml'))).toBe(other.packageManager === 'pnpm')
  })

  it('never touches a non-empty folder, and suggests a free name', () => {
    const dir = join(base, 'taken')
    mkdirSync(dir)
    writeFileSync(join(dir, 'keep.txt'), 'mine')
    expect(() => createProject({ directory: dir, ...offline })).toThrow(expect.objectContaining({ code: 'dir_not_empty', details: expect.objectContaining({ suggestion: 'taken-2' }) }))
    expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('mine')
    mkdirSync(join(base, 'empty'))
    expect(() => createProject({ directory: join(base, 'empty'), ...offline })).not.toThrow()
  })

  it('reports skipped steps with the exact commands to finish setup, and exits successfully', () => {
    const result = createProject({ directory: join(base, 'app'), ...offline, packageManager: 'npm' })
    expect(result.steps.map((s) => [s.name, s.status])).toEqual([
      ['files', 'done'],
      ['install', 'skipped'],
      ['generate', 'skipped'],
      ['database', 'skipped'],
      ['git', 'skipped'],
    ])
    expect(result.next).toEqual([`cd ${join(base, 'app')}`, 'npm install', 'npm exec -- caldera generate', 'npm exec -- caldera db:push -- --force', 'npm run dev'])
  })

  it('records the package manager version only when the package manager reported it', () => {
    const withAgent = createProject({ directory: join(base, 'a'), ...offline, env: { PATH: '', npm_config_user_agent: 'pnpm/11.25.0 npm/? node/v24.14.1 darwin arm64' } })
    expect(JSON.parse(readFileSync(join(withAgent.directory, 'package.json'), 'utf8')).packageManager).toBe('pnpm@11.25.0')
    const without = createProject({ directory: join(base, 'b'), ...offline, packageManager: 'pnpm' })
    expect(JSON.parse(readFileSync(join(without.directory, 'package.json'), 'utf8'))).not.toHaveProperty('packageManager')
  })

  it('installs @caldera packages from local tarballs in development, as npm would', () => {
    const result = createProject({ directory: join(base, 'linked'), ...offline, packageManager: 'pnpm', link: repo })
    const manifest = JSON.parse(readFileSync(join(result.directory, 'package.json'), 'utf8'))
    expect(manifest.dependencies['@caldera/core']).toMatch(/^file:\.\/\.caldera-local\/caldera-core-.+\.tgz$/)
    expect(manifest.devDependencies['@caldera/cli']).toMatch(/^file:\.\/\.caldera-local\/caldera-cli-/)
    expect(readFileSync(join(result.directory, 'pnpm-workspace.yaml'), 'utf8')).toMatch(/overrides:\n(  '@caldera\/\w+': 'file:.+'\n){9}/)
    expect(readFileSync(join(result.directory, '.gitignore'), 'utf8')).toContain('.caldera-local')
    expect(manifest.dependencies.hono).toMatch(/^\^/)
  }, 60_000)
})

describe('detectPackageManager', () => {
  it('prefers the user agent, then what is installed, then npm', () => {
    expect(detectPackageManager({ npm_config_user_agent: 'yarn/4.5.0 npm/? node/v24' })).toBe('yarn')
    const bin = mkdtempSync(join(tmpdir(), 'pm-bin-'))
    writeFileSync(join(bin, 'bun'), '#!/bin/sh\n')
    chmodSync(join(bin, 'bun'), 0o755)
    expect(detectPackageManager({ PATH: bin })).toBe('bun')
    expect(detectPackageManager({ PATH: '' })).toBe('npm')
    expect(packageManagerVersion('pnpm', { npm_config_user_agent: 'pnpm/11.25.0 npm/?' })).toBe('11.25.0')
    expect(packageManagerVersion('pnpm', {})).toBeUndefined()
    rmSync(bin, { recursive: true, force: true })
  })
})

// End to end against the npm registry: CALDERA_E2E=1 pnpm vitest run packages/create-caldera
describe.runIf(process.env.CALDERA_E2E === '1')('end to end', () => {
  it('creates, installs, generates, type-checks, tests and serves a working app', async () => {
    const result = createProject({ directory: join(base, 'e2e-app'), packageManager: 'pnpm', link: repo, git: true })
    const dir = result.directory
    expect(result.steps.filter((s) => s.status !== 'done'), readFileSync(result.log, 'utf8').slice(-3000)).toEqual([])

    const run = (...args: string[]) => spawnSync('pnpm', args, { cwd: dir, encoding: 'utf8' })
    const typecheck = run('typecheck')
    expect(typecheck.status, typecheck.stdout + typecheck.stderr).toBe(0)
    const tests = run('test')
    expect(tests.status, tests.stdout + tests.stderr).toBe(0)

    const { spawn } = await import('node:child_process')
    const poll = async <T>(read: () => Promise<T | undefined>): Promise<T | undefined> => {
      for (let i = 0; i < 60; i++) {
        const value = await read().catch(() => undefined)
        if (value !== undefined) return value
        await new Promise((r) => setTimeout(r, 500))
      }
      return undefined
    }

    // `caldera dev`: the codegen watcher, the server under tsx watch, and Vite.
    const dev = spawn('pnpm', ['dev'], { cwd: dir, env: { ...process.env, PORT: '3456' }, detached: true })
    try {
      const body = await poll(() => fetch('http://localhost:3456/users').then((r) => r.json()))
      expect(body).toEqual({ users: [] }) // the database step created the table
      // The page loads its scripts from the Vite dev server, which compiles the entry.
      const html = await poll(() => fetch('http://localhost:3456/').then((r) => r.text()).then((t) => (t.includes('@vite/client') ? t : undefined)))
      // With the CSP nonce, so the strict CSP lets the dev server's scripts run.
      expect(html).toMatch(/<script type="module" src="http:\/\/localhost:5173\/resources\/app\.tsx" nonce="[\w+/=]+"><\/script>/)
      expect(html).toContain('"component":"Home"')
      const entry = await fetch('http://localhost:5173/resources/app.tsx').then((r) => r.text())
      expect(entry).toContain('createInertiaApp')
    } finally {
      process.kill(-dev.pid!, 'SIGTERM') // the whole group: pnpm, caldera dev, tsx and vite
    }
    await poll(async () => (existsSync(join(dir, '.caldera/vite.hot')) ? undefined : true))
    expect(existsSync(join(dir, '.caldera/vite.hot'))).toBe(false)

    // Production: built assets from the manifest, served from public/build.
    const build = run('build')
    expect(build.status, build.stdout + build.stderr).toBe(0)
    const start = spawn('pnpm', ['start'], { cwd: dir, env: { ...process.env, PORT: '3457', NODE_ENV: 'production' }, detached: true })
    try {
      const html = await poll(() => fetch('http://localhost:3457/').then((r) => r.text()))
      const script = /<script type="module" src="(\/build\/assets\/[^"]+\.js)" nonce="[\w+/=]+">/.exec(html ?? '')?.[1]
      expect(script, html).toBeDefined()
      expect(html).toMatch(/<link rel="stylesheet" href="\/build\/assets\/[^"]+\.css" nonce="[\w+/=]+">/)
      const asset = await fetch(`http://localhost:3457${script}`)
      expect(asset.status).toBe(200)
      // A visit with the old asset version is told to reload the page.
      const stale = await fetch('http://localhost:3457/', { headers: { 'x-inertia': 'true', 'x-inertia-version': 'old' } })
      expect(stale.status).toBe(409)
    } finally {
      process.kill(-start.pid!, 'SIGTERM')
    }
  }, 300_000)
})
