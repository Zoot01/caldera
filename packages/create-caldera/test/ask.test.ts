import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { askCreateOptions, isInteractive, readlinePrompter, type Prompter } from '../src/index.js'

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
    const { prompter, asked } = scripted([join(base, 'blog'), '', 'n'])
    const options = await askCreateOptions(prompter, {}, { npm_config_user_agent: 'bun/1.4.3' })
    expect(options).toEqual({ directory: join(base, 'blog'), packageManager: 'bun', install: false })
    expect(asked).toEqual(['Project name (my-caldera-app)', 'Package manager (bun)', 'Install dependencies now? (true)'])
  })

  it('asks nothing that was given as a flag', async () => {
    const { prompter, asked } = scripted([])
    const given = { directory: 'x', packageManager: 'npm' as const, install: true }
    expect(await askCreateOptions(prompter, given)).toEqual(given)
    expect(asked).toEqual([])
  })

  it('asks again when the folder is taken, suggesting a free name', async () => {
    const taken = join(base, 'taken')
    mkdirSync(taken)
    writeFileSync(join(taken, 'file'), '')
    const { prompter, asked } = scripted([taken, ''])
    const options = await askCreateOptions(prompter, { packageManager: 'pnpm', install: false })
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

describe('readlinePrompter', () => {
  async function run<T>(lines: string[], ask: (p: Prompter) => Promise<T>) {
    const input = new PassThrough()
    const output = new PassThrough()
    let shown = ''
    output.on('data', (chunk) => (shown += chunk))
    const prompter = readlinePrompter(input, output)
    // Feed each line only once its question is on screen, as a person would.
    const feed = (async () => {
      for (const line of lines) {
        await new Promise<void>((r) => output.once('data', () => r()))
        input.write(`${line}\n`)
      }
    })()
    const result = await ask(prompter)
    await feed
    return { result, shown }
  }

  it('uses the default on an empty answer', async () => {
    expect((await run([''], (p) => p.text('Project name', 'app'))).result).toBe('app')
    expect((await run([''], (p) => p.confirm('Install?', true))).result).toBe(true)
    expect((await run(['no'], (p) => p.confirm('Install?', true))).result).toBe(false)
  })

  it('re-asks a select until the answer is one of the options', async () => {
    const { result, shown } = await run(['deno', 'NPM'], (p) => p.select('Package manager', ['pnpm', 'npm'] as const, 'pnpm'))
    expect(result).toBe('npm')
    expect(shown).toContain('[pnpm*/npm]')
    expect(shown.match(/Package manager/g)).toHaveLength(2)
  })
})
