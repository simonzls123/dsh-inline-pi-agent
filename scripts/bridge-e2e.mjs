/**
 * End to end: pi calls a DSH tool through the MCP bridge.
 * Boots the minimum services, mounts an executor, registers one tool.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as SessionStats from '@deepseek-ai/dsh-session-stats'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolsService from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as piAgentPlugin from '../src/index.js'

const workdir = join(process.cwd(), '.tmp-bridge-e2e')
mkdirSync(workdir, { recursive: true })
const sessionRoot = join(workdir, 'sessions')
mkdirSync(sessionRoot, { recursive: true })

const ctx = new Context()
ctx.plugin(TypertRegistry)
ctx.plugin(SessionProjectionRegistry)
ctx.plugin(SessionStore)
ctx.plugin(JsonlPersistence, { root: sessionRoot })
ctx.plugin(LlmRuntime)
ctx.plugin(AgentRegistry)
ctx.plugin(TokenMeter)
ctx.plugin(SessionStats)
ctx.plugin(SystemPrompt)
ctx.plugin(ToolsService)
ctx.plugin(NativeExecutor)

let executed = 0
ctx.inject(['tools'], (toolCtx) => {
  toolCtx.tools.register({
    name: 'board_create',
    description: 'Create one task on the shared board.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short task title.' },
    },
    output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
    async execute(args) {
      executed += 1
      return `board task: ${String(args.title)}`
    },
  })
})

ctx.plugin(piAgentPlugin, {
  piPath: process.env.PI_PATH ?? 'pi',
  cwd: workdir,
  debug: process.env.DEBUG === '1',
  dshTools: ['board_create'],
})

const waitFor = async (name, timeoutMs = 20000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const service = ctx.get(name)
    if (service !== undefined) return service
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timeout waiting for service: ${name}`)
}

{
  const tools = await waitFor('tools')
  const batch = await tools.execute({
    calls: [{ type: 'tool-call', id: 'direct-1', name: 'board_create', arguments: JSON.stringify({ title: 'direct' }) }],
    signal: AbortSignal.timeout(10000),
  })
  console.log('direct outcome:', JSON.stringify(batch.results[0]))
}

const agents = await waitFor('agents')
await waitFor('sessions')
await waitFor('sessionPersistence')

const createAgent = async (options) => {
  const deadline = Date.now() + 30000
  for (;;) {
    try {
      return await agents.create(options)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('no agent factory') || Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

const handle = await createAgent({ cwd: workdir, meta: { cwd: workdir } })
const agent = handle.agent
agent.followup(
  createUserMessage({
    content: [{ type: 'text', text: 'Call the mcp__dsh__board_create tool with title "from pi", then reply with only the tool result text.' }],
    source: { kind: 'user' },
  }),
)
await agent.whenIdle()

const events = agent.session.ownEvents()
const call = events.find((event) => event.type === 'tool/call')
const result = events.find((event) => event.type === 'tool/result')
const answer = events.filter((event) => event.type === 'assistant/message').at(-1)

console.log('tool/call name:', call?.data?.name)
console.log('tool/result text:', result?.data?.message?.content?.map((b) => b.text).join(' '))
console.log('final answer:', answer?.data?.message?.content?.filter((b) => b.type === 'text').map((b) => b.text).join(' '))
console.log('dsh-side executions:', executed)
const answerText = answer?.data?.message?.content?.filter((b) => b.type === 'text').map((b) => b.text).join(' ') ?? ''
console.log('direct tool call:', call?.data?.name === 'mcp__dsh__board_create')
console.log('PASS:', call?.data?.name === 'mcp__dsh__board_create' && executed >= 1 && answerText.includes('board task'))
await handle.dispose()
process.exit(0)
