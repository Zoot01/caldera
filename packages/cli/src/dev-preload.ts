// Loaded into the app server by `caldera dev` (NODE_OPTIONS=--import), never in production. Records
// unexpected errors for the MCP server's `last_errors` tool; @caldera-js/http calls the hook by shape.
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { SourceMap } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installMailOutbox } from './dev-outbox.js'


process.setSourceMapsEnabled(true)
if (process.env.CALDERA_MAIL_OUTBOX) installMailOutbox(process.env.CALDERA_MAIL_OUTBOX)
const file = process.env.CALDERA_ERROR_LOG
const MAX_BYTES = 512 * 1024

if (file) {
  ;(globalThis as { [key: symbol]: unknown })[Symbol.for('caldera.dev.reportError')] = (entry: Record<string, unknown>) => {
    try {
      const stack = typeof entry.stack === 'string' ? mapStack(entry.stack) : entry.stack
      appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry, stack })}\n`)
      // Keep the newest half once it grows past the cap.
      if (statSync(file).size > MAX_BYTES) {
        const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
        writeFileSync(file, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`)
      }
    } catch {
      // Recording is best-effort; it must never break the request.
    }
  }
}

const maps = new Map<string, SourceMap | null>()

/** The source map a bundled file points to (`//# sourceMappingURL=x.map` next to it), if any. */
function mapFor(path: string): SourceMap | null {
  if (maps.has(path)) return maps.get(path)!
  let map: SourceMap | null = null
  try {
    const tail = readFileSync(path, 'utf8').slice(-500)
    const url = /\/\/[#@] sourceMappingURL=([^\s]+)\s*$/.exec(tail)?.[1]
    if (url && !url.startsWith('data:')) {
      const mapPath = join(dirname(path), decodeURIComponent(url))
      if (existsSync(mapPath)) map = new SourceMap(JSON.parse(readFileSync(mapPath, 'utf8')))
    }
  } catch {
    map = null
  }
  maps.set(path, map)
  return map
}

/**
 * Bundled servers (Next.js) don't turn on Node's source maps; they map stacks only when they print
 * them. Frames in bundles with a map file are rewritten to the original file and line here.
 */
function mapStack(stack: string): string {
  return stack.replace(/(\(|at )((?:file:\/\/)?\/[^():\s]+):(\d+):(\d+)/g, (frame, prefix: string, file: string, line: string, column: string) => {
    const path = file.startsWith('file://') ? fileURLToPath(file) : file
    const entry = mapFor(path)?.findEntry(Number(line) - 1, Number(column) - 1) as { originalSource?: string; originalLine?: number; originalColumn?: number } | undefined
    if (!entry?.originalSource || entry.originalLine === undefined) return frame
    const source = entry.originalSource.startsWith('file://') ? fileURLToPath(entry.originalSource) : entry.originalSource
    return `${prefix}${source}:${entry.originalLine + 1}:${(entry.originalColumn ?? 0) + 1}`
  })
}
