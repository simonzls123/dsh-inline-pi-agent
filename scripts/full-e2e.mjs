/**
 * Full integration: the exact knob combination the profile ships.
 *
 * `dshTools` loads the bridge extension, `guard` loads the guard extension, and
 * `extensionUi: 'approval'` routes the guard's question through DSH approval.
 * Two extensions means two `-e` flags on one pi child — the failure mode this
 * guards against is a child that exits on startup, which kills every session.
 *
 * Usage: PI_PATH=/path/to/pi node scripts/full-e2e.mjs
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as SessionStats from '@deepseek-ai/dsh-session-stats'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolsService from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as piAgentPlugin from '../src/index.js'
import { buildPiSessionFile } from '../src/history.js'

let failed = false
const check = (label, condition, detail) => {
  console.log(`${condition ? 'OK' : 'FAIL'} ${label}${condition || detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) failed = true
}

class StubApproval extends Service {
  constructor(ctx) {
    super(ctx, 'approval')
    this.asked = []
    this.answer = 'allowed-once'
    this.policy = undefined
  }

  overrideOf() {
    return this.policy
  }

  async request(request) {
    this.asked.push(request)
    return this.answer
  }
}

const root = join(process.cwd(), '.tmp-full')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
const marker = join(root, 'guarded.txt')

const ctx = new Context()
ctx.plugin(TypertRegistry)
ctx.plugin(SessionProjectionRegistry)
ctx.plugin(SessionStore)
ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
ctx.plugin(LlmRuntime)
ctx.plugin(AgentRegistry)
ctx.plugin(TokenMeter)
ctx.plugin(SessionStats)
ctx.plugin(SystemPrompt)
ctx.plugin(ToolsService)
ctx.plugin(NativeExecutor)
ctx.plugin(StubApproval)
ctx.plugin(LocalAttachmentStore, { dshHome: join(root, 'home') })

let boardCalls = 0
ctx.inject(['tools'], (toolCtx) => {
  toolCtx.tools.register({
    name: 'board_create',
    description: 'Create one task on the shared board.',
    parameters: { title: { type: 'string', required: true, description: 'Short task title.' } },
    output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
    async execute(args) {
      boardCalls += 1
      return `board task: ${String(args.title)}`
    },
  })
})

// Exactly what the profile wires: bridge + guard + approval routing.
ctx.plugin(piAgentPlugin, {
  piPath: process.env.PI_PATH ?? 'pi',
  cwd: root,
  piArgs: ['-e', fileURLToPath(new URL('./fixtures/handled-input.mjs', import.meta.url))],
  dshTools: ['board_create'],
  extensionUi: 'approval',
  guard: ['bash'],
  approvalTimeoutMs: 15000,
  debug: process.env.DEBUG === '1',
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

const approval = await waitFor('approval')
const agents = await waitFor('agents')
await waitFor('sessions')
await waitFor('sessionPersistence')

let handle
const deadline = Date.now() + 30000
for (;;) {
  try {
    handle = await agents.create({ meta: { cwd: root } })
    break
  } catch (error) {
    if (!String(error).includes('no agent factory') || Date.now() > deadline) throw error
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
const agent = handle.agent

const ask = async (text) => {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

// 1. The child started at all: a bad `-e` would have exited before this turn.
await ask('Reply with exactly: ALIVE')
const turns = agent.session.ownEvents().filter((event) => event.type === 'assistant/message')
check('pi starts with both extensions loaded', turns.length === 1, `assistant messages=${turns.length}`)

// 2. The bridged DSH tool is reachable.
await ask('Call the mcp__dsh__board_create tool with title "combined", then reply with only its result text.')
const callNames = agent.session.ownEvents().filter((event) => event.type === 'tool/call').map((event) => event.data.name)
check('the bridged tool was callable', callNames.includes('mcp__dsh__board_create'), JSON.stringify(callNames))
check('the DSH tool executed once', boardCalls === 1, `executions=${boardCalls}`)

// 3. pi's own bash is still gated by the guard.
const normalized = marker.replace(/\\/g, '/')
await ask(`Run exactly this bash command: echo ok > ${normalized}`)
check('the guard asked the approval seam', approval.asked.length === 1, `asked=${approval.asked.length}`)
check('the guarded command ran after approval', existsSync(marker), `marker=${existsSync(marker)}`)

// 4. pi's file tools expose DSH's file-card aliases and result metadata.
const written = join(root, 'written.txt')
await ask(`Use the write tool to create ${written.replace(/\\/g, '/')} with exactly this content: hello from pi`)
const writeEvents = agent.session.ownEvents()
const writeCall = writeEvents.find((event) => event.type === 'tool/call' && event.data.name === 'write')
let writeArgs
try { writeArgs = writeCall === undefined ? null : JSON.parse(writeCall.data.arguments) } catch { writeArgs = null }
check(
  'write call exposes file_path to DSH',
  writeArgs !== null && typeof writeArgs.file_path === 'string' && resolve(writeArgs.file_path) === resolve(written),
  JSON.stringify(writeArgs),
)
const writeResult = writeEvents.find((event) => event.type === 'tool/result'
  && String(event.data.message?.source?.callId ?? '') === String(writeCall?.data?.callId ?? ''))
const writeMeta = writeResult?.data?.meta
check(
  'write result carries path and diffs',
  writeMeta !== null && typeof writeMeta === 'object'
    && resolve(String(writeMeta.path)) === resolve(written)
    && Array.isArray(writeMeta.diffs)
    && writeMeta.diffs.some((diff) => typeof diff.newText === 'string' && diff.newText.includes('hello from pi')),
  JSON.stringify(writeMeta),
)
const presented = writeEvents.find((event) => event.type === 'deliverables/presented'
  && String(event.data.callId ?? '') === String(writeCall?.data?.callId ?? ''))
check(
  'write publishes a file delivery',
  presented !== undefined
    && typeof presented.data.turn === 'number'
    && Array.isArray(presented.data.files)
    && presented.data.files.length === 1
    && resolve(String(presented.data.files[0]?.path)) === resolve(written),
  JSON.stringify(presented?.data),
)
check(
  'the file was written',
  existsSync(written) && readFileSync(written, 'utf8').includes('hello from pi'),
  `written=${existsSync(written)}`,
)

// 5. All three tool routes coexist in one session log.
const events = agent.session.ownEvents()
const allCallNames = events.filter((event) => event.type === 'tool/call').map((event) => event.data.name)
check(
  'the session recorded all tool routes',
  ['mcp__dsh__board_create', 'bash', 'write'].every((name) => allCallNames.includes(name)),
  JSON.stringify(allCallNames),
)

// 6. A handled prompt (extension command/input handler) starts no run and
// must close its turn instead of waiting forever for agent_settled.
const turnsBeforeHandled = agent.session.ownEvents().filter((event) => event.type === 'turn/start').length
await ask('HANDLED_TEST')
const handledEvents = agent.session.ownEvents()
const turnsAfterHandled = handledEvents.filter((event) => event.type === 'turn/start').length
const handledEnd = handledEvents.filter((event) => event.type === 'turn/end').at(-1)
check(
  'handled prompt closes its turn without a run',
  turnsAfterHandled === turnsBeforeHandled + 1 && handledEnd?.data?.reason?.kind === 'completed',
  `turns=${turnsBeforeHandled}->${turnsAfterHandled} reason=${JSON.stringify(handledEnd?.data?.reason)}`,
)
await ask('Reply with exactly: AFTER_HANDLED')
const afterHandled = agent.session.ownEvents().filter((event) => event.type === 'assistant/message').at(-1)
const afterHandledText = afterHandled?.data?.message?.content
  ?.filter((block) => block.type === 'text').map((block) => block.text).join(' ') ?? ''
check('the agent still runs after a handled prompt', afterHandledText.includes('AFTER_HANDLED'), afterHandledText)

// 7. Images from DSH attachments are resolved and sent to pi.
await waitFor('attachments')
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const image = await ctx.attachments.saveImage({ data: png, mediaType: 'image/png', name: 'dot.png' })
agent.followup(createUserMessage({
  content: [{ type: 'text', text: 'IMAGE_TEST' }, { type: 'image', attachment: image }],
  source: { kind: 'user' },
}))
await agent.whenIdle()
const imageSeen = JSON.parse(readFileSync(join(root, 'image-seen.json'), 'utf8'))
check('prompt images reach pi', imageSeen.images === 1, JSON.stringify(imageSeen))

const rebuilt = await buildPiSessionFile({
  session: agent.session,
  cwd: root,
  filePath: join(root, 'rebuilt.jsonl'),
  logger: () => {},
  attachments: ctx.attachments,
})
const rebuiltEntries = readFileSync(rebuilt, 'utf8').trim().split(/\r?\n/).slice(1).map((line) => JSON.parse(line))
const rebuiltImage = rebuiltEntries.find((entry) => entry.message?.role === 'user'
  && Array.isArray(entry.message.content)
  && entry.message.content.some((block) => block.type === 'image'))
const rebuiltImageBlock = rebuiltImage?.message.content.find((block) => block.type === 'image')
check(
  'resume history keeps prompt images',
  typeof rebuiltImageBlock?.data === 'string' && typeof rebuiltImageBlock?.mimeType === 'string',
  JSON.stringify(rebuiltImageBlock ?? null),
)

// 8. A next-step message injected while a tool is running reaches pi as a steer.
agent.followup(createUserMessage({
  content: [{ type: 'text', text: 'Use the bash tool to run exactly: sleep 5. After it finishes, reply exactly: SLOW_DONE' }],
  source: { kind: 'user' },
}))
const toolDeadline = Date.now() + 30000
while (Date.now() < toolDeadline
  && !agent.session.ownEvents().some((event) => event.type === 'tool/call' && event.data.name === 'bash')) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 100))
}
agent.inject(createUserMessage({ content: [{ type: 'text', text: 'INJECT_TEST' }], source: { kind: 'user' } }))
await agent.whenIdle()
const injected = existsSync(join(root, 'inject-seen.json'))
  ? JSON.parse(readFileSync(join(root, 'inject-seen.json'), 'utf8'))
  : null
check(
  'injected next-step reaches pi mid-run',
  injected?.text === 'INJECT_TEST',
  JSON.stringify(injected),
)

// 9. A selected model is applied before the next prompt reaches pi.
agent.model.select({ provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' })
await ask('Reply with exactly: MODEL_SELECT_OK')
const selectedAssistant = agent.session.ownEvents().filter((event) => event.type === 'assistant/message').at(-1)
const selectedModel = selectedAssistant?.data?.message?.source?.model
check('model selection reaches pi before the next prompt', selectedModel === 'deepseek-v4-pro', String(selectedModel))
const lastHeader = agent.session.ownEvents().filter((event) => event.type === 'request/header').at(-1)
check(
  'request header records the applied thinking level',
  lastHeader?.data?.header?.config?.reasoningEffort === 'high',
  JSON.stringify(lastHeader?.data?.header?.config),
)

await handle.dispose()
await new Promise((resolve) => setTimeout(resolve, 300))
try {
  rmSync(root, { recursive: true, force: true })
} catch {}
await ctx.dispose?.()

console.log(failed ? 'RESULT: FAILED' : 'RESULT: PASS')
process.exitCode = failed ? 1 : 0
process.exit(process.exitCode)
