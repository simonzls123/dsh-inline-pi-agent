/**
 * Rebuild a pi v3 session file from a DSH session's durable event log.
 *
 * DSH stays the source of truth: every create/resume regenerates this file so
 * the pi child starts with the full conversation in context, regardless of
 * which engine produced earlier turns. Format reference: pi `docs/session-format.md`.
 *
 * Adapted from dsh-pi-agent by Micheleww (MIT).
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { shadowedSeqSet } from './compaction.js'

function textBlocks(blocks) {
  return blocks.filter((block) => block && block.type === 'text').map((block) => block.text)
}

/**
 * Undo the DSH-only argument aliases agent.js adds for its file card; pi's
 * file tools use `path`, `edits`, `oldText` and `newText`.
 */
function piToolArguments(name, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args
  if (name !== 'write' && name !== 'edit') return args
  if (typeof args.path !== 'string' || args.path.trim() === '') return args
  const {
    file_path: _filePath, old_string: _oldString, new_string: _newString, ...piArgs
  } = args
  return piArgs
}

/**
 * Projection for a durable file reference when no handle text can be built.
 * Kept in step with agent.js: a resumed session must describe the attachment
 * the same way the live turn did.
 */
function fileFallbackText(ref) {
  const name = typeof ref?.name === 'string' ? ref.name : 'attachment'
  const bytes = Number(ref?.bytes ?? 0)
  const digest = typeof ref?.attachmentId === 'string' ? String(ref.attachmentId).slice(7, 15) : ''
  return `[File "${name}" (${String(bytes)} bytes${digest === '' ? '' : `, sha256:${digest}`}): no readable path is available in this environment. Say so instead of claiming to have read it.]`
}

/** Convert DSH content blocks into pi blocks; images are handled by imageBlocks(). */
function convertBlocks(blocks, logger) {
  const out = []
  for (const block of blocks ?? []) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        out.push({ type: 'text', text: block.text })
        break
      case 'reasoning':
        out.push({ type: 'thinking', thinking: block.text })
        break
      case 'tool-call': {
        let args = {}
        if (typeof block.arguments === 'string' && block.arguments !== '') {
          try {
            const parsed = JSON.parse(block.arguments)
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
          } catch {
            args = { raw: block.arguments }
          }
        }
        out.push({ type: 'toolCall', id: String(block.id), name: block.name, arguments: piToolArguments(String(block.name ?? ''), args) })
        break
      }
      case 'image':
        // Resolved separately by imageBlocks() for user messages.
        break
      default:
        break
    }
  }
  return out
}

function mapStopReason(reason, hasToolCalls) {
  if (hasToolCalls) return 'toolUse'
  switch (reason?.kind) {
    case 'max-tokens':
      return 'length'
    case 'aborted':
      return 'aborted'
    case 'error':
      return 'error'
    default:
      return 'stop'
  }
}

/**
 * Resolve DSH image blocks into pi ImageContent. The attachment store is
 * async, so the session rebuild awaits it when the service is mounted.
 */
async function imageBlocks(blocks, attachments, logger) {
  if (attachments === undefined) {
    if ((blocks ?? []).some((block) => block?.type === 'image')) {
      logger?.('[history] skipping image block: no attachment service')
    }
    return []
  }
  const out = []
  for (const block of blocks ?? []) {
    if (block?.type !== 'image' || block.attachment === undefined) continue
    try {
      const stored = await attachments.readImage(block.attachment)
      out.push({
        type: 'image',
        data: Buffer.from(stored.data).toString('base64'),
        mimeType: stored.ref.mediaType,
      })
    } catch (error) {
      logger?.(`[history] image attachment failed: ${String(error)}`)
    }
  }
  return out
}

