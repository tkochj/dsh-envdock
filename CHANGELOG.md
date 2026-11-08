# Changelog

本文件记录 EnvDock 的重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-11-08

### Added

- **面板重做（一屏说完）**：常显只剩头部一行、置顶接管卡、工具链、底部一行。头部 = 插件名 · 默认终端与版本 · **恰好 1 个**状态 badge · 「重新探测」；接管卡 = `终端` chips → `命令` 行（状态词 + 实际命令工具名 + 一句会话计数 + 会话 / 设置 / 详情 三个 ghost）→ 每行一句的常显备注（旧版接口、挡不掉已让路 / 并存、N 个会话看不到 `envd_shell`、策略未知、N 个会话被围栏、最近错误）→ 设置（接管模式 3 chip + 沙箱下接管 2 chip，默认收起）→ 逐会话（**异常自动展开**，每行 id 前 8 位 · 终局 · 工具名 · 围栏 / 挡掉信息 · 原因）→ 已识别宿主工具 chips → 详情（对账计数，默认收起）。工具链改成**一行一个工具**（分组 / 名称 / 版本 / 路径可点复制 / 行尾「N 个版本 ▾」），版本管理器一行一个（激活版本带 ←），环境检查收成工具链末尾**一行**（`✓ 通过` 或 `⚠ N 项` + 第一条标题），环境简报默认一行（状态 / 复制 / 展开）。一屏（约 600px 可用高度）基本不滚动。
- **新终局「工具并存」**：拿不到逐会话事实时（旧版 `/envdock-api`），宿主工具挡不掉且 `envd_shell` 可见 → 面板挂黄色「工具并存」并在命令行列出两个工具名（`envd_shell · ops_bash`），不谎报「接管中」、也不说成「让路」（EnvDock 的工具还看得见）。`commandTool.denies`（实际生效的遮挡）会出现在备注里（例如「envd_shell 不可见，已遮挡 bash, pwsh」），不再只有汇总数字。
- **可复用测试基础设施**：新增 `test/fixture/host.mjs`（假 Cordis 服务 + 真实 `index.js` 的共享宿主夹具，`host-harness` / `simulate` 共用）与 `test/simulate.mjs`（起假宿主、打印 `/envdock-api` 快照；`--mode` / `--host-tools` / `--unrestrictable` / `--delegate` 等参数复现让路、并存、委托场景）。`test/panel-render.mjs` 从 97 条断言扩展到 **194 条**，覆盖单 badge、常显备注、折叠触发词、异常自动展开、一行一个工具、环境检查一行、轮询去重与复制兜底。

### Changed

- **GET 探测过期改为 stale-while-revalidate**：探测缓存只是「过了 45s TTL」（没有被显式作废）时，GET 先端上一份快照、后台再刷新——面板每 15s 轮询、每第 3 次都会正好撞上过期，干等一次全量探测（PATH 重扫 + `reg.exe`）没有意义。显式作废（切终端 / 改选项 / `refresh`）仍然同步等新探测，语义不变。
- **同一 tick 的探针去重（两轮）**：①候选名单每 tick 只算一次，全局注册面用**一次** `tools.definitions()` 取代逐名 `hasTool`（老宿主没有该能力时回退逐名探），`liveHostNames` 复用同 tick 的快照，`envd_shell` 的「可见 / 是不是我们这一份」每 tick 每作用域只问一次（`visDirty` / `ownEpoch` 失效口径）；②稳态 tick 直接信任同 tick 的 `definitions` 快照（每 12 个 tick ≈ 60 秒强制逐名兜底一次；`definitions` 抛错不落快照）。实测探针次数：1/2/4 作用域 **34 / 57 / 103 → 6.7 / 10.3 / 17.6 次每 tick（-80% ~ -83%）**，让路与围栏会话 29 → 4.7（-84%），老宿主按设计回退、无退化；6 场景 × 约 325 个稳态 tick 的 `registers` / `disposes` / `denyApplies` 全程 +0，`/envdock-api` 载荷逐字节不变。
- **委托计数拆细**：`delegateCalls` 只在命令真的执行时 +1；新增 `delegateRunnerFailures`（执行器接了活但围栏 runner 坏了、命令没执行）与 `delegateAborts`（命令被取消），三种结局分开记账，不再把「没走过委托」与「runner 挂了」混成一个 0。
- **PowerShell 委托目标改走数据通道**：由 `-EncodedCommand` 改为 `-NoProfile -NonInteractive -Command`，脚本从 `$env:ENVD_CMD` 解 UTF-8 base64 再 `Invoke-Expression`，并固定 `[Console]::OutputEncoding` 为 UTF-8（非 65001 代码页下不乱码）。命令依旧不进命令行。
- **结构性挡不掉与临时性挡不掉分开处理**：作用域私有注册（`restrict` 的 `restrictableNames` 只含继承面，契约原文 "do not affect scoped registrations"）给 10 分钟 TTL、**不写 `lastError`**，不再每 30 秒刷一次红；publication reentry / 热重载空窗仍 30 秒重试并如实记错误。
- **`commandTool.hostName` 取真实宿主工具**：优先用逐会话事实里 `hostTools` 的并集（只有一个名字时就是它），dsh-ops 场景报 `ops_bash`，不再误报 `pwsh`；拿不到逐会话事实才退回 shippedName。

