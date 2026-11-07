# Changelog

本文件记录 EnvDock 的重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.0] - 2026-11-07

### Added

- **逐会话命令工具事实** `commandTool.scopes`：`kind`（`takeover` / `host` / `yield` / `sandbox-host`）+ `tool` / `hostTool` / `hostTools` / `ownVisible` / `hideOwnPlanned` / `visible` / `hidden` / `leaked` / `hidesOwn` / `confined` / `mode` / `anomaly`。事实按「此刻实际能不能用」推导（现测 `envd_shell` 与每个候选宿主 shell 在该作用域可见性），实际生效的遮挡以复读为准，不拿计划意图充数；`anomaly` 标出「零命令工具 / 接管下宿主仍可见 / 挡了却仍可见」。
- **动态识别宿主命令工具**：宿主提供 `tools.definitions` 时枚举定义，按名字里的家族 token（`ops_bash`、`tenant_*` 等）和「描述提到 bash / PowerShell / cmd / WSL 且参数里有 `command`」认出宿主命令工具，再按家族参与接管判定；认出的名字进运行态（`runtimeShellTools` / `learnedShells`），遮挡之后仍记得。认得出工具、认不出家族时**让路**，不猜语法。
- **事件驱动对账**：监听 `tools/change`，同一轮变更用 40 ms 合并定时器归并，别的插件晚一步注册或撤销 shell 时立刻收敛；5 秒 tick 保留为兜底（旧宿主没有该事件时仍然正确）。对账期间置 `mutating` 标志，自己派发的 `tools/change` 不再触发下一轮。
- **可执行面优先**：宿主提供 `tools.executable(name, agent)` 时用它判「这一单能不能调」，否则回落 `tools.get`；`hasExecutableApi` 把宿主到底有没有这个能力写进诊断。
- **拒绝守卫双向**：宿主 shell 被藏 → 改 `envd_shell`；`envd_shell` 被藏（让路 / 沙箱让路）→ 指路该会话里真的可见的宿主工具，原因取自逐会话事实（沙箱围栏 / 宿主 shell 作用域私有）；事实还没生成时给「暂时无法判定」，不编造工具名。守卫判替代品用可执行面（宿主有 `tools.executable` 时）或可见性；判不出时给「暂时无法判定」或放行，两种情况都不编造工具名。
- **诊断计数补全**：`registerTries` / `delegateTries` / `delegateFailures` / `ownHides` / `hostDenyApplies` / `denyNoops` / `transientMisses` / `steadyNow` / `steadySinceAt` / `lastErrorAt` / `guardReady` / `guardError` / `runtimeShellTools` / `scopeAnomalies` / `executorFamily` / `executorFamilySource` / `hasExecutableApi`；`hostOnlyScopes` / `sandboxHiddenScopes` 改为从实际事实推导（不再用计划意图或 `hideOwn` 计数冒充）。
- **面板**：头部新增「N 个会话命令工具异常」badge；title 列出**全部**会话（id 前 8 位 · 终局 · 实际工具名，含挡掉 / 沙箱围栏 / 泄漏标注）与诊断计数；旧版 API（没有 `scopes`）在 title 里明确标注「旧版构建」，退回汇总计数并说明无法逐会话核对。
- **测试**：新增 `test/panel-render.mjs`（极简 React 运行时替身加载 `client.js`、遍历 `.envd-badge` 做面板渲染回归）；`npm test` 现在跑四个文件。`test/` 不在 npm 包内，`npm test` 只适用于源代码检出目录。
- README / README.en.md 的 FAQ 扩写：命令工具的四种终局、面板两种汇总 badge 的含义（含异常会话）、沙箱会话为什么没有 `envd_shell`（含「全部会话被围栏 → 不注册工具」）。

### Changed

- 归属判定改为登记身份（`tools.get(name) === 我注册的那个定义对象`）：同名工具被别的层盖住时，名字还在不代表还是我们的，不会被误判成「已接管」去遮挡宿主。
- 遮挡与「主宿主 shell」全部按**作用域**判定：每个会话只挡它自己真的见过、且挡得掉的宿主 shell；挡不掉或认不出家族的那个只要此刻还在，就藏 `envd_shell` 让路（同时仍挡住本作用域挡得掉的其它宿主 shell）。
- 委托执行的包装器改为按**宿主执行器**（`ctx.shell`）的语法族选择（`executorFamily`：先看执行器对象 / 类名，判不出按平台默认，win32 是 PowerShell、其余平台是 bash）；判成 cmd 时拒绝委托。命令经 `ENVD_CMD` 传入，`dshEnv` 透传。
- 面板头部 badge 优先级：异常（红）> 混合（黄「N 个会话用宿主工具」）> 全接管（绿「模型可见」）；混合数字从 `commandTool.scopes` 推导，不再用 `sandboxHiddenScopes` 之类汇总值凑数。
- 接管诊断用 `steadyNow`（本 tick 是否稳态）而不是累计的 `steadyTicks`；`lastError` 显示写入龄期，且每轮对账开始即清空——瞬时错误不再常驻面板。
- 简报按模型**实际拿到**的命令工具分支出话：直连接管 / 未接管（`host`）/ 让路 / 沙箱各一套文案；API 没有会话时注明「全局视图；逐会话终局见 `commandTool.scopes`」，不再对「本会话」下结论。
- 「让路」被当作正常终局：诊断条不再给它挂 ⚠（头部汇总已经表达）。

### Fixed

- `hideOwn` 诚实记账 + 自愈：只有真的推了 `restrict` 且复读确认不可见，才把「已藏」记进账本（`ownHides`）；`scopesSettled` 复检「计划要藏、此刻却可见」时重挂——围栏 / 让路会话里的 `envd_shell` 不会因为别的层放开遮挡而复活（那等于绕过沙箱）。
- `restrict` 成功返回后复读可见性：仍可见的名字进该作用域 `badNames` 并计 `denyNoops`，不记成「已挡」；整体 `restrict` 抛错时退化为逐个挡，能挡几个挡几个，并对诊断如实交代。
- 过渡性缺名不再判死：`restrict` 报 unknown、但此刻本来也看不见的名字进 30 秒重试窗口（`transientMisses`），不锁进 `badNames` 造成永久让路 / 永久「挡不掉」。
- 多宿主 shell 时不再出现 `envd_shell` 与宿主工具并列：旧实现用全局记忆算掩码，`mask` 一旦非空就跳过让路分支；旧构建的历史观测里确实出现过模型手里两个命令工具、简报却只说一个。现在按作用域逐个对账。
- 委托失败分阶段记账（解析 / 启动 / 执行），输出里标 `[sandbox]`；执行器 `runnerFailed` 不再伪装成「命令跑完但失败」（返回 `ok:false`）；缺本会话 policy、缺会话信息、执行器族不支持时直接拒绝，绝不拿部署默认档冒充。旧说法「按宿主工具名选包装器」已废弃——Windows 官方 base 的宿主执行器是 PowerShell，而模型手里的工具可能是 bash 家族的 `ops_bash`，按工具名选包装器会直接 ParserError。
- 守卫方向一改用该会话事实里的 `hostTool`，多宿主时不再拿全局 `shippedName` 静默放行成裸 `UNKNOWN_TOOL`。
- 文档与验证口径：不把旧构建的观测当成新版本的验证结论。此前的 6.5 分钟稳态观测来自**旧构建**（没有 `commandTool.scopes` 与新计数），只能算历史观测；新构建的运行时证据需要重启 dsh 后重新采集。

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
