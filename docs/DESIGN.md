# EnvDock 设计说明

面向要读代码、改代码的人。用户向的安装与使用说明见 [README](../README.md)。

## 目标

Windows 上做开发时，机器上往往并排躺着好几套 Node / Python / Git，cmd、PowerShell、Git Bash 又在混用。EnvDock 要回答四个问题，并把答案交给 AI：

1. 工具装在哪（全部候选路径，而不是 PATH 上第一个）
2. 是什么版本
3. 该用哪个（用户选定的默认版本）
4. 这个终端里命令怎么写

同时保证：探测不准不致命——接管失败、注册失败、沙箱出现时都能退回「只给简报」，绝不把用户锁在没有命令工具的状态里。

## 探测模型

### PATH 扫描

- **PATH 目录只 readdir 一次**，按名字建索引。早期实现是「名字 × 目录 × PATHEXT」逐个 `statSync`，本机 ≈2400 次系统调用，冷缓存要 1 秒多，而且全压在事件循环上。
- 只认 `PATHEXT` 里的可执行扩展名，不会被 npm 的无扩展名 sh 脚本骗到。
- 处理未展开的 `%VAR%` 路径项、POSIX 路径分隔符。

### 版本探测

- 版本探测带缓存：key 是「可执行文件 + mtime + size + 参数」，常规刷新命中缓存、0 次子进程。
- 点「重新探测」时**清空版本缓存**并全部重测——mtime 判不出「同一路径的垫片/软链被换了」，用户点这个按钮就是要一个不信旧值的答案；重扫期间的状态写入会让这份结果进不了缓存（代数校验），不会把旧快照端回来。
- 版本管理器与工具版本**并行**：装了 nvm + conda + pyenv 的机器上，一条 `list` 最长 8s，原来串在所有工具版本后面。
- 并发探测只跑一份：连点「重新探测」不会叠出两倍的子进程。
- PATH 失效目录的**真实数量**单独记（`missingCount`），面板不把截断后的 12 显示成总数。
- **缓存链**：状态文件按 `mtime+size` 缓存解析（简报每个模型请求都要读一次 state，不再每次 `readFileSync`）；`detect()` 的结果缓存 **45 秒**（普通 GET 命中即复用，不再每次点开面板都全量扫 PATH、跑版本管理器 `list`）。
- **选择性失效**：只有影响探测结果的写入（`defaultShell` / `customShell` / `selections` / `customTools`）才 `invalidateDetection()`；改 `allowLan` 之类的选项不再让面板白跑一次全量重扫。接管状态变更仍然立刻触发对账（不等 5 秒 tick）。
- **每 tick 复用工具定义快照**：同一 turn 里 `tools.definitions()` 只枚举一次（`defsSet` / `defsStamp`），可见性快照在同一 tick 内复用（`visDirty` 变化才重探）；`seenShells` / `learnedShells` / 每个作用域的 `hostSeen` 有界（各 64 条），插件反复换名也不会让候选遍历与 API 载荷线性膨胀。
- `syncStats.detections` / `lastDetectMs` 记录探测次数与最近一次探测耗时——面板据此证明「没有反复全量重扫」。

### 「重新探测」问的是系统，不是 dsh 启动那一刻的快照

`process.env.PATH` 是进程启动时定死的。用户在系统里删掉一个失效目录、或新装工具把新目录加进 PATH 之后它就过期了——只重扫它，面板永远显示旧结果，非要重启 dsh 才「更新」。所以「重新探测」会：

1. 先用 `reg query` 重读机器级 + 用户级 PATH（展开 `%VAR%`）再扫；
2. 系统里已经删掉、目录也不在的僵尸项直接丢掉；
3. 系统里新加的目录立刻纳入；
4. 进程里多出来但目录真实存在的（启动器/终端自己塞的）保留；
5. 读不到注册表（无 `subprocess` 服务）时才退回进程快照。

两边确实不一致时，健康检查会多一条「提示」说明原因。

### 版本管理器

nvm-windows（`nvm list`）、pyenv-win（`pyenv versions` + `pyenv version` 取激活项）、conda（`conda env list`）、fnm（`fnm list` + `fnm current` 取激活项）、mise（`mise ls`）会解析已装版本；Volta、asdf 只报「在场」，不解析版本列表（输出格式随平台变，宁可不猜）。