### Fixed

- **DNS rebinding 防护**：回环来源必须配**回环 Host 字面量**（`127.0.0.0/8` / `localhost` / `::1`），`Host` 为空或非回环一律 403——只比较「Origin 与 Host 一致」会放行「攻击者域名重新解析到 127.0.0.1」的跨站写（写接口能改自定义终端 argv ≈ 本机代码执行）。读与写都覆盖。
- **严格同源**：写请求要求 `Origin.host:port === Host`（不只是回环）、`Content-Type` 含 `application/json`（否则跨源 simple POST 免预检就能打进来）、`sec-fetch-site: cross-site` 一律 403；没有 `Origin` 却带 `Sec-Fetch-Site` 的按非面板处理。
- **bash 委托目标内层去掉 `-l`**：外层 `-lc` 已经是登录 shell，内层再 `-l` 会让 profile 跑第二遍（重复的 PATH 拼接与 rc 副作用），改为 `printf %s $ENVD_CMD | base64 -d | bash -s`。
- **`familyOf` 大小写不敏感**：学到的家族按原名与 lowercase 各查一次，内置表按小写查，工具名大小写混用时不漏认。
- **`denyScopes` 去掉死参数**：`candidates` 形参从来没被读过（挡不掉的名单改由每个作用域自己记 `badNames` / `hardNames`），一并删掉，遮挡路径只读真实计划与作用域账本。
- **旧版接口的简报不再谎报「已接管」**：拿不到逐会话事实时按汇总事实说真话，挡不掉 / 不可见时说清，不写死「EnvDock 已接管」。
- **面板**：异常会话自动展开（不再被折叠藏住、也没有「还有 N 个」这种二次折叠）；健康检查收成一行，红 / 黄 / 灰不再堆在常显区；状态 badge 与卡片状态词始终是同一句结论。
- **委托执行的 stdin 与空载荷（第二轮审校）**：bash 目标的脚本改成 `[ -n "$ENVD_CMD" ] || exit 127; printf %s "$ENVD_CMD" | base64 -d | bash -s < /dev/null`——载荷缺失不再静默 `exit 0`，`read` / `cat` 也不会把 stdin 上的**脚本本身**吃掉（直跑路径的 stdin 是 ignore，语义对齐）；PowerShell 目标同样在 `$c` 为空时 `exit 127`。
- **切终端立即生效**：`envd_shell` 每次执行都按 `readState()` + 缓存探测现算终端，不再依赖下一轮对账才更新的 `activeShell`——以前 `setShell` 之后最多 5 秒内简报写的是新终端、命令却还按旧终端跑。
- **无主 deny 不再静默**：`restrict` 有可能**先落地再抛错**（publication reentry），deny 生效、撤销句柄却丢了。现在按「调用前可见 / 调用后不可见」识别这种路径，记进 `syncStats.lostDenies`、写 `lastError`、面板备注点名并提示重启 dsh 才能恢复；`restrict` 返回非函数时也不再当 disposer 塞进列表（teardown 不会炸）。
- **Host / Content-Type 判定修正**：`localhost.`（尾点）与 `[::ffff:127.0.0.1]`（IPv4-mapped IPv6）不再被误杀 403；`Content-Type` 按媒体类型精确匹配（`text/plain;application/json` 这种子串不再放行）；局域网「关开关」例外也要求 `Origin` 的 host:port 与 `Host` 完全一致；`addCustomTool` 的 `key` 拒绝 `__proto__` / `constructor` / `prototype` 并限制长度。
- **面板（第二轮审校）**：会话 id 先去掉 `session-` 前缀再截 8 位（真机 `session-<uuid>` 以前每行都显示 `session-`，完整 id 进 title）；`host` + 确定被围栏的会话行显示「沙箱」而不是「未接管」（与聚合口径一致）；混合 badge 文案改成「N 个会话用宿主工具」（非 takeover 的会话可能是让路 / 沙箱，不写成「未接管」）；已有数据时手动刷新失败也会显示错误框（以前只有没数据时才渲染）；窄屏（<560px）工具行不再让版本号与动作列叠在同一格；`reuse` 且没有工具名时不再补一句「没探测到命令工具」；会话计数不会再留下尾随的 ` · `。

