# dsh-inline-pi-agent

Run the [pi coding agent](https://github.com/earendil-works/pi) loop inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The bundle replaces DSH's agent loop (`dsh-agent-loop`) with a headless `pi --mode rpc` child process. DSH keeps its sessions, web UI, presets and permission surface; pi keeps its own prompt, tools, compaction and model routing.

## What works

- **Streaming, tool cards, stop button** — translated from pi's RPC events into DSH's durable session events plus `agent/assistant-stream` frames.
- **Resume** — on every create/resume the pi session file is rebuilt from DSH's event log, so a restarted harness continues with the full conversation in pi's context.
- **Model selector** — the plugin reads `pi --mode rpc get_available_models` and registers pi's own catalog in DSH's LLM registry. The selector lists exactly the models pi can run, and a selection is forwarded with `set_model`.
- **Steering and follow-ups** — `steer` is forwarded to pi mid-run and claimed once accepted; queued follow-ups run as separate turns in order.
- **Hand-back** — a session driven by pi can be resumed by the built-in loop, because every request is recorded in DSH's standard event vocabulary (including a `request/header` that declares the registry's tool schemas).

## Install

Requirements: DSH `0.2.2-rc.1` or a compatible release, and `pi` on `PATH` (or an explicit `piPath`).

```sh
dsh plugin --profile web add github:Komorebi-Nine/dsh-inline-pi-agent
```

The bundle layer disables `agent-loop`, DSH-side compaction and tool-result pruning, then inserts the `pi-agent` row. Restart `dsh web`, or rely on the profile's patch reload.

Installing from a local checkout instead:

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-inline-pi-agent
```

## Configuration

| key | default | meaning |
|---|---|---|
| `piPath` | `pi` | pi executable. On Windows, a `.cmd`/`.exe` path or a bare name (resolved through `cmd.exe`). |
| `model` | empty | Initial route pushed to pi, e.g. `deepseek/deepseek-flash`. |
| `models` | empty | DSH route → pi route mapping, when the two catalogs use different names. |
| `catalog` | `true` | Register pi's model catalog into DSH so the selector lists pi's models. |
| `requestHeader` | `true` | Record `request/header` and `request/context` per step. Needed for token measurement and for handing a session back to the built-in loop. |
| `presentFiles` | `true` | After a successful write/edit, append `deliverables/presented` so DSH renders the file in the turn-tail deliverables card. |
| `streamPaceMs` | `16` | Reveal cadence for streamed text (8–200 ms). pi delivers deltas in bursts; each tick reveals at most one frame of buffered text. |
| `streamCatchUpFrames` | `6` | How many ticks a full backlog should take to drain, which sets the reveal rate while text is arriving faster than it is shown. |
| `streamMaxCharsPerFrame` | `64` | Upper bound on characters revealed by one frame. |
| `piSessionDir` | `~/.dsh/pi-sessions` | Where rebuilt pi session snapshots are written. |
| `dshTools` | none | DSH tool names to expose to pi over MCP as `mcp__dsh__<name>`. Empty disables the bridge. List only tools pi does not ship itself. |
| `piArgs` | none | Extra pi child arguments, e.g. `['-e', 'C:/guard/permission.ts']` for an approval gate extension. |
| `extensionUi` | `deny` | How blocking extension dialogs are answered: `deny` replies `cancelled`; `approval` routes `confirm` through DSH's approval seam; `allow` approves the first option (debugging only). |
| `guard` | off | Gate pi's **own** tools behind DSH approval via pi's `tool_call` hook. `true` means `[bash, write, edit]`; an array picks tools. Requires `extensionUi: 'approval'`. |
| `approvalTimeoutMs` | `300000` | Upper bound for one approval; a timeout counts as a rejection (fail closed). |
| `headerModels` | none | Rewrites the model name recorded on `request/header` (metering and cost panels) without changing the route sent to pi, e.g. `{deepseek-flash: deepseek-v4-flash}`. |
| `toolProgress` | `false` | Publish pi's partial tool output (`tool_execution_update`) as live `agent/tool-progress` notifications. The session log is untouched; the current Web client does not render them yet. |
| `debug` | `false` | Protocol and lifecycle diagnostics. |

Override any of them in your profile patch:

```yaml
- id: pi-agent
  config:
    piPath: 'C:/Users/me/.pi/agent/bin/pi.cmd'
