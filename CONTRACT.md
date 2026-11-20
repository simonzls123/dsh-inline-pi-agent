# dsh-pi-agent 对接契约清单

DSH `0.2.2-rc.1` ⇄ pi `1.5.0`。本文件只写"必须对齐的接口、字段、时序"，不写实现细节。
标注 `[待验证]` 的条目需要在 P0/P1 阶段用真实运行确认，不要按推测编码。

---

## 0. 范围

- 做什么：实现一个 `AgentFactory` + `Agent`，用 `pi --mode rpc` 子进程替换 `dsh-agent-loop`，由 pi 驱动 DSH 会话。
- 不做什么：不桥接工具（pi 用自己的 `read`/`bash`/`edit`/`write`）、不做按会话切换 loop、不改 DSH 前端。
- 交付形态：独立包，profile patch 里禁用 `agent-loop` 并插入本插件。

---

## 1. 版本基线

| 组件 | 版本 | 位置 |
|---|---|---|
| DSH | `0.2.2-rc.1` | `C:\Users\k\.dsh\profiles\node_modules\@deepseek-ai\*`（junction 到 `C:\Users\k\.bun\install\global\node_modules`） |
| pi | `1.5.0` | `C:\Users\k\.pi\agent\install\releases\1.5.0\node_modules\@earendil-works\pi-coding-agent` |
| Node | `v26.13.0` | pi SDK 要求 ≥ 22.19 |

peerDependencies（`^0.2.2-rc.1`）：

```
@deepseek-ai/cordis
@deepseek-ai/dsh-agent
@deepseek-ai/dsh-llm
@deepseek-ai/dsh-scope
@deepseek-ai/dsh-session
@deepseek-ai/dsh-session-persistence
@deepseek-ai/dsh-session-projection
```

---

## 2. 插件装配

包同时是 **bundle**：`package.json` 的 `dsh.bundle.patch` 指向自带的 `cordis.patch.yml`，所以安装即整层生效，profile 不需要手写任何行。

```powershell
dsh plugin --profile web add link:C:/Users/k/Documents/DSH/dsh-pi-agent
# 发布后：dsh plugin --profile web add dsh-pi-agent
```

安装器会把它自动登记进 `profiles/<name>/package.json` 的 `dsh.profile.bundles`（实测）：

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-pi-agent"] } }
```

bundle 层内容（`cordis.patch.yml`，随包发布）：

```yaml
- id: agent-loop
  disabled: true          # 工厂唯一
- id: compaction-basic
  disabled: true          # pi 自己压缩
- id: command-compact
  disabled: true
- id: tool-result-pruner
  disabled: true
- insert:
    - id: pi-agent
      name: 'dsh-pi-agent'
      config: { piPath: 'pi', debug: false }
```

用户 patch（`cordis.patch.yml`）在 bundle 之后应用，仍可覆盖：

```yaml
- id: pi-agent
  config:
    piPath: 'C:/Users/k/.pi/agent/bin/pi.cmd'
    debug: true
