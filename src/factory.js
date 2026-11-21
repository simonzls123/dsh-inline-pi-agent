/**
 * PiAgentFactory — the `AgentFactory` behind `ctx.agents.create/resume`.
 *
 * Mirrors dsh-agent-loop's ordered transaction: prepare the session, take the
 * durable write handle, store the unstored suffix, enter and announce the
 * session, run the caller's setup while the agent is unpublished, then enter
 * and announce the agent. Teardown walks the same chain in reverse.
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import { SessionLogOffset, interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import { PiAgent } from './agent.js'
import { buildPiSessionFile } from './history.js'
import { PiRpcClient } from './rpc.js'

/** Split the configured `provider/model` route into agent options. */
function routeOptions(route) {
  if (typeof route !== 'string' || route === '') return {}
  const separator = route.indexOf('/')
  if (separator === -1) return { model: route }
  return { provider: route.slice(0, separator), model: route.slice(separator + 1) }
}

/** Close a persisted session handle exactly once (initialize failure paths overlap). */
async function closeStored(stored) {
  if (stored === undefined || stored.closed === true) return
  stored.closed = true
  await stored.handle.close().catch(() => undefined)
}

export class PiAgentFactory {
  constructor(registryCtx, options) {
    this.registryCtx = registryCtx
    this.options = options
    // owned dispose() → { agent, dispose }. A Map (not a Set) because idle
    // reclamation needs the agent's activity to decide what may be released.
    this.live = new Map()
    this.maxSessions = Number.isSafeInteger(options.maxSessions) && options.maxSessions > 0 ? options.maxSessions : 0
    this.idleReclaimMs = Number.isFinite(options.idleReclaimMs) && options.idleReclaimMs > 0 ? options.idleReclaimMs : 0
    this.reclaimTimer = null
    this.piSessionDirectory = options.piSessionDir ?? join(homedir(), '.dsh', 'pi-sessions')
    mkdirSync(this.piSessionDirectory, { recursive: true })
    this.#startReclaimer()
  }

  /** Stop every agent this factory published (plugin unload). */
  disposeAll() {
    if (this.reclaimTimer !== null) {
      clearInterval(this.reclaimTimer)
      this.reclaimTimer = null
    }
    const disposers = [...this.live.values()].map((record) => record.dispose)
    this.live.clear()
    return Promise.allSettled(disposers.map((dispose) => dispose()))
  }

