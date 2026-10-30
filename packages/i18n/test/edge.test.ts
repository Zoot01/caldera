import { join } from 'node:path'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { messages } from './catalog.js'

let mf: Miniflare
beforeAll(async () => {
  const result = await build({
    entryPoints: [join(import.meta.dirname, 'fixtures/edge-worker.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    write: false,
    logLevel: 'silent',
    // The catalog is read from lang/ at build time here, as `caldera generate` would embed it.
    plugins: [
      {
        name: 'catalog',
        setup(b) {
          b.onResolve({ filter: /edge-messages\.js$/ }, () => ({ path: 'catalog', namespace: 'catalog' }))
          b.onLoad({ filter: /.*/, namespace: 'catalog' }, () => ({ contents: `export const messages = ${JSON.stringify({ en: messages.en, fr: messages.fr })}`, loader: 'js' }))
        },
      },
    ],
  })
  // No nodejs_compat: the runtime needs nothing from Node.
  mf = new Miniflare({ modules: true, script: result.outputFiles[0]!.text, compatibilityDate: '2026-07-30' })
  await mf.ready
}, 60_000)
afterAll(async () => {
  await mf?.dispose()
})

it('translates, formats and localizes validation errors on workerd', async () => {
  const res = await mf.dispatchFetch('http://edge.test/', { headers: { 'accept-language': 'fr-FR,fr;q=0.9' } })
  expect(await res.json()).toEqual({ locale: 'fr', count: '1 200 articles', date: '30 octobre 2026', money: '9,50 €' })
  const invalid = await mf.dispatchFetch('http://edge.test/', { method: 'POST', headers: { 'content-type': 'application/json', 'accept-language': 'fr' }, body: JSON.stringify({ title: 'x' }) })
  expect(invalid.status).toBe(422)
  expect(((await invalid.json()) as { error: { fields: unknown } }).error.fields).toEqual({ title: ['Le champ title doit contenir au moins 3 caractères.'] })
})
