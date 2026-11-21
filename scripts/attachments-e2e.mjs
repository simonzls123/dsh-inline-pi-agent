/**
 * Attachments e2e: a `file` block must reach pi as handle text.
 *
 * DSH never sends file bytes to a provider: request assembly projects every file
 * reference into handle text naming a read-only saved path (dsh-llm
 * `fileRequestText`). The plugin used to drop `file` blocks entirely — the model
 * answered "there is no attachment" while the bytes sat in the attachment store.
 *
 * Cases:
 *   live    a file block becomes handle text in the prompt pi receives
 *   replay  rebuilding the pi session keeps the same handle text
 *   steer   a mid-run file message carries it too
 *   fallback  no readable path still names the file instead of hiding it
 *
 * Usage: node scripts/attachments-e2e.mjs [live|replay|steer|fallback|all]
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import { buildPiSessionFile } from '../src/history.js'
import * as piAgentPlugin from '../src/index.js'

const which = process.argv[2] ?? 'all'
const failures = []
const check = (ok, label, detail) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) {
    failures.push(label)
    if (detail !== undefined) console.log(`     ${String(detail).slice(0, 600)}`)
  }
}

const FILE_NAME = 'probe-attachment.txt'
const FILE_BODY = 'attachment line one\nattachment line two\n'

const boot = async ({ attachments: withAttachments = true, ...config } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-attach-'))
  const ctx = new Context()
  ctx.plugin(TypertRegistry)
  ctx.plugin(SessionProjectionRegistry)
  ctx.plugin(SessionStore)
  ctx.plugin(JsonlPersistence, { root: join(root, 'logs') })
  ctx.plugin(LlmRuntime)
  ctx.plugin(AgentRegistry)
  // The fallback branch lives where no attachment service is mounted: the llm
  // service then cannot resolve a read path and the projection must say so.
  if (withAttachments) ctx.plugin(AttachmentLocal, { dshHome: root })
  ctx.plugin(FileSystem)
  const fiber = ctx.plugin(piAgentPlugin, {
    cwd: root,
    piSessionDir: join(root, 'pi-sessions'),
    ...config,
  })
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
  const attachments = withAttachments ? await wait('attachments') : undefined
  const llm = await wait('llm')
  const create = async (options) => {
    for (let i = 0; i < 300; i += 1) {
      try {
        return await agents.create(options)
      } catch (error) {
        if (!String(error).includes('no agent factory')) throw error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    throw new Error('plugin never registered a factory')
  }
  const close = async () => {
    await fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
  return { ctx, agents, attachments, llm, create, close, root }
}

/** Durable file reference holding the probe body. */
const saveProbe = (attachments) =>
  attachments.saveFile({ data: Buffer.from(FILE_BODY), name: FILE_NAME })

const fileMessage = (ref, text) => createUserMessage({
  content: [{ type: 'file', attachment: ref }, { type: 'text', text }],
  source: { kind: 'user' },
})

/**
 * Record what the plugin actually hands the pi child. A fresh session spawns
 * pi with `--no-session`, so the child keeps no file to read back; the RPC
 * boundary is the only honest observation point.
 */
const capture = (agent) => {
  const seen = { prompts: [], steers: [] }
  const { rpc } = agent
  const prompt = rpc.prompt.bind(rpc)
  const steer = rpc.steer.bind(rpc)
  rpc.prompt = (text, images) => {
    seen.prompts.push({ text, images })
    return prompt(text, images)
  }
  rpc.steer = (text, images) => {
    seen.steers.push({ text, images })
    return steer(text, images)
  }
  return seen
}

const ask = async (agent, message) => {
  agent.followup(message)
  await agent.whenIdle()
}

if (which === 'live' || which === 'all') {
  console.log(`--- live: ${FILE_NAME} reaches pi ---`)
  const env = await boot()
  try {
    const ref = await saveProbe(env.attachments)
    const handleText = env.llm.fileRequestText(ref)
    check(handleText.includes(FILE_NAME), 'the llm projection names the file', handleText)
    check(/FileAttachment|attachments/i.test(handleText), 'the projection carries a saved path', handleText)

    const sessionId = SessionId(`attach-live-${Date.now().toString(36)}`)
    const handle = await env.create({
      sessionId,
      meta: { cwd: env.root },
      agentOptions: { provider: 'deepseek', model: 'deepseek-flash' },
    })
    const seen = capture(handle.agent)
    await ask(handle.agent, fileMessage(ref, 'Reply with exactly: LIVE_OK'))
    const last = seen.prompts.at(-1)?.text ?? ''
    check(last.includes(FILE_NAME), 'pi received the file name', last)
    check(last.includes(handleText), 'pi received the same handle text the native loop would send', last)
    check(last.includes('LIVE_OK'), 'the user text still travels with it', last)
    check(seen.prompts.at(-1)?.images.length === 0, 'a file block is not sent as an image', JSON.stringify(seen.prompts.at(-1)?.images))
    const reason = handle.agent.session.ownEvents().filter((e) => e.type === 'turn/end').at(-1)?.data.reason
    check(reason?.kind === 'completed', 'the turn completed', JSON.stringify(reason))
    await handle.dispose()
  } finally {
    await env.close()
  }
}