async function toPiUserMessage(message, attachments, fileText, logger) {
  const blocks = convertBlocks(message.content, logger)
  const images = await imageBlocks(message.content, attachments, logger)
  // A file reference is projected to handle text here exactly as it is on the
  // live path: no provider receives file bytes, and dropping the block would
  // make a resumed pi session answer "there is no attachment".
  const handles = []
  for (const block of message.content ?? []) {
    if (block?.type !== 'file' || block.attachment === undefined) continue
    let text
    try {
      text = fileText?.(block.attachment)
    } catch (error) {
      logger?.(`[history] file handle text failed: ${String(error)}`)
    }
    handles.push(typeof text === 'string' && text !== '' ? text : fileFallbackText(block.attachment))
  }
  const text = [...handles, textBlocks(blocks).join('\n')].filter((part) => part !== '').join('\n\n')
  if (images.length === 0) return { role: 'user', content: text === '' ? blocks : text }
  return {
    role: 'user',
    content: text === '' ? [...blocks, ...images] : [{ type: 'text', text }, ...images],
  }
}

/** DSH TokenUsage → pi usage block (pi requires `input`/`output` on every assistant message). */
function toPiUsage(usage) {
  return {
    input: usage?.inputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
    cacheRead: usage?.cacheReadTokens ?? 0,
    cacheWrite: usage?.cacheWriteTokens ?? 0,
    ...(usage?.reasoningTokens === undefined ? {} : { reasoning: usage.reasoningTokens }),
    totalTokens: usage?.totalTokens ?? 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function toPiAssistantMessage(data, finishReasons, logger) {
  const blocks = convertBlocks(data.message.content, logger)
  if (blocks.length === 0) return undefined
  const source = data.message.source ?? {}
  return {
    role: 'assistant',
    content: blocks,
    ...(typeof source.provider === 'string' ? { provider: source.provider } : {}),
    ...(typeof source.model === 'string' ? { model: source.model } : {}),
    usage: toPiUsage(data.usage),
    stopReason: mapStopReason(finishReasons.get(data.turn), blocks.some((block) => block.type === 'toolCall')),
  }
}

function toPiToolResult(data, toolNames, logger) {
  const message = data.message
  return {
    role: 'toolResult',
    content: convertBlocks(message.content, logger),
    toolCallId: String(message.toolCallId ?? ''),
    toolName: toolNames.get(String(message.toolCallId ?? '')) ?? 'unknown',
    isError: message.isError === true,
  }
}

function entryId(seq) {
  return `e${Number(seq).toString(16).padStart(7, '0')}`
}

/**
 * Write the pi session file for one DSH session.
 * @returns the written path.
 */
export async function buildPiSessionFile({ session, cwd, filePath, logger, attachments, fileText }) {
  const toolNames = new Map()
  const finishReasons = new Map()
  const entries = []
  let parentId = null

  const events = session.snapshotEvents()
  // Everything a compaction already dropped stays out: replaying it would
  // resurrect exactly the history pi chose to forget.
  const shadowed = shadowedSeqSet(events)

  for (const event of events) {
    if (shadowed.has(event.seq)) continue
    let message
    switch (event.type) {
      case 'turn/end':
        finishReasons.set(event.data.turn, event.data.reason)
        continue
      case 'tool/call':
        toolNames.set(String(event.data.callId), event.data.name)
        continue
      case 'user/message':
        message = await toPiUserMessage(event.data, attachments, fileText, logger)
        break
      case 'assistant/message':
        message = toPiAssistantMessage(event.data, finishReasons, logger)
        break
      case 'tool/result':
        message = toPiToolResult(event.data, toolNames, logger)
        break
      default:
        continue
    }
    if (message === undefined) continue
    const id = entryId(event.seq)
    entries.push({
      type: 'message',
      id,
      parentId,
      timestamp: new Date(event.time).toISOString(),
      message: { ...message, timestamp: event.time },
    })
    parentId = id
  }

  const header = {
    type: 'session',
    version: 3,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd,
  }
  const lines = [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))]
  mkdirSync(dirname(filePath), { recursive: true })
  const payload = `${lines.join('\n')}\n`
  const temporary = `${filePath}.tmp-${randomUUID()}`
  try {
    writeFileSync(temporary, payload)
    try {
      renameSync(temporary, filePath)
    } catch {
      // Windows may refuse to replace an existing target; retry after removing it.
      rmSync(filePath, { force: true })
      renameSync(temporary, filePath)
    }
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  logger?.(`[history] wrote ${String(entries.length)} entries to ${filePath}`)
  return filePath
}