**必须命令在 PATH 上或根目录真实存在才算在场**，然后实际跑它的 list 命令——不做「目录存在就算有」的猜测（那会把 pnpm 的 bin 目录当成版本管理器报出来）。pyenv/conda/Volta 的版本目录也会并进 Python/Node 的多版本候选。

Windows 的 `py` 启动器也是一种身份：它既是 `python` 的别名（`envd resolve py` 能命中），也是 `python.exe` 不在 PATH 时的兜底入口——那种机器上 Python 仍然会被报出来，默认路径落在 `py.exe`，并用 `py -0p` 列出全部解释器。

## 终端接替

- **宿主自带哪个 shell 是「查出来」的，不是写死的**。两路认：①宿主提供 `tools.definitions` 时枚举工具定义，按名字里的家族 token（`ops_bash`、`tenant_pwsh` 之类）和「描述提到 bash / PowerShell / cmd / WSL 且参数里有 command 类字段（`command` / `cmd` / `script` / `commandline`）」认家族（`shellFamilyFromDefinition`），认出的名字进运行态 `rt.learnedShells`；②把已知候选名在全局与每个 agent 作用域里逐个 `tools.get(name, agent)` 探一遍（不传 agent 只见全局视图，这是踩过的坑；有 `tools.executable(name, agent)` 时优先用它）。**只有命令参数不够、名字带 cmd 也不够**：`run_cmd`（task 参数）、`wc_cmd_palette`（UI 面板）必须被排除，否则接管会静默挡掉无关工具。谁在，宿主就是哪个家族；名字认得出、家族认不出 → 让路，不猜语法。
- **默认终端与宿主同族 → 什么都不做**，不重复造工具、不遮挡。
- **固定名注册 + 占名不认领**：接管的命令工具固定叫 `envd_shell`（切终端只改执行方式，不拆建、不留空窗）；同名已被别的插件注册 → 报错并放弃接管，绝不认领别人的工具。判断「是不是我这一份」用**登记身份**（`tools.get(name) === 我注册的那个定义对象`，dsh-ops 的 publication ownership 是同一口径），不只看名字——同名工具被别人顶掉时，名字还在不代表还是我们的。
- 注册后验证「模型看得见」，不是看 `register()` 有没有抛错；各 agent 作用域能不能看见由遮挡层逐个处理。**可执行面优先**：有 `tools.executable(name, agent)` 就用它判「这一单能调」，否则回落 `tools.get`——`ptc` 模式下模型直呼只允许 `run_code`，拿 `get` 判会把一个调不了的替代工具当成就绪，于是把真正能用的宿主工具藏掉。本机这一代 dsh-tools（0.2.1-rc.2）不提供 `tools.executable`，所以「可执行面」并非处处可用（`hasExecutableApi` 把这件事写进诊断）；PTC 折叠下模型直呼还可能被折叠进 `run_code`，那种调用连可见性探针都看不到——「不可执行时放行」不是已有保障。
- **注册失败绝不遮挡宿主工具**：宁可放弃接管，也不让模型一个命令工具都没有。（早期版本在这里把自己锁死过：`bash` 被遮、`pwsh` 被 deny，手上没有任何命令通道。）
- **沙箱按会话判，不按能力位判**：dsh 的 `ctx.shell` 是 ShellExecutor。可围栏的实现会公布 `sandboxMode`——但那是**部署默认档**（`dsh-pwsh-sandbox` 里就是 `sandboxPolicy.defaultMode`），不是本会话的有效策略。拿它当事实会在 `danger-full-access` 的会话里谎报围栏、把接管永久锁死。正确口径（与 `dsh-tool-pwsh` 一致）：能力位 = 执行器会不会围栏；有效策略 = 逐会话 `ctx.sandboxPolicy.resolve({ session })`，而且是**三态**：`true` 确定围栏 / `false` 确定无围栏 / `null` 策略不可知。合法策略是**闭集** `read-only` / `workspace-write` / `danger-full-access`：resolve 返回 `{}`、空 mode 或闭集之外的值一律按「不可知」处理，**绝不回落到部署默认档**（回落会让围栏会话被当成无围栏直接 spawn）。`null` 绝不压成 `false`：执行层按「有围栏」保守处理，plan 也不去遮宿主；反过来，执行器自称不围栏、但策略服务明确说本会话受围栏时，EnvDock 仍然拒绝自己 spawn / 委托。**只有至少一个会话证明无围栏时才注册 `envd_shell`**；所有会话都被围栏（或全都不可知）时干脆不注册（注册了也只能被自己藏起来，还多一次拆建），这时每个会话的终局都是「未接管」（`host`），`sandboxBlocked` = 没有任何会话**确认**无围栏。一个会话被围栏不影响别的会话，EnvDock 按作用域决定遮宿主的 shell 还是遮自己的 `envd_shell`（两份掩码互斥）；`sandbox-host` 这个终局只出现在「有会话无围栏 + 本会话被围栏」的混合部署里。
- **宿主 shell 记忆按作用域，且是历史事实**：每个作用域记它自己真的见过的宿主 shell（`cur.hostSeen`），被挡住之后记忆仍在——否则每 5 秒会在「遮住 → 看不见 → 放开 → 又看见」之间来回抖。但**不能用全局记忆**：那会把「只在别的会话里注册的 `pwsh`」带进这个会话，`mask` 一旦非空就跳过让路分支，模型手里出现两个命令工具（旧构建的历史观测里就是这样出问题的）。同时判定要**有活证**：`shippedName` 必须此刻真的可见（或仍在我们自己的掩码里）才算数——见过之后宿主撤回了工具，就立刻接管兜底，不会永远以为「与宿主同族」而不干活；从没见过宿主时给约 60 秒宽限，避免和晚注册的宿主插件抢（抢了就是先建后拆）。
- **作用域私有的遮挡失败不株连**：某个作用域挡不掉的 shell 名只记在那个作用域（`cur.badNames`），别的挡得掉的作用域继续挡——否则「一个会话挡不掉」会让别的会话永久漏挡。`badNames` 带约 30 秒过期（到期自动重试，不是永久判死）。`restrict` 成功返回后必须**复读可见性**（agent 自己层注册的同名工具挡不掉，`restrict` 也不报错）：仍可见的进 `badNames` 并计 `denyNoops`，不记成已挡；整体抛错时退化为逐个挡，能挡几个挡几个。过渡性缺名（`restrict` 报 unknown、但此刻本来也看不见）进 30 秒重试窗口（`transientMisses`），同样不锁进黑名单造成永久让路。
- **让路与自愈**：宿主工具挡不掉或家族认不出、而它此刻确实还在 → 藏自己的 `envd_shell` 让路，同时仍挡住本作用域挡得掉的其它宿主 shell，模型最后只剩那个挡不掉的宿主工具。`hideOwn` 只认「真推了 `restrict` 且复读确认不可见」的记账（`ownHides`）；`scopesSettled` 会复检「计划要藏、此刻却可见」并重挂——围栏 / 让路会话里 `envd_shell` 不会因为别的层放开遮挡而复活（复活就等于绕过沙箱）。已遮挡作用域里 `envd_shell` 一旦不可见，立刻把宿主 shell 还回去（宁可两个，也不制造零工具）。

