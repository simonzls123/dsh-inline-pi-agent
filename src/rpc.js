/**
 * PiRpcClient — spawns a headless `pi --mode rpc` process and speaks its JSONL
 * protocol. Protocol reference: pi 1.5.0 `docs/rpc.md`, `docs/rpc-commands.md`.
 *
 * Adapted from dsh-pi-agent by Micheleww (MIT).
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

const isWindows = process.platform === 'win32'

/** Levels pi accepts by name; an unknown one is silently treated as `off`. */
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function cmdQuote(value) {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * Windows cannot spawn a .cmd/.ps1 shim directly. Route .cmd through cmd.exe
 * as one command line, so no argument is re-split by the shell.
 */
function resolveSpawn(piPath, args) {
  if (!isWindows || /\.(exe|com)$/i.test(piPath)) return { file: piPath, args }
  const shim = /\.(cmd|bat)$/i.test(piPath) ? piPath : `${piPath}.cmd`
  const line = [shim, ...args].map(cmdQuote).join(' ')
  return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', line] }
}

/** How much of pi's stderr to keep for diagnostics (it carries auth/provider errors). */
const STDERR_TAIL_LINES = 40
const STDERR_TAIL_CHARS = 8192

export class PiRpcClient {
  constructor({ piPath = 'pi', cwd, sessionFile, logger, extraArgs, extraEnv }) {
    this.cwd = cwd
    this.logger = logger
    this.closed = false
    this.nextId = 0
    this.buffer = ''
    this.pending = new Map()
    this.events = new EventEmitter()
    // The terminal failure, once the child is unusable. Every later command
    // rejects with it instead of a transport-level symptom (EPIPE, destroyed
    // stream), which is what the user would otherwise see in the transcript.
    this.failure = undefined
    this.emittedExit = false
    this.stderrTail = []
    // Resolves when the child becomes usable or permanently dead, so a failed
    // write can wait for the lifecycle verdict instead of reporting EPIPE.
    this.death = new Promise((resolve) => {
      this.deathResolve = resolve
    })
    // Extension UI requests are a separate subprotocol: they carry their own id
    // namespace and expect `extension_ui_response` on stdin (docs/rpc-extension-ui.md).
    this.ui = new EventEmitter()

    const args = ['--mode', 'rpc']
    // Caller-supplied flags (e.g. `-e <guard.ts>`) come before the session
    // selector so a positional session path stays last.
    if (Array.isArray(extraArgs)) for (const arg of extraArgs) if (typeof arg === 'string') args.push(arg)
    if (sessionFile === undefined) args.push('--no-session')
    else args.push('--session', sessionFile)
    const { file, args: spawnArgs } = resolveSpawn(piPath, args)
    this.proc = spawn(file, spawnArgs, {
      cwd,
      env: extraEnv === undefined ? process.env : { ...process.env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk) => this.#onData(chunk))
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (chunk) => {
      this.#captureStderr(chunk)
      this.logger?.(`[pi:stderr] ${chunk.trimEnd()}`)
    })
    // Writing to a dead child raises EPIPE on stdin; without a listener that
    // becomes an uncaught 'error' event and takes the host process down.
    this.proc.stdin.on('error', (error) => this.logger?.(`[pi:stdin] ${String(error)}`))
    // A spawn failure (ENOENT, EACCES for a non-executable piPath) emits `error`
    // and never `exit`: settle every pending command here, or the turn hangs.
    this.proc.on('error', (error) => {
      this.logger?.(`[pi:error] ${String(error)}`)
      this.#fail(this.#diagnose(`cannot start pi (${JSON.stringify(String(piPath))}): ${error.message}`))
    })
    this.proc.on('exit', (code, signal) => {
      this.closed = true
      this.logger?.(`[pi:exit] code=${String(code)} signal=${String(signal)}`)
      this.#fail(
        this.#diagnose(`pi exited (code=${String(code)} signal=${String(signal)})`),
        { code, signal },
      )
    })
  }

  /** Keep the tail of stderr so a failure can quote what pi actually said. */
  #captureStderr(chunk) {
    for (const line of String(chunk).split('\n')) {
      if (line.trim() === '') continue
      this.stderrTail.push(line.trimEnd())
    }
    if (this.stderrTail.length > STDERR_TAIL_LINES) {
      this.stderrTail.splice(0, this.stderrTail.length - STDERR_TAIL_LINES)
    }
    let total = 0
    for (const line of this.stderrTail) total += line.length + 1
    while (total > STDERR_TAIL_CHARS && this.stderrTail.length > 1) {
      total -= this.stderrTail[0].length + 1
      this.stderrTail.shift()
    }
  }

  /** Attach pi's own words to a lifecycle failure. */
  #diagnose(base) {
    const tail = this.stderrTail.join('\n').trim()
    return new Error(tail === '' ? base : `${base}\n--- pi stderr ---\n${tail}`)
  }

  /**
   * Publish the terminal state once, and reject every waiter with the first
   * failure. Later transport errors (the exit that follows a spawn error, an
   * EPIPE after the child died) must not replace the actionable message.
   */
  #fail(error, info = { code: null, signal: null }) {
    const first = this.failure === undefined
    this.failure ??= error
    this.closed = true
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(this.failure)
    if (first) {
      this.emittedExit = true
      this.events.emit('exit', { ...info, error: this.failure })
    }
    this.deathResolve()
  }

  get running() {
    return !this.closed
  }

  #onData(chunk) {
    this.buffer += chunk
    // Strict JSONL framing: split on LF only (U+2028/U+2029 are legal in strings).
    let index
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim() === '') continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        this.logger?.(`[pi:bad-json] ${line.slice(0, 200)}`)
        continue
      }
      this.#dispatch(record)
    }
  }

  #dispatch(record) {
    if (record?.type === 'response') {
      const id = record.id ?? record.command
      const entry = this.pending.get(id)
      if (entry === undefined) return
      this.pending.delete(id)
      entry.resolve(record)
      return
    }
    // A dialog request blocks the agent until the client answers. Dropping it
    // on the floor stalls the run, so it never reaches the event stream.
    if (record?.type === 'extension_ui_request') {
      this.ui.emit('request', record)
      return
    }
    this.events.emit('event', record)
  }

  /** Answer one `extension_ui_request`; fire-and-forget, no correlated response. */
  respondUi(id, body) {
    if (this.closed) return
    this.proc.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id, ...body })}\n`)
  }

  /** Send one command and resolve with its correlated response envelope. */
  send(command) {
    if (this.closed || this.failure !== undefined) {
      return Promise.reject(this.failure ?? new Error('pi process is not running'))
    }
    const id = command.id ?? `cmd-${++this.nextId}`
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (error === null || error === undefined) return
        // A write error means the pipe is gone, not why the child is gone. The
        // exit or spawn error carries the actionable cause and arrives within
        // the same event-loop turn on some platforms, a beat later on others,
        // so give it a short window before falling back to the transport error.
        const settle = () => {
          if (this.pending.delete(id)) reject(this.failure ?? error)
        }
        const timer = setTimeout(settle, 250)
        timer.unref?.()
        void this.death.then(() => {
          clearTimeout(timer)
          settle()
        })
      })
    })
  }

  async prompt(message, images) {
    const response = await this.send({
      type: 'prompt',
      message,
      ...(Array.isArray(images) && images.length > 0 ? { images } : {}),
    })
    if (!response.success) throw new Error(`pi prompt failed: ${response.error ?? 'unknown'}`)
    return response.data
  }

  async steer(message, images) {
    const response = await this.send({
      type: 'steer',
      message,
      ...(Array.isArray(images) && images.length > 0 ? { images } : {}),
    })
    if (!response.success) throw new Error(`pi steer failed: ${response.error ?? 'unknown'}`)
    return response.data
  }

  async abort() {
    try {
      await this.send({ type: 'abort' })
    } catch {
      // The child may already be gone; abort is best-effort.
    }
  }

  async setModel(provider, modelId) {
    const response = await this.send({ type: 'set_model', provider, modelId })
    if (!response.success) throw new Error(response.error ?? 'pi set_model failed')
    return response.data
  }

  /**
   * Set the reasoning level. Levels are model-scoped, so call after setModel.
   * @returns the level pi actually applied, after clamping to the model.
   */
  async setThinkingLevel(level) {
    // pi answers `success` for an unrecognized level and lands on `off`, which
    // would silently disable reasoning. Reject locally instead.
    if (!THINKING_LEVELS.has(level)) throw new Error(`pi has no thinking level "${String(level)}"`)
    const response = await this.send({ type: 'set_thinking_level', level })
    if (!response.success) throw new Error(response.error ?? 'pi set_thinking_level failed')
    try {
      const state = await this.send({ type: 'get_state' })
      const applied = state.data?.thinkingLevel
      return typeof applied === 'string' ? applied : undefined
    } catch {
      return undefined
    }
  }

  onEvent(listener) {
    this.events.on('event', listener)
    return () => this.events.off('event', listener)
  }

  onUiRequest(listener) {
    this.ui.on('request', listener)
    return () => this.ui.off('request', listener)
  }

  onExit(listener) {
    this.events.on('exit', listener)
    return () => this.events.off('exit', listener)
  }

  /**
   * Stop the child. Closing stdin makes pi shut down after the active run
   * settles, so abort first — an open stdin is the only thing keeping a run
   * alive (see CONTRACT.md §9.1).
   */
  close() {
    if (this.closed) return
    this.closed = true
    try {
      this.proc.stdin.write(`${JSON.stringify({ type: 'abort', id: `close-${++this.nextId}` })}\n`)
    } catch {
      // stdin already closed
    }
    try {
      this.proc.stdin.end()
    } catch {
      // ignore
    }
    const timer = setTimeout(() => {
      try {
        this.proc.kill()
      } catch {
        // already gone
      }
    }, 2000)
    timer.unref?.()
  }
}
