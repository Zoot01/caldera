import { confirm, isCancel, select, text } from '@clack/prompts'
import type { Readable, Writable } from 'node:stream'

export interface Prompter {
  /** `validate` returns an error to show (and ask again), or undefined when the answer is fine. */
  text(question: string, defaultValue?: string, validate?: (answer: string) => string | undefined): Promise<string>
  /** `labels` replace the values on screen ("SQLite" for `sqlite`); `hints` are shown beside them. */
  select<T extends string>(question: string, options: readonly T[], defaultValue: T, hints?: Partial<Record<T, string>>, labels?: Partial<Record<T, string>>): Promise<T>
  confirm(question: string, defaultValue: boolean): Promise<boolean>
}

/** The person pressed Ctrl+C (or Escape) at a question: nothing has been written yet. */
export class PromptCancelled extends Error {
  constructor() {
    super('Cancelled.')
  }
}

/**
 * Prompts only when a person is clearly there: both ends are terminals, and it's neither CI nor an
 * AI agent (which should get defaults or a precise error, never a question it can't answer).
 */
export function isInteractive(env: NodeJS.ProcessEnv = process.env, stdin = process.stdin, stdout = process.stdout): boolean {
  if (!stdin.isTTY || !stdout.isTTY) return false
  const automated = ['CI', 'CLAUDECODE', 'CLAUDE_CODE', 'CURSOR_AGENT', 'CODEX_SANDBOX', 'GEMINI_CLI', 'AIDER', 'OPENCODE']
  return !automated.some((name) => env[name] !== undefined && env[name] !== '' && env[name] !== '0' && env[name] !== 'false')
}

/** Arrow-key selects, typed answers with placeholders, and inline validation (@clack/prompts). */
export function clackPrompter(streams: { input?: Readable; output?: Writable } = {}): Prompter {
  const answered = <T>(value: T | symbol): Exclude<T, symbol> => {
    if (isCancel(value)) throw new PromptCancelled()
    return value as Exclude<T, symbol>
  }
  return {
    async text(question, defaultValue, validate) {
      return answered(
        await text({
          ...streams,
          message: question,
          ...(defaultValue ? { placeholder: defaultValue, defaultValue } : {}),
          ...(validate ? { validate: (answer) => validate(answer || defaultValue || '') } : {}),
        }),
      )
    },
    async select(question, options, defaultValue, hints = {}, labels = {}) {
      return answered(
        await select({
          ...streams,
          message: question,
          options: options.map((value) => ({ value, label: labels[value] ?? value, ...(hints[value] ? { hint: hints[value] } : {}) })) as never,
          initialValue: defaultValue,
        }),
      ) as typeof defaultValue
    },
    async confirm(question, defaultValue) {
      return answered(await confirm({ ...streams, message: question, initialValue: defaultValue }))
    },
  }
}
