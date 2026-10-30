import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
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
    if (options.server ?? true) {
      const tsx = findBin(root, 'tsx')
      if (tsx) {
        const start = () => spawn(process.execPath, [tsx, 'watch', options.serverEntry ?? 'src/server.ts'], { cwd: root, stdio: 'inherit' })
        let server = start()
        children.push(server)
        restartServer = async () => {
          const exited = new Promise((resolve) => server.once('exit', resolve))
          server.kill('SIGTERM')
          await exited
          children.splice(children.indexOf(server), 1, (server = start()))
        }
      } else emit({ type: 'error', changed: [], error: new CalderaError('missing_dependency', 'tsx is not installed; install it or use --no-server.').message })
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
