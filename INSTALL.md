# 安装与验证

本目录是 [simonzls123/dsh-inline-pi-agent](https://github.com/simonzls123/dsh-inline-pi-agent)
某次提交的**原样副本**（pin 的 commit 见 [PROVENANCE.md](PROVENANCE.md)），随仓库分发，
不再从浮动 git specifier 安装。安装包用 `npm pack` 生成在 `../plugins/`。

这个 bundle 把 DSH 的 `agent-loop` 换成无头 `pi --mode rpc` 子进程：会话、Web UI、
权限界面仍由 DSH 提供，推理与工具执行交给 pi。

## 安装

```sh
# 打包（版本号变化时同步更新文件名）
cd integrations/dsh-inline-pi-agent
npm pack --pack-destination ../plugins

# 装进某个 profile（用 DSH 自带的 pnpm 最稳）
pnpm add "file:/绝对路径/integrations/plugins/dsh-inline-pi-agent-0.2.0.tgz"
```

`package.json` 需要两处：`dependencies` 指向 tarball，
`dsh.profile.bundles` 末尾加上 `dsh-inline-pi-agent`。bundle 自带的
[cordis.patch.yml](cordis.patch.yml) 负责禁用 `agent-loop`、DSH 侧压缩与工具裁剪，
并插入 `pi-agent` 行——profile 不需要手写这些。

profile 的 `cordis.patch.yml` 只补路由映射：

```yaml
- id: pi-agent
  name: "dsh-inline-pi-agent"
  config:
    models:
      deepseek-official/deepseek-flash: deepseek/deepseek-flash
```

pi 的 catalog 路由是**只读显示**，真正跑推理的是 pi 自己的 provider 名，所以 DSH 默认
路由必须映射过去；不写映射时 pi 会收到一个它不认识的 `provider/model`，`set_model` 失败。

要求：`pi` 在 PATH 上（或用 `piPath` 指绝对路径），pi 侧已配置 provider 凭据
（`~/.pi/agent/auth.json`）。改完 profile 需重启 `dsh web` / 桌面 App。

## 容量与空闲回收

每个会话占一个 `pi --mode rpc` 子进程（实测 RSS 约 160MB），会话不释放就一直占着。
两个开关把它变成可管理的资源：

```yaml
- id: pi-agent
  name: "dsh-inline-pi-agent"
  config:
    maxSessions: 8          # 超出时先回收空闲会话，仍满则创建失败并说明原因
    idleReclaimMs: 1200000  # 20 分钟无活动就释放；重新打开会话即 resume
```

两者默认关闭（`0`）。判定「可回收」的条件：状态 idle、无 driver、无排队输入、
无未闭合的 step/turn、无待审批请求 —— 这些工作无法靠重放日志恢复，绝不回收。

## 验证

```sh
cd <profile 目录>
node node_modules/dsh-inline-pi-agent/scripts/smoke.mjs text     # → SMOKE_OK
node node_modules/dsh-inline-pi-agent/scripts/smoke.mjs tool     # pi 调 read 工具并复述内容
node node_modules/dsh-inline-pi-agent/scripts/smoke.mjs resume   # dispose 后 resume 仍记得上下文
node node_modules/dsh-inline-pi-agent/scripts/compaction-e2e.mjs # → RESULT: PASS
node node_modules/dsh-inline-pi-agent/scripts/limits-e2e.mjs     # 启动失败/容量/空闲回收 → RESULT: PASS
node node_modules/dsh-inline-pi-agent/scripts/attachments-e2e.mjs  # 附件（file/image）投影 → RESULT: PASS
```

`attachments-e2e.mjs` 覆盖附件投影：`file` 块必须变成句柄文字进 prompt（live）、
重建 pi 会话后仍在（replay）、运行中 steer 也带上（steer）、拿不到可读路径时仍描述该文件
（fallback）。`file` 块被丢弃时，模型会回答「没有附件」——这是最容易被误判成模型问题的坑。

`limits-e2e.mjs` 的三个用例：不存在的 `piPath` 与立即退出的 `pi` 都必须给出
「pi 起不来」而不是流错误、且派发 `agent/error`；`maxSessions=1` 时第二个会话被拒绝
且提示可操作；`idleReclaimMs` 到期后会话被释放、再 resume 仍记得上下文。

`smoke.mjs` 直接用 pi 的路由名建会话，**绕过了 profile 的映射**。线上走映射路径时，
还要确认网页里新建的会话（默认 `deepseek-official/...`）确实由 pi 回答：
`assistant/message` 的 `source` 应为 pi 的 `deepseek/deepseek-flash`。

## 已知边界

- pi 自己执行工具，DSH 的沙箱与权限预设不作用于这些工具。要恢复约束，配 `guard`
  （`bash`/`write`/`edit` 走 DSH 审批）或 `dshTools`（把 DSH 工具经 MCP 暴露给 pi）。
- 插件不派发 `agent/pre-step`，依赖它的钩子（时间注入、每步 flush、plan-mode 旁白）不生效。
- `contextBreakdown.toolsTokens` 描述的是 DSH 工具注册表，不是 pi 的工具块。
- 重装 profile 会重建 `node_modules`，`file:` 依赖会重新解包——这是预期行为；不要直接改
  `node_modules` 里的副本，改动要落在本目录再重新打包。