## 与 dsh-ops 的兼容与借鉴

同一台机器上 EnvDock 与 dsh-ops 可能同时接管命令工具（dsh-ops 的 cordis 模式会把官方 `pwsh` 换成 `ops_bash`）。两边都只用 `tools.register` + `tools.get/restrict`，没有私有通道，所以共存靠下面几条：

**适配**

- **宿主命令工具的家族是运行时认出来的**：`SHELL_TOOL_FAMILY` 只是内置表（`ops_bash` 在里面按 bash 家族认领），真正的入口是 `tools.definitions` + 名字 token / 描述启发式（`shellFamilyFromDefinition`），认出的名字进 `rt.learnedShells`——换前缀、换平台、别的插件发布同类工具都不会漏认；漏认的后果就是模型同时看到两个命令工具，`shippedShell` 也永远是 null（连委托都做不了）。认不出家族的命令工具一律让路，不遮挡也不教语法。
- 谁的官方替换谁负责：EnvDock 只遮「命令工具」（shell 家族），不碰 dsh-ops 替换的 `read/glob/grep` 等文件工具，也不认领 dsh-ops 的 refusal 职责。

**借鉴（都是 dsh-ops 已经踩过的坑）**

1. **事件驱动对账**：监听 `tools/change`，用一个 40ms 的合并定时器触发对账；别的插件晚一步注册/撤销 shell 时立刻收敛，而不是等下一个 5 秒 tick。5 秒 tick 保留为兜底（旧宿主没有该事件、或事件不完整时仍然正确）。对账期间置 `mutating` 标志，自己的 `register/restrict` 派发的 `tools/change` 不再触发下一轮——这就是 dsh-ops 用 `withToolChange` 表达的作用域归属。
2. **mask + refusal 同权（双向）**：被藏掉的命令工具仍可能被上一步捕获的工具表直呼。注册一个 `tools.guard`：宿主 shell 被藏 → 「已由 EnvDock 接管，请用 `envd_shell`，语法见简报」；`envd_shell` 被藏（让路 / 沙箱）→ 指路该会话里真的可见的宿主工具，原因取自逐会话事实（沙箱围栏 / 宿主 shell 作用域私有 / 策略不可知）。守卫必须比遮挡更保守：替代品判不出「此刻能不能用」时给「暂时无法判定」，不编造工具名；宿主没有 `tools.executable` 时只能按可见性判，PTC 折叠下直呼可能被折叠进 `run_code` —— 守卫是可操作提示，不是安全边界。**dsh-ops 0.5.0 可能先手**：它自己的 `tools/pre-execute` deny / guard 在前，调用根本走不到 EnvDock，方向二的文案不一定出现、`guardDenials` 也可能一直是 0——这是正常的，不能当作「守卫失效」。
3. **登记身份，不只看名字**：`tools.get(name) === 我注册的那个定义对象` 才算我们的工具。同名工具被别的层盖住时，名字还在不代表还是我们的；这时候绝不能拿它当「已接管」去挡宿主。
4. **可执行面优先（有则用，无则退）**：`tools.get` 是注册表视图，`tools.executable(name, agent)` 才是「这一单能不能调」（`ptc` 折叠、按步捕获）。有该方法时判后者，旧宿主没有时只能回落前者——本机这一代 dsh-tools（0.2.1-rc.2）不提供 `tools.executable`，所以「可执行面」并非处处可用，`hasExecutableApi` 把这件事写进诊断。

