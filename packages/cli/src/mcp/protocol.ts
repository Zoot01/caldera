import { z } from 'zod'

/**
 * The part of the Model Context Protocol a tools-only server needs: initialize (with version
 * negotiation), ping, tools/list and tools/call, over newline-delimited JSON-RPC. Small enough to
 * own, so the CLI doesn't carry the SDK's HTTP stack; tests drive it with the official SDK client.
 */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const

export interface ToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string
  title: string
  description: string
  input: S
  annotations?: ToolAnnotations
  /** Its result is sent as JSON text (and as `structuredContent` when it's an object). */
  handle(input: z.output<S>): Promise<unknown>
}

export const defineTool = <S extends z.ZodType>(tool: ToolDefinition<S>): ToolDefinition<S> => tool

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

type JsonRpcResponse = { jsonrpc: '2.0'; id: string | number | null } & ({ result: unknown } | { error: { code: number; message: string; data?: unknown } })

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

export interface McpServerOptions {
  name: string
  version: string
  /** Shown to the agent on initialize: what the server is for and how to use it. */
  instructions?: string
  tools: readonly ToolDefinition<any>[]
}

/** Handles one message (or batch); returns what to send back, or undefined for notifications. */
export function createMcpServer(options: McpServerOptions) {
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]))
  let protocolVersion: string = PROTOCOL_VERSIONS[0]

  const listed = options.tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.input, { io: 'input', unrepresentable: 'any' }),
    ...(tool.annotations ? { annotations: { title: tool.title, ...tool.annotations } } : {}),
  }))

  const call = async (params: Record<string, unknown>): Promise<unknown> => {
    const tool = tools.get(String(params.name))
    if (!tool) throw Object.assign(new Error(`Unknown tool: ${String(params.name)}`), { code: INVALID_PARAMS })
    const parsed = tool.input.safeParse(params.arguments ?? {})
    // Bad arguments are the model's to fix, so they come back as a tool error it can read.
    if (!parsed.success) return toolError(`Invalid arguments: ${parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`)
    try {
      const result = await tool.handle(parsed.data)
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
      const structured = protocolVersion >= '2025-06-18' && result !== null && typeof result === 'object' && !Array.isArray(result)
      return { content: [{ type: 'text', text }], ...(structured ? { structuredContent: result } : {}) }
    } catch (error) {
      const e = error as { code?: unknown; message?: string }
      return toolError(typeof e.code === 'string' ? `${e.code}: ${e.message}` : (e.message ?? String(error)))
    }
  }

  const handleOne = async (message: unknown): Promise<JsonRpcResponse | undefined> => {
    const request = message as JsonRpcRequest
    if (typeof request !== 'object' || request === null || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return { jsonrpc: '2.0', id: (request as { id?: string | number })?.id ?? null, error: { code: INVALID_REQUEST, message: 'Invalid request' } }
    }
    const isNotification = request.id === undefined
    try {
      let result: unknown
      switch (request.method) {
        case 'initialize': {
          const asked = String(request.params?.protocolVersion ?? '')
          // The client's version when we speak it, else our latest; the client decides whether to go on.
          protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0]
          result = {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: options.name, version: options.version },
            ...(options.instructions ? { instructions: options.instructions } : {}),
          }
          break
        }
        case 'ping':
          result = {}
          break
        case 'tools/list':
          result = { tools: listed }
          break
        case 'tools/call':
          result = await call(request.params ?? {})
          break
        default:
          if (request.method.startsWith('notifications/')) return undefined
          if (isNotification) return undefined
          return { jsonrpc: '2.0', id: request.id ?? null, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${request.method}` } }
      }
      return isNotification ? undefined : { jsonrpc: '2.0', id: request.id ?? null, result }
    } catch (error) {
      if (isNotification) return undefined
      const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : INTERNAL_ERROR
      return { jsonrpc: '2.0', id: request.id ?? null, error: { code, message: (error as Error).message } }
    }
  }

  return {
    /** One line of input → the line to write back, if any. */
    async handleLine(line: string): Promise<string | undefined> {
      if (!line.trim()) return undefined
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        return JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } })
      }
      if (Array.isArray(message)) {
        const responses = (await Promise.all(message.map(handleOne))).filter(Boolean)
        return responses.length ? JSON.stringify(responses) : undefined
      }
      const response = await handleOne(message)
      return response ? JSON.stringify(response) : undefined
    },
    get protocolVersion() {
      return protocolVersion
    },
  }
}

function toolError(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/**
 * Serves over stdio. stdout carries only protocol messages, so anything else that writes there
 * (an app's console.log during a tool call) is sent to stderr instead.
 */
export function serveStdio(server: ReturnType<typeof createMcpServer>, io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {}): Promise<void> {
  const input = io.input ?? process.stdin
  const output = io.output ?? process.stdout
  const write = output.write.bind(output) as (chunk: string) => boolean
  if (output === process.stdout) {
    process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write
    for (const method of ['log', 'info', 'debug'] as const) console[method] = (...args: unknown[]) => console.error(...args)
  }
  let buffer = ''
  // Responses go out in request order, even when a slow tool call is still running.
  let queue: Promise<void> = Promise.resolve()
  input.setEncoding?.('utf8')
  return new Promise((resolve) => {
    input.on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        const pending = server.handleLine(line)
        queue = queue.then(async () => {
          const response = await pending
          if (response) write(`${response}\n`)
        })
      }
    })
    input.on('end', () => void queue.then(() => resolve()))
  })
}
