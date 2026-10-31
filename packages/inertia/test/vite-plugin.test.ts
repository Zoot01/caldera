import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { afterEach, expect, it } from 'vitest'
import caldera from '../src/vite-plugin.js'

let root: string
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('writes the hot file while the dev server listens, and removes it when it stops', async () => {
  root = mkdtempSync(join(tmpdir(), 'caldera-vite-plugin-'))
  const server = await createServer({ root, configFile: false, logLevel: 'silent', plugins: [caldera({ input: 'app.ts' })], server: { port: 0, strictPort: false } })
  await server.listen()
  const hot = join(root, '.caldera/vite.hot')
  expect(readFileSync(hot, 'utf8')).toMatch(/^http:\/\/localhost:\d+$/)
  await server.close()
  expect(existsSync(hot)).toBe(false)
})

it('leaves a running dev server’s hot file alone from a server that never listens (Vitest’s)', async () => {
  root = mkdtempSync(join(tmpdir(), 'caldera-vite-plugin-'))
  const hot = join(root, '.caldera/vite.hot')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(root, '.caldera'))
  writeFileSync(hot, 'http://localhost:5173')
  const server = await createServer({ root, configFile: false, logLevel: 'silent', plugins: [caldera({ input: 'app.ts' })], server: { middlewareMode: true } })
  await server.close()
  process.emit('exit', 0)
  expect(readFileSync(hot, 'utf8')).toBe('http://localhost:5173')
})