**不学的部分**

dsh-ops 的 `ops_bash` 同样走 `ctx.subprocess`（没有 `sandboxPolicy` 入口），所以 EnvDock 自己 spawn 时的沙箱闸门必须原样保留：围栏会话绝不直连，只能委托宿主执行器或拒绝。

另外，委托必须**安全**：包装串跟**宿主执行器**的语法族走（`executorFamily`：先看 `ctx.shell` 对象/类名，判不出按平台默认，win32 是 PowerShell、其余平台是 bash，并把 `source` 报给诊断），而且命令数据从不拼进命令行。支持矩阵只覆盖 **bash / PowerShell 目标**：

- bash 目标：用户命令 base64 后放环境变量 `ENVD_CMD`（纯 base64，无空格/引号/通配符），宿主命令行里跑 `printf %s $ENVD_CMD | base64 -d | bash -s`；载荷超过 ~30KB（环境变量上限）就拒绝。
- PowerShell 目标：`-NoLogo -NoProfile -NonInteractive -EncodedCommand <UTF-16LE base64>`，前缀 `$ProgressPreference='SilentlyContinue';` 抑制 5.1 嵌套启动时的 progress→CLIXML stderr 噪音；超过 Windows 命令行上限（~24KB 编码后）就拒绝。
- **cmd / WSL / 自定义终端目标一律拒绝**：实测 PowerShell 5.1 会吞掉参数里的双引号（命令语义被静默改写），MSYS 宿主会把 cmd 的 `/d /s /c` 改写成路径（命令根本没跑）。宁可拒绝，也不让模型拿到「看起来成功」的假结果。

执行器不在、判成 cmd、缺会话信息、policy 为 `null` 或 mode 不在闭集时同样拒绝委托，不拿部署默认档冒充。`result` 必须是对象：空 / 非对象算失败；`aborted` 返回 `ok:false`。计数上，进入委托路径记 `delegateTries`，目标/执行器不支持记 `delegateRefusals`，只有拿到合法 result 才记 `delegateCalls`。

## 状态与面板 API

