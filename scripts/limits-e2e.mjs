/**
 * Limits e2e: the failure and capacity behaviour of the pi bundle.
 *
 * C1 a pi that never starts must surface an actionable error, not a transport
 *    symptom, and C2 that failure must reach `agent/error` observers.
 * B2 a profile must refuse over-capacity sessions and reclaim idle ones.
 *
 * Usage: node scripts/limits-e2e.mjs [spawn|cap|idle|all]
 */

import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as piAgentPlugin from '../src/index.js'

const which = process.argv[2] ?? 'all'
const failures = []

const check = (ok, label, detail) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) {
    failures.push(label)
    if (detail !== undefined) console.log(`     ${String(detail)}`)
  }
}

/** Boot the minimum services and mount the plugin with an explicit config. */
const boot = async (config) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-limits-'))
  const ctx = new Context()
  const seen = { errors: [], status: [] }
  ctx.on('agent/error', (payload) => seen.errors.push(payload))
  ctx.on('agent/status', (payload) => seen.status.push(payload.status))
  ctx.plugin(TypertRegistry)
  ctx.plugin(SessionProjectionRegistry)
  ctx.plugin(SessionStore)
  ctx.plugin(JsonlPersistence, { root: join(root, 'logs') })
  ctx.plugin(LlmRuntime)
  ctx.plugin(AgentRegistry)
  const fiber = ctx.plugin(piAgentPlugin, { cwd: root, ...config })
  const wait = async (name) => {
    for (let i = 0; i < 600; i += 1) {
      const service = ctx.get(name)
      if (service !== undefined) return service
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`timeout waiting for ${name}`)
  }
  const agents = await wait('agents')
  await wait('sessions')
  // The plugin registers its factory asynchronously; retry until it lands.
  const create = async (options) => {
    for (let i = 0; i < 300; i += 1) {
      try {
        return await agents.create(options)
      } catch (error) {
        const message = String(error)
        if (!message.includes('no agent factory')) throw error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    throw new Error('plugin never registered a factory')
  }
  const close = async () => {
    await fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
  return { ctx, agents, seen, create, close, root }
}

const ask = async (agent, text) => {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

const turnEnd = (agent) => {
  const ends = agent.session.ownEvents().filter((event) => event.type === 'turn/end')
  return ends.at(-1)?.data.reason
}

if (which === 'spawn' || which === 'all') {
  console.log('--- C1/C2: pi that cannot run ---')
  // A binary that exists and exits immediately is portable; /bin/false is not
  // present on macOS, so relying on it silently degraded to the ENOENT case.
  const exitingScript = join(mkdtempSync(join(tmpdir(), 'pi-exit-')), 'pi-exits.sh')
  writeFileSync(exitingScript, '#!/bin/sh\nexit 1\n')
  chmodSync(exitingScript, 0o755)
  for (const [label, piPath] of [['missing binary', join(tmpdir(), 'no-such-pi-binary')], ['binary that exits at once', exitingScript]]) {
    const env = await boot({ piPath })
    try {
      const handle = await env.create({
        sessionId: SessionId(`limits-spawn-${Date.now().toString(36)}`),
        meta: { cwd: env.root },
        agentOptions: { provider: 'deepseek', model: 'deepseek-flash' },
      })
      await ask(handle.agent, 'Reply with exactly: NEVER')
      const reason = turnEnd(handle.agent)
      const message = reason?.error?.message ?? ''
      check(reason?.kind === 'error', `${label}: turn ends as error`, JSON.stringify(reason))
      check(
        /cannot start pi|cannot run pi|pi exited/.test(message),
        `${label}: message names the pi lifecycle, not a stream symptom`,
        message,
      )
      check(
        !/stream was destroyed|EPIPE/.test(message),
        `${label}: message is free of transport noise`,
        message,
      )
      check(env.seen.errors.length === 1, `${label}: agent/error emitted once`, `saw ${String(env.seen.errors.length)}`)
      const reported = String(env.seen.errors[0]?.error?.message ?? '')
      check(
        message.includes(reported) && reported !== '',
        `${label}: agent/error carries the same failure`,
        `${reported} | ${message}`,
      )
      check(env.seen.errors[0]?.turn === 1, `${label}: agent/error reports the turn`, `turn=${String(env.seen.errors[0]?.turn)}`)
      // No step opens when pi never starts, so 0 is the honest report: the
      // payload must still carry a step field, not omit it.
      check(typeof env.seen.errors[0]?.step === 'number', `${label}: agent/error reports a step`, `step=${String(env.seen.errors[0]?.step)}`)
      await handle.dispose()
    } finally {
      await env.close()
    }
  }
}

if (which === 'cap' || which === 'all') {
  console.log('--- B2: capacity guard ---')
  const env = await boot({ maxSessions: 1 })
  try {
    const first = await env.create({
      sessionId: SessionId(`limits-cap-a-${Date.now().toString(36)}`),
      meta: { cwd: env.root },
      agentOptions: { provider: 'deepseek', model: 'deepseek-flash' },
    })
    await ask(first.agent, 'Reply with exactly: CAP_A')
    let rejected
    try {
      await env.create({
        sessionId: SessionId(`limits-cap-b-${Date.now().toString(36)}`),
        meta: { cwd: env.root },
        agentOptions: { provider: 'deepseek', model: 'deepseek-flash' },
      })
    } catch (error) {
      rejected = String(error)
    }
    check(rejected !== undefined, 'a second session is refused')
    check(/maxSessions=1/.test(rejected ?? ''), 'the refusal names the limit and the knob', rejected)
    check(/Close an idle session/.test(rejected ?? ''), 'the refusal says what to do', rejected)
    await first.dispose()
    // After releasing the slot, creation must work again.
    const third = await env.create({
      sessionId: SessionId(`limits-cap-c-${Date.now().toString(36)}`),
      meta: { cwd: env.root },
      agentOptions: { provider: 'deepseek', model: 'deepseek-flash' },
    })
    await ask(third.agent, 'Reply with exactly: CAP_C')
    check(turnEnd(third.agent)?.kind === 'completed', 'the slot is reusable after dispose', JSON.stringify(turnEnd(third.agent)))
    await third.dispose()
  } finally {
    await env.close()
  }
}

if (which === 'idle' || which === 'all') {
  console.log('--- B2: idle reclamation ---')
  const env = await boot({ idleReclaimMs: 2000 })
  try {
    const handle = await env.create({
      sessionId: SessionId('limits-idle'),
      meta: { cwd: env.root },
      agentOptions: { provider: 'deepseek', model: 'deepseek-flash' },
    })
    await ask(handle.agent, 'Remember the number 7. Reply with exactly: IDLE_OK')
    check(turnEnd(handle.agent)?.kind === 'completed', 'the first turn completed')
    const started = Date.now()
    while (!handle.agent.disposed && Date.now() - started < 15000) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    check(handle.agent.disposed, 'an idle session is released without user action', `after ${String(Date.now() - started)}ms`)
    const resumed = await env.agents.resume({
      resumeSessionId: SessionId('limits-idle'),
      agentOptions: { provider: 'deepseek', model: 'deepseek-flash' },
    })
    await ask(resumed.agent, 'What number did I ask you to remember? Reply with just the number.')
    const text = resumed.agent.session
      .ownEvents()
      .filter((event) => event.type === 'assistant/message')
      .at(-1)
      ?.data.message.content.filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
    check(text?.includes('7') === true, 'the released session resumes with its context', JSON.stringify(text))
    await resumed.dispose()
  } finally {
    await env.close()
  }
}

console.log(failures.length === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures.join('; ')})`)
process.exit(failures.length === 0 ? 0 : 1)
