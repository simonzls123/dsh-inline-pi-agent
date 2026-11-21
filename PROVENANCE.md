# Provenance

Upstream: https://github.com/simonzls123/dsh-inline-pi-agent
Base commit: 2b93905 ("fix: drain tool-end text and report the applied thinking level", 0.2.0)
Release commit: 00d6a58 (0.2.3, tag v0.2.3 on `main`)
Local version: 0.2.3

`src/` started as a verbatim copy of the base commit. Everything below is a local
change on top of it; `git diff` against a fresh checkout of `2b93905` shows exactly
these edits. Reinstall from the packed tarball in `../plugins/`, never from a
floating git specifier, so the bytes a running profile loads match this tree.

## 0.2.3 — file attachments reach pi

`src/agent.js`, `src/history.js`, `src/factory.js`

A `file` attachment block was dropped entirely: `#collectImages` only looked at
`image` blocks and `textOf` only at `text`, so a message carrying a zip or a
document reached pi as bare text and the model answered "there is no
attachment" while the bytes sat in the attachment store (observed on a
deployment: a 120KB zip at 10:50, re-asked at 10:51).

No provider receives file bytes — DSH's own request assembly projects every file
reference into handle text naming a read-only saved path (`dsh-llm`
`fileRequestText` / `fileHandleText`). The plugin now calls that same projection,
so pi receives byte-for-byte what the native loop would have sent, and its own
read/bash tools can open the saved path:

- `#collectAttachments` returns `{ images, files }`; images keep the base64
  path, files become handle text.
- `#promptFor` puts handle text first, then the user's text.
- `#deliverSteer` uses the same pair, so a mid-run file message carries it too.
- `history.js` projects file blocks identically when rebuilding the pi session,
  so a resumed session keeps the reference instead of losing it.
- Without a readable path the reference is still named (never silently dropped).

`scripts/attachments-e2e.mjs` covers live, replay, steer and fallback.

## 0.2.1/0.2.2 — local fixes

### C1 a pi that cannot run says so

`src/rpc.js`

- A spawn failure (`ENOENT`, a non-executable `piPath`) rejected nothing: pending
  commands surfaced a transport symptom instead (`ERR_STREAM_DESTROYED: Cannot call
  write after a stream was destroyed`). The child's `error` event now settles every
  pending command with `cannot start pi ("<path>"): <cause>`.
- pi's stderr is kept (last 40 lines) and appended to any lifecycle failure, so
  provider/auth errors reach the transcript instead of only a debug logger.
- The terminal failure is latched: later transport noise cannot replace the
  actionable message, and `send()` after death rejects with it.
- `stdin` gained an `error` listener; an `EPIPE` on a dead child used to be an
  uncaught event on the host process.
- A write that fails while the child is dying waited on nothing: Linux reports
  `EPIPE` before `exit`, so the transcript showed the transport symptom and the
  lifecycle failure never surfaced (0.2.2). The write path now waits up to 250ms
  for the exit/spawn verdict before falling back to the transport error.
- `scripts/limits-e2e.mjs` uses a generated "exits at once" script instead of
  `/bin/false`, which does not exist on macOS — the case silently degraded to the
  missing-binary path (0.2.2).

### C2 failures reach observers

`src/agent.js`

- The turn failure is published as `agent/error` with `{ turn, step, error }`,
  matching the native loop. The Web client, session telemetry and parent agents
  listen to that event rather than re-reading the durable log, so a failed turn used
  to end silently from their point of view.
- The `turn/end` reason now quotes the lifecycle failure captured by the RPC client.

### B2 capacity and idle reclamation

`src/factory.js`, `src/agent.js`, `src/index.js`

- `maxSessions`: refuse a new session at the limit instead of overcommitting the
  host. The refusal names the limit and says what to do, and a burst of new sessions
  reclaims stale ones first.
- `idleReclaimMs`: release sessions idle past the threshold, closing their pi child.
  The durable log stays complete, so reopening the session resumes it. A session with
  a running driver, queued input, an open step or a pending approval is never
  reclaimed — that work is not replayable.
- Both default to off (`0`), so an unconfigured deployment behaves as before.

`scripts/limits-e2e.mjs` covers all three: a missing binary, a binary that fails
immediately, the capacity refusal, and idle reclaim followed by resume.

### B3 session-format: advertised and recorded arguments must match

`src/agent.js`, `src/history.js`, `scripts/session-format-guard.mjs`

- `dshFileToolArguments()` used to add DSH's `file_path` / `old_string` /
  `new_string` aliases to the recorded `tool/call` only; the assistant message kept
  pi's raw `path` / `edits`. Session-format v4 requires the two strings to be
  byte-identical, so the first `write` or `edit` made the whole session unreadable:
  `SessionFormatError: tool/call ... does not match one advertised tool call`.
- The assistant block now goes through the same function, `#onToolStart()` reuses
  the advertised string verbatim, and `history.js` strips the aliases again when it
  rebuilds pi's own session.
- `scripts/session-format-guard.mjs` scans `~/.dsh/sessions` for the invariant
  (`npm run guard:session-format`). See CONTRACT.md §16.
- Note: a process that loaded the old code keeps writing invalid records after the
  files on disk are fixed — restart the App / gateway before resuming.

## 0.2.0 fixes that 0.1.x (an earlier private fork) lacked

- pi prompt lifecycle: `data.disposition === 'handled'` no longer waits for a settle
  that never arrives.
- image attachments are forwarded through `prompt`/`steer` `images`.
- the applied thinking level is forwarded (`set_thinking_level`).
- model sync on resume uses the session's folded selection.
- pi compaction is recorded in the DSH log and `/compact` is backed by pi.
- bounded tool logs, atomic history writes, single persistence-handle close.
- tool-end text is drained before the tool result is appended.
