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
  serverEntry?: string
  onEvent?: (event: DevEvent) => void
  /** Milliseconds to wait for more changes before regenerating. */
  debounce?: number
}

export interface DevSession {
  /** Resolves after the first generation. */
  ready: Promise<void>
  stop(): Promise<void>
}

/**
 * Keeps generated types current while you work: generates once, then regenerates on every change
 * under src/ (a fresh project load each time, so edits are seen). Codegen errors are reported and the
 * watcher keeps going; the server (tsx watch) restarts itself on source changes.
 */
export function startDev(root: string, options: DevOptions = {}): DevSession {
  const emit = options.onEvent ?? (() => {})
  const run = async () => {
    try {
      const result: GenerateResult = await generate(openProject(root))
      emit({ type: 'generated', changed: result.files.filter((f) => f.status !== 'unchanged').map((f) => f.path) })
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

  const ready = (queued = run())
  let watcher: FSWatcher | undefined
  let server: ChildProcess | undefined
  void ready.then(() => {
    watcher = watch(join(root, 'src'), { recursive: true }, (_event, file) => {
      if (file && !String(file).includes(CONVENTIONS.generatedDir)) schedule()
    })
    if (options.server ?? true) {
      const tsx = findBin(root, 'tsx')
      if (!tsx) {
        emit({ type: 'error', changed: [], error: new CalderaError('missing_dependency', 'tsx is not installed; install it or use --no-server.').message })
        return
      }
      server = spawn(process.execPath, [tsx, 'watch', options.serverEntry ?? 'src/server.ts'], { cwd: root, stdio: 'inherit' })
    }
  })

  return {
    ready,
    async stop() {
      clearTimeout(timer)
      watcher?.close()
      server?.kill('SIGTERM')
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