```

## Enabling Agent Team and subagents

When `dshTools` is non-empty the plugin serves a token-guarded bridge on 127.0.0.1 and loads a pi extension (`-e`) that registers DSH's tools as the MCP server `dsh`; the model sees `mcp__dsh__<tool>`. Calls run through `ctx.tools.execute` without `log`, so DSH policy and rendering still apply while pi keeps the only durable record of the call.

Expose only what pi lacks (pi already ships bash/read/write/edit, and duplicates make the model choose between two of everything):

```yaml
- id: pi-agent
  config:
    dshTools:
      - subagent
      - subagent_fork
      - send_message
      - list_agents
      - interrupt_agent
      - wait_agent
      - team_task_create
      - team_task_get
      - team_task_list
      - team_task_update
```

With that list, **Use Agent Teams** actually works: teammates are created by the `subagent` tool through the same `AgentFactory`, so each teammate is its own pi child.

Two boundaries:

- **Only bridged tools obey DSH policy.** pi's own bash/read/write still execute inside pi, so the sandbox and approval presets do not apply to them.
- **DSH's team guidance text does not reach pi** (pi uses its own system prompt). The task-board tools work, but the "how to use the board" section is missing; add it to your prompt if the model needs it.

## Known limitations

- pi executes its own tools, so DSH sandboxing, approval flow and permission presets do not apply to them. To actually gate them, load a pi extension that hooks `tool_call` and calls `ctx.ui.confirm()`, then bridge the dialog — the plugin answers it (default `extensionUi: 'deny'`).
- The plugin does not dispatch `agent/pre-step`. Hooks that rely on it — time-context injection, the per-step flush, plan-mode narration — do not run for pi sessions.
- `contextBreakdown.toolsTokens` describes DSH's tool registry rather than pi's tool block; it is declared on `request/header` so a native-loop resume stays valid. Context pressure itself comes from provider-reported usage.
- The model catalog probe (`probeModels`) spawns one extra pi child, so it no longer blocks plugin load: sessions are served immediately and the adapter is registered when the probe answers.
- **Agent Team (`dsh-agent-team`) needs `dshTools`.** `subagent` and the task-board tools are DSH-side model tools; without the bridge a pi child never sees them, and toggling Team mode only records `team/mode`. See `CONTRACT.md` §12.5 and §13.

## Rollback

Disable the bundle under **Settings → Plugins**, or remove the package. The bundle layer disappears with it, so `agent-loop` is enabled again and existing sessions continue under the built-in loop.

**Restart `dsh web` after toggling the bundle.** Switching it on or off replaces the single agent factory and the loop's session projections. A running loader cannot apply that swap atomically; a half-applied reload can show an empty session list even though every session is intact on disk. A restart always restores them. Session data is never touched by the toggle.

If you also changed the deployment default model to a pi route while the bundle was active, set it back to a built-in route before disabling — pi providers only exist while the bundle is loaded:

```yaml
- id: agent-default-model
  config: { provider: deepseek-official, model: deepseek-flash }
```

## Development

`CONTRACT.md` records the interface, event and protocol contracts the plugin is built against, together with the measurements behind them. `scripts/smoke.mjs` is a standalone harness (no DSH server) covering text, tool, multi-turn, abort, dispose, resume, steer, followup, token accounting and the model catalog:

```sh
node scripts/smoke.mjs text
node scripts/smoke.mjs tool
node scripts/smoke.mjs resume
```

## License

MIT — see [LICENSE](LICENSE).
