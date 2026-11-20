/**
 * Bridge smoke: the loopback HTTP endpoint the plugin serves, and the MCP stdio
 * server pi spawns. Both run against a stubbed `tools` service, so this needs
 * neither a DSH deployment nor a model.
 *
 * Usage: node scripts/bridge-smoke.mjs
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { DshToolBridge } from '../src/bridge/server.js'

let failed = false
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`OK ${label}`)
    return
  }
  failed = true
  console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const calls = []
const stubTools = {
  async resolve() {
    return { dispose() {}, view: () => new Map() }
  },
  schemas() {
    return [
      {
        name: 'task_create',
        description: 'Create a shared task',
        parameters: {
          title: { type: 'string', required: true, description: 'Short title' },
          owner: { type: 'string', description: 'Assign to a teammate' },
        },
      },
      { name: 'bash', description: 'not exposed', parameters: {} },
    ]
  },
  executable(name) {
    return name === 'task_create' ? { name } : undefined
  },
  async execute(input) {
    calls.push(input)
    return {
      results: [
        {
          callId: input.calls[0].id,
          result: {
            isError: false,
            content: [{ type: 'text', text: `created ${JSON.parse(input.calls[0].arguments).title}` }],
          },
        },
      ],
      additionalContexts: [],
      concluded: false,
    }
  },
}

const bridge = new DshToolBridge({ tools: stubTools, allow: ['task_create'], logger: () => {} })
await bridge.start()
const { token, box } = bridge.bind()
box.agent = { id: 'agent-1' }

const post = async (path, body) => {
  const response = await fetch(`${bridge.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

// ---- HTTP bridge ----
{
  const listing = await post('/tools', { token })
  check('tools/list reached the bridge', listing.status === 200, JSON.stringify(listing.body))
  const exposed = listing.body.tools ?? []
  check('allowlist filtered out other tools', exposed.length === 1 && exposed[0].name === 'task_create', JSON.stringify(exposed))
  check('DSH required booleans became a required array', JSON.stringify(exposed[0]?.inputSchema?.required) === '["title"]', JSON.stringify(exposed[0]?.inputSchema))
  check('properties are otherwise preserved', exposed[0]?.inputSchema?.properties?.owner?.description === 'Assign to a teammate')

  const denied = await post('/tools', { token: 'nope' })
  check('unknown token is rejected', denied.status === 401)

  const notAllowed = await post('/call', { token, name: 'bash', args: {} })
  check('a non-exposed tool is refused', notAllowed.status === 403, JSON.stringify(notAllowed.body))

  const call = await post('/call', { token, name: 'task_create', args: { title: 'wire the board' }, callId: 'call-1' })
  check('call returned rendered content', call.status === 200 && call.body.content?.[0]?.text === 'created wire the board', JSON.stringify(call.body))
  check('execute received a tool-call block with JSON arguments', calls[0]?.calls?.[0]?.type === 'tool-call' && calls[0]?.calls?.[0]?.arguments === '{"title":"wire the board"}', JSON.stringify(calls[0]))
  check('execute was called without log (pi owns the session record)', calls[0]?.log === undefined)
}

// ---- MCP stdio server ----
{
  const env = { ...process.env, ...bridge.envFor(token) }
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/bridge/mcp-server.mjs', import.meta.url))], {
    env,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const pending = new Map()
  let nextId = 0
  createInterface({ input: child.stdout }).on('line', (line) => {
    const record = JSON.parse(line)
    pending.get(record.id)?.(record)
    pending.delete(record.id)
  })
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      setTimeout(() => reject(new Error(`timeout: ${method}`)), 10000).unref?.()
    })

  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
  check('initialize answers with tools capability', init.result?.capabilities?.tools !== undefined, JSON.stringify(init))
  check('initialize echoes the requested protocol version', init.result?.protocolVersion === '2025-06-18')

  const list = await request('tools/list', {})
  check('tools/list proxies the bridge', list.result?.tools?.[0]?.name === 'task_create', JSON.stringify(list))

  const call = await request('tools/call', { name: 'task_create', arguments: { title: 'mcp path' } })
  check('tools/call proxies through to DSH', call.result?.content?.[0]?.text === 'created mcp path', JSON.stringify(call))
  check('tools/call reports isError false', call.result?.isError === false)

  const bad = await request('tools/call', { name: 'bash', arguments: {} })
  check('an unknown tool surfaces as a JSON-RPC error', bad.error?.code !== undefined, JSON.stringify(bad))

  child.kill()
}

await bridge.close()
console.log(failed ? 'RESULT: FAILED' : 'RESULT: PASS')
process.exitCode = failed ? 1 : 0
