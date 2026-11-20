/**
 * Compaction e2e: pi compacts, the DSH log records it, and the surface shrinks.
 *
 * Usage: PI_PATH=/path/to/pi node scripts/compaction-e2e.mjs
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import CommandsService from '@deepseek-ai/dsh-commands'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as SessionStats from '@deepseek-ai/dsh-session-stats'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as piAgentPlugin from '../src/index.js'
import { shadowedSeqSet } from '../src/compaction.js'

let failed = false
const check = (label, condition, detail) => {
  console.log(`${condition ? 'OK' : 'FAIL'} ${label}${condition || detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) failed = true
}

const root = join(process.cwd(), '.tmp-compaction')
rmSync(root, { recursive: true, force: true })
mkdirSync(join(root, '.pi'), { recursive: true })
// pi keeps 20k recent tokens by default — far more than a test can afford to
// generate. A project-local settings file (trusted with `-a`) shrinks the window
// so compaction has something to do.
writeFileSync(
  join(root, '.pi', 'settings.json'),
  `${JSON.stringify({ compaction: { keepRecentTokens: 120 } }, null, 2)}
`,
)

const ctx = new Context()
ctx.plugin(TypertRegistry)
ctx.plugin(SessionProjectionRegistry)
ctx.plugin(SessionStore)
ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
ctx.plugin(LlmRuntime)
ctx.plugin(AgentRegistry)
ctx.plugin(CommandsService)
ctx.plugin(TokenMeter)
ctx.plugin(SessionStats)
ctx.plugin(piAgentPlugin, {
  piPath: process.env.PI_PATH ?? 'pi',
  cwd: root,
  piArgs: ['-a'],
  piSessionDir: join(root, 'pi-sessions'),
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

// Enough history that pi agrees to compact: it refuses on tiny sessions.
for (const n of [1, 2, 3]) {
  await ask(`Reply with exactly: TURN_${n}. Then write the numbers 1 to 60, one per line.`)
}

// `/compact` must exist and drive pi through the plugin's command handler.
const commands = await waitFor('commands')
const names = commands.list(agent).map((descriptor) => descriptor.name)
check('/compact is registered', names.includes('compact'), JSON.stringify(names))

const before = agent.session.surface.nodes.length
const execution = await commands.execute(agent, '/compact', [], new AbortController().signal)
console.log('/compact ->', JSON.stringify(execution?.result))
check('/compact reports success', execution?.result?.kind === 'success', JSON.stringify(execution?.result))

const events = agent.session.ownEvents()
const start = events.filter((event) => event.type === 'compaction/start')
const summary = events.filter((event) => event.type === 'compaction/summary')
const end = events.filter((event) => event.type === 'compaction/end')
check('compaction/start recorded', start.length === 1, String(start.length))
check('compaction/summary recorded', summary.length === 1, String(summary.length))
check('compaction/end recorded', end.length === 1 && end[0].data.error === undefined, JSON.stringify(end[0]?.data))
check('the marker pairs up', start[0]?.data.compactionId === summary[0]?.data.compactionId && start[0]?.data.compactionId === end[0]?.data.compactionId)

const record = summary[0]?.data
check('the summary carries text', typeof record?.summary?.[0]?.text === 'string' && record.summary[0].text.length > 0)
check('shadowed seqs are listed', Array.isArray(record?.shadowedSeqs) && record.shadowedSeqs.length > 0, JSON.stringify(record?.shadowedSeqs))
check(
  'the shadowed range matches the listed seqs',
  record?.shadowedRange?.start === record?.shadowedSeqs?.[0] && record?.shadowedRange?.end === record?.shadowedSeqs?.at(-1),
  JSON.stringify(record?.shadowedRange),
)

const after = agent.session.surface.nodes.length
check('the surface shrank', after < before, `${before} -> ${after}`)
check(
  'the compacted range was replaced in place',
  after === before - record.shadowedSeqs.length + 1,
  `surface=${after}, expected ${before - record.shadowedSeqs.length + 1}`,
)

// Resume must not resurrect what pi dropped.
const name = handle.agent.session.id
await handle.dispose()
const resumed = await agents.resume({ resumeSessionId: name })
await resumed.agent.whenIdle()
const rebuilt = resumed.agent.session.ownEvents()
const LF = String.fromCharCode(10)
// The rebuilt pi session must not carry the history pi already dropped.
const rebuiltFile = join(root, 'pi-sessions', `${String(name).replace(/[^\w-]/g, '_')}.jsonl`)
const piEntries = readFileSync(rebuiltFile, 'utf8')
  .split(LF)
  .filter((line) => line.startsWith('{'))
  .map((line) => JSON.parse(line))
  .filter((entry) => entry.type === 'message')
check('the rebuilt pi session matches the compacted surface', piEntries.length === after, `${piEntries.length} entries vs surface ${after}`)
check('resume kept the compaction record', rebuilt.some((event) => event.type === 'compaction/summary'))
check('resume surface matches', resumed.agent.session.surface.nodes.length === after, `${resumed.agent.session.surface.nodes.length} vs ${after}`)

await resumed.dispose()
await new Promise((resolve) => setTimeout(resolve, 200))
try { rmSync(root, { recursive: true, force: true }) } catch {}

console.log(failed ? 'RESULT: FAILED' : 'RESULT: PASS')
process.exitCode = failed ? 1 : 0
