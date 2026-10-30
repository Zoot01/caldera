import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createDatabase } from '@caldera/db'
import { sql } from 'drizzle-orm'
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { createMcpServer, defineTool, generate, openProject, runReadOnly } from '../src/index.js'
import { hasPostgres, startPostgres } from './postgres-server.js'

const here = import.meta.dirname
const bin = join(here, '../bin/caldera.js')
const tmp = join(here, '.tmp')
const PREFIX = 'mcp-'
let root: string

beforeAll(async () => {
  root = join(tmp, `${PREFIX}${Math.random().toString(36).slice(2)}`)
  cpSync(join(here, 'fixtures/mcp-app'), root, { recursive: true, filter: (src) => !src.includes('/.caldera') && !src.endsWith('.db') })
  await generate(openProject(root))
  const db = createClient({ url: `file:${join(root, 'app.db')}` })
  await db.execute('create table posts (id integer primary key autoincrement, title text not null)')
  await db.execute("insert into posts (title) values ('First')")
  db.close()
}, 60_000)
afterAll(() => {
  for (const entry of existsSync(tmp) ? readdirSync(tmp) : []) if (entry.startsWith(PREFIX)) rmSync(join(tmp, entry), { recursive: true, force: true })
})

async function connect(args: string[] = []) {
  const client = new Client({ name: 'test', version: '1.0.0' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin, 'mcp', '--cwd', root, ...args], stderr: 'pipe' })
  await client.connect(transport)
  return client
}

type Result = { content: { type: string; text: string }[]; structuredContent?: Record<string, any>; isError?: boolean }
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Result

describe('caldera mcp (official SDK client over stdio)', () => {
  it('negotiates the latest protocol and lists read tools only, unless writes are allowed', async () => {
    const client = await connect()
    expect(client.getServerVersion()).toMatchObject({ name: 'caldera' })
    expect(client.getInstructions()).toContain('describe')
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(['describe', 'routes', 'db_schema', 'model', 'abilities', 'schedules', 'check', 'generate', 'i18n_missing', 'broadcast_list', 'broadcast_authorize', 'mail_list', 'mail_render', 'mail_outbox', 'logs', 'last_errors', 'db_query', 'route_call', 'make'])
    const routeCall = (await client.listTools()).tools.find((t) => t.name === 'route_call')!
    expect(routeCall.annotations).toMatchObject({ readOnlyHint: true })
    expect(routeCall.inputSchema).toMatchObject({ type: 'object', properties: { path: { type: 'string' } } })
    await client.close()
    const writer = await connect(['--allow-writes'])
    expect((await writer.listTools()).tools.map((t) => t.name)).toContain('db_seed')
    await writer.close()
  }, 30_000)

  it('describes the app and its routes, with structured results', async () => {
    const client = await connect()
    const routes = await call(client, 'routes', { filter: 'posts' })
    expect(routes.structuredContent!.routes.map((r: { name: string }) => r.name)).toEqual(['posts.index', 'posts.store', 'posts.boom'])
    expect(JSON.parse(routes.content[0]!.text)).toEqual(routes.structuredContent)
    const described = await call(client, 'describe')
    expect(described.structuredContent!.providers.map((p: { name: string }) => p.name)).toEqual(['db', 'mail'])
    expect(JSON.stringify(described.structuredContent)).not.toContain('file:app.db')
    await client.close()
  }, 30_000)

  it('calls routes in-process, keeps app output off the protocol, and refuses writes without the flag', async () => {
    const client = await connect()
    const list = await call(client, 'route_call', { path: '/posts' })
    expect(list.structuredContent).toMatchObject({ status: 200, body: { posts: [{ id: 1, title: 'First' }] } })
    const missing = await call(client, 'route_call', { path: '/nowhere' })
    expect(missing.structuredContent).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } })
    const refused = await call(client, 'route_call', { method: 'POST', path: '/posts', json: { title: 'Nope' } })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]!.text).toContain('writes_disabled')
    await client.close()

    const writer = await connect(['--allow-writes'])
    const invalid = await call(writer, 'route_call', { method: 'POST', path: '/posts', json: { title: 'x' } })
    expect(invalid.structuredContent).toMatchObject({ status: 422, body: { error: { fields: { title: [expect.any(String)] } } } })
    const created = await call(writer, 'route_call', { method: 'POST', path: '/posts', json: { title: 'Second' } })
    expect(created.structuredContent).toMatchObject({ status: 201, body: { post: { id: 2, title: 'Second' } } })
    await writer.close()
  }, 30_000)

  it('runs SQL read-only: rows come back, writes are refused and change nothing', async () => {
    const client = await connect(['--allow-writes'])
    const rows = await call(client, 'db_query', { sql: 'select id, title from posts where id = 1' })
    expect(rows.structuredContent).toMatchObject({ rows: [{ id: 1, title: 'First' }], truncated: false })
    const write = await call(client, 'db_query', { sql: "delete from posts where title = 'First'" })
    expect(write.isError).toBe(true)
    expect(write.content[0]!.text).toMatch(/^query_failed: .*readonly database/i)
    const still = await call(client, 'db_query', { sql: "select count(*) as n from posts where title = 'First'" })
    expect(still.structuredContent!.rows).toEqual([{ n: 1 }])
    await client.close()
  }, 30_000)

  it('renders mail, and plans files with make (writing only when allowed)', async () => {
    const client = await connect()
    const mail = await call(client, 'mail_render', { name: 'users.welcome', props: { name: 'Bo' } })
    expect(mail.structuredContent).toMatchObject({ subject: 'Welcome, Bo', text: expect.stringContaining('Hi Bo, welcome.') })
    const planned = await call(client, 'make', { kind: 'job', name: 'SendDigest', write: true })
    expect(planned.structuredContent!.planned).toEqual([{ path: 'src/jobs/send-digest.ts', contents: expect.stringContaining("name: 'send-digest'"), exists: false }])
    expect(existsSync(join(root, 'src/jobs/send-digest.ts'))).toBe(false)
    await client.close()
    const writer = await connect(['--allow-writes'])
    const made = await call(writer, 'make', { kind: 'job', name: 'SendDigest', write: true })
    expect(made.structuredContent).toMatchObject({ created: ['src/jobs/send-digest.ts'] })
    expect(existsSync(join(root, 'src/jobs/send-digest.ts'))).toBe(true)
    await writer.close()
  }, 30_000)

  it('reports server errors recorded under caldera dev, with source-mapped stacks', async () => {
    const client = await connect()
    const before = await call(client, 'last_errors')
    expect(before.content[0]!.text).toContain('start the app with `caldera dev`')
    // What caldera dev does for the server: the preload, pointed at .caldera/dev-errors.jsonl.
    writeFileSync(join(root, '.caldera/dev-errors.jsonl'), '')
    writeFileSync(join(root, '.caldera/dev.log'), '\u001b[32mlisting posts\u001b[39m\nGET /posts 200\n')
    const tsx = join(here, '../node_modules/tsx/dist/cli.mjs')
    // NODE_OPTIONS, as caldera dev sets it: tsx runs the script in a child process, which inherits it.
    const run = spawnSync(process.execPath, [tsx, 'src/hit.ts'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CALDERA_ERROR_LOG: join(root, '.caldera/dev-errors.jsonl'), NODE_OPTIONS: `--import ${JSON.stringify(join(here, '../dist/dev-preload.js'))}` },
    })
    expect(run.stdout.trim()).toBe('500')
    const errors = await call(client, 'last_errors')
    const [error] = errors.structuredContent!.errors
    expect(error).toMatchObject({ method: 'GET', path: '/posts/boom', status: 500, message: 'kaboom' })
    // Mapped to the .ts source: the throw is on line 19.
    expect(error.stack).toMatch(/src\/routes\/posts\.ts:19:11/)
    const logs = await call(client, 'logs', { contains: 'posts' })
    expect(logs.structuredContent!.lines).toEqual(['listing posts', 'GET /posts 200'])
    await client.close()
  }, 30_000)

  it('answers bad arguments as a tool error the model can read', async () => {
    const client = await connect()
    const bad = await call(client, 'route_call', { path: 'no-slash' })
    expect(bad.isError).toBe(true)
    expect(bad.content[0]!.text).toMatch(/^Invalid arguments: path:/)
    await client.close()
  }, 30_000)
})

