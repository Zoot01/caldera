import { existsSync } from 'node:fs'
import { CalderaError } from '@caldera/core'
import { AUTH_SCHEMA_FILE, generateProjectAuthSchema } from './auth-schema.js'
import { generate } from './codegen.js'
import type { Project } from './project.js'

export interface CheckIssue {
  code: string
  message: string
  file?: string
  /** The command that fixes it, when there is one. */
  fix?: string
}

export interface CheckResult {
  schemaVersion: 1
  ok: boolean
  issues: CheckIssue[]
}

/** Everything `caldera check` verifies, for CI and agents. Never writes files. */
export async function check(project: Project): Promise<CheckResult> {
  const issues: CheckIssue[] = []

  try {
    const generated = await generate(project, { check: true })
    for (const file of generated.files.filter((f) => f.status === 'stale')) {
      issues.push({ code: 'stale_generated', message: `${file.path} is out of date with the code.`, file: file.path, fix: 'caldera generate' })
    }
  } catch (error) {
    issues.push(asIssue(error))
  }

  if (existsSync(project.path(AUTH_SCHEMA_FILE))) {
    try {
      const auth = await generateProjectAuthSchema(project, { check: true })
      if (auth.status === 'stale') {
        issues.push({ code: 'stale_auth_schema', message: `${AUTH_SCHEMA_FILE} doesn't match your Better Auth config (plugins changed?).`, file: AUTH_SCHEMA_FILE, fix: 'caldera auth:schema' })
      }
    } catch (error) {
      issues.push(asIssue(error))
    }
  }

  return { schemaVersion: 1, ok: issues.length === 0, issues }
}

function asIssue(error: unknown): CheckIssue {
  // By shape: errors from the project's code come from its own copy of @caldera/core.
  if (error instanceof Error && typeof (error as CalderaError).code === 'string') {
    const e = error as CalderaError
    const file = (e.details as { file?: string } | undefined)?.file
    return { code: e.code, message: e.message, ...(file ? { file } : {}) }
  }
  return { code: 'internal_error', message: error instanceof Error ? error.message : String(error) }
}
