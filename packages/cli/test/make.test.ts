import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ejectStub, make, names, openProject } from '../src/index.js'

const here = import.meta.dirname
const bin = join(here, '../bin/caldera.js')
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
// Copies stay at test/.tmp/<name> (the fixtures' tsconfig extends the base config by relative path),
// and each test file only cleans up its own prefix: files run in parallel.
const tmp = join(here, '.tmp')
const PREFIX = 'make-'
let root: string

beforeEach(() => {
  root = join(tmp, `${PREFIX}${Math.random().toString(36).slice(2)}`)
  cpSync(join(here, 'fixtures/basic-app'), root, { recursive: true, filter: (src) => !src.includes('/.caldera') && !src.includes('/drizzle/') })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
afterAll(() => {
  for (const entry of existsSync(tmp) ? readdirSync(tmp) : []) if (entry.startsWith(PREFIX)) rmSync(join(tmp, entry), { recursive: true, force: true })
})

describe('names', () => {
  it('derives every variant from any spelling', () => {
    for (const input of ['BlogPost', 'blog post', 'blog-post', 'blog_post']) {
      expect(names(input)).toEqual({ Name: 'BlogPost', name: 'blogPost', kebab: 'blog-post', table: 'blog_posts', plural: 'blogPosts' })
    }
    expect(names('category').plural).toBe('categories')
    expect(names('box').table).toBe('boxes')
  })
})

describe('make:*', () => {
  it('scaffolds a model, policy and factory that compile and type-check once registered', async () => {
    const project = openProject(root)
    const model = await make(project, 'model', 'Comment')
    expect(model.created).toEqual(['src/db/tables/comment.ts', 'src/models/comment.ts'])
    expect(model.hints[0]).toMatch(/Add `comments` .* to defineRelations in src\/db\/relations\.ts/)
    expect(model.generate).toMatchObject({ error: expect.stringMatching(/isn't in src\/db\/relations\.ts/) })

    // What the hint tells the developer to do.
    const relations = join(root, 'src/db/relations.ts')
    writeFileSync(
      relations,
      readFileSync(relations, 'utf8')
        .replace("import { posts, users } from './schema.js'", "import { posts, users } from './schema.js'\nimport { comments } from './tables/comment.js'")
        .replace('defineRelations({ users, posts }', 'defineRelations({ users, posts, comments }'),
    )
    // Each CLI command opens a fresh project (module graph); do the same after editing files.
    expect((await make(openProject(root), 'policy', 'comment')).generate).toBe('ok')
    expect((await make(openProject(root), 'factory', 'comment')).created).toEqual(['src/db/factories/comment.ts'])

    const register = readFileSync(join(root, '.caldera/register.d.ts'), 'utf8')
    expect(register).toContain('comments: typeof models0.Comment')
    expect(register).toContain('comment: typeof policies0.CommentPolicy')
    const result = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')], { encoding: 'utf8' })
    expect(result.stdout + result.stderr).toBe('')
  }, 60_000)

  it('refuses to overwrite without --force', async () => {
    const project = openProject(root)
    await make(project, 'routes', 'comments')
    await expect(make(project, 'routes', 'comments')).rejects.toMatchObject({ code: 'file_exists', details: { files: ['src/routes/comments.ts'] } })
    await expect(make(project, 'routes', 'comments', { force: true })).resolves.toMatchObject({ created: ['src/routes/comments.ts'] })
  })

  it('uses an ejected stub over the built-in one', async () => {
    const project = openProject(root)
    expect(ejectStub(project, 'seeder').created).toEqual(['stubs/seeder.stub'])
    writeFileSync(join(root, 'stubs/seeder.stub'), '// custom seeder for {{ Name }}\n')
    await make(project, 'seeder', 'demo data')
    expect(readFileSync(join(root, 'src/db/seeders/demo-data.ts'), 'utf8')).toBe('// custom seeder for DemoData\n')
    expect(() => ejectStub(project, 'nope')).toThrow(/Unknown stub "nope"/)
  })

  it('exits 2 with a JSON error when the name is missing', () => {
    const result = spawnSync(process.execPath, [bin, 'make:model', '--cwd', root, '--json'], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(JSON.parse(result.stdout).error).toMatchObject({ code: 'missing_argument', details: { missing: ['name'] } })
  })
})
