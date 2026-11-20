// Test extension: asks the host before every bash call. Used by ui.test.mjs to
// exercise the `extension_ui_request` / `extension_ui_response` subprotocol.
import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent"

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return
    const ok = await ctx.ui.confirm("Run shell command?", event.input.command)
    if (!ok) return { block: true, reason: "denied by host" }
  })
}