  /**
   * Release sessions that have been idle long enough. Every pi child holds a
   * whole agent runtime (~160MB), so an abandoned browser tab would otherwise
   * pin memory until the process restarts. The durable log stays complete, so
   * reopening the session resumes it.
   */
  #startReclaimer() {
    if (!(this.idleReclaimMs > 0)) return
    const interval = Math.max(1000, Math.min(60000, Math.floor(this.idleReclaimMs / 4)))
    this.reclaimTimer = setInterval(() => {
      void this.#reclaimIdle()
    }, interval)
    this.reclaimTimer.unref?.()
  }

  /** Dispose idle agents; returns how many were released. */
  async #reclaimIdle(now = Date.now()) {
    const victims = []
    for (const [owned, record] of this.live) {
      if (record.agent.reclaimableAfter(now, this.idleReclaimMs)) victims.push([owned, record])
    }
    for (const [owned, record] of victims) {
      this.live.delete(owned)
      const idleSeconds = Math.round((now - record.agent.lastActivityAt) / 1000)
      this.options.logger?.(`[pi] reclaiming idle session ${String(record.agent.id)} after ${String(idleSeconds)}s; reopening it resumes from the durable log`)
      await record.dispose().catch((error) => {
        this.options.logger?.(`[pi] reclaim failed for ${String(record.agent.id)}: ${String(error)}`)
      })
    }
    return victims.length
  }

  /**
   * Hold a session slot, or refuse with an actionable message. Reclaiming first
   * means a burst of new sessions can take over stale ones instead of failing.
   */
  async #reserveSlot() {
    const max = this.maxSessions
    if (!(max > 0) || this.live.size < max) return
    if (this.idleReclaimMs > 0) await this.#reclaimIdle()
    if (this.live.size < max) return
    throw new Error(
      `pi-agent: ${String(this.live.size)} sessions are already running (maxSessions=${String(max)}). `
      + 'Close an idle session and retry, or raise maxSessions for this profile.',
    )
  }

  #sessionFile(id) {
    mkdirSync(this.piSessionDirectory, { recursive: true })
    return join(this.piSessionDirectory, `${String(id).replace(/[^\w-]/g, '_')}.jsonl`)
  }

  /** Take write ownership when a persistence backend is mounted. */
  async #createStored(session, signal) {
    const persistence = this.registryCtx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    if (signal?.aborted === true) throw new Error(`agent "${String(session.id)}" creation aborted`)
    return {
      handle: await persistence.create(session.header, {
        inheritedEventCount: session.inheritedEventCount,
        ...(signal === undefined ? {} : { signal }),
      }),
      storedCount: 0,
    }
  }

  /** Store events appended before the session entered the live event feed. */
  async #appendUnstored(stored, session) {
    if (stored === undefined) return
    const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount))
    if (suffix.length > 0) await stored.handle.append(suffix)
    stored.storedCount += suffix.length
  }

  /** Build the agent, publish it, and return the owned handle. */
  async #initialize(ownerCtx, { session, stored, agentOptions, setup, signal, source, parentAgent }) {
    const cwd = session.header.cwd ?? this.options.cwd
    const history = session.snapshotEvents()
    const sessionFile = history.length === 0 ? undefined : await buildPiSessionFile({
      session,
      cwd,
      filePath: this.#sessionFile(session.id),
      logger: this.options.logger,
      attachments: this.registryCtx.get('attachments'),
      // Same projection the live turn uses, so a resumed session describes the
      // attachment identically instead of silently losing it.
      fileText: (ref) => this.registryCtx.get('llm')?.fileRequestText?.(ref),
    })

    // Reserve the bridge token before spawning: the child needs it in its env,
    // and tool calls can only arrive after a prompt — later than construction.
    const reservation = this.options.bridge?.bind()
    const guardExtension = this.options.guardExtension
    const extraArgs = [
      ...(Array.isArray(this.options.piArgs) ? this.options.piArgs : []),
      ...(this.options.bridgeExtension === undefined ? [] : ['-e', this.options.bridgeExtension]),
      ...(guardExtension === undefined ? [] : ['-e', guardExtension]),
    ]
    const extraEnv = {
      ...(reservation === undefined ? {} : this.options.bridge.envFor(reservation.token)),
      ...(guardExtension === undefined ? {} : { DSH_GUARD_TOOLS: (this.options.guardTools ?? []).join(',') }),
    }
    const rpc = new PiRpcClient({
      piPath: this.options.piPath,
      cwd,
      ...(sessionFile === undefined ? {} : { sessionFile }),
      ...(extraArgs.length === 0 ? {} : { extraArgs }),
      ...(Object.keys(extraEnv).length === 0 ? {} : { extraEnv }),
      logger: this.options.logger,
    })
    const requested = { ...routeOptions(this.options.model), ...agentOptions }
    const agent = new PiAgent({
      ctx: this.registryCtx,
      session,
      agentOptions: requested,
      rpc,
      cwd,
      logger: this.options.logger,
      startSource: source,
      requestHeader: this.options.requestHeader !== false,
      ...(this.options.presentFiles === undefined ? {} : { presentFiles: this.options.presentFiles }),
      toolSchemas: () => this.registryCtx.get('tools')?.schemas?.() ?? [],
      ...(this.options.streamPaceMs === undefined ? {} : { streamPaceMs: this.options.streamPaceMs }),
      ...(this.options.streamCatchUpFrames === undefined ? {} : { streamCatchUpFrames: this.options.streamCatchUpFrames }),
      ...(this.options.streamMaxCharsPerFrame === undefined ? {} : { streamMaxCharsPerFrame: this.options.streamMaxCharsPerFrame }),
      ...(this.options.models === undefined ? {} : { modelMap: this.options.models }),
      ...(this.options.modelInfo === undefined ? {} : { modelInfo: this.options.modelInfo }),
      ...(this.options.extensionUi === undefined ? {} : { extensionUi: this.options.extensionUi }),
      ...(this.options.toolProgress === undefined ? {} : { toolProgress: this.options.toolProgress }),
      ...(this.options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: this.options.approvalTimeoutMs }),
      ...(this.options.headerModels === undefined ? {} : { headerModels: this.options.headerModels }),
    })
    // Tool calls can only arrive after a prompt, so filling the box here is
    // always earlier than the bridge needs it.
    if (reservation !== undefined) reservation.box.agent = agent
    // Align pi's route before the first prompt. The session's persisted
    // `model/selection` wins over the deployment default in `requested`.
    const initialSelection = agent.model.current()
    if (initialSelection !== undefined) await agent.syncModel(initialSelection)

    let detachSession
    let detachAgent
    let disposing
    const dispose = () =>
      (disposing ??= (async () => {
        try {
          agent.cancel({ kind: 'disposed' })
          await agent.whenIdle().catch(() => undefined)
          await agent.dispose()
        } finally {
          try {
            await closeStored(stored)
          } finally {
            if (reservation !== undefined) this.options.bridge.unbind(reservation.token)
            detachAgent?.()
            detachSession?.()
          }
        }
      })())
    const unfollowOwner = ownerCtx.effect(() => () => {
      if (disposing === undefined) void dispose()
    })

    try {
      await this.#appendUnstored(stored, session)
      detachSession = this.registryCtx.sessions.enter(session)
      this.registryCtx.sessions.announce(session)
      if (setup !== undefined) {
        const commit = await setup(agent.ctx, agent)
        commit?.commit()
      }
      detachAgent = this.registryCtx.agents.enter(agent, parentAgent)
      await this.registryCtx.agents.announce(agent, source, signal)
      emitAgentEvent(this.registryCtx, agent, 'agent/session-start', { source })
      const owned = () => dispose().then(() => undefined)
      const record = {
        agent,
        dispose: () => {
          this.live.delete(owned)
          return owned()
        },
      }
      this.live.set(owned, record)
      return {
        agent,
        dispose: () => {
          this.live.delete(owned)
          return owned()
        },
      }
    } catch (error) {
      unfollowOwner?.()
      await dispose()
      throw error
    }
  }

  async createAgent(ownerCtx, options) {
    await this.#reserveSlot()
    const session = this.registryCtx.sessions.prepare(options.sessionId, {
      ...(options.meta === undefined ? {} : { meta: options.meta }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount }),
    })
    const stored = await this.#createStored(session, options.signal)
    try {
      return await this.#initialize(ownerCtx, {
        session,
        stored,
        agentOptions: options.agentOptions ?? {},
        setup: options.setup,
        signal: options.signal,
        source: 'startup',
        parentAgent: options.parentAgent,
      })
    } catch (error) {
      await closeStored(stored)
      throw error
    }
  }

  async resume(ownerCtx, options) {
    const persistence = this.registryCtx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    await this.#reserveSlot()
    const id = options.resumeSessionId
    const handle = await persistence.open(id, 'write', {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const stored = { handle, storedCount: 0 }
    try {
      const coldRead = await handle.read(0, undefined, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      const persisted = coldRead.events
      // A log whose last turn never ended is closed before replay (crash repair).
      const closers = interruptedTurnClosers(persisted)
      if (closers.length > 0) await handle.append(closers)
      stored.storedCount = persisted.length + closers.length

      const session = this.registryCtx.sessions.prepare(id, {
        seed: [...persisted, ...closers],
        meta: structuredClone(handle.header),
        inheritedEventCount: handle.inheritedEventCount,
        eventState: coldRead.eventState,
      })
      return await this.#initialize(ownerCtx, {
        session,
        stored,
        agentOptions: options.agentOptions ?? {},
        setup: options.setup,
        signal: options.signal,
        source: 'resume',
        parentAgent: options.parentAgent,
      })
    } catch (error) {
      await closeStored(stored)
      throw error
    }
  }
}