```

`src/index.js` 仍是一个普通 Cordis 插件（`name` / `inject` / `apply`），bundle 只是把它和必要的行一起交付：

```ts
export const name = 'pi-agent'
export const inject = ['sessions', 'agents', 'sessionProjections', 'llm']
export async function apply(ctx: Context, config): Promise<void>
```

约束：

| 项 | 说明 |
|---|---|
| 工厂唯一性 | `ctx.agents.setFactory()` 在已有工厂时抛 `an agent factory is already registered`（`dsh-agent/lib/index.js`）。必须禁用 `agent-loop`，**不能**"底下还留一份" |
| 回退 | 禁用 bundle（或删掉行）；bundle 层撤销后 `agent-loop` 自动回到启用状态 |
| 服务依赖 | `agentLoop` 服务只有 `dsh-agent-loop` 自己声明，其他包不 `inject`，因此禁用不会连带失败 |

---

## 3. DSH 接口契约

### 3.1 AgentFactory（`@deepseek-ai/dsh-agent`）

```ts
createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>
resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>
```

`CreateAgentOptions`：

| 字段 | 类型 | 处理方式 |
|---|---|---|
| `sessionId` | `SessionId` | 唯一身份，直接给 `sessions.prepare` 与 pi session 文件命名 |
| `parentAgent?` | `Agent` | 传给 `ctx.agents.enter(agent, parentAgent)` |
| `meta?` | `{ cwd?, parentSession?, isSeeded?, origin?: 'subagent', delegationDepth?, agentPreset? }` | 原样传给 `sessions.prepare(id, { meta })`；`cwd` 必须绝对路径 |
| `inheritedEventCount?` | `SessionLogOffset` | fork 场景，P0 不处理，直接透传 |
| `seed?` | `SessionEvent[]` | fork 场景，P0 不处理，直接透传 |
| `agentOptions?` | `AgentOptions` | 初始路由；`provider` / `model` / `reasoningEffort` / `maxTokens` |
| `signal?` | `AbortSignal` | 创建期取消；abort 后必须回滚已建资源再 reject |
| `setup?` | `AgentSetup` | **签名已变更**：`(agentCtx, agent)`，且可能返回 `{ commit() }`；必须在发布前 await，commit 在发布前同步调用 |

`ResumeAgentOptions`：`resumeSessionId` / `parentAgent?` / `agentOptions?` / `signal?` / `setup?`。

`AgentHandle`：`{ agent, dispose(): Promise<void> }`；`dispose()` 需完成"停 pi → 注销 agent/session → 解 scope → 关写句柄"。

### 3.2 Agent 必填成员

```ts
readonly id: SessionId
readonly options: AgentOptions
readonly session: Session
readonly model: Model              // AgentModel
readonly inbox: Inbox
readonly status: AgentStatus       // 'idle' | 'running'
readonly ctx: Context              // createScope(...).ctx.extend({ agent })
cancel(cause: AgentCancelCause, options?: { keepInbox?: boolean }): void
whenIdle(): Promise<void>
runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
send(message: UserMessage, target: 'next-turn' | 'next-step', wakeup: boolean): void
followup(message: UserMessage): void
steer(message: UserMessage): void
inject(message: UserMessage): void
```

`Inbox` 必须实现：`nextTurn` / `nextStep` / `clear()` / `append()` / `prepend()` / `replace()` / `remove()` / `splice()`。
**0.2.2 不再从 `dsh-agent` 导出 `Inbox` 类**，需自研；每次变更都要追加 `agent/inbox/spliced` 并发出对应 `agent/inbox/*` 通知。

`AgentCancelCause`：`{kind:'user'}` | `{kind:'parent'}` | `{kind:'hook',reason}` | `{kind:'disposed'}`。

### 3.3 配套 API

| 用途 | API | 出处 |
|---|---|---|
| 建会话 | `ctx.sessions.prepare(id, { meta, seed })` → `enter(session)` → `announce(session)` | `dsh-session/index.d.ts:442-478` |
| 持久化写句柄 | `ctx.sessionPersistence.create(header)` / `open(id, 'write')` → `close()` | `dsh-session-persistence/handle.d.ts` |
| scope | `createScope(ctx, key)`；key 用 agent 对象自身 | `dsh-scope/index.d.ts:78` |
| 事件分发 | `agentEvents(ctx, agent)` → `emit/serial/waterfall`；一次性通知用 `emitAgentEvent(ctx, agent, name, payload)` | `dsh-agent/dispatch` |
| 模型选择 | `readerFor(session)` + `modelSelectionProjectionDefinition` + `new AgentModel(readState, session, options)` | `dsh-session-projection`、`dsh-agent/model-selection` |
| 消息构造 | `createAssistantMessage` / `createToolResultMessage` / `CallId` | `dsh-llm/message` |

---

## 4. 持久事件契约（必须由 loop 追加）

| 事件 | 字段 | 约束 |
|---|---|---|
| `turn/start` | `{turn}` | 每轮一次 |
| `step/start` / `step/end` | `{turn,step}` | 一次模型调用 + 其工具执行 = 一个 step |
| `user/message` | `UserMessage` | `surfaceOp:'append'`；`id`/`content`/`source` 必填 |
| `assistant/message` | `{turn, step, message, stream, usage?, interrupted?}` | **`stream: AssistantStreamRecord[]` 必填**；`sourceEventSeqs` 对本事件非法（用 `stream` 内嵌） |
| `assistant/attempt` | `{turn, step, stream}` | 失败/重试/中断且不产生可见消息时用 |
| `tool/call` | `{turn, step, callId, name, arguments}` | `arguments` 是模型产出的原始 JSON 字符串 |
| `tool/result` | `{turn, step, message, error?, meta?}` | `surfaceOp:'append'`，`sourceEventSeqs:[tool/call.seq]` |
| `turn/end` | `{turn, reason}` | `TurnEndReason`：`completed`/`aborted{reason}`/`blocked`/`error{error}`/`max-tokens`/`interrupted`/`forked` |
| `model/selection` | `ModelSelection` | 由 `AgentModel.select()` 产生，不要手写 |

禁止事项：

- `assistant/chunk` 在 0.2.2 **已不存在**，追加会被判为未知事件。
- 自造事件类型必须带 `ignorable` 标记，否则持久化读路径拒绝加载整个日志。
- `assistant/message` 的 `stream` 不是可选字段，缺失等同于数据损坏。

---

## 5. 实时事件契约（`agent/*`，进程本地）

| 事件 | payload | 何时发 |
|---|---|---|
| `agent/status` | `{status}` | 状态切换；构造时发一次 `idle` |
| `agent/session-start` | `{source:'startup'}` | 发布完成后一次 |
| `agent/assistant-stream` | `AssistantStreamFrame`：`start{attemptId,revision,turn,step}` / `chunk{attemptId,revision,index,time,chunk}` / `end{attemptId,revision,index,outcome}` | **Web 端逐字输出的唯一来源**；消费方是 `dsh-api-session-controller` |
| `agent/error` | `{turn, step, error}` | step 内异常 |
| `agent/inbox/inserted` | `{message}` | 每次 inbox 插入 |
| `agent/inbox/claimed` | `{message, turn}` | 轮次/步骤边界领取 |
| `agent/inbox/discarded` | `{message}` | 取消清空 |

`agent/created` / `agent/disposed` 由 `ctx.agents.enter/announce` 与 teardown 产生，不要手工发。

---

## 6. pi 侧协议

### 6.1 启动

```
pi --mode rpc --session <file.jsonl>     # 有历史
pi --mode rpc --no-session               # 无历史
```

Windows：`pi` 是 `pi.cmd` / `pi.ps1`，`spawn('pi')` 不可直接执行，需 `pi.cmd` + `shell` 或 `cmd.exe /c`。
pi 需要写 `~/.pi`（配置、信任、session），沙箱化环境下会 EPERM。

### 6.2 用到的命令

| 命令 | 字段 | 响应 |
|---|---|---|
| `prompt` | `{message, images?, streamingBehavior?: 'steer'\|'followUp'}` | `data.disposition`: `started`/`queued`/`handled`；`handled` 时不要等 `agent_settled` |
| `steer` | `{message, images?}` | 运行中插入，落在下一次 LLM 调用前 |
| `abort` | `{}` | 结束后才回响应 |
| `set_model` | `{provider, modelId}` | 返回完整 Model 对象 |
| `get_available_models` | `{}` | `data.models[]`，用于模型映射校验 |

所有命令都可带 `id`，响应同 `id`；事件一般无 `id`。

### 6.3 用到的事件（字段已实测）

| 事件 | 字段 |
|---|---|
| `message_start` | `message`；assistant 首帧 `content:[]`、`stopReason:'pending'`、`usage` 全 0 |
| `message_update` | `usage`（累计，流式期间可能为 0）+ `assistantMessageEvent{type, contentIndex, delta?/content?}` |
| `message_end` | `message`（权威完整消息，含 `usage`、`stopReason`、`durationMs`、`thinkingLevel`） |
| `tool_execution_start` | `toolCallId`, `toolName`, `args`（**对象，不是字符串**） |
| `tool_execution_update` | `toolCallId`, `toolName`, `args`, `partialResult` |
| `tool_execution_end` | `toolCallId`, `toolName`, `result{content[], structuredContent?}`, `isError`, `durationMs` |
| `turn_start` / `turn_end` | `turn_end` 带 `message`, `toolResults[]` |
| `agent_start` / `agent_end` / `agent_settled` | `agent_end` 带 `messages[]`,`willRetry`；`agent_settled` 带 `aborted` |

关键语义（实测）：

- `message_start/message_end` **不只属于 assistant**：system 提示词、user 消息、工具结果都会各发一对，必须按 `message.role` 过滤。
- 工具结果消息的 role 是 **`toolResult`**（驼峰），字段 `toolCallId`/`toolName`/`content`/`isError`/`durationMs`。
- `message_update` 只带 delta；`text_end`/`thinking_end` 才给权威全文，`message_end` 覆盖整条消息。
- `stopReason`：`pending` / `stop` / `toolUse` / **`aborted`**（中断时仍保留已产出的部分内容）。
- 以 `agent_settled` 作为 DSH 轮次结束信号；`agent_end` 后仍可能有重试/压缩/排队工作。
- **run 进行中不能关 stdin**：stdin EOF 触发有序关闭并中止当前 run（实测只收到 system/user 两个消息对就退出）。

内容块映射：pi `text`→DSH `text`、`thinking`→`reasoning`、`toolCall`→`tool-call`（`arguments` 对象需 `JSON.stringify`）。

`usage` 字段映射（pi → DSH `TokenUsage`）：

| pi | DSH |
|---|---|
| `input` | `inputTokens` |
| `output` | `outputTokens` |
| `cacheRead` | `cacheReadTokens` |
| `cacheWrite` | `cacheWriteTokens` |
| `reasoning` | `reasoningTokens` |
| `totalTokens` | `totalTokens` |
| `cost` | 丢弃（DSH 无对应字段） |

---

## 7. 映射表

**轮次粒度（实测修正）**：pi 的 `turn_start`/`turn_end` 是"一次 assistant 响应 + 它的工具调用"，**不是**用户一轮对话。
因此映射为：

| pi | DSH |
|---|---|
| `agent_start` | `turn/start`（一个用户提示 = 一个 DSH 轮） |
| `turn_start` | `step/start` |
| `message_start`（assistant） | assistant 消息起点；如有 prior step 则其 `turn_end` 已关闭 step |
| `message_update.text_delta` | `agent/assistant-stream` chunk（`text-delta`）+ 累积 `AssistantStreamRecord` |
| `message_update.thinking_delta` | 同上（`reasoning-delta`） |
| `message_update.toolcall_delta` | 同上（`tool-call-delta`） |
| `message_update.*_start/_end` | 只用于切分内容块，不直接落事件 |
| `message_end`（assistant） | `assistant/message`（含 `stream`、`usage`）→ 发 `assistant-stream end{committed}` |
| `tool_execution_start` | `tool/call`（`arguments` 用 `JSON.stringify(args)`），记 `seq` 备关联 |
| `tool_execution_end` | `tool/result`（`content` 取 `result.content`，`isError` 直传），`sourceEventSeqs:[callSeq]` |
| `turn_end` | `step/end` |
| `agent_settled{aborted:false}` | `turn/end{completed}` |
| `agent_settled{aborted:true}` | `turn/end{aborted, reason}`；已产出文本以 `interrupted:true` 落 `assistant/message` |
| `message_end`（user / toolResult / system） | 不落事件（DSH 侧由 loop 自己写 `user/message`、`tool/result`） |

中断实测行为：`abort` 在 run 中到达后，pi 发 `message_end{stopReason:'aborted'}`（保留部分内容）→ `turn_end` → `agent_end{willRetry:false}` → `agent_settled{aborted:true}` → 最后才回 `abort` 的 `response`。所以 DSH 侧不能等 `abort` 响应来判断停稳，要等 `agent_settled`。

---

## 8. 生命周期时序

**create**

```
createAgent(ownerCtx, opts)
  ├─ persistence.create(header)              // 拿写句柄
  ├─ sessions.prepare(sessionId, {meta, seed})
  ├─ buildPiSessionFile(session) → ~/.dsh/pi-sessions/<id>.jsonl
  ├─ spawn pi --mode rpc --session <file>
  ├─ new PiAgent(...)                        // scope + agentEvents + Inbox
  ├─ await setup(agent.ctx, agent) → commit()
  ├─ sessions.enter(session) / announce(session)
  ├─ agents.enter(agent, parent) / announce(agent)
  └─ emit agent/session-start
```

**turn**（一个用户提示 = 一个 DSH turn；pi 的每个 turn 对应一个 DSH step）

```
turn/start
  └─ user/message → prompt 命令
       ├─ pi agent_start
       ├─ pi turn_start            → step/start
       │    message_start/update…  → assistant-stream 帧
       │    message_end            → assistant/message
       │    tool_execution_start   → tool/call
       │    tool_execution_end     → tool/result
       │  pi turn_end              → step/end
       ├─ pi turn_start …（工具后续步骤重复）
       ├─ pi agent_end
       └─ pi agent_settled         → turn/end{completed | aborted}
```

**resume**

```
persistence.open(id,'write') → read() → fold inbox/model 投影 →
prepare(session with seed) → rebuild pi session file → spawn → 发布
```

**dispose**：`abort pi` → `close()` pi 子进程 → 关闭 step/turn（若开着）→ `agent/disposed` → 解 scope → `handle.close()`。

---

## 9. 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `piPath` | `pi` | Windows 建议显式给 `pi.cmd` 绝对路径 |
| `cwd` | `process.cwd()` | 兜底工作目录；`meta.cwd`（会话工作区）优先 |
| `model` | 空 | 创建会话时推给 pi 的初始路由；空则用会话路由 / pi 默认 |
| `models` | 空 | DSH 路由 → pi 路由的映射表；目录对齐（见 §9.4）后一般不需要 |
| `catalog` | `true` | 启动时探测 pi 并注册模型目录适配器；`false` 关闭 |
| `requestHeader` | `true` | 每步记录 `request/header` + `request/context`（token 计量需要）；`false` 关闭 |
| `piSessionDir` | `~/.dsh/pi-sessions` | 重建的 pi 会话快照目录 |
| `debug` | `false` | 协议与生命周期日志 |

### 9.0 profile 必需行

前四行已由 bundle 层自带（见 §2）。仅当**不用 bundle**、手工挂行时才需要自己写：

```yaml
- id: agent-loop
  disabled: true          # 工厂唯一
- id: compaction-basic
  disabled: true          # pi 自己压缩
- id: command-compact
  disabled: true
- id: tool-result-pruner
  disabled: true          # 会改日志 surface，resume 回放给 pi 时失真
- insert:
    - id: pi-agent
      name: 'dsh-pi-agent'
```

默认模型建议指向 pi 路由（目录适配器已注册同名 provider）：

```yaml
- id: agent-default-model
  config: { provider: deepseek, model: deepseek-flash }
```

---

## 9.1 实测记录（pi 1.5.0，2026-11-07）

隔离环境：`PI_CODING_AGENT_DIR` 指向临时目录并从 `~/.pi/agent` 复制凭据，cwd 指向临时工作区；`pi --mode rpc --no-session`，用 `cmd` 管道喂命令。

| 场景 | 观测到的序列 |
|---|---|
| 纯文本一轮 | `response(prompt, started)` → `agent_start` → `turn_start` → `message_start/end`(system) → `message_start/end`(user) → `message_start`(assistant) → 4×`message_update` → `message_end` → `turn_end` → `agent_end` → `agent_settled{aborted:false}` |
| 带工具 | … `message_end`(assistant, `stopReason:'toolUse'`, content=`[toolCall]`) → `tool_execution_start` → `tool_execution_end` → `message_start/end`(`role:'toolResult'`) → `turn_end` → `turn_start`(下一步) → … |
| 中断 | `message_end{stopReason:'aborted'}`（保留 1083 字符）→ `turn_end` → `agent_end{willRetry:false}` → `agent_settled{aborted:true}` → `response(abort)` |
| 空 stdin | 仅 system/user 消息对后进程退出，run 被中止 |

其它确认：

- Windows 下 `pi.cmd` + `cmd /c` 重定向可用，stdout 为纯 JSONL，无 banner 干扰；`--no-session` 全程无 stderr。
- `get_state.data` 字段：`model`、`thinkingLevel`、`isStreaming`、`isCompacting`、`steeringMode`、`followUpMode`、`sessionId`、`autoCompactionEnabled`、`messageCount`、`pendingMessageCount`。
- `set_model`：成功返回完整 Model 对象；失败为 `success:false, error:"Model not found: <provider>/<model>"`（provider 或 model 任一不存在都是这句）。
- `message_update` 子类型实测出现：`thinking_start/delta/end`、`text_start/delta/end`、`toolcall_start/delta/end`。
- `agent_settled` 是唯一可靠的"停稳"信号；`abort` 的响应在停稳之后才回。

## 9.2 P0 实测记录（插件首版，2026-11-07）

测试方式：`scripts/smoke.mjs` 直接启动最小服务组合（TypertRegistry + SessionProjectionRegistry + SessionStore + AgentRegistry + 本插件），不启动 DSH 服务器。

| 场景 | 结果 |
|---|---|
| 纯文本一轮 | `turn/start` → `user/message` → `step/start` → `assistant/message` → `step/end` → `turn/end{completed}`；stream 4 条 raw chunk；usage 正确映射 |
| 工具调用 | 1 个 turn、**2 个 step**；`tool/call` → `tool/result`（`sourceEventSeqs=[6]` 指向对应 call）；第二次 assistant 消息落在 step 2 |
| 两轮对话 | turn 1/2 独立，inbox `inserted → claimed` 各一次，pi 侧上下文连续 |
| 中途取消 | `turn/end{aborted, reason:{kind:'user'}}`，assistant 消息标 `interrupted:true` |
| 实时帧 | `assistant-stream` 每次尝试 1 个 start + N 个 chunk + 1 个 end；end 的 `outcome` 带 durable seq |
| 无持久化 | 会话只存在内存（写句柄 / resume 属 P2） |

实现取舍（与 §10 待验证项相关）：

- `AssistantStreamRecord` 统一使用 raw `chunk` 记录（`{type:'chunk', time, chunk}`），不实现 delta 打包；因此 `tool-call-chunks` 变体无需解析。
- Windows 下通过 `cmd.exe /d /s /c` 单行命令启动 `pi.cmd`，不再使用 `shell:true` + args（会触发 DEP0190 且可能重新分词）。
- pi 子进程退出会立即释放等待中的 settle，避免 `whenIdle()` 悬死。

## 9.3 P2 实测记录（持久化 + resume，2026-11-07）

测试方式：冒烟脚本挂载 `@deepseek-ai/dsh-session-persistence-jsonl`（`root` 指向临时目录），先建会话、跑一轮、dispose，再 `agents.resume()` 续接。

| 检查点 | 结果 |
|---|---|
| 写句柄 | `persistence.create(header)` → `appendUnstoredSuffix` → 进入 store 后按会话 id 路由；teardown 时 `handle.close()` |
| 落盘 | 日志文件生成；关闭时后端追加 `session/end-seed` 作为种子边界 |
| resume 读路径 | `open(id,'write')` → `read(0)` → `interruptedTurnClosers` → `prepare(seed)` |
| 历史重建 | 生成 pi v3 会话文件（header + `message` 条目链）；pi 续接后能答出上一轮内容（"42"） |
| 轮次编号 | 续接后 `turn` 从 2 继续（`agents.turnBoundaryOf(session).lastTurn`） |
| 事件连续性 | 续接事件接在既有 seq 之后（8→16），无重复、无空洞 |

踩到并修掉的两个真问题：

1. **pi 要求 assistant 消息带 `usage`**：缺 `usage.input` 会让 pi 在重建上下文时抛 `Cannot read properties of undefined (reading 'input')`。已把 DSH `TokenUsage` 反向映射为 pi 的 `{input, output, cacheRead, cacheWrite, totalTokens, cost}`。
2. **轮次号必须从持久化状态恢复**：否则续接后 `turn` 回到 1，与历史 `turn/start` 冲突。

未覆盖：崩溃恢复（日志末尾 turn 未闭合 → `interruptedTurnClosers` 合成收尾）、resume 时 pending inbox 的折叠（正常 dispose 会清空待处理输入，只有崩溃残留才会走到）。

## 9.4 模型目录接入（2026-11-08）

浏览器模型选择器读的是 `ctx.llm.listProviders()` / `listModels()`（`dsh-api-session-controller` 的 `buildModelCatalog`）。

接入方式：插件启动时用一次性 `pi --mode rpc` 子进程调 `get_available_models`，再用一个 **catalog-only** 的 `LlmAdapter` 把 pi 的模型注册进 `ctx.llm`——provider 名与 model id 都是 pi 自己的，因此：

- 会话路由 = pi 路由，选择即直通，无需映射表；
- `resolveModel` 提供 `contextWindow`、`maxTokens` 与推理档位（来自 `thinkingLevelMap`），选择器可显示上下文与思考等级；
- `stream()` 直接抛错：pi 才是执行者。任何走 DSH LLM 的同路由功能（压缩、标题）都必须关掉或另配路由。

实测（`pi` 1.5.0）：

```
deepseek (pi · deepseek): deepseek-flash, deepseek-v4-pro
  resolve deepseek-flash: context=512000 efforts=low|high|max
opencode-go (pi · opencode-go): claude-haiku-5-5, minimax-m3, … (30+)
```

适配器必须最先注册（早于工厂发布），否则前端可能在目录就绪前渲染选择器。

## 9.5 转向 / 排队 / 双向兼容 / token 修正（2026-11-08）

### steer 与 followup

| 场景 | 观测 |
|---|---|
| 运行中 `steer` | `next-step` 插入 → pi 接受后立即 claim（纯删除）→ 当前 assistant 轮结束后产生新的 assistant 消息 `STEERED`；不会在下一轮重复拼进 prompt |
| `followup` 连发两次 | 严格 FIFO：turn 1 = FIRST，turn 2 = SECOND |

实现要点：`steer` 在运行中把文本转给 pi，并在 `rpc.steer` 成功后调 `inbox.claimMessage()`；失败则留在 inbox，下一轮作为 prompt 前缀投递。早期实现只转给 pi 而不 claim，会导致下一轮重复投递。

### 与原生 loop 的双向兼容

| 会话来源 | 原生 loop 续接结果 |
|---|---|
| pi 会话，**无** `request/header` | 正常续接并答出上文暗号 |
| pi 会话，header **无 tools** | ❌ 被 DeepSeek 拒绝：`tools: at least one tool must have defer_loading=false`（原生 loop 把全部工具当新增 → 全部 deferred） |
| pi 会话，header **声明 DSH 工具表** | ✅ 正常续接（实测答出 `NOVA-3`）；原生 loop 重新记录自己的 `resume` header |

因此 `request/header` 必须带上 DSH 工具注册表的 schema（`ctx.tools.schemas()`），即使 pi 并不使用这些工具。代价：`contextBreakdown.toolsTokens` 反映的是 DSH 工具集而非 pi 的实际工具块；上下文压力仍以 provider usage 为准，不受影响。

### token 计量

根因：`tokenMeasurement` 只在存在 `request/header` 时采用 provider 上报的 usage，否则退化为启发式估算。

修正后（单次调用实测）：

| 指标 | 值 |
|---|---|
| `ttftMs` | 1146 |
| `decodeMs` | 25 |
| `decodeTokens` | 4 |
| `tokenUsage` | `uncachedInput 148 / output 4 / cacheRead 7296` |

同时记录 `request/context`（provider、model、`contextWindow`），供上下文压力展示使用。

## 9.6 剩余项处理（2026-11-08）

| 项 | 结论 |
|---|---|
| 空 `stream` | ✅ 接受：`assistant/message` 带 `stream: []` 可入库，投影正常折叠 |
| 非绝对 `cwd` | ✅ `session header cwd must be an absolute path, got "relative/path"` |
| 流式中 `dispose` | ✅ 事件闭合（`step/end` + `turn/end`）；工具执行中中断不产生孤儿 `tool/call`；代价是可能留下一个空 step |
| `requestHeader: false` | `sessionStats` 指标仍可用（ttft 1078ms vs 开头的 1146ms），但 `tokenMeasurement.anchor.usage` 为空 → 上下文占用采样退回估算 |
| `agent/pre-step` 缺失 | ⚠️ 确认是 **waterfall**（`next()`）；pi 模式下这些不生效：`dsh-time-context`（时间注入）、`dsh-agent-instructions`（AGENTS.md 组合）、`dsh-plan-mode`（旁白/闸门）、`dsh-session-checkpoint-policy`（每步 flush）。**决定不实现**：pi 自带上下文加载，DSH 再注入会重复；如需启用应做成显式 opt-in |

## 9.7 安装、开关与热更新（2026-11-08 核实）

安装（bundle 形式，实测）：

```powershell
dsh plugin --profile web add link:C:/Users/k/Documents/DSH/dsh-pi-agent
```

装完 `profiles/web/package.json` 的 `dsh.profile.bundles` 会自动多出 `dsh-pi-agent`；只装这一个包就能启动并跑出结果（临时 profile 实测输出 `BUNDLE_OK`），无需手写 patch。

开关：

| 层 | 机制 | 效果 |
|---|---|---|
| bundle | 设置 → 插件 → 该 bundle 的开关（`plugin-manager.setBundleEnabled` → `selectBundle`） | 整层撤销/恢复；撤销后 `agent-loop` 自动回到启用 |
| 单行 | `setPluginEnabled(id, enabled)`，把 `disabled` 写进 profile patch（保留注释） | 逐行；本插件不建议单独关 `pi-agent`，否则没有工厂 |
| 手工 | 直接编辑 profile patch | 等价 |

热更新：

| 改动 | 是否热生效 |
|---|---|
| patch / bundle 增删行（web 这类长驻 surface） | ✅ `plugin-manager.reload()` → `hmr.reconcileProfile()` |
| headless 等 startup-only profile | ❌ 需重启（`hmr` 未挂载时 `reload()` 只重新组合配置） |
| 本包**代码**改动 | ❌ `hmr.root` 为空，不监听包目录；需重启（或把包路径加进 `hmr.root`） |
| `link:` 目标 / 版本等解析变化 | ❌ 明确 `ResolutionRestartRequired` |

注意：对已安装过的包再次执行 `dsh plugin add` 只会 `Already up to date`，不会补登记 bundle（安装器只扫描新增依赖）；需要 `remove` 后重装，或用 bundle 开关。

### 9.8 热切换 bundle 的实际风险（2026-11-08 现场复现）

现场：启用后对话正常、会话可见；在设置里**停用**并刷新页面 → 会话列表全空；**完整重启 `dsh web` 后全部恢复**。

核对结果：

| 检查 | 结论 |
|---|---|
| 会话文件 | 39 个目录都在，最新会话 61 个事件（3 轮 + 工具 + header）完整 |
| 服务端列表 | 直接调用 `sessionQuery.listSessions()` 返回 43 条，含该 pi 会话 |
| 插件自身卸载/重载 | 冒烟 `reload` 模式通过：卸载 fiber → 重新 apply → 新一轮正常，无残留 |

结论：数据与插件生命周期都正常，故障点在 **loader 热切换工厂与投影**这一层：停用 bundle 会同时恢复 `agent-loop`（它要注册唯一工厂和 `inbox`/`modelSelection` 投影）并卸载本插件，两个 owner 在重载窗口内重叠；`recompose` 对"新引入的失败条目"会抛错（`app-boot` L4617），留下半应用的树 —— 投影缺失后客户端无法渲染冷会话，表现为列表全空。

已做的加固：

- 投影注册改为"冲突即让位"（另一个 owner 提供同语义单元时不报错）；
- 插件卸载时通过 `ctx.effect` 调 `factory.disposeAll()` 停掉所有存活 agent 及其 pi 子进程；
- README/CONTRACT 明确：**停用/启用后必须重启 `dsh web`**，并给出默认模型悬空的修复片段。

## 9.9 流式呈现：从"合并"到"匀速揭示"（2026-11-08）

现象演进：

1. 初版一 delta 一帧 → 长输出 1728 帧，浏览器卡顿。
2. 改为 20ms 合并窗口 → 帧数降了，但文本变成"跳跃式"出现：一次刷新就吐出十几个 token。
3. 根因不是渲染，而是**发送节奏**：pi 的 delta 突发到达（实测约 250 个/秒），任何"攒够就发"的策略都会成块。

最终做法（paced reveal）：

- delta 进入队列，按 `streamPaceMs`（默认 16ms）一拍发**一帧**；
- 每拍字符预算 = `ceil(积压 / streamCatchUpFrames)`，上限 `streamMaxCharsPerFrame`（默认 64），可跨多个 delta 取，且不跨内容块；
- 因此显示速率自动跟随到达速率：稳态积压约 6 拍（≈96ms），既平滑又不会落后；
- `message_end` / `turn_end` / 工具事件 / `cancel` / `dispose` 前用 `#drainNow()` 兜底排空；
- 持久记录在 `#finishAttempt` 时把 timeline **压缩成打包 run**（每条消息通常 2–3 条记录）。

实测（同一提示，1..800 行数字）：

| 指标 | 值 |
|---|---|
| 原始 delta | ~1700 |
| 揭示帧 | 300（约 37 fps） |
| 帧间隔 | 平均 19ms / 最大 32ms |
| 持久记录 | 2 条打包 run |
| 回放校验 | `expandAssistantStream` 通过，3091 字符完整 |

## 10. 待验证（剩余）

无阻塞项。可选后续：

1. `agent/pre-step` 的显式 opt-in（接受重复注入风险时）。
2. 流式中 dispose 的空 step 是否要在 UI 侧过滤。
3. `hmr.root` 纳入本包路径，实现插件代码热更新。

---

## 11. 验收清单

- [x] 新建会话一轮问答，session JSONL 含 `turn/start`→`user/message`→`step/start`→`assistant/message`→`step/end`→`turn/end`
- [x] 一次用户提示触发多步（工具）时，DSH 侧是 1 个 turn、N 个 step（对齐 pi 的 `agent_*` / `turn_*` 粒度）
- [x] Web 端逐字输出（`revision` 逐帧递增后已确认流式）
- [x] 一次工具调用在 UI 上呈现为 call + result 两块，且 `sourceEventSeqs` 关联正确
- [x] 中途停止：`turn/end{aborted}`，已输出文本保留为 `interrupted:true`
- [x] run 进行中不关闭 pi 的 stdin（`close()` 先 abort 再 end）
- [x] 转向（steer）在运行中生效，落在当前工具批次之后（并即时 claim，不重复投递）
- [x] followup 连发保持 FIFO，各自独立成 turn
- [x] 模型选择器显示 pi 模型并可切换（目录适配器 + `set_model` 转发）
- [x] token 计量采用 provider usage（`request/header` + `request/context`）
- [x] 关闭 DSH 后重新打开并 resume：pi 侧上下文完整（已用独立进程验证，跨 DSH 重启待 P4）
- [x] 在 pi 下跑过几轮再切回原生 loop 的会话可正常续接（header 需声明 DSH 工具表）
- [x] 无 `assistant/chunk`、无未知事件，日志可被持久化读路径正常加载
- [x] Windows 下 `piPath` 生效，无 EPERM（经 `cmd.exe /d /s /c` 启动 `pi.cmd`）

---

## 12. 2026-11-20 修补：对话框、思考档位、工具进度、启动路径

改动集中在四个"沉默失败"上——它们不报错，只是让 UI 状态与 pi 的实际行为分叉。

### 12.1 `extension_ui_request`（安全相关）

**之前**：`PiRpcClient#dispatch` 只认 `type: "response"`，其余全部丢进事件流；`PiAgent` 的 `#onPiEvent` 没有对应分支，记录被静默丢弃。pi 侧 `ctx.ui.confirm()` 于是等到自带 `timeout`，由**扩展作者写的默认值**收尾——通常就是"允许"。

**现在**：`rpc.js` 把该子协议分流到独立的 `ui` emitter，并提供 `respondUi(id, body)`；`agent.js` 的 `#onUiRequest` 对 4 个阻塞方法（`select`/`confirm`/`input`/`editor`）**一律应答**，默认 `{ cancelled: true }`；`notify` 等 fire-and-forget 方法只记日志。

实测（`.tmp-test/gate.ts`，一个在 `bash` 前 `ctx.ui.confirm()` 的扩展）：

| 观察项 | 结果 |
|---|---|
| `extension_ui_request` 是否到达 | 是，`method: "confirm"` |
| 插件是否应答 | 是，`{ cancelled: true }` |
| 工具是否被拦 | 是，`tool_execution_end` 结果含 `denied by host` |
| 是否还等 timeout | 否 |

配置 `extensionUi: 'allow'` 会把对话框按"确认/首项/空串"放行，仅供调试。

### 12.2 `set_thinking_level`

**之前**：`catalog.js` 把 `thinkingLevelMap` 翻译成 DSH 的 efforts，选择器能选档位，但 `#applyModel` 只发 `set_model`，档位从未下发。

**现在**：`#applyModel` 与工厂的初始路由都下发档位（初始路由串行：先 `set_model` 再 `set_thinking_level`）。

实测（deepseek-flash，levels = `off/low/high/max`）：

| 请求 | pi 实际 |
|---|---|
| `medium` | `high`（clamp） |
| `xhigh` | `max`（clamp） |
| `bogus` | `off`，且 `success: true` |

最后一行是关键：pi 对未知档位**静默落到 `off`**，等于悄悄关掉推理。因此 `setThinkingLevel` 在本地按 `off/minimal/low/medium/high/xhigh/max` 校验后才下发，并通过 `get_state` 读回实际生效值。

另：`thinking_level_changed` 事件只在扩展或 UI 改动时发出，**RPC 设置不会触发**，所以确认路径必须是 `get_state`。

### 12.3 `tool_execution_update`

DSH 没有"工具进度"这层事件：它自己的 bash 通过 job registry（`job.list` / `job.follow`）向 Web 端流式输出，而向会话日志追加半成品 `tool/result` 会同时污染回放与模型历史。

因此实现为：内存中按 `toolCallId` 保留最近 8KB 预览；`toolProgress: true` 时发 `agent/tool-progress` 实时通知（未知通知对客户端无害，会话日志不写）；`tool_execution_end` 时清理。

实测：`for i in 1 2 3 4; do echo tick$i; sleep 1; done` → 收到 2 次 update，第二次 `partialResult` 为 `tick1\n`。

真正的 UI 渲染需要 DSH 侧提供通道（把 pi 的工具注册成 job 的 pull source 是最贴近现有架构的做法），这条留作后续。

### 12.4 启动路径

`probeModels` 会起一个完整 pi 子进程；Windows 上数秒。它原来在 `apply()` 里 `await`，直接拖慢 `dsh web` 启动。

现在：先 `setFactory`（会话立即可用），目录探测在后台完成后再 `registerAdapter`（注册仍属于本插件 fiber，卸载时一并释放）。

### 12.5 Agent Team 是否可用

**当前不可用**，原因是工具表归属：

- `dsh-agent-team` 本身只提供 durable 任务板（compare-and-set 领取）；teammate 由 `dsh-tool-subagent` / `dsh-tool-subagent-control` 注册的**模型工具**（`subagent`、`subagent_fork`、`send_message`、`list_agents`、`interrupt_agent`）创建。
- 任务板的 4 个 schema 与"共享任务"指引也由 DSH 侧工具注册与 prompt provider 提供。
- pi 会话里，模型工具表来自 pi 子进程；`toolSchemas()` 只用于写入 `request/header`（为了让原生 loop 能续接），**并不下发给 pi**。prompt provider 同理不参与。

所以勾选"启用 Agent Team"只会写一条 `team/mode`，模型侧行为不变。

可行的接通方式（两条都要做）：

1. 把 DSH 工具表通过 **MCP** 暴露给 pi（pi 支持 stdio MCP：`pi mcp add ...`、`~/.pi/agent/mcp.json`，或 `-e builtin:mcp`）。插件持有 `ctx.tools`，包一个 stdio MCP server 即可，工具调用回落到 DSH 执行器——顺带把沙箱、审批、jobs 全部接通。
2. 把 team 的指引文本拼进 `prompt`（pi 自带系统提示词，DSH 的 prompt section 不会进去）。

子 agent 侧本身没有障碍：`dsh-subagent-spawn-in-process` 明确说明它"shares this process and its agent factory"，而本插件已按 `parentAgent` 与 `meta.origin === 'subagent'` 处理创建，因此每个 teammate 会自然变成独立的 pi 子进程。

---

## 13. DSH 工具 → pi：MCP 桥（2026-11-20）

§12.5 说"Agent Team 不可用是因为 pi 看不到 DSH 的工具表"。这一节记录接通方式与实测。

### 13.1 为什么必须有桥

pi 子进程是独立进程树，拿不到 `ctx.tools`；而 DSH 的工具是模型工具，只在 DSH 自己的 loop 里注入。两侧都没有现成的跨进程工具通道，所以桥必须自己做。pi 侧的唯一入口是 MCP。

### 13.2 结构

```
pi 子进程
  └─ pi 扩展（-e src/bridge/pi-extension.js）
        └─ pi.registerMcpServer('dsh', { command: node, args: [mcp-server.mjs], exposure: 'direct', env })
              └─ mcp-server.mjs（stdio MCP, JSON-RPC 2.0 换行分帧）
                    └─ HTTP 127.0.0.1:<临时端口> + 会话级一次性 token
                          └─ 插件内 DshToolBridge（src/bridge/server.js）
                                └─ ctx.tools.resolve / schemas / executable / execute
```

- token 在 spawn 前绑定（`bridge.bind()` → env），agent 构造后回填（`box.agent = agent`）。工具调用只可能发生在 prompt 之后，因此回填一定早于首次调用。
- 服务只监听 `127.0.0.1`，端口由系统分配；token 24 字节随机，随插件卸载/agent dispose 失效。
- 对外只有两个端点：`POST /tools`、`POST /call`。

### 13.3 关键决策：execute 不带 log

`ctx.tools.execute({ calls, signal, agent, toolSet })` **不传 `log`** 时，executor 不写 root `tool/call` / `tool/result` 事件（`executor.d.ts` 明确："Without `log`, return one outcome per input call... omit those events"）。

这正是要的：pi 自己的 `tool_execution_start` / `tool_execution_end` 已经由 `agent.js` 翻译成 `tool/call` / `tool/result`，DSH 侧再写一遍就是双份记录，而且 resume 重建 pi 历史时会重复。

于是分工是：**DSH 负责策略与渲染，pi 负责记账。**

### 13.4 工具命名与暴露面

pi 把 MCP 工具注册为 `mcp__<server>__<tool>`，所以 DSH 的 `team_task_create` 在模型眼里是 `mcp__dsh__team_task_create`。

`dshTools` 是**白名单**，默认空（不启用）。理由：pi 自带 `bash`/`read`/`write`/`edit`，若整表暴露，模型会同时看到两套 bash，且 DSH 那套会绕开 pi 的工具管线。

`exposure: 'direct'` 是必需的：默认的 codemode 暴露会把每次调用包进生成的脚本，实测首次调用就因为生成脚本报 `SyntaxError: invalid redefinition of parameter name` 浪费一轮。

schema 转换直接用 `@deepseek-ai/dsh-tools` 的 `parameterSchemaSpecToJsonSchema`（DSH 参数 DSL 是每属性自带 `required: true` 的映射，MCP 要标准 `required` 数组），不要自己实现——已有官方实现，重复实现必然漂移。

### 13.5 实测

`scripts/bridge-e2e.mjs`：挂 `systemPrompt` + `tools` + `native-tool-executor`，注册一个 `board_create` 工具，用 `dshTools: ['board_create']` 起插件，让 pi 调用它。

| 观察项 | 结果 |
|---|---|
| 扩展是否加载 | 是（`-e`，纯 ESM `.js`；用 `.ts` 时若解析失败 pi 直接 exit 1，整会话挂掉） |
| `tools/list` | 返回 `board_create`，`inputSchema.required = ["title"]` |
| 模型看到的工具名 | `mcp__dsh__board_create` |
| `tools/call` | DSH 侧 `execute` 被调用 1 次 |
| 会话记录 | 只有 1 条 `tool/call` + 1 条 `tool/result`（无重复） |
| 模型收到的结果 | `board task: from pi` |

另外两点实测细节：

- **`ToolBatchResult.results[i]` 是 `{ callId, result }`**，`outcome` 嵌在 `result` 里。第一版按扁平结构读，导致返回空内容而 `isError: false`——空结果比报错更难发现。
- `tools` 服务 `inject: ['systemPrompt']`。最小测试环境要挂 `@deepseek-ai/dsh-system-prompt`，否则 `ctx.get('tools')` 永远是 `undefined`。

### 13.6 仍未接通

1. **pi 自带工具不受 DSH 策略管**。要管，得反过来把 pi 的 bash 关掉、只留桥过来的 DSH bash —— 那会改变 pi 的工具语义（后台 job、spill、终端卡片），属于另一个决策。
2. **DSH 的 prompt section 进不了 pi**。team 的"共享任务板怎么用"指引、plan-mode 旁白都属于这类。要么拼进 prompt，要么做成 pi 扩展的 `before_agent_start` 注入。
3. **审批**仍需要 pi 侧的 `tool_call` 守卫扩展 + 本插件的对话框桥（§12.1 已具备应答能力，缺的是把 `confirm` 接到 DSH 的人工审批 UI）。

---

## 14. 审批网关：让 DSH 的权限预设管住 pi 自己的工具（2026-11-20）

§13.6 剩下的第 3 条。这一节记录接通方式、实测，以及一个必须处理好的语义陷阱。

### 14.1 为什么不能用 pi 的 `--approve`

pi 根本没有逐工具审批（`docs/security.md` 明说它不逐个工具征求同意）。唯一能拦的钩子是扩展的 `tool_call`：它在工具执行前触发，可以返回 `{ block: true, reason }`。

### 14.2 链路

```
pi 的 tool_call 钩子（src/guard/guard-extension.js）
  └─ ctx.ui.confirm(title, "tool: bash\n<command>")
        └─ extension_ui_request（§12.1 已具备应答通道）
              └─ 插件 #askApproval → ctx.approval.request({ agent, toolName, reason, signal })
                    └─ approval/request 瀑布 → dsh-client-ui-approval（浏览器卡片）
                          └─ allowed-once / rejected / cancelled / unavailable
                                └─ respondUi({ confirmed: outcome === 'allowed-once' })
                                      └─ pi 放行或被 block
```

两侧都随本包发布，因此用一个显式约定传结构化信息：`confirm` 的 `message` 首行是 `tool: <name>`，其余是给人看的细节。解析失败时插件仍会询问（用 `pi-tool` 作审计标签）——不解析就等于静默放行。

### 14.3 语义陷阱：`never` 不等于“拒绝”

`ApprovalService.request()` 在 `never` 策略下**确定性地返回 `rejected`**（不弹窗）。如果插件把这个 `rejected` 当成“人类说不”，那么默认预设 `danger-full-access`（approval = `never`）会把 pi 的每个 bash 都拦死——正好与预设的含义相反。

所以插件先读策略再问：

```js
if (approval.overrideOf(session) === 'never') → respondUi({ confirmed: true })   // 不问，放行
else → approval.request(...)                                                     // ask：问人
```

`overrideOf()` 读的是会话初始化时由 `setApprovalPolicy` 写入的 `approval/policy` 覆盖；预设切换会写同名事件，因此切换预设即时生效。

### 14.4 失败一律关闭

| 情况 | 结果 |
|---|---|
| 部署没挂 `dsh-user-approval` | `confirmed: false`（工具被 block） |
| 有服务但没有回答者 | `unavailable` → `confirmed: false` |
| 等待超过 `approvalTimeoutMs`（默认 300s） | signal 中止 → `cancelled` → `confirmed: false` |
| `approval.request` 抛错 | `confirmed: false` |

pi 侧同样 fail closed：`ctx.ui.confirm()` 返回 `undefined`（超时/取消/未应答）不等于 `true`，于是 `{ block: true }`。

### 14.5 实测

`scripts/approval-e2e.mjs`：最小服务栈 + 一个按剧本作答的 `approval` 桩，`extensionUi: 'approval'`、`guard: ['bash']`，让 pi 跑 `echo hi > marker.txt`，用文件是否存在判定命令有没有真的跑。

| 场景 | 审批被问 | 命令执行 | 模型看到的 |
|---|---|---|---|
| 回答 `rejected` | 1 次 | 否（marker 不存在） | 工具结果 `isError: true` |
| 回答 `allowed-once` | 1 次 | 是 | 正常结果 |
| 会话策略 `never` | **0 次** | 是 | 正常结果 |

同时验证了问题里带上了工具名（`bash`）和命令细节（用于审计的 `reason`）。

### 14.6 仍未覆盖

1. **`read` 类工具没有拦**（默认列表只有 `bash`/`write`/`edit`）。读操作一般不需要审批，需要时把 `guard` 写成数组即可。
2. **`mcp__dsh__*` 工具不需要这条链路**：它们本来就经 `ctx.tools.execute`，DSH 的策略在那一侧生效。
3. **pi 的 `bash` 仍然不是 DSH 的 bash**：审批能拦住它，但沙箱模式、后台 job、spill、终端卡片这些仍是 pi 自己的语义。要统一就得关掉 pi 的 bash、只留桥过来的 DSH bash（见 §13.6 第 1 条）。
