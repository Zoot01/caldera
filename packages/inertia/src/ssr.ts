import type { PageObject } from './inertia.js'
import { devServerUrl, isTestRun, readText } from './vite.js'

/** What an Inertia SSR render returns: tags for the <head>, and the body (page data plus rendered app). */
export interface SsrResult {
  head: string[]
  body: string
}

/** Renders a page on the server. `null` means "render on the client this time". */
export interface SsrRenderer {
  render(page: PageObject): Promise<SsrResult | null>
  /** One-time loading (the SSR bundle), done outside the render timeout so a cold start isn't a timeout. */
  prepare?(): Promise<unknown>
  /** Milliseconds before giving up and rendering on the client. Default 2000. */
  readonly timeout?: number
}

const RENDER = Symbol.for('caldera.inertia.ssr')
type RenderPage = (page: PageObject) => Promise<SsrResult> | SsrResult

/**
 * Supplies the SSR render function where the bundle can't be imported from disk at runtime: a
 * bundled deployment imports `build/ssr/ssr.js` and passes its default export here.
 */
export function setSsrRender(render: RenderPage | undefined) {
  ;(globalThis as { [key: symbol]: unknown })[RENDER] = render
}

const warned = new Set<string>()
const warnOnce = (message: string) => {
  if (warned.has(message)) return
  warned.add(message)
  console.warn(`[caldera] ${message}`)
}

/**
 * Server-side rendering with Inertia's Vite plugin and your SSR entry (`resources/ssr.tsx`):
 * - while the Vite dev server runs, pages render through it (`/__inertia_ssr`), with HMR;
 * - in production on Node, the SSR build (`vite build --ssr`, written to `build/ssr/ssr.js`) is
 *   imported once and renders in-process: no second server to run;
 * - a bundled deployment passes the render function to `setSsrRender()`.
 * Whatever fails, the page still renders: on the client, as without SSR.
 */
export function viteSsr(options: { bundle?: string; hotFile?: string; timeout?: number } = {}): SsrRenderer {
  const bundle = options.bundle ?? 'build/ssr/ssr.js'
  let loaded: Promise<RenderPage | null> | undefined

  const fromBundle = () =>
    (loaded ??= (async () => {
      if ((await readText(bundle)) === undefined) {
        warnOnce(`No SSR build at ${bundle}: pages render on the client. Build it with \`vite build --ssr\`.`)
        return null
      }
      const [{ pathToFileURL }, { resolve }] = await Promise.all([import('node:url'), import('node:path')])
      const module = (await import(pathToFileURL(resolve(bundle)).href)) as { default?: unknown }
      const render = await Promise.resolve(module.default)
      if (typeof render !== 'function') throw new Error(`${bundle} must export a render function (export default (page) => …).`)
      return render as RenderPage
    })().catch((error: unknown) => {
      loaded = undefined
      throw error
    }))

  return {
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    async prepare() {
      const provided = (globalThis as { [key: symbol]: unknown })[RENDER]
      if (provided || isTestRun() || (await devServerUrl(options.hotFile))) return
      await fromBundle()
    },
    async render(page) {
      const provided = (globalThis as { [key: symbol]: unknown })[RENDER] as RenderPage | undefined
      if (provided) return provided(page)
      // Tests render pages without a build or dev server (their props are what they assert on).
      if (isTestRun()) return null
      const dev = await devServerUrl(options.hotFile)
      if (dev) {
        const response = await fetch(`${dev}/__inertia_ssr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(page) })
        if (!response.ok) throw new Error(`the Vite dev server's SSR endpoint answered ${response.status}: ${(await response.text()).slice(0, 500)}`)
        // null while Vite is still warming up the SSR module graph.
        return (await response.json()) as SsrResult | null
      }
      const render = await fromBundle()
      return render ? render(page) : null
    },
  }
}

/** Runs the renderer with its timeout; any failure is logged and means client rendering. */
export async function renderOnServer(renderer: SsrRenderer, page: PageObject): Promise<SsrResult | null> {
  const timeout = renderer.timeout ?? 2000
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await renderer.prepare?.()
    const result = await Promise.race([
      renderer.render(page),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`took longer than ${timeout}ms`)), timeout)
      }),
    ])
    if (result && (typeof result.body !== 'string' || !Array.isArray(result.head))) throw new Error('the SSR render must return { head: string[], body: string }')
    return result
  } catch (error) {
    console.error(`[caldera] SSR failed for ${page.component} (${page.url}), rendering on the client: ${(error as Error).message}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}
