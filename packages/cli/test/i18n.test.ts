import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { check, generate, i18nReport, openProject } from '../src/index.js'

const here = import.meta.dirname
const tmp = join(here, '.tmp')
const PREFIX = 'i18n-'
afterAll(() => {
  for (const entry of existsSync(tmp) ? readdirSync(tmp) : []) if (entry.startsWith(PREFIX)) rmSync(join(tmp, entry), { recursive: true, force: true })
})
const fresh = () => {
  const dir = join(tmp, `${PREFIX}${Math.random().toString(36).slice(2)}`)
  cpSync(join(here, 'fixtures/i18n-app'), dir, { recursive: true, filter: (src) => !src.includes('/.caldera') })
  return dir
}

it('generates the catalogue (app messages over the built-in ones) and each page’s declared messages', async () => {
  const dir = fresh()
  await generate(openProject(dir))
  const gen = readFileSync(join(dir, '.caldera/i18n.gen.ts'), 'utf8')
  expect(gen).toContain('"posts.title.index": "Tous les articles"')
  expect(gen).toContain('"validation.invalid_type.required": "Le champ {attribute} est obligatoire."')
  expect(gen).toContain('"Posts/Index": [\n    "posts.*",\n    "common.missing"\n  ]')
  const register = readFileSync(join(dir, '.caldera/register.d.ts'), 'utf8')
  expect(register).toContain(`declare module '@caldera-js/i18n' {`)
  expect(register).toContain('"posts.count": { "count": number }')
  expect(register).toContain('"posts.by": { "gender": "female" | (string & {}) }')
  expect(register).toContain('"posts.title.index": {}')
})

it('types t(): unknown keys, missing and wrong parameters are compile errors', async () => {
  const dir = fresh()
  await generate(openProject(dir))
  writeFileSync(
    join(dir, 'src/usage.ts'),
    `import { translator } from '@caldera-js/i18n'
const { t } = translator('fr')
t('posts.count', { count: 2 })
t('posts.title.index')
// @ts-expect-error unknown key
t('posts.nope')
// @ts-expect-error missing parameter
t('posts.count')
// @ts-expect-error wrong type
t('posts.count', { count: 'two' })
// @ts-expect-error extra parameter
t('posts.greeting', { name: 'Ann', extra: 1 })
`,
  )
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', noEmit: true, skipLibCheck: true, types: [] }, include: ['src', '.caldera/register.d.ts'] }))
  const tsc = spawnSync(process.execPath, [join(here, '../node_modules/typescript/bin/tsc'), '-p', dir], { encoding: 'utf8' })
  expect(tsc.stdout + tsc.stderr).toBe('')
  expect(tsc.status).toBe(0)
})

it('reports missing, extra, mismatched and unused messages, and check fails on mismatches', async () => {
  const dir = fresh()
  await generate(openProject(dir))
  const report = i18nReport(openProject(dir))
  const fr = report.locales.find((l) => l.locale === 'fr')!
  expect(fr.missing).toEqual(['posts.by', 'posts.orphan'])
  expect(fr.extra).toEqual(['posts.leftover'])
  expect(fr.mismatched).toEqual([{ key: 'posts.count', file: 'lang/fr/posts.json', problems: ["doesn't use {count}", "uses {total}, which the canonical message doesn't take"] }])
  expect(report.unused).toEqual(['posts.count', 'posts.by', 'posts.title.index', 'posts.orphan'])
  expect(report.unknownPagePatterns).toEqual([{ page: 'Posts/Index', pattern: 'common.missing' }])
  const result = await check(openProject(dir))
  expect(result.issues.map((i) => i.code)).toEqual(['i18n_params_mismatch', 'i18n_page_messages_unknown'])
  expect(result.issues[0]!.message).toBe(`lang/fr/posts.json "posts.count" doesn't use {count}; uses {total}, which the canonical message doesn't take (compared with en).`)
})

it('refuses invalid ICU and pages whose messages aren’t a literal list, naming the file', async () => {
  const dir = fresh()
  writeFileSync(join(dir, 'lang/fr/broken.json'), JSON.stringify({ x: '{n, plural, one {#}' }))
  await expect(generate(openProject(dir))).rejects.toThrow(/lang\/fr\/broken.json "broken.x": /)
  rmSync(join(dir, 'lang/fr/broken.json'))
  writeFileSync(join(dir, 'resources/pages/Posts/Index.tsx'), 'const base = ["posts.*"]\nexport const messages = [...base]\nexport default () => null\n')
  await expect(generate(openProject(dir))).rejects.toThrow(/must be a literal array of strings/)
})