## [0.3.0] - 2026-11-08

### Added

- **面板重做（简洁 + 接管可视化）**：头部压成一行、只挂 1 个状态 badge（异常红 / 混合黄 / 直连接管绿 / 未接管灰）；置顶「命令工具 / 接管」卡片 = 终端 chips + 状态行（状态词 / 当前命令工具名 / 执行器族 / 接管模式 chips / 沙箱下接管 chips）+ 逐会话行（id 前 8 位 · 终局 · 实际工具名，异常行红色并在行尾给原因，异常会话优先展示，最多 5 行、其余折叠成「还有 N 个」）+ 已识别宿主命令工具 chips（`名字 · 家族`，启发式认出的带标记）+ 可折叠诊断；工具链路径点击即复制、多版本折叠；健康检查与环境简报默认折叠；底部两个开关。面板只在 `web` profile 注册。
- **自动刷新**：面板每 15 秒静默拉一次 `/envdock-api`，只在页面可见时拉；比较 payload 前剔除易变计数（`ticks` / `steadyTicks` / `steadySinceAt` / `lastAt` / `lastErrorAt` 等），事实没变就不重渲染，卸载时清定时器。
- **剪贴板兜底**：安全上下文走 `navigator.clipboard`，局域网 http 退到 `textarea + execCommand('copy')`，两条都失败给可见提示；复制反馈挂 `aria-live`。
- `syncStats` 增加 `detections`（探测次数）/ `lastDetectMs`（最近一次探测耗时）/ `steadyPrev`（上一轮是否稳态）。
- 委托计数细化：新增 `delegateRefusals`（目标终端 / 执行器不支持时 +1）；`delegateTries` 在进入委托路径时就 +1，`delegateCalls` 只在拿到合法执行结果后 +1；面板诊断里能直接看到「委托拒绝」。
- **逐会话命令工具事实** `commandTool.scopes`：`kind`（`takeover` / `host` / `yield` / `sandbox-host`）+ `tool` / `hostTool` / `hostTools` / `ownVisible` / `hideOwnPlanned` / `visible` / `hidden` / `leaked` / `hidesOwn` / `confined` / `mode` / `anomaly`。事实按「此刻实际能不能用」推导（现测 `envd_shell` 与每个候选宿主 shell 在该作用域可见性），实际生效的遮挡以复读为准，不拿计划意图充数；`anomaly` 标出「零命令工具 / 接管下宿主仍可见 / 挡了却仍可见」。
- **动态识别宿主命令工具**：宿主提供 `tools.definitions` 时枚举定义，按名字里的家族 token（`ops_bash`、`tenant_*` 等）和「描述提到 bash / PowerShell / cmd / WSL 且参数里有 command 类字段（`command` / `cmd` / `script` / `commandline`）」认出宿主命令工具，再按家族参与接管判定；认出的名字进运行态（`runtimeShellTools` / `learnedShells`），遮挡之后仍记得。认得出工具、认不出家族时**让路**，不猜语法。
- **事件驱动对账**：监听 `tools/change`，同一轮变更用 40 ms 合并定时器归并，别的插件晚一步注册或撤销 shell 时立刻收敛；5 秒 tick 保留为兜底（旧宿主没有该事件时仍然正确）。对账期间置 `mutating` 标志，自己派发的 `tools/change` 不再触发下一轮。
- **可执行面优先**：宿主提供 `tools.executable(name, agent)` 时用它判「这一单能不能调」，否则回落 `tools.get`；`hasExecutableApi` 把宿主到底有没有这个能力写进诊断。
- **拒绝守卫双向**：宿主 shell 被藏 → 改 `envd_shell`；`envd_shell` 被藏（让路 / 沙箱让路）→ 指路该会话里真的可见的宿主工具，原因取自逐会话事实（沙箱围栏 / 宿主 shell 作用域私有）；事实还没生成时给「暂时无法判定」，不编造工具名。守卫判替代品用可执行面（宿主有 `tools.executable` 时）或可见性；判不出时给「暂时无法判定」或放行，两种情况都不编造工具名。
- **诊断计数补全**：`registerTries` / `delegateTries` / `delegateFailures` / `ownHides` / `hostDenyApplies` / `denyNoops` / `transientMisses` / `steadyNow` / `steadySinceAt` / `lastErrorAt` / `guardReady` / `guardError` / `runtimeShellTools` / `scopeAnomalies` / `executorFamily` / `executorFamilySource` / `hasExecutableApi`；`hostOnlyScopes` / `sandboxHiddenScopes` 改为从实际事实推导（不再用计划意图或 `hideOwn` 计数冒充）。
- **面板**：头部新增「N 个会话命令工具异常」badge；title 列出**全部**会话（id 前 8 位 · 终局 · 实际工具名，含挡掉 / 沙箱围栏 / 泄漏标注）与常用计数；旧版 API（没有 `scopes`）在 title 里明确标注「旧版构建」，退回汇总计数并说明无法逐会话核对。
- **测试**：新增 `test/panel-render.mjs`（极简 React 运行时替身加载 `client.js`、遍历 `.envd-badge` 做面板渲染回归）；`npm test` 现在跑四个文件。`test/` 不在 npm 包内，`npm test` 只适用于源代码检出目录。
- README / README.en.md 的 FAQ 扩写：命令工具的四种终局、面板两种汇总 badge 的含义（含异常会话）、沙箱会话为什么没有 `envd_shell`（含「全部会话被围栏 → 不注册工具」）。

