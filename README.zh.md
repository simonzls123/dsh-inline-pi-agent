# dsh-inline-pi-agent

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里运行 [pi coding agent](https://github.com/earendil-works/pi) 的 agent loop。

这个 bundle 用无头的 `pi --mode rpc` 子进程替换 DSH 自带的 `dsh-agent-loop`。DSH 继续提供会话、Web UI、预设与权限界面；pi 继续使用自己的系统提示词、工具、压缩与模型路由。

## 支持的能力

- **流式输出、工具卡片、停止按钮**：把 pi 的 RPC 事件翻译成 DSH 的持久会话事件与 `agent/assistant-stream` 帧。
- **resume**：每次创建/恢复都从 DSH 事件日志重建 pi 会话文件，重启后的会话在 pi 侧保留完整上下文。
- **模型选择器**：插件读取 `pi --mode rpc get_available_models`，把 pi 自己的模型目录注册进 DSH 的 LLM 注册表；选择器里就是 pi 能跑的模型，选中后通过 `set_model` 下发。
- **转向与排队**：运行中的 `steer` 会转发给 pi，被接受后立即从队列中领取；`followup` 按顺序各自成轮。
- **可交还**：pi 驱动的会话能被内置 loop 继续，因为每次请求都按 DSH 标准事件记录（含声明工具表的 `request/header`）。

## 安装

要求：DSH `0.2.2-rc.1` 或兼容版本；`pi` 在 `PATH` 上（或显式指定 `piPath`）。

```sh
dsh plugin --profile web add github:Komorebi-Nine/dsh-inline-pi-agent
```

bundle 层会禁用 `agent-loop`、DSH 侧压缩与工具结果裁剪，并插入 `pi-agent` 行。之后重启 `dsh web`，或依赖 profile 的 patch 热重载。

本地检出安装：

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-inline-pi-agent
```

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `piPath` | `pi` | pi 可执行文件。Windows 下可为 `.cmd`/`.exe` 路径或裸名（经 `cmd.exe` 解析）。 |
| `model` | 空 | 创建会话时推给 pi 的初始路由，如 `deepseek/deepseek-flash`。 |
| `models` | 空 | 两套目录命名不一致时的 DSH 路由 → pi 路由映射。 |
| `catalog` | `true` | 是否把 pi 的模型目录注册进 DSH（选择器据此显示）。 |
| `requestHeader` | `true` | 每步记录 `request/header` 与 `request/context`；token 计量与会话交还依赖它。 |
| `presentFiles` | `true` | 成功 write/edit 后追加 `deliverables/presented`，让 DSH 在轮次末尾显示文件卡片。 |
| `streamPaceMs` | `16` | 文本揭示节拍（8–200ms）。pi 的 delta 是突发到达的，每拍最多揭示一帧缓冲文本。 |
| `streamCatchUpFrames` | `6` | 完整积压应在多少拍内排空，用来决定追赶速率。 |
| `streamMaxCharsPerFrame` | `64` | 单帧最多揭示的字符数。 |
| `piSessionDir` | `~/.dsh/pi-sessions` | 重建的 pi 会话快照目录。 |
| `maxSessions` | 0（不限） | 同时存活的 pi 会话上限。超出时先回收空闲会话，仍满则创建失败并说明原因。 |
| `idleReclaimMs` | 0（不回收） | 空闲多久后释放该会话（含 pi 子进程）。会话日志完整，重新打开即 resume。 |
| `dshTools` | 空 | 要把哪些 **DSH 工具** 通过 MCP 暴露给 pi（`mcp__dsh__<name>`）。留空则不启用；建议只列 pi 自己没有的工具，例如 Agent Team 那一套。 |
| `piArgs` | 空 | 追加给 pi 子进程的参数，如 `['-e', 'C:/guard/permission.ts']`（审批网关扩展）。 |
| `extensionUi` | `deny` | pi 扩展发起阻塞式对话框时如何应答：`deny` 一律 `cancelled`；`approval` 把 `confirm` 转成 DSH 的审批请求（会话策略决定是否弹窗）；`allow` 按“确认/首项/空串”放行（仅调试）。 |
| `guard` | 关 | 用 pi 的 `tool_call` 钩子把 pi **自己**的工具拦到审批前面。`true` = `[bash, write, edit]`，也可给数组。需要 `extensionUi: 'approval'`。 |
| `approvalTimeoutMs` | `300000` | 单次审批等待上限；超时按拒绝处理（fail closed）。 |
| `headerModels` | 空 | 只改写 `request/header` 里的模型名（作用于计量与成本面板），不影响发给 pi 的路由。例如 `{deepseek-flash: deepseek-v4-flash}`。 |
| `toolProgress` | `false` | 把 pi 的工具中间输出（`tool_execution_update`）作为 `agent/tool-progress` 实时通知发布。会话日志不受影响；当前 Web 客户端还不渲染该通知。 |
| `debug` | `false` | 协议与生命周期日志。 |

在自己的 profile patch 里覆盖：

```yaml
- id: pi-agent
  config:
    piPath: 'C:/Users/me/.pi/agent/bin/pi.cmd'
```

## 开启 Agent Team / 子 agent

`dshTools` 非空时，插件在 127.0.0.1 起一个带一次性 token 的桥，并用 `-e` 给 pi 加载一个扩展，把 DSH 工具注册成 MCP server `dsh`；模型看到的名字是 `mcp__dsh__<tool>`。工具调用走 `ctx.tools.execute`（不带 `log`），所以 DSH 侧策略与渲染照常生效，而**会话日志仍由 pi 独占记录**，不会重复。

推荐只暴露 pi 自己不带的工具（pi 自带 bash/read/write/edit，重复暴露会让模型面对两套）：

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

装上这组后，「启用 Agent Team」才真的生效：teammate 由 `subagent` 工具创建，走的是同一个 AgentFactory，所以每个 teammate 是一个独立的 pi 子进程。

两个要知道的边界：

- **只有 DSH 工具受 DSH 策略管**。pi 自带的 bash/read/write 仍然是 pi 自己执行，沙箱与审批不适用（见下方已知限制）。
- **DSH 的 team 指引文本进不了 pi**（pi 用自己的系统提示词）。任务板工具能用，但「怎么用共享任务板」的说明缺失，必要时在 prompt 里补。

## 让 DSH 的权限预设管住 pi 自己的工具

pi 执行自己的工具，DSH 的审批策略原本看不到它们。开启下面两项后，pi 的 `bash`/`write`/`edit` 会先问 DSH：

```yaml
- id: pi-agent
  config:
    extensionUi: approval     # confirm 走 DSH 审批立面
    guard: true               # 等价于 [bash, write, edit]
```

链路：pi 的 `tool_call` 钩子 → `ctx.ui.confirm()` → `extension_ui_request` → 插件调 `ctx.approval.request()` → 浏览器审批卡片（`dsh-client-ui-approval`）→ 结果回给 pi 决定放行或 block。

语义与权限预设一致：

| 会话审批策略 | 行为 |
|---|---|
| `ask`（workspace-write 等） | 弹窗询问；拒绝则工具被 block，模型收到失败结果 |
| `never`（danger-full-access） | **不问直接放行**（预设的含义就是“别再问了”） |

失败一律关闭（fail closed）：没有审批服务、没有观众、超时、审批链路抛错，全部按拒绝处理。审计落在会话日志的 `approval/asked` / `approval/decided`。

> 注意：`guard` 只覆盖 pi **自己的**工具。经 `dshTools` 桥过来的 DSH 工具本来就受 DSH 策略管，不需要重复拦截。

## 运行行为

- 用户消息里的图片会从 DSH 的 attachment 服务读出，作为 pi `prompt`/`steer` 的 `images` 下发；挂载 attachment 服务时，resume 重建 pi 会话也会把历史图片重新写回 user message。
- pi 对扩展命令/输入处理器返回 `disposition: "handled"` 时不启动 run；插件直接把该 turn 记为完成，不再等待 `agent_settled`。
- resume 时会话持久化的 `model/selection` 优先于部署默认模型；每次 prompt 前会等待 `set_model` + `set_thinking_level` 完成。
- 运行中到达的 `next-step`/inject 消息通过 pi 的 `steer` 下发；错过当前 turn 的消息留在队列，下一轮再发。
- 工具结果文本上限 64KB；图片/二进制结果只记录占位说明，不把 base64 写进 DSH 会话日志。pi 扩展抛出的 `extension_error` 会写入 DSH warn 日志。

## 已知限制

- **pi 自己的工具**只有配了 `guard` 才受 DSH 审批约束；未配置时（默认）它们仍由 pi 直接执行。
- 压缩（自动与 `/compact`）会被记成 DSH 的 `compaction/*` 事务并替换 surface；pi 的边界无法映射到 DSH 节点时**不记录**（避免伪造 surface），`/compact` 会返回错误。
- 插件不派发 `agent/pre-step`，依赖它的钩子（时间注入、每步 flush、plan-mode 旁白）在 pi 会话中不生效。
- `contextBreakdown.toolsTokens` 描述的是 DSH 工具注册表而非 pi 的工具块（写在 `request/header` 上是为了让原生 loop 能续接）；上下文压力本身来自 provider 上报的 usage。
- 模型目录探测（`probeModels`）会额外起一个 pi 子进程，因此**不再阻塞插件加载**：会话先可用，目录适配器稍后补注册。首次打开模型选择器若扑空，等几秒再打开。
- Agent Team（`dsh-agent-team`）**需要显式开启**：`subagent` 与任务板是 DSH 侧注册的模型工具，pi 子进程看不到 DSH 的工具表，必须先通过 `dshTools` 暴露（见上一节）。默认不暴露时，勾选「启用 Agent Team」只会写一条 `team/mode`，模型行为不变。

## 回退

在**设置 → 插件**里停用该 bundle，或移除包。bundle 层随之消失，`agent-loop` 恢复启用，已有会话可继续。

**停用/启用后请重启 `dsh web`。** 切换会替换唯一的 agent 工厂与 loop 的会话投影，运行中的 loader 无法原子完成这次替换；半应用的重载会让会话列表显示为空（数据仍在磁盘上，重启即恢复）。切换本身不会改动任何会话数据。

如果启用期间把部署默认模型改成了 pi 路由，停用前请改回内置路由——pi 的 provider 只在 bundle 加载期间存在：

```yaml
- id: agent-default-model
  config: { provider: deepseek-official, model: deepseek-flash }
```

## 开发

`CONTRACT.md` 记录了插件所依赖的接口、事件与协议契约，以及对应的实测数据。`scripts/smoke.mjs` 是独立测试台（不需要 DSH 服务器），覆盖 text / tool / multi / abort / dispose / resume / steer / followup / token / catalog：

```sh
node scripts/smoke.mjs text
node scripts/smoke.mjs tool
node scripts/smoke.mjs resume
```

## 许可

MIT，见 [LICENSE](LICENSE)。

附件说明：`image` 块以 `ImageContent` 下发给 pi；`file` 块（zip、文档等）按 `dsh-llm` 的 `fileRequestText` 投影成句柄文字（文件名、字节数、只读路径），pi 用自己的 read/bash 工具读该路径。
