import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { askCreateOptions, clackPrompter, isInteractive, PromptCancelled, type Prompter } from '../src/index.js'

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'create-caldera-ask-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

/** Answers questions from a script and records what was asked. */
function scripted(answers: string[]) {
  const asked: string[] = []
  const next = () => answers.shift() ?? ''
  const prompter: Prompter = {
    async text(question, defaultValue) {
      asked.push(`${question} (${defaultValue})`)
      // No inline validation here: askCreateOptions asks again itself.
      return next() || defaultValue || ''
    },
    async select(question, _options, defaultValue) {
      asked.push(`${question} (${defaultValue})`)
      return (next() || defaultValue) as typeof defaultValue
    },
    async confirm(question, defaultValue) {
      asked.push(`${question} (${defaultValue})`)
      const answer = next()
      return answer ? answer === 'y' : defaultValue
    },
  }
  return { prompter, asked }
}

describe('askCreateOptions', () => {
  it('asks for everything missing, defaulting to the detected package manager', async () => {
    const { prompter, asked } = scripted([join(base, 'blog'), 'blank', '', 'vercel', '', 'n'])
    const options = await askCreateOptions(prompter, {}, { npm_config_user_agent: 'bun/1.4.3' })
    expect(options).toEqual({ directory: join(base, 'blog'), frontend: 'inertia', kit: 'blank', database: 'sqlite', target: 'vercel', packageManager: 'bun', install: false })
    expect(asked).toEqual([
      'Project name (my-caldera-app)',
      'Starter kit (starter)',
      'Database (sqlite)',
      'Deploy target (node)',
      'Package manager (bun)',
      'Install dependencies now? (true)',
    ])
  })

  it('offers only the targets that work with the answers so far', async () => {
    const offered: string[][] = []
    const { prompter } = scripted(['postgres'])
    const select = prompter.select.bind(prompter)
    prompter.select = async (question, options, ...rest) => {
      offered.push([question, ...options])
      return select(question, options, ...rest)
    }
    const options = await askCreateOptions(prompter, { directory: 'x', packageManager: 'pnpm', install: false, kit: 'starter' })
    expect(options.database).toBe('postgres')
    // Workers apps use D1, so Postgres can't go there.
    expect(offered).toEqual([
      ['Database', 'sqlite', 'postgres'],
      ['Deploy target', 'node', 'vercel'],
    ])
  })

  it('asks no kit for the Next.js variant (--next)', async () => {
    const { prompter, asked } = scripted([])
    const options = await askCreateOptions(prompter, { directory: 'x', frontend: 'next', packageManager: 'pnpm', install: false })
    expect(options).toEqual({ directory: 'x', frontend: 'next', database: 'sqlite', target: 'node', packageManager: 'pnpm', install: false })
    expect(asked).toEqual(['Database (sqlite)', 'Deploy target (node)'])
  })

  it('asks nothing that was given as a flag', async () => {
    const { prompter, asked } = scripted([])
    const given = { directory: 'x', frontend: 'inertia' as const, kit: 'blank' as const, database: 'postgres' as const, target: 'node' as const, packageManager: 'npm' as const, install: true }
    expect(await askCreateOptions(prompter, given)).toEqual(given)
    expect(asked).toEqual([])
  })

  it('asks again when the folder is taken, suggesting a free name', async () => {
    const taken = join(base, 'taken')
    mkdirSync(taken)
    writeFileSync(join(taken, 'file'), '')
    const { prompter, asked } = scripted([taken, ''])
    const options = await askCreateOptions(prompter, { packageManager: 'pnpm', install: false, kit: 'starter', database: 'sqlite', target: 'node' })
    expect(options.directory).toBe('taken-2')
    expect(asked[1]).toBe(`${taken} already exists and isn't empty. Project name (taken-2)`)
  })
})

describe('isInteractive', () => {
  const tty = { isTTY: true } as never
  it('needs terminals on both ends', () => {
    expect(isInteractive({}, tty, tty)).toBe(true)
    expect(isInteractive({}, { isTTY: false } as never, tty)).toBe(false)
    expect(isInteractive({}, tty, { isTTY: undefined } as never)).toBe(false)
  })
  it('never prompts in CI or under an AI agent', () => {
    expect(isInteractive({ CI: 'true' }, tty, tty)).toBe(false)
    expect(isInteractive({ CLAUDECODE: '1' }, tty, tty)).toBe(false)
    expect(isInteractive({ CI: '0' }, tty, tty)).toBe(true)
    expect(isInteractive({ CI: 'false' }, tty, tty)).toBe(true)
  })
})

describe('clackPrompter', () => {
  // A terminal: keys go in, the prompt is drawn on `output`. Each key is sent once the prompt is on screen.
  async function run<T>(keys: string[], ask: (p: Prompter) => Promise<T>) {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (on: boolean) => void }
    const output = new PassThrough() as PassThrough & { columns?: number; rows?: number }
    output.columns = 80
    output.rows = 24
    let shown = ''
    output.on('data', (chunk) => (shown += chunk))
    const result = ask(clackPrompter({ input, output }))
    for (const key of keys) {
      await new Promise((r) => setTimeout(r, 20))
      input.write(key)
    }
    return { result: await result, shown }
  }
  const ENTER = '\r'
  const DOWN = '\u001b[B'

  it('takes the default on Enter, and typed text', async () => {
    expect((await run([ENTER], (p) => p.text('Project name', 'my-app'))).result).toBe('my-app')
    expect((await run(['b', 'l', 'o', 'g', ENTER], (p) => p.text('Project name', 'my-app'))).result).toBe('blog')
  })

  it('selects with the arrow keys, showing labels and hints', async () => {
    const { result, shown } = await run([DOWN, ENTER], (p) => p.select('Database', ['sqlite', 'postgres'] as const, 'sqlite', { postgres: 'Needs a Postgres server' }, { sqlite: 'SQLite', postgres: 'Postgres' }))
    expect(result).toBe('postgres')
    expect(shown).toContain('Needs a Postgres server')
    expect(shown).toContain('SQLite')
    expect((await run([ENTER], (p) => p.confirm('Install dependencies now?', true))).result).toBe(true)
  })

  it('shows a validation error and keeps asking', async () => {
    const { result, shown } = await run(['x', ENTER, '\u007f', 'y', ENTER], (p) => p.text('Project name', undefined, (a) => (a === 'x' ? 'x is taken' : undefined)))
    expect(result).toBe('y')
    expect(shown).toContain('x is taken')
  })

  it('throws PromptCancelled on Ctrl+C', async () => {
    await expect(run(['\u0003'], (p) => p.text('Project name', 'app'))).rejects.toBeInstanceOf(PromptCancelled)
  })
})
