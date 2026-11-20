/**
 * DshToolBridge — exposes DSH's tool registry to a pi child over loopback HTTP.
 *
 * A pi child is a separate process tree, so it cannot reach `ctx.tools`
 * directly. The plugin therefore serves two endpoints here and hands each child
 * a single-use token:
 *
 *   POST /tools  { token }                        → { tools: [{name, description, inputSchema}] }
 *   POST /call   { token, name, args, callId }    → { content, isError }
 *
 * Execution goes through `ctx.tools.execute` **without** `log`, so the DSH
 * executor still applies its policy pipeline and rendering while writing no
 * session events: pi owns the durable record (its `tool_execution_start` /
 * `tool_execution_end` are what the loop translates into `tool/call` and
 * `tool/result`). Passing `log` here would duplicate every entry.
 */

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

import { toJsonSchema, toMcpContent } from './schema.js'

const MAX_BODY = 1 << 20

/** Read a bounded JSON request body. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (body.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${String(error)}`))
      }
    })
    req.on('error', reject)
  })
}

function reply(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

export class DshToolBridge {
  /**
   * @param tools - the `tools` service, or undefined when the deployment has none.
   * @param allow - tool names to expose; anything else is filtered out.
   */
  constructor({ tools, allow, logger }) {
    this.tools = tools
    this.allow = Array.isArray(allow) ? new Set(allow) : undefined
    this.logger = logger
    this.bindings = new Map()
    this.server = null
    this.url = undefined
  }

  /** Start the loopback listener. Cheap: one ephemeral port, no external I/O. */
  async start() {
    if (this.server !== null) return
    this.server = createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        this.logger?.(`[bridge] ${String(error)}`)
        if (!res.headersSent) reply(res, 500, { error: String(error) })
      })
    })
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    const address = this.server.address()
    this.url = `http://127.0.0.1:${address.port}`
    this.logger?.(`[bridge] listening on ${this.url}`)
  }

  /** Environment for one pi child. The box is filled once its agent exists. */
  envFor(token) {
    return {
      DSH_TOOL_BRIDGE_URL: this.url ?? '',
      DSH_TOOL_BRIDGE_TOKEN: token,
      DSH_TOOL_BRIDGE_NODE: process.execPath,
    }
  }

  /**
   * Reserve a token for one agent. The returned box is filled by the caller
   * after the agent is constructed: tool calls can only arrive after a prompt,
   * which is always later than construction.
   */
  bind() {
    const token = randomBytes(24).toString('hex')
    const box = { agent: undefined }
    this.bindings.set(token, box)
    return { token, box }
  }

  unbind(token) {
    this.bindings.delete(token)
  }

  async close() {
    this.bindings.clear()
    const server = this.server
    this.server = null
    this.url = undefined
    if (server === null) return
    await new Promise((resolve) => server.close(() => resolve()))
  }

  /** Resolve the tool set one agent may use right now, or undefined. */
  async #toolSet(agent, signal) {
    const tools = this.tools
    if (tools === undefined) throw new Error('this deployment has no tool registry')
    if (agent === undefined) throw new Error('session not ready')
    const modelSelection = agent.model?.current?.()
    const set = await tools.resolve({
      agent,
      signal,
      ...(modelSelection === undefined ? {} : { modelSelection }),
    })
    return set
  }

  #visible(set, agent) {
    const schemas = this.tools.schemas(agent, set)
    return schemas.filter((schema) => this.allow === undefined || this.allow.has(schema.name))
  }

  async #handle(req, res) {
    if (req.method !== 'POST') {
      reply(res, 405, { error: 'method not allowed' })
      return
    }
    const body = await readJson(req)
    const box = this.bindings.get(String(body.token ?? ''))
    if (box === undefined) {
      reply(res, 401, { error: 'unknown bridge token' })
      return
    }
    const signal = AbortSignal.timeout(30 * 60 * 1000)
    if (req.url === '/tools') {
      const set = await this.#toolSet(box.agent, signal)
      try {
        reply(res, 200, {
          tools: this.#visible(set, box.agent).map((schema) => ({
            name: String(schema.name),
            description: typeof schema.description === 'string' ? schema.description : '',
            inputSchema: toJsonSchema(schema.parameters),
          })),
        })
      } finally {
        set.dispose()
      }
      return
    }
    if (req.url === '/call') {
      const name = String(body.name ?? '')
      if (name === '') {
        reply(res, 400, { error: 'missing tool name' })
        return
      }
      if (this.allow !== undefined && !this.allow.has(name)) {
        reply(res, 403, { error: `tool "${name}" is not exposed to pi` })
        return
      }
      const set = await this.#toolSet(box.agent, signal)
      try {
        if (this.tools.executable(name, box.agent, set) === undefined) {
          reply(res, 404, { error: `no such tool: ${name}` })
          return
        }
        const batch = await this.tools.execute({
          calls: [
            {
              type: 'tool-call',
              id: String(body.callId ?? `bridge-${Date.now()}`),
              name,
              arguments: JSON.stringify(body.args ?? {}),
            },
          ],
          signal,
          agent: box.agent,
          toolSet: set,
        })
        // `ToolBatchResult.results` wraps each outcome: `{ callId, result }`.
        const outcome = batch.results[0]?.result
        if (outcome === undefined) {
          reply(res, 500, { error: 'the tool produced no outcome' })
          return
        }
        reply(res, 200, {
          isError: outcome.isError === true,
          ...(outcome.isError === true && outcome.error?.message !== undefined
            ? { errorMessage: String(outcome.error.message) }
            : {}),
          content: toMcpContent(outcome.content),
        })
      } finally {
        set.dispose()
      }
      return
    }
    reply(res, 404, { error: `unknown path: ${String(req.url)}` })
  }
}
