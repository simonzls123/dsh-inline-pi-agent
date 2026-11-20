/**
 * pi guard: route selected tool calls through a human decision before they run.
 *
 * pi executes its own tools, so DSH's approval policy never sees them. This
 * extension closes that gap: it hooks `tool_call` (which can block) and asks
 * `ctx.ui.confirm`, which crosses the RPC boundary as an `extension_ui_request`.
 * The plugin answers it through `ctx.approval.request`, so the decision obeys
 * the session's approval policy and lands in the DSH audit log.
 *
 * Wire protocol with the plugin (both sides ship together):
 *   title   — human copy, e.g. "Allow running a shell command?"
 *   message — first line `tool: <name>`, then the detail the user needs
 * If the plugin cannot parse it, it still asks; only the audit label degrades.
 *
 * Environment: DSH_GUARD_TOOLS — comma-separated tool names. Empty disables the
 * guard; the plugin omits this extension entirely in that case.
 */
export default function (pi) {
  const configured = String(process.env.DSH_GUARD_TOOLS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
  if (configured.length === 0) return
  const guarded = new Set(configured)

  /** One line of context is enough for a decision; the full input can be huge. */
  const detail = (event) => {
    let summary
    try {
      summary = JSON.stringify(event.input ?? {})
    } catch {
      summary = String(event.input)
    }
    return summary.length > 2000 ? `${summary.slice(0, 2000)}…` : summary
  }

  pi.on('tool_call', async (event, ctx) => {
    if (!guarded.has(event.toolName)) return
    const allowed = await ctx.ui.confirm(`Allow ${event.toolName}?`, `tool: ${event.toolName}\n${detail(event)}`)
    // `undefined` (timeout, cancelled, undecided) fails closed on purpose.
    if (allowed !== true) return { block: true, reason: `blocked: ${event.toolName} was not approved` }
  })
}
