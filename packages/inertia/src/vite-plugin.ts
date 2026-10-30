import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Plugin } from 'vite'

export interface CalderaViteOptions {
  /** Entry modules, e.g. `resources/app.tsx`. The same list goes to `viteAssets({ entry })`. */
  input: string | string[]
  /** Where `vite build` writes, served at `/build/`. Default `public/build`. */
  buildDirectory?: string
  /** Where the dev server's URL is written for the app to find. Default `.caldera/vite.hot`. */
  hotFile?: string
}

/**
 * Connects Vite to a Caldera app: builds to `public/build` with a manifest, and while the dev server
 * runs, writes its URL to the hot file so the app's pages load assets (with HMR) from it.
 */
export default function caldera(options: CalderaViteOptions): Plugin {
  const buildDirectory = (options.buildDirectory ?? 'public/build').replace(/\/$/, '')
  const hotFile = options.hotFile ?? '.caldera/vite.hot'
  let hotPath: string | undefined

  return {
    name: 'caldera',
    config(user, { command }) {
      // A fixed port gives a fixed origin, so asset URLs Vite writes (CSS url(), imported images)
      // point at the dev server instead of the app.
      const port = user.server?.port ?? 5173
      const host = typeof user.server?.host === 'string' ? user.server.host : 'localhost'
      return {
        base: command === 'build' ? `/${buildDirectory.split('/').pop()}/` : '/',
        // public/ belongs to the app; copying it into public/build would nest it forever.
        publicDir: false,
        build: {
          manifest: true,
          outDir: buildDirectory,
          emptyOutDir: true,
          rolldownOptions: { input: options.input },
        },
        server: {
          port,
          strictPort: true,
          origin: user.server?.origin ?? `http://${host}:${port}`,
        },
      }
    },
    configureServer(server) {
      hotPath = resolve(server.config.root, hotFile)
      const write = () => {
        mkdirSync(dirname(hotPath!), { recursive: true })
        writeFileSync(hotPath!, server.config.server.origin ?? `http://localhost:${server.config.server.port}`)
      }
      const remove = () => rmSync(hotPath!, { force: true })
      server.httpServer?.once('listening', write)
      server.httpServer?.once('close', remove)
      // Without the hot file the app falls back to the build, so it must not outlive the server.
      process.once('exit', remove)
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
        process.once(signal, () => {
          remove()
          process.exit()
        })
      }
    },
  }
}
