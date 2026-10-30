import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'

const LIMIT_BYTES = 5 * 1024 * 1024

/**
 * The shared dev mail outbox: what the `log` mailer "sent" from every process (the dev server,
 * queue workers, the scheduler), as JSON lines in one file. @caldera/mail calls this hook when it's
 * installed, so the mail package itself never touches the filesystem (edge bundles stay clean).
 */
export function installMailOutbox(file: string) {
  ;(globalThis as { [key: symbol]: unknown })[Symbol.for('caldera.dev.mailOutbox')] = {
    append(entry: unknown) {
      appendFileSync(file, `${JSON.stringify(entry)}\n`)
      // Keep the newest half once it passes the cap: a development aid, not a mail archive.
      if (statSync(file).size > LIMIT_BYTES) {
        const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
        writeFileSync(file, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`)
      }
    },
    async read() {
      if (!existsSync(file)) return []
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as unknown]
          } catch {
            return []
          }
        })
    },
  }
}
