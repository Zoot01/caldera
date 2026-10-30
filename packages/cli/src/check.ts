import { existsSync } from 'node:fs'
import { CalderaError } from '@caldera/core'
import { AUTH_SCHEMA_FILE, generateProjectAuthSchema } from './auth-schema.js'
import { generate } from './codegen.js'
import { i18nReport } from './i18n.js'
import { workersIssues } from './cloudflare.js'
import { vercelIssues } from './vercel.js'
import { loadApp, projectEnv } from './describe.js'
import type { Project } from './project.js'

export interface CheckIssue {
  code: string
  /** Warnings are reported but don't fail the check. Default error. */
  severity?: 'error' | 'warning'
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

  // Missing translations are normal while a locale is in progress; a translation that takes different
  // parameters breaks at runtime (or renders wrong), so that fails.
  if (existsSync(project.path('lang'))) {
    try {
      const report = i18nReport(project)
      for (const locale of report.locales) {
        for (const m of locale.mismatched) {
          issues.push({ code: 'i18n_params_mismatch', message: `${m.file} "${m.key}" ${m.problems.join('; ')} (compared with ${report.canonical}).`, file: m.file, fix: 'caldera i18n:missing' })
        }
      }
      for (const { page, pattern } of report.unknownPagePatterns) {
        issues.push({ code: 'i18n_page_messages_unknown', message: `Page ${page} declares messages "${pattern}", which matches no ${report.canonical} message.`, fix: 'caldera i18n:missing' })
      }
    } catch (error) {
      issues.push(asIssue(error))
    }
  }

  // Deploy targets (a wrangler config, a vercel.json): the defaults the app would use there.
  const bootWith = async (env: Record<string, unknown>, options: { local?: boolean } = {}) => {
    const app = await loadApp(project)
    await app.boot({ env: options.local === false ? env : { ...projectEnv(project), ...env } })
    return app as unknown as { config: Record<string, any>; shutdown(): Promise<void> }
  }
  for (const target of [workersIssues, vercelIssues]) {
    try {
      issues.push(...(await target(project, bootWith)))
    } catch (error) {
      issues.push(asIssue(error))
    }
  }

  return { schemaVersion: 1, ok: !issues.some((issue) => issue.severity !== 'warning'), issues }
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