if (which === 'replay' || which === 'all') {
  console.log('--- replay: the rebuilt pi session keeps the reference ---')
  const env = await boot()
  try {
    const ref = await saveProbe(env.attachments)
    const handleText = env.llm.fileRequestText(ref)
    const sessionId = SessionId(`attach-replay-${Date.now().toString(36)}`)
    const handle = await env.create({
      sessionId,
      meta: { cwd: env.root },
      agentOptions: { provider: 'deepseek', model: 'deepseek-flash' },
    })
    await ask(handle.agent, fileMessage(ref, 'Reply with exactly: REPLAY_OK'))
    // Rebuild from the durable log, which is exactly what resume does.
    const rebuilt = await buildPiSessionFile({
      session: handle.agent.session,
      cwd: env.root,
      filePath: join(env.root, 'rebuilt.jsonl'),
      logger: undefined,
      attachments: env.attachments,
      fileText: (attachment) => env.llm.fileRequestText(attachment),
    })
    const content = readFileSync(rebuilt, 'utf8')
    check(content.includes(FILE_NAME), 'the rebuilt session names the file', content.slice(0, 400))
    const probe = handleText.slice(handleText.indexOf('('), handleText.indexOf('(') + 24)
    check(content.includes(probe), 'the rebuilt session carries the handle text', content.slice(0, 400))
    await handle.dispose()
  } finally {
    await env.close()
  }
}

if (which === 'steer' || which === 'all') {
  console.log('--- steer: a mid-run file message carries it too ---')
  const env = await boot()
  try {
    const ref = await saveProbe(env.attachments)
    const sessionId = SessionId(`attach-steer-${Date.now().toString(36)}`)
    const handle = await env.create({
      sessionId,
      meta: { cwd: env.root },
      agentOptions: { provider: 'deepseek', model: 'deepseek-flash' },
    })
    const seen = capture(handle.agent)
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Count from 1 to 1500, one number per line, no other text.' }],
      source: { kind: 'user' },
    }))
    await new Promise((resolve) => setTimeout(resolve, 1000))
    handle.agent.steer(fileMessage(ref, 'Stop counting and reply with exactly: STEER_FILE'))
    await handle.agent.whenIdle()
    const steered = seen.steers.at(-1)?.text ?? ''
    check(seen.steers.length > 0, 'the mid-run steer used the RPC steer path', `steers=${String(seen.steers.length)} prompts=${String(seen.prompts.length)}`)
    check(steered.includes(FILE_NAME), 'the steered file reference reached pi', steered || '(no steer captured)')
    await handle.dispose()
  } finally {
    await env.close()
  }
}

if (which === 'fallback' || which === 'all') {
  console.log('--- fallback: an unreadable path still names the file ---')
  const env = await boot({ attachments: false })
  try {
    const ref = { attachmentId: 'sha256:' + 'a'.repeat(64), name: FILE_NAME, bytes: FILE_BODY.length }
    const sessionId = SessionId(`attach-fallback-${Date.now().toString(36)}`)
    const handle = await env.create({
      sessionId,
      meta: { cwd: env.root },
      agentOptions: { provider: 'deepseek', model: 'deepseek-flash' },
    })
    const seen = capture(handle.agent)
    await ask(handle.agent, fileMessage(ref, 'Reply with exactly: FALLBACK_OK'))
    const last = seen.prompts.at(-1)?.text ?? ''
    check(last.includes(FILE_NAME), 'the fallback names the file', last)
    check(/readable path/i.test(last), 'the fallback states the access situation', last)
    await handle.dispose()
  } finally {
    await env.close()
  }
}

console.log(failures.length === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures.join('; ')})`)
process.exit(failures.length === 0 ? 0 : 1)
