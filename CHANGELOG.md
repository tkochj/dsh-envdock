# Changelog

本文件记录 EnvDock 的重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。


## [0.3.0] - 2026-11-07

### Added

- 认得 dsh-ops 的 `ops_bash`（cordis 模式下顶替官方 shell）：按 bash 家族参与接管判定，不再被漏认成「两个命令工具并列」，`shippedShell` 也不会一直是空。
- 事件驱动对账：监听 `tools/change`，同一轮变更用 40 ms 合并定时器归并；5 秒 tick 保留为兜底。
- 拒绝守卫 `tools.guard`：被藏掉的宿主 shell 被直呼时给一条可操作的拒绝（改用 `envd_shell`、语法见简报），不再掉成 `UNKNOWN_TOOL`；我们的工具在该作用域不可执行时守卫放行。
- 拒绝守卫反向补齐：让路 / 沙箱会话里 `envd_shell` 被藏后仍被直呼时，拒绝文案会指出改用宿主自带的那个命令工具（`kind` 取自 `commandTool.scopes`，说清是「沙箱围栏」还是「宿主 shell 作用域私有」）；宿主工具在该作用域不可见时守卫仍放行。
- 可执行面优先：有 `tools.executable(name, agent)` 时用它判「这一单能不能调」，旧宿主没有该方法才回落 `tools.get`。
- `/envdock-api` 的 `commandTool` 增加 `scopes`：逐会话给出命令工具终局——`kind`（`takeover` / `host` / `yield` / `sandbox-host`）、`tool`、`visible`（该作用域的可执行口径）、`hidden`（实际生效的遮挡）、`hidesOwn`、`confined`、`mode`。终局以实际生效的账本为准，不拿计划意图充数。
- `syncStats` 增加三个计数：`delegateCalls`（围栏下真正委托宿主执行器执行的次数）、`guardDenials`（拒绝守卫命中次数）、`yieldTicks`（计划里含让路作用域的 tick 数）；稳态时 `yieldTicks` 跟着 tick 涨、注册表动作不涨才是对的。
- README / README.en.md 的 FAQ：命令工具的三种终局、「N 个会话用宿主工具」的含义、沙箱会话为什么没有 `envd_shell`。

### Changed

- 归属判定改为登记身份（`tools.get(name) === 我注册的那个定义对象`）：同名工具被别的层盖住时，名字还在不代表还是我们的，不会被误判成「已接管」去遮挡宿主。
- 面板头部不再只凭全局可见性挂「模型可见」：存在非直连接管的会话时改挂 warn 汇总 badge「N 个会话用宿主工具」，逐会话的 id 前 8 位、终局与实际工具名（含接管诊断）收进悬停说明；纯直连接管时保持原来的 ok badge。
- `/envdock-api` 的 `brief` 不再对「本会话」下结论（API 没有会话）：部署默认档之后改为「各会话有效策略见 scopes」，不再输出「本会话策略未知」。
- 接管诊断新增「委托 / 守卫拒绝 / 让路轮次」三项计数。

### Fixed

- 测试夹具补上 `tools.executable`：覆盖「`get` 有、`executable` 无」的 ptc 折叠口径，接管就绪判定不再只看注册表视图。
- README 的「沙箱下接管」说明改为与实现一致：`委托执行` 只在 `envd_shell` 还没从围栏会话的工具表里摘掉时生效，它不是「围栏下也能用 EnvDock 终端」的开关。

## [0.2.0] - 2026-11-07

### Added

- 逐作用域计划：无围栏的会话藏宿主 shell、保留 `envd_shell`；被围栏的会话反过来藏 `envd_shell`、保留宿主 shell。两份掩码互斥，任何会话都不会零命令工具。
- 围栏下「委托执行」（默认）：命令经带围栏的宿主 `ctx.shell` 执行（`resolve` + `execute`，命令走 `ENVD_CMD` 环境变量），`sandbox.denied` 如实回显给模型；「直接拒绝」保留旧行为。

### Changed

- 面板把「能力位 / 部署默认 / 本会话有效策略」三层分开显示。
- 简报按模型**实际拿到**的那个命令工具教语法：围栏会话教宿主 shell 的语法，接管会话教默认终端的语法。

### Fixed

- 沙箱按会话判策略，不再按部署默认档判：执行器公布的 `sandboxMode` 只是部署默认档，真实策略逐会话问 `sandboxPolicy.resolve({ session })`。`danger-full-access` 的会话不再被谎报成 `workspace-write`，接管也不会被永久锁死。

## [0.1.0] - 2026-11-07

首个版本。

### Added

- 工具链探测：node、npm、pnpm、yarn、bun、deno、python、pip、uv、git、conda，列出全部候选路径与版本。
- 版本管理器探测：nvm-windows、pyenv-win、conda、fnm、mise 解析已装版本（前四还解析激活项）；Volta、asdf 只报「在场」。
- 默认版本一键切换；环境简报注入运行上下文；红 / 黄 / 灰三档健康检查。
- 可选的终端接管：默认终端与宿主命令工具不同族时，注册固定名字的 `envd_shell` 并遮挡宿主 shell。
- `envd` 工具（`summary` / `resolve` / `check` / `set_default`）与 `/envdock-api` 面板接口（默认只放行 loopback，可显式允许局域网访问）。
- 侧边栏面板：默认终端、工具链、版本管理器、健康检查、简报预览、重新探测、选项（含自定义终端与自定义工具）。
