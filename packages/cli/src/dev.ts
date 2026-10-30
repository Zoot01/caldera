import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CalderaError } from '@caldera/core'
import { generate, type GenerateResult } from './codegen.js'
import { CONVENTIONS, openProject } from './project.js'

export interface DevEvent {
  type: 'generated' | 'error'
  /** Files whose contents changed (only for `generated`). */
  changed: string[]
  error?: string
}

export interface DevOptions {
  /** Start the app server with the project's `tsx watch` (default true). */
  server?: boolean
  /** Start the project's Vite dev server when it has a vite.config (default true). */
  vite?: boolean
  serverEntry?: string
  onEvent?: (event: DevEvent) => void
  /** Milliseconds to wait for more changes before regenerating. */
  debounce?: number
}

export interface DevSession {
  /** Resolves once types are generated and the watchers are running. */
  ready: Promise<void>
  stop(): Promise<void>
}

/**
 * Keeps generated types current while you work: generates once, then regenerates on every change
 * under src/ (a fresh project load each time, so edits are seen). Codegen errors are reported and the
 * watcher keeps going; the server (tsx watch) restarts itself on source changes. tsx ignores
 * dot-directories, so when only `.caldera/*.gen.ts` changed (an edit in lang/, say), dev restarts it.
 */
export function startDev(root: string, options: DevOptions = {}): DevSession {
  const emit = options.onEvent ?? (() => {})
  // CALDERA_DEBUG_WATCH=1 logs raw file events and each regeneration, for diagnosing watcher trouble.
  const debug = process.env.CALDERA_DEBUG_WATCH ? (message: string) => process.stderr.write(`[caldera dev ${new Date().toISOString()}] ${message}\n`) : () => {}
  // Set by the src/ watcher: tsx restarts the server itself for those changes.
  let srcTouched = false
  let restartServer: (() => Promise<void>) | undefined
  const run = async () => {
    const touchedSrc = srcTouched
    srcTouched = false
    const started = Date.now()
    debug('generate: start')
    try {
      const project = openProject(root)
      let result: GenerateResult
      try {
        result = await generate(project)
      } finally {
        await project.dispose()
      }
      debug(`generate: done in ${Date.now() - started}ms`)
      const changed = result.files.filter((f) => f.status !== 'unchanged').map((f) => f.path)
      emit({ type: 'generated', changed })
      // The server imports .caldera/*.gen.ts; register.d.ts is types only.
      if (restartServer && !touchedSrc && changed.some((path) => path.startsWith(`${CONVENTIONS.generatedDir}/`) && path.endsWith('.gen.ts'))) {
        debug('generated runtime files changed outside src/: restarting the server')
        await restartServer()
      }
    } catch (error) {
      emit({ type: 'error', changed: [], error: error instanceof Error ? error.message : String(error) })
    }
  }

  let queued: Promise<void> = Promise.resolve()
  let timer: NodeJS.Timeout | undefined
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      queued = queued.then(run)
    }, options.debounce ?? 100)
  }

  const watchers: FSWatcher[] = []
  const children: ChildProcess[] = []
  const firstRun = (queued = run())
  const ready = firstRun.then(async () => {
    // Pages and lang/ live outside src/; both change generated types (pages, message keys).
    for (const dir of ['src', CONVENTIONS.pagesDir, CONVENTIONS.langDir].filter((d) => existsSync(join(root, d)))) {
      watchers.push(
        watch(join(root, dir), { recursive: true }, (event, file) => {
          debug(`fs ${event} ${dir}/${file ?? '?'}`)
          if (file && !String(file).includes(CONVENTIONS.generatedDir)) {
            if (dir === 'src') srcTouched = true
            schedule()
          }
        }),
      )
    }
    const viteConfig = ['vite.config.ts', 'vite.config.mts', 'vite.config.js'].find((f) => existsSync(join(root, f)))
    if ((options.vite ?? true) && (options.server ?? true) && viteConfig) {
      const vite = findBin(root, 'vite')
      if (vite) children.push(spawn(process.execPath, [vite], { cwd: root, stdio: 'inherit' }))
      else emit({ type: 'error', changed: [], error: `${viteConfig} exists but vite isn't installed; install it or use --no-vite.` })
    }
    const nextConfig = ['next.config.ts', 'next.config.mjs', 'next.config.js'].find((f) => existsSync(join(root, f)))
    if (options.server ?? true) {
      // A Next.js app: `next dev` serves the pages and the API (Caldera at /api) and reloads itself.
      const command = nextConfig ? findBin(root, 'next') : findBin(root, 'tsx')
      if (command) {
        const logs = devLogFiles(root)
        const start = () => {
          const child = spawn(process.execPath, nextConfig ? [command, 'dev'] : [command, 'watch', options.serverEntry ?? 'src/server.ts'], {
            cwd: root,
            stdio: ['inherit', 'pipe', 'pipe'],
            // The preload records unexpected errors for `caldera mcp` (last_errors), with source-mapped stacks.
            env: { ...process.env, CALDERA_ERROR_LOG: logs.errors, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${JSON.stringify(PRELOAD)}`.trim() },
          })
          // Shown as before, and kept in .caldera/dev.log for `caldera mcp` (logs).
          child.stdout!.on('data', (chunk: Buffer) => (process.stdout.write(chunk), logs.append(chunk)))
          child.stderr!.on('data', (chunk: Buffer) => (process.stderr.write(chunk), logs.append(chunk)))
          return child
        }
        let server = start()
        children.push(server)
        restartServer = async () => {
          const exited = new Promise((resolve) => server.once('exit', resolve))
          server.kill('SIGTERM')
          await exited
          children.splice(children.indexOf(server), 1, (server = start()))
        }
      } else {
        const missing = nextConfig ? `${nextConfig} exists but next isn't installed` : 'tsx is not installed'
        emit({ type: 'error', changed: [], error: new CalderaError('missing_dependency', `${missing}; install it or use --no-server.`).message })
      }
    }
    // File watchers (FSEvents on macOS) can miss changes made while they start up, or during the
    // first generation. Let them settle, then regenerate once to pick up anything that slipped by.
    await new Promise((r) => setTimeout(r, 100))
    queued = queued.then(run)
    await queued
  })

  return {
    ready,
    async stop() {
      clearTimeout(timer)
      for (const watcher of watchers) watcher.close()
      for (const child of children) child.kill('SIGTERM')
      await queued
    },
  }
}

/** Resolves a package's executable from its own package.json `bin`, walking up node_modules. */
function findBin(root: string, name: string): string | undefined {
  for (let dir = root; ; dir = dirname(dir)) {
    const manifestPath = join(dir, 'node_modules', name, 'package.json')
    if (existsSync(manifestPath)) {
      const bin = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: string | Record<string, string> }).bin
      const relative = typeof bin === 'string' ? bin : bin?.[name]
      return relative ? join(dir, 'node_modules', name, relative) : undefined
    }
    if (dirname(dir) === dir) return undefined
  }
}

const PRELOAD = fileURLToPath(new URL('./dev-preload.js', import.meta.url))
const MAX_LOG_BYTES = 2 * 1024 * 1024

/** `.caldera/dev.log` (the server's output) and `.caldera/dev-errors.jsonl`, fresh for each `caldera dev`. */
export function devLogFiles(root: string) {
  const dir = join(root, CONVENTIONS.generatedDir)
  const log = join(dir, 'dev.log')
  const errors = join(dir, 'dev-errors.jsonl')
  mkdirSync(dir, { recursive: true })
  writeFileSync(log, '')
  writeFileSync(errors, '')
  return {
    log,
    errors,
    append(chunk: Buffer) {
      try {
        appendFileSync(log, chunk)
        // Keep the newest half once it passes the cap.
        if (statSync(log).size > MAX_LOG_BYTES) writeFileSync(log, readFileSync(log).subarray(-MAX_LOG_BYTES / 2))
      } catch {
        // The log is a convenience; never let it stop the server.
      }
    },
  }
}