### Changed

- 归属判定改为登记身份（`tools.get(name) === 我注册的那个定义对象`）：同名工具被别的层盖住时，名字还在不代表还是我们的，不会被误判成「已接管」去遮挡宿主。
- **局域网访问改为只读**：打开「允许局域网访问」后局域网只能 GET 面板数据；所有写操作（切终端、改默认版本、加自定义工具 / 终端 argv、改选项）都只允许本机，唯一例外是同源页面把该开关**关掉**（`Origin` 必须与 `Host` 一致）。理由：写操作能改默认终端 argv，等于把命令注入面开到整个局域网。
- 面板 badge 语义：全部会话都「未接管」时灰「未接管」、全部围栏时灰「沙箱」，不再用黄色混合告警；「N 个会话用宿主工具」只在真混合（部分接管 + 部分未接管）时出现；数字来自 `commandTool.scopes`（旧版 API 才回退到「约 N 个」，并把 `hostOnlyScopes` 与 `sandboxHiddenScopes` 相加）。
- `commandTool.scopes` 增加 `confined` 三态（true / false / null = 策略不可知）、`policyKnown`、`ownNameVisible` / `ownOurs`；`sandbox.scopes` 同步三态，`sandboxBlocked` 改为「没有任何会话**确认**无围栏」。策略不可知按有围栏保守处理：藏 `envd_shell`、留宿主工具，绝不拿部署默认档冒充。
- 宿主 shell 判定加「活证」：必须此刻可见（或仍在我们的遮挡里）才算存在；从没见过宿主时给约 60 秒宽限，见过之后又消失则接管兜底。作用域内挡不掉的名字改为带约 30 秒过期的 `badNames`，到期自动重试。
- 动态识别收紧：必须同时有 command 类参数（`command` / `cmd` / `script` / `commandline`）才认，名字里带 `cmd` 不再足够（`run_cmd`、`wc_cmd_palette` 不会被误认成宿主 shell）；`runtimeShellTools` 只报真的见过的名字，不再把 8 个内置候选说成「已识别」。
- 委托执行：执行器族判不出时按平台默认（win32 = PowerShell）并标注来源；判成 cmd、执行器不存在、没有会话信息、或拿不到本会话 policy 时拒绝委托。
- **委托执行支持矩阵收紧（安全）**：只有 **bash / PowerShell 目标**能安全委托，且命令数据不走命令行——bash 目标把用户命令 base64 放进环境变量 `ENVD_CMD`、由 `base64 -d | bash -s` 解码执行；PowerShell 目标用 `-EncodedCommand`（UTF-16LE base64，前缀 `$ProgressPreference` 抑制 5.1 的 CLIXML 噪音，并对超长命令设上限）。**cmd / WSL / 自定义终端目标一律拒绝委托**：PowerShell 5.1 会吞参数里的双引号、MSYS 会把 cmd 的 `/d /s /c` 改写成路径，实测命令静默不执行。
- **沙箱策略改为闭集**：`sandboxPolicy.resolve` 返回 `{}` / 空 mode / 闭集（`read-only` / `workspace-write` / `danger-full-access`）之外的值，一律按「策略不可知」保守处理，不再回落到部署默认档；反过来，执行器自称不围栏、但策略服务明确说本会话受围栏时，EnvDock 仍然拒绝自己 spawn / 委托。
- 简报：按逐会话事实说真话；sessionless 与「策略不可知」不再冒充「确定无围栏」；围栏会话的工具表只剩 `envd_shell` 时提示「下一轮对账会把宿主工具换回来」；末行改为「`envd` 只解析已探测到的工具」。
- 面板悬停 / 诊断只展示常用计数，完整字段留给 `/envdock-api` 的 `syncStats`；旧版 API（没有 `scopes` 字段）在 title 标注「旧版构建」，新构建零会话（`scopes: []`）显示「当前无会话」而不是误报旧版。
- 遮挡与「主宿主 shell」全部按**作用域**判定：每个会话只挡它自己真的见过、且挡得掉的宿主 shell；挡不掉或认不出家族的那个只要此刻还在，就藏 `envd_shell` 让路（同时仍挡住本作用域挡得掉的其它宿主 shell）。
- 委托执行的包装器改为按**宿主执行器**（`ctx.shell`）的语法族选择（`executorFamily`：先看执行器对象 / 类名，判不出按平台默认，win32 是 PowerShell、其余平台是 bash）；判成 cmd 时拒绝委托。命令数据走 base64 通道（bash 目标：`ENVD_CMD`；PowerShell 目标：`-EncodedCommand`），`dshEnv` 透传。
- 面板头部改为**单 badge**：异常（红）> 混合（黄「N 个会话用宿主工具」）> 直连接管（绿「模型可见」）> 未接管（灰，含全部会话都未接管 / 全部围栏的「沙箱」/ 由其它插件提供）；混合数字从 `commandTool.scopes` 推导，不再用 `sandboxHiddenScopes` 之类汇总值凑数。
- 接管诊断用 `steadyNow`（本 tick 是否稳态）+ `steadyPrev`（上一轮是否稳态）而不是累计的 `steadyTicks`；`lastError` 显示写入龄期，且每轮对账开始即清空——瞬时错误不再常驻面板。
- 简报按模型**实际拿到**的命令工具分支出话：直连接管 / 未接管（`host`）/ 让路 / 沙箱各一套文案；API 没有会话时注明「全局视图；逐会话终局见 `commandTool.scopes`」，不再对「本会话」下结论。
- 「让路」被当作正常终局：诊断条不再给它挂 ⚠（头部汇总已经表达）。

