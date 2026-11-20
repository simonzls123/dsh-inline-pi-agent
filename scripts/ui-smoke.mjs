/**
 * Verifies the two protocol fixes end to end against a real pi child:
 *   1. `extension_ui_request` is routed and answered (never left to time out)
 *   2. `set_thinking_level` is accepted and confirmed by pi
 *
 * Usage: PI_PATH=/path/to/pi node scripts/ui-smoke.mjs
 */
import { fileURLToPath } from 'node:url'
import { PiRpcClient } from '../src/rpc.js'

const piPath = process.env.PI_PATH ?? 'pi'
const extension = fileURLToPath(new URL('./fixtures/confirm-gate.ts', import.meta.url))

const fail = (message) => {
  console.error(`FAIL: ${message}`)
  process.exitCode = 1
}

// ---- 1. extension UI ----
{
  const requests = []
  const events = []
  const rpc = new PiRpcClient({
    piPath,
    cwd: process.cwd(),
    extraArgs: ['-e', extension],
    logger: (line) => process.env.DEBUG === '1' && console.log('[log]', line),
  })
  rpc.onUiRequest((request) => {
    requests.push(request)
    // The plugin's default policy: decline every blocking dialog.
    rpc.respondUi(request.id, { cancelled: true })
  })
  rpc.onEvent((event) => {
    events.push(event)
    if (event.type === 'extension_error') console.log('[extension_error]', JSON.stringify(event))
  })

  await rpc.prompt('Run this exact shell command with the bash tool: echo hello')
  const deadline = Date.now() + 60000
  while (!events.some((event) => event.type === 'agent_settled') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  rpc.close()

  const dialog = requests.find((request) => request.method === 'confirm')
  if (dialog === undefined) fail(`no extension_ui_request arrived (got ${requests.length})`)
  else console.log('OK ui: confirm request ->', JSON.stringify(dialog.title))

  const blocked = events.find(
    (event) => event.type === 'tool_execution_end' && JSON.stringify(event.result ?? '').includes('denied by host'),
  )
  if (blocked === undefined) fail('the blocked tool call did not report the host denial')
  else console.log('OK ui: tool blocked with reason')
}

// ---- 2. thinking level ----
{
  const rpc = new PiRpcClient({ piPath, cwd: process.cwd() })
  await rpc.setModel('deepseek', 'deepseek-flash')
  try {
    // deepseek-flash offers off/low/high/max; `medium` is clamped to `high`.
    const applied = await rpc.setThinkingLevel('medium')
    if (applied !== 'high') fail(`expected clamping to high, pi applied ${String(applied)}`)
    else console.log('OK thinking: medium clamped to high, confirmed via get_state')
  } catch (error) {
    fail(`set_thinking_level rejected: ${String(error)}`)
  }
  try {
    await rpc.setThinkingLevel('bogus')
    fail('an unknown level was accepted; pi would silently land on off')
  } catch {
    console.log('OK thinking: unknown level rejected locally')
  }
  rpc.close()
}

console.log(process.exitCode === 1 ? 'RESULT: FAILED' : 'RESULT: PASS')
