import { createInterface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'

export interface Prompter {
  text(question: string, defaultValue?: string): Promise<string>
  select<T extends string>(question: string, options: readonly T[], defaultValue: T): Promise<T>
  confirm(question: string, defaultValue: boolean): Promise<boolean>
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

export function readlinePrompter(input: Readable = process.stdin, output: Writable = process.stdout): Prompter {
  const ask = async (question: string) => {
    const rl = createInterface({ input, output })
    try {
      return (await rl.question(question)).trim()
    } finally {
      rl.close()
    }
  }
  return {
    async text(question, defaultValue) {
      const answer = await ask(`${question}${defaultValue ? ` (${defaultValue})` : ''}: `)
      return answer || defaultValue || ''
    },
    async select(question, options, defaultValue) {
      for (;;) {
        const answer = await ask(`${question} [${options.map((o) => (o === defaultValue ? `${o}*` : o)).join('/')}]: `)
        if (!answer) return defaultValue
        const match = options.find((o) => o === answer.toLowerCase())
        if (match) return match
      }
    },
    async confirm(question, defaultValue) {
      const answer = (await ask(`${question} ${defaultValue ? '(Y/n)' : '(y/N)'}: `)).toLowerCase()
      return answer ? answer.startsWith('y') : defaultValue
    },
  }
}