### Fixed

- `hideOwn` 诚实记账 + 自愈：只有真的推了 `restrict` 且复读确认不可见，才把「已藏」记进账本（`ownHides`）；`scopesSettled` 复检「计划要藏、此刻却可见」时重挂——围栏 / 让路会话里的 `envd_shell` 不会因为别的层放开遮挡而复活（那等于绕过沙箱）。
- `restrict` 成功返回后复读可见性：仍可见的名字进该作用域 `badNames` 并计 `denyNoops`，不记成「已挡」；整体 `restrict` 抛错时退化为逐个挡，能挡几个挡几个，并对诊断如实交代。
- 过渡性缺名不再判死：`restrict` 报 unknown、但此刻本来也看不见的名字进 30 秒重试窗口（`transientMisses`），不锁进 `badNames` 造成永久让路 / 永久「挡不掉」。
- 多宿主 shell 时不再出现 `envd_shell` 与宿主工具并列：旧实现用全局记忆算掩码，`mask` 一旦非空就跳过让路分支；旧构建的历史观测里确实出现过模型手里两个命令工具、简报却只说一个。现在按作用域逐个对账。
- 委托失败分阶段记账（解析 / 启动 / 执行），输出里标 `[sandbox]`；执行器 `runnerFailed` 不再伪装成「命令跑完但失败」（返回 `ok:false`）；缺本会话 policy、缺会话信息、执行器族不支持时直接拒绝，绝不拿部署默认档冒充。旧说法「按宿主工具名选包装器」已废弃——Windows 官方 base 的宿主执行器是 PowerShell，而模型手里的工具可能是 bash 家族的 `ops_bash`，按工具名选包装器会直接 ParserError。
- 守卫方向一改用该会话事实里的 `hostTool`，多宿主时不再拿全局 `shippedName` 静默放行成裸 `UNKNOWN_TOOL`。
- 委托结果校验：执行器返回空 / 非对象 `result` 算失败（不记成功委托、不输出假结果），`aborted` 返回 `ok:false`；配合支持矩阵，cmd / WSL / 自定义终端目标不再出现「看起来跑完、其实命令没执行」。
- 文档与验证口径：不把旧构建的观测当成新版本的验证结论。此前的 6.5 分钟稳态观测来自**旧构建**（没有 `commandTool.scopes` 与新计数），只能算历史观测；新构建的运行时证据需要重启 dsh 后重新采集。
- **API 安全加固**：请求体 >1 MB 时先把请求读完再回 413（不再 ECONNRESET）；`sec-fetch-site: cross-site` 一律 403；本机请求但 `Origin` 不是回环也 403；`isLoopbackHost` 严格匹配回环地址（`127.0.0.1.evil.example` 不算回环）。
- **性能**：状态文件按 `mtime+size` 缓存解析结果；探测结果在内存里缓存 45 秒；只有影响探测的写入（默认终端 / 自定义终端 / 默认版本 / 自定义工具）才作废探测缓存，改 `allowLan` 之类选项不再触发全量重扫；每 tick 复用工具定义快照（`defsSet` / `defsStamp`），候选名集合有界（各 64 条），`runtimeShellTools` 不再随插件改名线性膨胀。
- **面板修复**：诊断三态（`diagUser` 未设置时跟随自动展开，点「收起」不再假死）、warn 级诊断不染红（danger 只留给 error / 最近错误）、异常会话不会被「还有 N 个」藏住（异常优先排序，按钮标注「（A 个异常）」）、长名字 / 路径溢出改为省略号 + title、403 无数据时不再显示假的「简报注入关闭」、中英文案补齐（英文界面不出现中文、`(平台默认)` 走词条）、复制失败可见提示。
- **守卫边界说明**（dsh-ops 0.5.0）：它可能**先**挂 `tools/pre-execute` 的 deny + 自己的 guard，那种情况下 EnvDock 方向二的拒绝文案不一定出现、`guardDenials` 也可能一直是 0；文档不再把「不可执行时放行」之类写成已有保障。

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