describe('protocol', () => {
  const server = () =>
    createMcpServer({ name: 't', version: '1', tools: [defineTool({ name: 'echo', title: 'Echo', description: 'Echo', input: z.object({ text: z.string() }), handle: async ({ text }) => ({ text }) })] })
  const send = async (s: ReturnType<typeof server>, message: unknown) => JSON.parse((await s.handleLine(JSON.stringify(message)))!)

  it('speaks an older client’s version, and leaves out structured content before 2025-06-18', async () => {
    const s = server()
    expect((await send(s, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'old', version: '0' } } })).result.protocolVersion).toBe('2024-11-05')
    const result = (await send(s, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } })).result
    expect(result).toEqual({ content: [{ type: 'text', text: '{\n  "text": "hi"\n}' }] })
    expect((await send(s, { jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2099-01-01' } })).result.protocolVersion).toBe('2025-11-25')
  })

  it('answers JSON-RPC errors: unknown method, unknown tool, unparseable input; ignores notifications', async () => {
    const s = server()
    expect((await send(s, { jsonrpc: '2.0', id: 1, method: 'resources/list' })).error.code).toBe(-32601)
    expect((await send(s, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope' } })).error).toMatchObject({ code: -32602, message: 'Unknown tool: nope' })
    expect(JSON.parse((await s.handleLine('{oops'))!).error.code).toBe(-32700)
    expect(await s.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).toBeUndefined()
    expect(await send(s, { jsonrpc: '2.0', id: 9, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 9, result: {} })
  })
})

describe.runIf(hasPostgres)('db_query on Postgres (real server)', () => {
  it('refuses writes with READ ONLY and rolls everything back', async () => {
    const server = await startPostgres()
    const pool = new pg.Pool({ connectionString: server.url, max: 2 })
    try {
      const db = createDatabase(drizzlePg({ client: pool }), { driver: 'postgres' })
      await pool.query('create table notes (id serial primary key, body text not null)')
      await pool.query("insert into notes (body) values ('keep')")
      expect(await runReadOnly(db, sql, 'select body from notes', 10)).toEqual({ rows: [{ body: 'keep' }], count: 1, truncated: false })
      await expect(runReadOnly(db, sql, 'delete from notes', 10)).rejects.toThrow(/cannot execute DELETE in a read-only transaction/)
      // A writable CTE is refused too; nothing slips through as a "select".
      await expect(runReadOnly(db, sql, "with gone as (delete from notes returning *) select * from gone", 10)).rejects.toThrow(/read-only transaction/)
      expect((await pool.query('select count(*)::int as n from notes')).rows).toEqual([{ n: 1 }])
      const many = await runReadOnly(db, sql, 'select generate_series(1, 5) as n', 2)
      expect(many).toEqual({ rows: [{ n: 1 }, { n: 2 }], count: 5, truncated: true })
    } finally {
      await pool.end()
      await server.stop()
    }
  }, 60_000)
})