- 状态文件 `~/.dsh/envdock.json` 原子写：先写同目录临时文件再 rename，进程中途被杀不会留下半截 JSON。
- 真的损坏时回落到全自动、把原文件备份成 `envdock.json.corrupt`，并在面板健康检查里给一条 issue（改一次设置即写回正常文件）。
- **非法选项写不进去**：`setShell` 只接受真实探测到的终端名（`auto` 或某个终端 key）；`setOption` 只认白名单（`injectBrief` / `allowLan` 一律归一成布尔，`shellTakeover` 只认 `auto` / `takeover` / `off`），手滑的 key/字符串不会再永久写进状态文件。
- 面板 API 默认只放行 loopback：数据含本机绝对路径与终端。打开「允许局域网访问」（`allowLan`）后**局域网只能读**（GET）；所有写操作只允许本机，唯一例外是同源页面把 `allowLan` **关掉**（`Origin` 的 host 必须与 `Host` 一致，避免任意网页替用户关掉）。理由：写操作能改默认终端 argv，等于把命令注入面开到局域网。
- **API 加固**：请求体 >1 MB 时先把请求读完再回 413（直接 `destroy` 会让客户端看到 `ECONNRESET`，既不是 413 也不可诊断）；`sec-fetch-site: cross-site` 一律 403；本机请求但 `Origin` 不是回环也 403；`isLoopbackHost` 严格匹配（`localhost` / `::1` / `127.0.0.0/8`，`127.0.0.1.evil.example` 不算）；非 GET / POST 回 405，坏 JSON 回 400。
- `/envdock-api` 的 `commandTool.scopes` 逐会话给终局：`kind` ∈ `takeover` / `host` / `yield` / `sandbox-host`，字段 `tool` / `hostTool` / `hostTools` / `ownVisible` / `ownNameVisible` / `ownOurs` / `hideOwnPlanned` / `visible` / `hidden` / `leaked` / `hidesOwn` / `confined`（三态）/ `policyKnown` / `mode` / `anomaly`。事实按「此刻实际能不能用」现测推导（不按计划意图）：`anomaly` = 零命令工具 / 接管下宿主仍可见 / 挡了却仍可见 / 同名工具不是我们登记的。`hostOnlyScopes` / `sandboxHiddenScopes` / `scopeAnomalies` 都从这份事实推导。`sandbox.scopes` 同样带 `confined` 三态与 `policyKnown`。
- 诊断计数（`syncStats`）：`registerTries` / `registers` / `disposes`、`delegateTries` / `delegateCalls` / `delegateFailures` / `delegateRefusals`、`ownHides` / `hostDenyApplies` / `denyNoops` / `transientMisses`、`yieldTicks`、`guardDenials` / `guardReady` / `guardError`、`steadyNow` / `steadyPrev` / `steadySinceAt` / `steadyTicks` / `lastErrorAt`、`detections` / `lastDetectMs`、`executorFamily` / `executorFamilySource`、`runtimeShellTools` / `hasExecutableApi`、`scopeAnomalies`。`steadyNow` 是状态、`steadyPrev` 是上一轮状态、`steadyTicks` 只是累计量——面板不能拿累计量冒充「现在稳态」。委托三兄弟的语义：进入委托路径 +1 try，目标 / 执行器不支持 +1 refusal，只有拿到合法 result 才 +1 call。
- 面板头部只挂**一个** badge：异常（红）> 混合（黄「N 个会话用宿主工具」）> 直连接管（绿「模型可见」）> 未接管（灰，含「沙箱」）。「混合」必须是真混合（部分 takeover + 部分未接管）；全部会话都未接管时是灰「未接管」而不是黄色告警。新旧 API 按「`commandTool.scopes` 字段在不在」判：新构建零会话给 `scopes: []`（面板写「当前无会话」），旧构建没有该字段才用 `hostOnlyScopes` / `sandboxHiddenScopes` 兜底并把两者相加、文案写「约 N 个」，同时在 title 注明「旧版构建」。

## 面板结构

`client.js` 的 `EnvDockPanel` 是单屏五块（**只在 Web 有**：`dsh.client.platform` 只注册 `web`；`tui` / `headless` 装得上但没有面板，简报与 `envd` 工具照常生效）：

