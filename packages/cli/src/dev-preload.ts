// Loaded into the app server by `caldera dev` (NODE_OPTIONS=--import), never in production. Records
// unexpected errors for the MCP server's `last_errors` tool; @caldera/http calls the hook by shape.
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'

process.setSourceMapsEnabled(true)
const file = process.env.CALDERA_ERROR_LOG
const MAX_BYTES = 512 * 1024

if (file) {
  ;(globalThis as { [key: symbol]: unknown })[Symbol.for('caldera.dev.reportError')] = (entry: Record<string, unknown>) => {
    try {
      appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
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
