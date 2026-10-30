import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest'
import { generate, make, openProject } from '../src/index.js'

const here = import.meta.dirname
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
const tmp = join(here, '.tmp')
const PREFIX = 'inertia-'
let root: string

beforeEach(() => {
  root = join(tmp, `${PREFIX}${Math.random().toString(36).slice(2)}`)
  cpSync(join(here, 'fixtures/inertia-app'), root, { recursive: true, filter: (src) => !src.includes('/.caldera') })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
afterAll(() => {
  for (const entry of existsSync(tmp) ? readdirSync(tmp) : []) if (entry.startsWith(PREFIX)) rmSync(join(tmp, entry), { recursive: true, force: true })
})

const typecheck = () => spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')], { encoding: 'utf8' })

it('registers every page by path, with its component props, and the shared props', async () => {
  await generate(openProject(root))
  const register = readFileSync(join(root, '.caldera/register.d.ts'), 'utf8')
  expect(register).toContain(
    `  interface PageRegistry {\n` +
      `    'Home': ComponentProps<typeof import('../resources/pages/Home.js').default>\n` +
      `    'Posts/Index': ComponentProps<typeof import('../resources/pages/Posts/Index.js').default>\n` +
      `  }\n`,
  )
  expect(register).toContain(`shared: SharedPropsOf<typeof import('../src/inertia.js').inertia>`)
  expect(register).toContain(`declare module '@inertiajs/core'`)
})

it('type-checks c.render against the pages, and usePage() against the shared props', async () => {
  await generate(openProject(root))
  const result = typecheck()
  expect(result.stdout + result.stderr).toBe('')
  expect(result.status).toBe(0)
})

it('catches a page whose props no longer match the route', async () => {
  await generate(openProject(root))
  writeFileSync(join(root, 'resources/pages/Home.tsx'), 'export default function Home({ name }: { name: string }) {\n  return <p>{name}</p>\n}\n')
  const result = typecheck()
  expect(result.status).not.toBe(0)
  expect(result.stdout).toContain('src/routes/pages.ts')
})

it('make:page creates a nested page and registers it', async () => {
  const result = await make(openProject(root), 'page', 'posts/show')
  expect(result.created).toEqual(['resources/pages/Posts/Show.tsx'])
  expect(result.hints[0]).toContain(`c.render('Posts/Show'`)
  expect(readFileSync(join(root, 'resources/pages/Posts/Show.tsx'), 'utf8')).toContain('export default function Show({ title }: { title: string })')
  expect(readFileSync(join(root, '.caldera/register.d.ts'), 'utf8')).toContain(`'Posts/Show'`)
  expect(typecheck().status).toBe(0)
})
