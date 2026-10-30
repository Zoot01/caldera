import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'

/**
 * Runs a `vercel build` output (Build Output API v3) the way Vercel serves it, closely enough to
 * test a deployment without one: the function's files laid out as shipped (its folder plus every
 * filePathMap file, symlinks kept), static files first, then the rewrite to the function. The
 * function runs in this process, with this process's env; `cwd` is the task folder, as on Vercel.
 */
export async function serveVercelOutput(project: string, port: number): Promise<{ stop(): Promise<void> }> {
  const output = join(project, '.vercel/output')
  const func = join(output, 'functions/api/index.func')
  const config = JSON.parse(readFileSync(join(func, '.vc-config.json'), 'utf8')) as { handler: string; filePathMap: Record<string, string> }
  const task = mkdtempSync(join(tmpdir(), 'vercel-task-'))
  cpSync(func, task, { recursive: true })
  for (const [to, from] of Object.entries(config.filePathMap)) {
    const source = join(project, from)
    if (existsSync(source)) cpSync(source, join(task, to), { recursive: true, verbatimSymlinks: true })
  }
  const previous = process.cwd()
  process.chdir(task)
  const handler = (await import(join(task, config.handler))) as { default: { fetch(request: Request): Promise<Response> } }
  const types: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }
  const server: Server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url!, 'http://x').pathname)
    const file = join(output, 'static', path)
    if (path !== '/' && existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
      return res.end(readFileSync(file))
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined
    const response = await handler.default.fetch(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, ...(body ? { body } : {}) }))
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    async stop() {
      await new Promise((resolve) => server.close(resolve))
      process.chdir(previous)
      rmSync(task, { recursive: true, force: true })
    },
  }
}
