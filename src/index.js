/**
 * dsh-pi-agent — run the pi coding agent loop inside DeepSeek Harness.
 *
 * Registers an `AgentFactory`, so every session the frontend creates is driven
 * by a headless `pi --mode rpc` child instead of `dsh-agent-loop`. Disable the
 * `agent-loop` profile row before mounting this plugin: the registry allows a
 * single factory and throws when one is already registered.
 *
 * Disabling `agent-loop` also removes the `inbox` / `modelSelection` session
 * projections it owns, so this plugin registers them itself.
 */

import { fileURLToPath } from 'node:url'

import { PiCatalogAdapter, probeModels } from './catalog.js'
import { DshToolBridge } from './bridge/server.js'
import { PiAgentFactory } from './factory.js'
import { projectionDefinitions } from './projections.js'

export const name = 'pi-agent'

export const inject = ['sessions', 'agents', 'sessionProjections', 'llm']

/** Finite positive number check for numeric config options. */
const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0

export async function apply(ctx, config = {}) {
  // `agent-loop` normally owns these units. During a live bundle toggle the two
  // owners can overlap; a duplicate registration must not fail this plugin (or
  // worse, fail the reloading tree) — the other owner provides the same fold.
  for (const definition of projectionDefinitions) {
    try {
      await ctx.sessionProjections.register(definition)
    } catch (error) {
      ctx.logger?.warn?.(`[pi-agent] projection "${String(definition.key)}" already owned: ${String(error)}`)
    }
  }

  const debug = config.debug === true
  const logger = debug
    ? (line) => {
        try {
          ctx.logger?.debug?.(line)
        } catch {
          // diagnostics must never break the plugin
        }
      }
    : undefined

  // Advertise pi's own models so the selector offers what actually runs.
  // The probe spawns a whole pi child (seconds on Windows), so it stays off the
  // startup path: sessions are served without a catalog, and the adapter lands
  // when the probe answers. Registrations still belong to this plugin's fiber,
  // so unloading the plugin disposes them with everything else.
  const catalog = { lookup: undefined }
  if (config.catalog !== false) {
    void (async () => {
      try {
        const models = await probeModels({ piPath: config.piPath ?? 'pi', cwd: config.cwd ?? process.cwd(), logger })
        const adapter = new PiCatalogAdapter(models)
        if (adapter.providers.length > 0) {
          ctx.llm.registerAdapter(adapter.providers, adapter)
          catalog.lookup = (provider, model) => adapter.lookup(provider, model)
        }
      } catch (error) {
        ctx.logger?.warn?.(`[pi-agent] model catalog unavailable: ${String(error)}`)
      }
    })()
  }

  // Expose DSH's own tools to pi over MCP. Off unless the deployment names the
  // tools to expose: pi already ships bash/read/write/edit, so a blanket bridge
  // would offer two of everything.
  let bridge
  let bridgeExtension
  if (Array.isArray(config.dshTools) && config.dshTools.length > 0) {
    const names = config.dshTools.filter((name) => typeof name === 'string' && name !== '')
    if (names.length > 0) {
      bridge = new DshToolBridge({ getTools: () => ctx.get('tools'), allow: names, logger })
      await bridge.start()
      bridgeExtension = fileURLToPath(new URL('./bridge/pi-extension.js', import.meta.url))
      ctx.effect(() => () => bridge.close())
    }
  }

  // Guard pi's own tools with DSH's approval seam. `guard` accepts `true` (the
  // default list: bash/write/edit), an array of tool names, or `false`.
  const guardTools = config.guard === true
    ? ['bash', 'write', 'edit']
    : Array.isArray(config.guard)
      ? config.guard.filter((name) => typeof name === 'string' && name !== '')
      : []
  const guardExtension = guardTools.length === 0
    ? undefined
    : fileURLToPath(new URL('./guard/guard-extension.js', import.meta.url))

  const factory = new PiAgentFactory(ctx, {
    piPath: config.piPath ?? 'pi',
    cwd: config.cwd ?? process.cwd(),
    model: config.model ?? '',
    ...(config.models === undefined ? {} : { models: config.models }),
    ...(config.piSessionDir === undefined ? {} : { piSessionDir: config.piSessionDir }),
    requestHeader: config.requestHeader !== false,
    modelInfo: (provider, model) => catalog.lookup?.(provider, model),
    ...(config.extensionUi === undefined ? {} : { extensionUi: config.extensionUi }),
    ...(config.toolProgress === undefined ? {} : { toolProgress: config.toolProgress }),
    ...(positive(config.approvalTimeoutMs) ? { approvalTimeoutMs: config.approvalTimeoutMs } : {}),
    ...(config.headerModels === undefined ? {} : { headerModels: config.headerModels }),
    ...(Array.isArray(config.piArgs) ? { piArgs: config.piArgs.filter((arg) => typeof arg === 'string') } : {}),
    ...(bridge === undefined ? {} : { bridge }),
    ...(bridgeExtension === undefined ? {} : { bridgeExtension }),
    ...(guardExtension === undefined ? {} : { guardExtension, guardTools }),
    ...(positive(config.streamPaceMs) ? { streamPaceMs: Math.min(200, Math.max(8, config.streamPaceMs)) } : {}),
    ...(positive(config.streamCatchUpFrames) ? { streamCatchUpFrames: Math.max(1, Math.round(config.streamCatchUpFrames)) } : {}),
    ...(positive(config.streamMaxCharsPerFrame) ? { streamMaxCharsPerFrame: Math.max(1, Math.round(config.streamMaxCharsPerFrame)) } : {}),
    logger,
  })
  ctx.agents.setFactory(factory)

  // `/compact` belongs to whichever engine owns compaction: `command-compact`
  // is disabled by this bundle, so pi's own `compact` RPC backs the command.
  ctx.inject(['commands'], (commandCtx) => {
    const unregister = commandCtx.commands.register({
        name: 'compact',
        description: 'Compact older conversation history (via pi)',
        async handler(invocation) {
          if (invocation.rawInput.trim() !== '') {
            return { kind: 'error', text: 'Usage: /compact' }
          }
          const agent = invocation.agent
          if (typeof agent?.compactNow !== 'function') {
            return { kind: 'error', text: 'This session is not driven by pi.' }
          }
          const outcome = await agent.compactNow(invocation.signal)
          if (invocation.signal.aborted) return { kind: 'error', text: 'Compaction cancelled.' }
          if (outcome.ok !== true) {
            if (outcome.reason === 'busy') return { kind: 'error', text: 'Compaction is unavailable while the session is running.' }
            if (outcome.reason === 'unmapped') {
              return {
                kind: 'error',
                text: "pi compacted its own context, but its boundary could not be mapped onto this session's history. Use `/compact` after the next turn.",
              }
            }
            return { kind: 'error', text: `Compaction failed: ${String(outcome.reason)}` }
          }
          return {
            kind: 'success',
            text: `Compacted ${String(outcome.shadowedCount)} history items (~${String(outcome.shadowedTokenCount)} tokens).`,
            ...(outcome.summarySeq === undefined ? {} : { sourceEventSeq: outcome.summarySeq }),
          }
        },
    })
    // `effect` installs the disposer; the registration itself must happen now.
    commandCtx.effect(() => () => unregister())
  })

  // A live bundle toggle unloads this plugin while agents may still be running:
  // tear them down (and close their pi children) instead of leaking them.
  ctx.effect(() => () => factory.disposeAll())
}
