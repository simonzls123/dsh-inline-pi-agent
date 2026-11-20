/**
 * Approval e2e: pi's own bash goes through DSH's approval seam.
 *
 * Boots the minimum services plus a stubbed `approval` service that answers on
 * command, mounts the plugin with `extensionUi: 'approval'` and `guard: ['bash']`,
 * and checks that the guard actually stops or allows pi's bash.
 *
 * Usage: PI_PATH=/path/to/pi node scripts/approval-e2e.mjs
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as SessionStats from '@deepseek-ai/dsh-session-stats'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as piAgentPlugin from '../src/index.js'

let failed = false
const check = (label, condition, detail) => {
  console.log(`${condition ? 'OK' : 'FAIL'} ${label}${condition || detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) failed = true
}

class StubApproval extends Service {
  constructor(ctx) {
    super(ctx, 'approval')
    this.asked = []
    this.answer = 'rejected'
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

const waitFor = async (ctx, name, timeoutMs = 20000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const service = ctx.get(name)
    if (service !== undefined) return service
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timeout waiting for service: ${name}`)
}

/**
 * Run one scenario: the session's policy override, the answerer's decision, and
 * whether the command must have run.
 */
async function scenario(answer, expectedRun, policy = undefined) {
  const root = join(process.cwd(), '.tmp-approval', answer)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const marker = join(root, 'marker.txt')

  const ctx = new Context()
  ctx.plugin(TypertRegistry)
  ctx.plugin(SessionProjectionRegistry)
  ctx.plugin(SessionStore)
  ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
  ctx.plugin(LlmRuntime)
  ctx.plugin(AgentRegistry)
  ctx.plugin(TokenMeter)
  ctx.plugin(SessionStats)
  ctx.plugin(StubApproval)
  ctx.plugin(piAgentPlugin, {
    piPath: process.env.PI_PATH ?? 'pi',
    cwd: root,
    extensionUi: 'approval',
    guard: ['bash'],
    approvalTimeoutMs: 15000,
    debug: process.env.DEBUG === '1',
  })

  const approval = await waitFor(ctx, 'approval')
  approval.answer = answer
  approval.policy = policy
  const agents = await waitFor(ctx, 'agents')
  await waitFor(ctx, 'sessions')
  await waitFor(ctx, 'sessionPersistence')

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

  handle.agent.followup(
    createUserMessage({
      content: [{ type: 'text', text: `Run exactly this bash command: echo hi > ${marker.replace(/\\/g, '/')}` }],
      source: { kind: 'user' },
    }),
  )
  await handle.agent.whenIdle()

  const label = policy === undefined ? answer : `${policy} policy`
  const expectedAsks = policy === 'never' ? 0 : 1
  check(`[${label}] approval seam asked ${expectedAsks} time(s)`, approval.asked.length === expectedAsks, `asked=${approval.asked.length}`)
  if (expectedAsks === 1) {
    check(`[${label}] the question names the tool`, approval.asked[0]?.toolName === 'bash', String(approval.asked[0]?.toolName))
    check(
      `[${label}] the question carries the command as the reason`,
      typeof approval.asked[0]?.reason === 'string' && approval.asked[0].reason.includes('marker.txt'),
      JSON.stringify(approval.asked[0]?.reason),
    )
  }
  check(`[${label}] command ${expectedRun ? 'ran' : 'did not run'}`, existsSync(marker) === expectedRun, `marker=${existsSync(marker)}`)

  const events = handle.agent.session.ownEvents()
  const result = events.find((event) => event.type === 'tool/result')
  check(
    `[${label}] the model was told about the outcome`,
    result !== undefined && (result.data.message.isError === true) === !expectedRun,
    JSON.stringify(result?.data?.message?.content ?? null),
  )

  await handle.dispose()
  await new Promise((resolve) => setTimeout(resolve, 200))
  rmSync(root, { recursive: true, force: true })
  await ctx.dispose?.()
}

await scenario('rejected', false)
await scenario('allowed-once', true)
// A full-access preset records `never`: the guard must not turn that into a denial.
await scenario('rejected', true, 'never')

console.log(failed ? 'RESULT: FAILED' : 'RESULT: PASS')
process.exitCode = failed ? 1 : 0
