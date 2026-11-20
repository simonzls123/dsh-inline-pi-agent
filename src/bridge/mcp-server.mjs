#!/usr/bin/env node
/**
 * Minimal MCP stdio server exposing DSH tools to one pi child.
 *
 * pi spawns this as its MCP server; every request is forwarded to the plugin's
 * loopback bridge, which owns `ctx.tools`. Nothing is cached: the tool list is
 * fetched per `tools/list`, so DSH-side changes (team mode, presets) show up on
 * the next listing.
 *
 * Framing: newline-delimited JSON-RPC 2.0 on stdin/stdout (MCP stdio transport).
 */

import { createInterface } from 'node:readline'

const url = process.env.DSH_TOOL_BRIDGE_URL ?? ''
const token = process.env.DSH_TOOL_BRIDGE_TOKEN ?? ''
const SERVER_INFO = { name: 'dsh-tools', version: '0.1.0' }

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`)
}

async function post(path, body) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, ...body }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error ?? `bridge returned ${response.status}`)
  return payload
}

async function handle(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      }
    case 'ping':
      return {}
    case 'tools/list': {
      const { tools } = await post('/tools', {})
      return { tools: Array.isArray(tools) ? tools : [] }
    }
    case 'tools/call': {
      const name = String(params?.name ?? '')
      const args = params?.arguments ?? {}
      const result = await post('/call', { name, args, callId: `mcp-${Date.now()}` })
      return {
        content: Array.isArray(result.content) ? result.content : [{ type: 'text', text: '' }],
        isError: result.isError === true,
      }
    }
    case 'resources/list':
      return { resources: [] }
    case 'prompts/list':
      return { prompts: [] }
    default: {
      const error = new Error(`unsupported method: ${String(method)}`)
      error.code = -32601
      throw error
    }
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })

for await (const line of lines) {
  const trimmed = line.trim()
  if (trimmed === '') continue
  let request
  try {
    request = JSON.parse(trimmed)
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'invalid JSON' } })
    continue
  }
  const isNotification = request.id === undefined || request.id === null
  try {
    const result = await handle(request.method, request.params)
    if (!isNotification) send({ jsonrpc: '2.0', id: request.id, result })
  } catch (error) {
    if (!isNotification) {
      send({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: typeof error.code === 'number' ? error.code : -32603, message: String(error.message ?? error) },
      })
    }
  }
}
