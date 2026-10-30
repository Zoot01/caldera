/**
 * Base class for every error Caldera throws on purpose. `code` is stable and
 * machine-readable so the CLI, MCP tools and the HTTP error envelope can rely on it.
 */
export class CalderaError extends Error {
  readonly code: string
  readonly details: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = new.target.name
    this.code = code
    this.details = details
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, details: this.details }
  }
}

export interface EnvIssue {
  key: string
  message: string
}

/** Thrown at boot when the environment doesn't match the env schema. Never includes values. */
export class EnvValidationError extends CalderaError {
  declare readonly details: { issues: EnvIssue[] }

  constructor(issues: EnvIssue[]) {
    const list = issues.map((i) => `  - ${i.key}: ${i.message}`).join('\n')
    super('env_invalid', `Invalid environment variables:\n${list}`, { issues })
  }
}

/** Thrown when providers or config can't be assembled into an app (cycles, duplicates, missing deps). */
export class BootError extends CalderaError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, details)
  }
}

/** Thrown when something is read before `app.boot()` has finished. */
export class NotBootedError extends CalderaError {
  constructor(what: string) {
    super('not_booted', `Cannot read ${what} before the app has booted. Call \`await app.boot()\` first, or use \`app.middleware()\`.`)
  }
}
