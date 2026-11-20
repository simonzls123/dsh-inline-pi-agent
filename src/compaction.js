/**
 * Record pi's compaction in the DSH log.
 *
 * pi compacts on its own schedule and rewrites its session file; DSH keeps the
 * full log. Without a record, three things go wrong: the UI shows no reason for
 * a sudden token drop, the model's history and pi's disagree, and a resume
 * rewrites pi's session from the uncompacted log — silently undoing the
 * compaction.
 *
 * DSH's compaction protocol (see dsh-compaction `types.d.ts`) is:
 *
 *   compaction/start { compactionId, turn }
 *   compaction/summary { summary, shadowedRange, shadowedSeqs, shadowedTokenCount, ... }
 *   user/message (surfaceOp replace over shadowedRange)   ← performs the replacement
 *   compaction/end { compactionId, turn }
 *
 * The replacement must immediately follow the summary: that adjacency is what
 * lets a consumer pair the two.
 */

import { randomUUID } from 'node:crypto'

import { createUserMessage } from '@deepseek-ai/dsh-llm'

/**
 * Map pi's `firstKeptEntryId` to an index into the current message list.
 *
 * The id is pi-native (pi appended its own entries), so it cannot be matched
 * against DSH seqs. Instead walk pi's active branch and count messages before
 * the kept entry; DSH's surface mirrors that list one-to-one, in order.
 *
 * @returns the number of leading messages to shadow, or undefined when the
 *   entry is not on the active branch.
 */
export async function resolveKeptIndex(rpc, firstKeptEntryId) {
  if (typeof firstKeptEntryId !== 'string' || firstKeptEntryId === '') return undefined
  const response = await rpc.send({ type: 'get_entries' })
  if (response.success !== true) return undefined
  const entries = response.data?.entries
  const leafId = response.data?.leafId
  if (!Array.isArray(entries) || typeof leafId !== 'string') return undefined

  const byId = new Map(entries.map((entry) => [String(entry?.id ?? ''), entry]))
  const branch = []
  let cursor = leafId
  for (let guard = 0; guard < entries.length + 1 && cursor !== null && cursor !== undefined; guard += 1) {
    const entry = byId.get(String(cursor))
    if (entry === undefined) return undefined
    branch.push(entry)
    cursor = entry.parentId ?? null
  }
  branch.reverse()

  const messages = branch.filter((entry) => entry?.type === 'message')
  const index = messages.findIndex((entry) => String(entry.id) === firstKeptEntryId)
  if (index <= 0) return undefined
  return index
}

/** Sum the token usage recorded on the events about to be shadowed. */
function shadowedTokens(events) {
  let total = 0
  for (const event of events) {
    const usage = event?.data?.usage
    if (usage === undefined || usage === null) continue
    total += Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0)
  }
  return total
}

/** Convert pi's usage envelope into DSH's TokenUsage. */
function dshUsage(usage) {
  if (usage === undefined || usage === null || typeof usage !== 'object') return undefined
  return {
    inputTokens: Number(usage.input ?? 0),
    outputTokens: Number(usage.output ?? 0),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: Number(usage.totalTokens) }),
    ...(usage.cacheRead === undefined ? {} : { cacheReadTokens: Number(usage.cacheRead) }),
    ...(usage.cacheWrite === undefined ? {} : { cacheWriteTokens: Number(usage.cacheWrite) }),
    ...(usage.reasoning === undefined ? {} : { reasoningTokens: Number(usage.reasoning) }),
  }
}

/**
 * Append the compaction transaction, ending with the surface replacement.
 * @returns `{ shadowedCount, shadowedTokenCount, summarySeq }`, or undefined
 *   when the log and pi disagree and recording would corrupt the surface.
 */
export function recordCompaction({ session, keptIndex, result, turn, provider, model, logger }) {
  const summaryText = typeof result?.summary === 'string' ? result.summary.trim() : ''
  if (summaryText === '') return undefined

  const nodes = session.surface.nodes
  if (keptIndex === undefined || keptIndex >= nodes.length) return undefined
  const shadowedSeqs = nodes.slice(0, keptIndex)
  if (shadowedSeqs.length === 0) return undefined

  const shadowedRange = { start: shadowedSeqs[0], end: shadowedSeqs[shadowedSeqs.length - 1] }
  const bySeq = new Map(session.snapshotEvents().map((event) => [event.seq, event]))
  const shadowedEvents = shadowedSeqs.map((seq) => bySeq.get(seq)).filter((event) => event !== undefined)
  const shadowedTokenCount = shadowedTokens(shadowedEvents)

  const compactionId = `pi-${randomUUID()}`
  const summary = [{ type: 'text', text: summaryText }]
  const usage = dshUsage(result?.usage)

  session.append('compaction/start', { compactionId, turn })
  session.append('compaction/summary', {
    compactionId,
    summary,
    shadowedRange,
    shadowedSeqs,
    shadowedTokenCount,
    provider: typeof provider === 'string' && provider !== '' ? provider : 'pi',
    model: typeof model === 'string' && model !== '' ? model : 'pi',
    ...(usage === undefined ? {} : { usage }),
  })
  const summarySeq = session.append(
    'user/message',
    createUserMessage({ content: summary, source: { kind: 'user' } }),
    {
      surfaceOp: { op: 'replace', startSeq: shadowedRange.start, endSeq: shadowedRange.end },
      // A replacement must name every surface node it shadows.
      sourceEventSeqs: shadowedSeqs,
    },
  ).seq
  session.append('compaction/end', { compactionId, turn })

  logger?.(`[compaction] shadowed ${String(shadowedSeqs.length)} messages (~${String(shadowedTokenCount)} tokens)`)
  return { shadowedCount: shadowedSeqs.length, shadowedTokenCount, summarySeq }
}

/**
 * Surface seqs hidden by past compactions, in log order.
 *
 * `buildPiSessionFile` skips them: replaying the whole log into pi would
 * resurrect exactly the history pi already dropped.
 */
export function shadowedSeqSet(events) {
  const shadowed = new Set()
  for (const event of events) {
    if (event.type !== 'compaction/summary') continue
    for (const seq of event.data.shadowedSeqs ?? []) shadowed.add(seq)
  }
  return shadowed
}
