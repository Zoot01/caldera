import { CalderaError } from '@caldera/core'

/** One entry of Vite's `.vite/manifest.json`. */
export interface ManifestChunk {
  file: string
  src?: string
  isEntry?: boolean
  imports?: string[]
  css?: string[]
}

export type ViteManifest = Record<string, ManifestChunk>

export interface ViteAssetsOptions {
  /** Entry modules, relative to the project root, e.g. `resources/app.tsx`. */
  entry: string | string[]
  /** Public URL prefix of the built assets. Default `/build/`. */
  base?: string
  /**
   * The production manifest. Defaults to reading `public/build/.vite/manifest.json` from disk; on
   * edge runtimes import it instead: `import manifest from '../public/build/.vite/manifest.json'`.
   */
  manifest?: ViteManifest | (() => ViteManifest | Promise<ViteManifest>)
  /** File the Caldera Vite plugin writes while the dev server runs. Default `.caldera/vite.hot`. */
  hotFile?: string
}

export interface ViteAssets {
  /** `<script>`/`<link>` tags for the entries, with the CSP nonce when there is one. */
  tags(nonce?: string): Promise<string>
  /** The asset version Inertia compares to force a reload after a deploy. */
  version(): Promise<string | null>
}

/**
 * Asset tags for the root HTML. While `vite` runs (the plugin writes a hot file) the tags point at
 * the dev server for HMR; otherwise they come from the build manifest.
 */
export function viteAssets(options: ViteAssetsOptions): ViteAssets {
  const entries = Array.isArray(options.entry) ? options.entry : [options.entry]
  const base = withTrailingSlash(options.base ?? '/build/')
  let manifest: Promise<ViteManifest> | undefined
  let version: Promise<string | null> | undefined

  const loadManifest = () =>
    (manifest ??= (async () => {
      if (typeof options.manifest === 'function') return options.manifest()
      if (options.manifest) return options.manifest
      const text = await readText('public/build/.vite/manifest.json')
      if (text === undefined) {
        throw new CalderaError('vite_manifest_missing', 'No Vite manifest at public/build/.vite/manifest.json. Run `vite build`, or start `caldera dev` for the dev server.')
      }
      return JSON.parse(text) as ViteManifest
    })().catch((error: unknown) => {
      manifest = undefined // let the next request retry, e.g. once a build has finished
      throw error
    }))

  return {
    async tags(nonce) {
      const n = nonce ? ` nonce="${escapeAttribute(nonce)}"` : ''
      const hot = await devServerUrl(options.hotFile)
      if (hot) {
        return [`<script type="module" src="${hot}/@vite/client"${n}></script>`, ...entries.map((e) => `<script type="module" src="${hot}/${e}"${n}></script>`)].join('\n')
      }
      const chunks = await loadManifest()
      const css = new Set<string>()
      const preloads = new Set<string>()
      const scripts: string[] = []
      for (const entry of entries) {
        const chunk = chunks[entry]
        if (!chunk) throw new CalderaError('vite_entry_missing', `"${entry}" isn't in the Vite manifest. Add it to the plugin's input and rebuild.`)
        scripts.push(base + chunk.file)
        collect(chunks, entry, css, preloads, new Set())
      }
      return [
        ...[...css].map((file) => `<link rel="stylesheet" href="${base}${file}"${n}>`),
        ...[...preloads].filter((file) => !scripts.includes(base + file)).map((file) => `<link rel="modulepreload" href="${base}${file}"${n}>`),
        ...scripts.map((src) => `<script type="module" src="${src}"${n}></script>`),
      ].join('\n')
    },

    version() {
      return (version ??= (async () => {
        // In dev, HMR handles changes; a fixed version keeps Inertia from reloading on every edit.
        if (await devServerUrl(options.hotFile)) {
          version = undefined
          return 'dev'
        }
        return hash(JSON.stringify(await loadManifest()))
      })())
    },
  }
}

function collect(chunks: ViteManifest, key: string, css: Set<string>, preloads: Set<string>, seen: Set<string>) {
  if (seen.has(key)) return
  seen.add(key)
  const chunk = chunks[key]
  if (!chunk) return
  preloads.add(chunk.file)
  for (const file of chunk.css ?? []) css.add(file)
  for (const imported of chunk.imports ?? []) collect(chunks, imported, css, preloads, seen)
}

async function devServerUrl(hotFile = '.caldera/vite.hot'): Promise<string | undefined> {
  const text = await readText(hotFile)
  return text?.trim().replace(/\/$/, '') || undefined
}

/** Reads a project file where there's a filesystem; undefined on edge runtimes or when missing. */
async function readText(path: string): Promise<string | undefined> {
  try {
    const fs = await import('node:fs/promises')
    return await fs.readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const withTrailingSlash = (value: string) => (value.endsWith('/') ? value : `${value}/`)

export function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}