1. **头部一行**：标题 + 当前终端与版本 + **一个**状态 badge（异常红 / 混合黄 / 直连接管绿 / 未接管灰）+ 问题数 +「重新探测」。
2. **置顶「命令工具 / 接管」卡片**：终端 chips；状态行 = 状态词 chip + 当前命令工具名 + 执行器族（`executorFamily`，`source=platform` 标「平台默认」）+ 接管模式 chips（自动 / 总是接管 / 只给简报）；真有围栏会话、或执行器具备围栏能力时才挂沙箱下接管 chips（委托执行 / 直接拒绝）。逐会话行最多 5 行（**异常优先**，超出折叠成「还有 N 个 /（A 个异常）」），异常行行尾给原因；「已识别宿主命令工具」chips 来自 `syncStats.runtimeShellTools`（`learned` 带标记）；诊断折叠区默认收起、有问题自动展开（`diagUser` 三态：未设置=跟随 auto，点过就听用户的），红色只给 error 级。
3. **工具链**（含版本管理器与自定义工具入口）：路径点击即复制，多版本折叠成「N 个版本」。
4. **健康检查 / 环境简报**：都默认折叠成一行；健康检查只在有问题时渲染。
5. **底部一行**：简报注入开关（`!data` 时不渲染，避免 403 时显示假「关闭」）、允许局域网访问开关（403 时仍可点）、复制反馈（`role=status`，`aria-live`）。

面板每 15 秒静默拉一次 `/envdock-api`，只在 `document.visibilityState === 'visible'` 时拉；payload 比较前剔除 `ticks` / `steadyTicks` / `steadySinceAt` / `lastAt` / `lastErrorAt` 等易变键（否则每个 tick 都会被当成「有变化」重渲染）。复制优先 `navigator.clipboard`，局域网 http 退到 `textarea + execCommand('copy')`，失败给可见提示。

## 健康检查

红 / 黄 / 灰三档：

- 红：应用商店占位符（`looksLikeStoreStub`）、默认版本路径失效（`staleSelection`）、默认终端不可用、选了 Git Bash 但没找到 `bash.exe`、默认 Python 是 2.x。
- 黄：多版本并存、Node < 18、Python 3.x < 3.9、npm 与 Node 不匹配、PATH 有失效目录、版本管理器激活版本与 PATH 实际解析不一致。
- 灰：dsh 进程里的 PATH 是旧的（探测已按系统当前值刷新，重启只是让两边彻底一致）。

## 自测

```powershell
npm test                     # 四个自测一次跑完（只在源代码检出目录可用）

node test/parsers.mjs        # 版本管理器输出解析
node test/i18n-check.mjs     # 中英词条键/占位符一致、slot 注册仍在
node test/host-harness.mjs   # 用 Cordis 服务替身把 apply() 真跑起来，走完所有 API op / envd action / 接管路径
node test/panel-render.mjs   # 用极简 React 运行时替身渲染面板，断言头部 badge / title / 旧版兜底
```

`host-harness` 把状态文件写在临时 `DSH_HOME` 里，不会碰你真实的 `~/.dsh/envdock.json`；`subprocess` 用固定输出的替身（本机沙箱不允许 Node 用管道 stdio 起子进程），所以每次探测起几个子进程是可数的——版本缓存的收益也在断言里。`panel-render` 不引入 React：桩掉 slots / locale / fetch，加载 `client.js` 捕获真实渲染树，断言 badge 文案、title 里的逐会话行与计数——纯 Node、零外部依赖。

`npm test` 只在**检出目录**可用：npm 包的 `files` 里没有 `test/`，从 npm 安装的插件没有这些自测可跑。

## 结构

```
index.js          Host：探测、envd 工具、简报注入、终端接替、/envdock-api
client.js         Client：侧边栏图标 + 中央面板
cordis.patch.yml  bundle patch（insert id: envdock）
locale/           meta.title / meta.description
icon.svg          插件图标
CHANGELOG.md      版本变更记录
test/parsers.mjs       版本管理器输出解析自测
test/i18n-check.mjs    client.js 静态自检（词条/占位符/slot）
test/host-harness.mjs  Host 半边运行时夹具（替身服务，全链路）
test/panel-render.mjs  面板渲染回归（极简 React 替身，零依赖）
```

Host 半边**不 import 任何 `@deepseek-ai/*` 包**（本地目录安装是 link 检出，包内 import 解析不到 profile 的 node_modules），只用 `node:` 内置模块；命令探测走宿主的 `subprocess` 服务（只跑 `--version` 之类的只读探测，继承 dsh 的工作目录语义）。**接管出来的命令工具默认也走 `subprocess`，而且是唯一的安全理由**：`subprocess.spawn` 没有 `sandboxPolicy` 入口，所以围栏会话绝不自己 spawn。围栏下的降级路径是**委托**：把命令交给带围栏的 `ctx.shell`（`resolve` + `execute`，命令数据经 base64 通道传入——bash 目标 `ENVD_CMD`、PowerShell 目标 `-EncodedCommand`，宿主命令行里不出现用户命令），围栏挂在宿主进程上、子终端继承，`sandbox.denied` 也如实回显给模型。

