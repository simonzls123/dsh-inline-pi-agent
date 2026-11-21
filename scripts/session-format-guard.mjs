#!/usr/bin/env node
/**
 * Session-format v4 guard.
 *
 * DSH requires every `tool/call` record to carry the exact same `arguments`
 * string as the `tool-call` block advertised by its `assistant/message`. A
 * mismatch makes the whole session unreadable:
 *
 *   SessionFormatError: tool/call <id> does not match one advertised tool call
 *
 * Run this after touching `src/agent.js` (`convertBlocks`,
 * `dshFileToolArguments`, `#onToolStart`) or anything else that writes
 * tool calls:
 *
 *   node scripts/session-format-guard.mjs
 *   node scripts/session-format-guard.mjs ~/.dsh/sessions   # explicit roots
 *
 * Exits 1 when any stored session is inconsistent.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const roots = process.argv.slice(2)
if (roots.length === 0) roots.push(join(homedir(), '.dsh', 'sessions'))

function sessionFiles(path) {
  const out = []
  const stat = statSync(path)
  if (stat.isFile()) return [path]
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = join(path, entry.name)
    if (entry.isDirectory()) out.push(...sessionFiles(full))
    else if (entry.name === 'session.v4.jsonl.zstd' || entry.name === 'session.v4.jsonl') out.push(full)
  }
  return out
}

function plaintext(file) {
  if (file.endsWith('.jsonl')) return readFileSync(file, 'utf8')
  try {
    return execFileSync('zstd', ['-dc', file], { maxBuffer: 1024 * 1024 * 1024, encoding: 'utf8' })
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function checkSessions(file) {
  const text = plaintext(file)
  if (typeof text !== 'string') return { file, error: text.error, mismatches: [] }
  const advertised = new Map()
  const mismatches = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const data = event.data ?? {}
    if (event.type === 'assistant/message') {
      for (const block of data.message?.content ?? []) {
        if (block.type === 'tool-call') {
          advertised.set(String(block.id), { seq: event.seq, name: block.name, arguments: block.arguments })
        }
      }
    } else if (event.type === 'tool/call') {
      const id = String(data.callId)
      const adv = advertised.get(id)
      if (adv !== undefined && adv.arguments !== data.arguments) {
        mismatches.push({ seq: event.seq, advSeq: adv.seq, id, name: data.name })
      }
    }
  }
  return { file, mismatches }
}

let failures = 0
let sessions = 0
let mismatches = 0
for (const root of roots) {
  for (const file of sessionFiles(root)) {
    sessions += 1
    const result = checkSessions(file)
    if (result.error !== undefined) {
      console.error(`ERROR ${file}: ${result.error}`)
      failures += 1
      continue
    }
    for (const mismatch of result.mismatches) {
      mismatches += 1
      console.error(`MISMATCH ${file}\n  tool/call seq ${mismatch.seq} (advertised at ${mismatch.advSeq}) ${mismatch.name} ${mismatch.id}`)
    }
  }
}

if (mismatches > 0) {
  console.error(`\n${mismatches} mismatched tool/call record(s) in ${sessions} session(s).`)
  console.error('Fix the writer: the advertised assistant block and the recorded tool/call must use the identical arguments string.')
  process.exit(1)
}
console.log(`OK: ${sessions} session(s) checked, every tool/call matches its advertised call.`)
