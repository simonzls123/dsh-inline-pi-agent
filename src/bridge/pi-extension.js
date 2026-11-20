/**
 * pi extension that wires this session to the DSH tool bridge.
 *
 * The plugin spawns the pi child with `DSH_TOOL_BRIDGE_*` in its environment and
 * loads this file with `-e`. Registering the server per session keeps the
 * global `~/.pi/agent/mcp.json` untouched: nothing about DSH leaks into the
 * user's other pi sessions.
 *
 * Plain ESM, no TypeScript: an extension that fails to parse makes pi exit with
 * status 1 and takes the whole session with it.
 */
import { fileURLToPath } from 'node:url'

export default function (pi) {
  const url = process.env.DSH_TOOL_BRIDGE_URL
  const token = process.env.DSH_TOOL_BRIDGE_TOKEN
  if (url === undefined || url === '' || token === undefined || token === '') return

  pi.registerMcpServer('dsh', {
    // The node that hosts this plugin is the one that can run the server.
    command: process.env.DSH_TOOL_BRIDGE_NODE ?? process.execPath,
    args: [fileURLToPath(new URL('./mcp-server.mjs', import.meta.url))],
    // Direct exposure keeps these as ordinary tools: codemode would wrap each
    // call in a generated script, and a script that fails costs the model a turn.
    exposure: 'direct',
    env: { DSH_TOOL_BRIDGE_URL: url, DSH_TOOL_BRIDGE_TOKEN: token },
  })
}
