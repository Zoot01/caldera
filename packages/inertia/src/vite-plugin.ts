import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Plugin } from 'vite'

export interface CalderaViteOptions {
  /** Entry modules, e.g. `resources/app.tsx`. The same list goes to `viteAssets({ entry })`. */
  input: string | string[]
  /** Where `vite build` writes, served at `/build/`. Default `public/build`. */
  buildDirectory?: string
  /** Where the dev server's URL is written for the app to find. Default `.caldera/vite.hot`. */
  hotFile?: string
  /** The SSR entry (e.g. `resources/ssr.tsx`): `vite build --ssr` builds it to `ssrDirectory`. */
  ssr?: string
  /** Where `vite build --ssr` writes; `viteSsr()` imports `ssr.js` from here. Default `build/ssr`. */
  ssrDirectory?: string
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
    config(user, { command, isSsrBuild }) {
      // A build is for production, whatever NODE_ENV the shell or CI has (test, development): otherwise
      // React's development JSX runtime is compiled in, and the server bundle fails under production.
      if (command === 'build' && process.env.NODE_ENV !== 'production') process.env.NODE_ENV = 'production'
      if (isSsrBuild) {
        // The server bundle: imported by the app (viteSsr()), never served.
        return {
          publicDir: false,
          build: {
            outDir: options.ssrDirectory ?? 'build/ssr',
            emptyOutDir: true,
            manifest: false,
            ...(options.ssr ? { rolldownOptions: { input: options.ssr } } : {}),
          },
        }
      }
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
      // Only a server that listens (`vite`, `caldera dev`) owns the hot file. Vitest runs Vite too,
      // without listening: it must leave a running dev server's file alone, or `pnpm test` during
      // development would point the app back at a build that isn't there.
      const httpServer = server.httpServer
      if (!httpServer) return
      hotPath = resolve(server.config.root, hotFile)
      const origin = () => server.config.server.origin ?? `http://localhost:${server.config.server.port}`
      // Only this server's own file: another dev server may have started since.
      const remove = () => {
        try {
          if (readFileSync(hotPath!, 'utf8') === origin()) rmSync(hotPath!, { force: true })
        } catch {
          // Already gone.
        }
      }
      httpServer.once('listening', () => {
        mkdirSync(dirname(hotPath!), { recursive: true })
        writeFileSync(hotPath!, origin())
        httpServer.once('close', remove)
        // Without the hot file the app falls back to the build, so it must not outlive the server.
        process.once('exit', remove)
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
          process.once(signal, () => {
            remove()
            process.exit()
          })
        }
      })
    },
  }
}