## 已知边界

- 版本探测器探的是「可执行文件与版本」，不解析 `.nvmrc` / `pyproject.toml` / `package.json` 里的版本要求。
- `python` / `python3` / `py` 三个名字都解析到同一条 Python 记录：`py.exe` 是启动器不是解释器，`resolve` 会单独把它的路径和 `py -3.10` 用法讲清楚。
- 「重新探测」重读系统 PATH 依赖 Windows 注册表（`reg query`，机器级 + 用户级）。POSIX、或宿主没有 `subprocess` 服务时，只能退回 dsh 进程启动时的 `process.env.PATH`——那种情况下改了系统 PATH 仍然要重启 dsh。Windows 上「进程里多出来但目录真实存在」的 PATH 项会保留（那是启动器/终端自己塞的，不属于系统 PATH）。
- Volta / asdf 只报「在场」，不解析版本列表。
- 版本探测依赖宿主 `subprocess` 服务；没有它时只做 PATH 扫描，版本列显示「版本未知」。
- 接管后的命令工具是**精简执行器**：单次前台、输出截断、支持 `cwd` / `timeoutMs`；没有后台作业、没有 tail 落盘文件、没有 `sandbox_permissions` 升级参数。要这些能力就切回「只给简报」用宿主自带的。围栏会话下它按「沙箱下接管」选项工作：`delegate`（默认）= 命令还没被摘掉时经带围栏的宿主执行器执行（包装串按 `executorFamily`；缺本会话 policy / 族不支持时拒绝），`refuse` = 不接管（等价「只给简报」）；稳态围栏会话里根本没有 `envd_shell`。
- 宿主命令工具的家族靠名字 token / 描述启发式认：认不出家族的不遮挡、不教语法，该会话让路，模型沿用工具表里那个工具的原始用法。
- 拒绝守卫是「可操作提示」，不是安全边界：没有 `tools.executable` 时只能按可见性判；PTC 折叠下模型直呼可能被折叠进 `run_code`；dsh-ops 0.5.0 还可能先用自己的 `tools/pre-execute` deny / guard 拦掉，EnvDock 方向二的文案不一定出现（`guardDenials` 甚至可能一直是 0）。
- 全部会话都被围栏时不注册 `envd_shell`（每个会话都是 `host` / 未接管），头部是灰色 badge；`sandbox-host` 只在混合部署（至少一个无围栏会话 + 本会话被围栏）里出现；策略不可知（`confined: null`）按「有围栏」保守处理。
- 围栏下的委托按阶段记账（解析 / 启动 / 执行 → `delegateFailures`）：执行器 runner 不可用时 `ok:false` 并在输出里标 `[sandbox]`，不伪装成「命令跑完但失败」。
- 委托执行只支持 **bash / PowerShell 目标**：cmd / WSL / 自定义终端目标没有安全路径（命令会静默不执行），一律拒绝。PowerShell 5.1 作为宿主仍然安全——命令走 `-EncodedCommand` / `ENVD_CMD` 的数据通道，不拼命令行；但 cmd 目标就是不支持委托。
- 工作目录取**当前会话的工作目录**（不是 dsh 进程 cwd）。
- 探测结果在内存里缓存 45 秒，只有默认终端 / 自定义终端 / 默认版本 / 自定义工具的写入会让它立即失效；「重新探测」强制重扫并清空版本号缓存（版本号本身缓存 10 分钟，key 含 mtime+size）。
- 宿主命令工具必须**此刻真的可见**（或仍在我们自己的遮挡里）才算存在：见过之后又消失会立刻接管兜底；从没见过宿主时给约 60 秒宽限，避免和晚注册的宿主插件抢。
- 面板只在 `web` profile 注册；npm 上发布的版本可能滞后（当前是 0.1.0），要本轮功能请用本地目录 / Git 安装或等 0.3.0 发布。
- 面板每 15 秒静默轮询一次（仅页面可见时），数据最多滞后一个周期；payload 比较会剔除易变计数，所以计数变化本身不一定触发重渲染。
