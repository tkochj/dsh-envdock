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
- **过期探测走 stale-while-revalidate**：缓存只是「过了 45 秒 TTL」而没被显式作废时，`GET /envdock-api` 先端上一份快照、后台再刷新。面板 15 秒轮询一次，每第 3 次都会正好撞上过期——让它干等一次全量探测（PATH 重扫 + `reg.exe`）没有意义，下一次轮询自然拿到新快照。**显式作废**（切终端 / 改选项 / `refresh`）语义不变：仍然同步等新数据，用户点完就看见结果。
- **选择性失效**：只有影响探测结果的写入（`defaultShell` / `customShell` / `selections` / `customTools`）才 `invalidateDetection()`；改 `allowLan` 之类的选项不再让面板白跑一次全量重扫。接管状态变更仍然立刻触发对账（不等 5 秒 tick）。
- **每 tick 复用工具定义快照**：同一 tick 里 `tools.definitions()` 只枚举一次（`defsSet` / `defsStamp`），`publishScopeFacts` 直接复用这份可见定义快照，不再每 tick 每个会话重做约 10 次单点 probe（真实宿主每次 probe 都要重建 view 集合）；单个名字的可见性仍按 `visDirty` 变化才重探。`seenShells` / `learnedShells` / 每个作用域的 `hostSeen` 有界（各 64 条），插件反复换名也不会让候选遍历与 API 载荷线性膨胀。
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

- **宿主自带哪个 shell 是「查出来」的，不是写死的**。两路认：①宿主提供 `tools.definitions` 时枚举工具定义，按名字里的家族 token（`ops_bash`、`tenant_pwsh` 之类）和「描述提到 bash / PowerShell / cmd / WSL 且参数里有 command 类字段（`command` / `cmd` / `script` / `commandline`）」认家族（`shellFamilyFromDefinition`），认出的名字进运行态 `rt.learnedShells`；②把已知候选名在全局与每个 agent 作用域里逐个 `tools.get(name, agent)` 探一遍（不传 agent 只见全局视图，这是踩过的坑；有 `tools.executable(name, agent)` 时优先用它）。**内置表命中就短路**：`ops_bash` 在内置 bash 家族里，不要求 command 参数；「名字 token + command 参数」那道门槛只约束第三方发布名。**只有命令参数不够、名字带 cmd 也不够**：`run_cmd`（task 参数）、`wc_cmd_palette`（UI 面板）必须被排除，否则接管会静默挡掉无关工具。谁在，宿主就是哪个家族；名字认得出、家族认不出 → 让路，不猜语法。家族查表**大小写不敏感**（学到的按原名与 lowercase 各查一次，内置表按小写查）。
- **默认终端与宿主同族 → 什么都不做**，不重复造工具、不遮挡。
- **固定名注册 + 占名不认领**：接管的命令工具固定叫 `envd_shell`（切终端只改执行方式，不拆建、不留空窗）；同名已被别的插件注册 → 报错并放弃接管，绝不认领别人的工具。判断「是不是我这一份」用**登记身份**（`tools.get(name) === 我注册的那个定义对象`，dsh-ops 的 publication ownership 是同一口径），不只看名字——同名工具被别人顶掉时，名字还在不代表还是我们的。
- 注册后验证「模型看得见」，不是看 `register()` 有没有抛错；各 agent 作用域能不能看见由遮挡层逐个处理。**可执行面优先**：有 `tools.executable(name, agent)` 就用它判「这一单能调」，否则回落 `tools.get`——`ptc` 模式下模型直呼只允许 `run_code`，拿 `get` 判会把一个调不了的替代工具当成就绪，于是把真正能用的宿主工具藏掉。本机这一代 dsh-tools（0.2.1-rc.2）不提供 `tools.executable`，所以「可执行面」并非处处可用（`hasExecutableApi` 把这件事写进诊断）；PTC 折叠下模型直呼还可能被折叠进 `run_code`，那种调用连可见性探针都看不到——「不可执行时放行」不是已有保障。
- **注册失败绝不遮挡宿主工具**：宁可放弃接管，也不让模型一个命令工具都没有。（早期版本在这里把自己锁死过：`bash` 被遮、`pwsh` 被 deny，手上没有任何命令通道。）
- **沙箱按会话判，不按能力位判**：dsh 的 `ctx.shell` 是 ShellExecutor。可围栏的实现会公布 `sandboxMode`——但那是**部署默认档**（`dsh-pwsh-sandbox` 里就是 `sandboxPolicy.defaultMode`），不是本会话的有效策略。拿它当事实会在 `danger-full-access` 的会话里谎报围栏、把接管永久锁死。正确口径（与 `dsh-tool-pwsh` 一致）：能力位 = 执行器会不会围栏；有效策略 = 逐会话 `ctx.sandboxPolicy.resolve({ session })`，而且是**三态**：`true` 确定围栏 / `false` 确定无围栏 / `null` 策略不可知。合法策略是**闭集** `read-only` / `workspace-write` / `danger-full-access`：resolve 返回 `{}`、空 mode 或闭集之外的值一律按「不可知」处理，**绝不回落到部署默认档**（回落会让围栏会话被当成无围栏直接 spawn）。`null` 绝不压成 `false`：执行层按「有围栏」保守处理，plan 也不去遮宿主；反过来，执行器自称不围栏、但策略服务明确说本会话受围栏时，EnvDock 仍然拒绝自己 spawn / 委托。**只有至少一个会话证明无围栏时才注册 `envd_shell`**；所有会话都被围栏（或全都不可知）时干脆不注册（注册了也只能被自己藏起来，还多一次拆建），这时每个会话的终局都是「未接管」（`host`），`sandboxBlocked` = 没有任何会话**确认**无围栏。一个会话被围栏不影响别的会话，EnvDock 按作用域决定遮宿主的 shell 还是遮自己的 `envd_shell`（两份掩码互斥）；`sandbox-host` 这个终局只出现在「有会话无围栏 + 本会话被围栏」的混合部署里。
- **宿主 shell 记忆按作用域，且是历史事实**：每个作用域记它自己真的见过的宿主 shell（`cur.hostSeen`），被挡住之后记忆仍在——否则每 5 秒会在「遮住 → 看不见 → 放开 → 又看见」之间来回抖。但**不能用全局记忆**：那会把「只在别的会话里注册的 `pwsh`」带进这个会话，`mask` 一旦非空就跳过让路分支，模型手里出现两个命令工具（旧构建的历史观测里就是这样出问题的）。同时判定要**有活证**：`shippedName` 必须此刻真的可见（或仍在我们自己的掩码里）才算数——见过之后宿主撤回了工具，就立刻接管兜底，不会永远以为「与宿主同族」而不干活；从没见过宿主时给约 60 秒宽限，避免和晚注册的宿主插件抢（抢了就是先建后拆）。
- **作用域私有的遮挡失败不株连**：某个作用域挡不掉的 shell 名只记在那个作用域，别的挡得掉的作用域继续挡——否则「一个会话挡不掉」会让别的会话永久漏挡。挡不掉分**两类**：**结构性**（`restrict` 的 `restrictableNames` 只含继承面，作用域私有注册永远挡不掉——契约原文 restrictions "do not affect scoped registrations"）记进 `cur.hardNames`，给 10 分钟 TTL 且**不写 `lastError`**：重试没用，每 30 秒刷一次红只会制造噪音；**临时性**（publication reentry / 临时拒绝）记进 `cur.badNames`，30 秒后重试并如实记一条错误。`restrict` 成功返回后必须**复读可见性**（agent 自己层注册的同名工具挡不掉，`restrict` 也不报错）：仍可见的按结构性挡不掉处理并计 `denyNoops`，不记成已挡；整体抛错时退化为逐个挡，能挡几个挡几个。过渡性缺名（`restrict` 报 unknown、但此刻本来也看不见）进 30 秒重试窗口（`transientMisses`），同样不锁进黑名单造成永久让路。
- **让路与自愈**：宿主工具挡不掉或家族认不出、而它此刻确实还在 → 藏自己的 `envd_shell` 让路，同时仍挡住本作用域挡得掉的其它宿主 shell，模型最后只剩那个挡不掉的宿主工具。`hideOwn` 只认「真推了 `restrict` 且复读确认不可见」的记账（`ownHides`）；`scopesSettled` 会复检「计划要藏、此刻却可见」并重挂——围栏 / 让路会话里 `envd_shell` 不会因为别的层放开遮挡而复活（复活就等于绕过沙箱）。已遮挡作用域里 `envd_shell` 一旦不可见，立刻把宿主 shell 还回去（宁可两个，也不制造零工具）。

## 与 dsh-ops 的兼容与借鉴

同一台机器上 EnvDock 与 dsh-ops 可能同时接管命令工具（dsh-ops 的 cordis 模式会把官方 `pwsh` 换成 `ops_bash`）。两边都只用 `tools.register` + `tools.get/restrict`，没有私有通道，所以共存靠下面几条：

**适配**

- **宿主命令工具的家族是运行时认出来的**：`SHELL_TOOL_FAMILY` 只是内置表（`ops_bash` 在里面按 bash 家族认领），真正的入口是 `tools.definitions` + 名字 token / 描述启发式（`shellFamilyFromDefinition`），认出的名字进 `rt.learnedShells`——换前缀、换平台、别的插件发布同类工具都不会漏认；漏认的后果就是模型同时看到两个命令工具，`shippedShell` 也永远是 null（连委托都做不了）。认不出家族的命令工具一律让路，不遮挡也不教语法。
- **`ops_bash` 挡不掉，让路是正确结论**：它由 dsh-ops 在 agent 自己的层发布，`tools.restrict` 的 `restrictableNames` 只含继承面（契约原文 restrictions "do not affect scoped registrations"），EnvDock **没有任何受支持的 API** 能让它从模型工具表里消失。所以 EnvDock 藏掉自己的 `envd_shell`（它是全局注册、挡得掉），该会话恰好留一个 `ops_bash`。想让某个会话改用 EnvDock 的终端接管，唯一受支持的入口是在 **dsh-ops 的设置里关掉 Publish Bash**（没有 unregister API，EnvDock 侧无法代劳）；这类结构性挡不掉按 10 分钟 TTL 重试且不写 `lastError`。
- 谁的官方替换谁负责：EnvDock 只遮「命令工具」（shell 家族），不碰 dsh-ops 替换的 `read/glob/grep` 等文件工具，也不认领 dsh-ops 的 refusal 职责。

**借鉴（都是 dsh-ops 已经踩过的坑）**

1. **事件驱动对账**：监听 `tools/change`，用一个 40ms 的合并定时器触发对账；别的插件晚一步注册/撤销 shell 时立刻收敛，而不是等下一个 5 秒 tick。5 秒 tick 保留为兜底（旧宿主没有该事件、或事件不完整时仍然正确）。对账期间置 `mutating` 标志，自己的 `register/restrict` 派发的 `tools/change` 不再触发下一轮——这就是 dsh-ops 用 `withToolChange` 表达的作用域归属。
2. **mask + refusal 同权（双向）**：被藏掉的命令工具仍可能被上一步捕获的工具表直呼。注册一个 `tools.guard`：宿主 shell 被藏 → 「已由 EnvDock 接管，请用 `envd_shell`，语法见简报」；`envd_shell` 被藏（让路 / 沙箱）→ 指路该会话里真的可见的宿主工具，原因取自逐会话事实（沙箱围栏 / 宿主 shell 作用域私有 / 策略不可知）。守卫必须比遮挡更保守：替代品判不出「此刻能不能用」时给「暂时无法判定」，不编造工具名；宿主没有 `tools.executable` 时只能按可见性判，PTC 折叠下直呼可能被折叠进 `run_code` —— 守卫是可操作提示，不是安全边界。**dsh-ops 0.5.0 可能先手**：它自己的 `tools/pre-execute` deny / guard 在前，调用根本走不到 EnvDock，方向二的文案不一定出现、`guardDenials` 也可能一直是 0——这是正常的，不能当作「守卫失效」。
3. **登记身份，不只看名字**：`tools.get(name) === 我注册的那个定义对象` 才算我们的工具。同名工具被别的层盖住时，名字还在不代表还是我们的；这时候绝不能拿它当「已接管」去挡宿主。
4. **可执行面优先（有则用，无则退）**：`tools.get` 是注册表视图，`tools.executable(name, agent)` 才是「这一单能不能调」（`ptc` 折叠、按步捕获）。有该方法时判后者，旧宿主没有时只能回落前者——本机这一代 dsh-tools（0.2.1-rc.2）不提供 `tools.executable`，所以「可执行面」并非处处可用，`hasExecutableApi` 把这件事写进诊断。

**不学的部分**

dsh-ops 的 `ops_bash` 同样走 `ctx.subprocess`（没有 `sandboxPolicy` 入口），所以 EnvDock 自己 spawn 时的沙箱闸门必须原样保留：围栏会话绝不直连，只能委托宿主执行器或拒绝。

另外，委托必须**安全**：包装串跟**宿主执行器**的语法族走（`executorFamily`：先看 `ctx.shell` 对象/类名，判不出按平台默认，win32 是 PowerShell、其余平台是 bash，并把 `source` 报给诊断），而且命令数据从不拼进命令行。支持矩阵只覆盖 **bash / PowerShell 目标**：

- bash 目标：用户命令 base64 后放环境变量 `ENVD_CMD`（纯 base64，无空格/引号/通配符），宿主命令行里跑 `printf %s $ENVD_CMD | base64 -d | bash -s`；外层 `-lc` 已经是登录 shell，**内层只 `-s`**——再带 `-l` 会让 profile 跑第二遍（重复的 PATH 拼接与 rc 副作用）。载荷超过 ~30KB（环境变量上限）就拒绝。
- PowerShell 目标：`-NoLogo -NoProfile -NonInteractive -Command <script>`。脚本先把 `[Console]::OutputEncoding` 固定成 UTF-8（非 65001 代码页下中文不乱码），再从 `$env:ENVD_CMD` 解 UTF-8 base64、`Invoke-Expression` 执行；命令数据不进命令行，5.1 吞引号的问题无从触发。载荷超过 ~30KB 就把拒绝写成 `too-long`。
- **cmd / WSL / 自定义终端目标一律拒绝**：实测 PowerShell 5.1 会吞掉参数里的双引号（命令语义被静默改写），MSYS 宿主会把 cmd 的 `/d /s /c` 改写成路径（命令根本没跑）。宁可拒绝，也不让模型拿到「看起来成功」的假结果。

执行器不在、判成 cmd、缺会话信息、policy 为 `null` 或 mode 不在闭集时同样拒绝委托，不拿部署默认档冒充；拒绝文案带上事实（「本会话策略 X」/「本会话被沙箱围栏」/「本会话沙箱策略不可知」），免得模型以为工具坏了。`result` 必须是对象：空 / 非对象算失败；`aborted` 返回 `ok:false`。计数上，进入委托路径记 `delegateTries`，目标 / 执行器不支持记 `delegateRefusals`，**只有命令真的执行了**才记 `delegateCalls`；围栏 runner 坏了（命令没跑）记 `delegateRunnerFailures`，命令被取消记 `delegateAborts`——三种结局分开记账，不会把「没走过委托」和「runner 挂了」混成一个 0。

## 状态与面板 API

- 状态文件 `~/.dsh/envdock.json` 原子写：先写同目录临时文件再 rename，进程中途被杀不会留下半截 JSON。
- 真的损坏时回落到全自动、把原文件备份成 `envdock.json.corrupt`，并在面板健康检查里给一条 issue（改一次设置即写回正常文件）。
- **非法选项写不进去**：`setShell` 只接受真实探测到的终端名（`auto` 或某个终端 key）；`setOption` 只认白名单（`injectBrief` / `allowLan` 一律归一成布尔，`shellTakeover` 只认 `auto` / `takeover` / `off`），手滑的 key/字符串不会再永久写进状态文件。
- 面板 API 默认只放行 loopback：数据含本机绝对路径与终端。打开「允许局域网访问」（`allowLan`）后**局域网只能读**（GET）；所有写操作只允许本机，唯一例外是同源页面把 `allowLan` **关掉**（`Origin.host:port` 必须与 `Host` 完全一致，避免任意网页替用户关掉）。理由：写操作能改默认终端 argv，等于把命令注入面开到局域网。
- **API 加固**：回环来源必须配**回环 Host 字面量**——攻击者把自己的域名重新解析到 `127.0.0.1`（DNS rebinding）后来源地址是回环，但 `Host` 仍是攻击者域名；只比较「Origin 与 Host 一致」会放行这种跨站写（实测可改自定义终端 argv ≈ 本机代码执行），所以 `Host` 为空或非回环一律 403，读写都覆盖。**严格同源**：写请求要求 `Origin.host:port === Host`（不只是「都是回环」——`other-port.localhost` 也能发跨源简单 POST）、`Content-Type` 含 `application/json`（浏览器的跨源简单请求免预检，只认 JSON 才能靠预检挡住）、`sec-fetch-site: cross-site` 一律 403、没有 `Origin` 却带 `Sec-Fetch-Site` 的按非面板处理。请求体 >1 MB 时在读 body **之前**就回 413（直接 `destroy` 会让客户端看到 `ECONNRESET`，既不是 413 也不可诊断，而且早拒的 413 不会执行 body 里的操作）；`isLoopbackHost` 严格匹配（`localhost` / `::1` / `127.0.0.0/8`，`127.0.0.1.evil.example` 不算）；非 GET / POST 回 405，坏 JSON 回 400。
- `/envdock-api` 的 `commandTool.scopes` 逐会话给终局：`id` / `kind` ∈ `takeover` / `host` / `yield` / `sandbox-host`，字段 `tool` / `hostTool` / `hostTools` / `ownVisible` / `hideOwnPlanned` / `visible` / `hidden` / `leaked` / `hidesOwn` / `confined`（三态）/ `policyKnown` / `mode` / `anomaly`。事实按「此刻实际能不能用」现测推导（不按计划意图）：`anomaly` = 零命令工具 / 接管下宿主仍可见 / 挡了却仍可见 / 同名工具不是我们登记的。`hostOnlyScopes` / `sandboxHiddenScopes` / `scopeAnomalies` 都从这份事实推导（面板不再拿它们凑数字）。`commandTool.hostName` 也取自这份事实：所有会话 `hostTools` 的并集只有一个名字时就是它（dsh-ops 场景报 `ops_bash`），否则退回运行时登记的 shippedName。`sandbox.scopes` 同样带 `confined` 三态与 `policyKnown`。
- 诊断计数（`syncStats`）：`registerTries` / `registers` / `disposes`、`delegateTries` / `delegateCalls` / `delegateFailures` / `delegateRefusals` / `delegateRunnerFailures` / `delegateAborts`、`ownHides` / `hostDenyApplies` / `denyNoops` / `transientMisses`、`yieldTicks`、`guardDenials` / `guardReady` / `guardError`、`steadyNow` / `steadyPrev` / `steadySinceAt` / `steadyTicks` / `lastErrorAt`、`detections` / `lastDetectMs`、`executorFamily` / `executorFamilySource`、`runtimeShellTools` / `hasExecutableApi`、`scopeAnomalies`。`steadyNow` 是状态、`steadyPrev` 是上一轮状态、`steadyTicks` 只是累计量——面板不能拿累计量冒充「现在稳态」。委托计数：进入委托路径 +1 try，目标 / 执行器不支持 +1 refusal，只有命令真的执行 +1 call，runner 坏了 +1 runnerFailed，取消 +1 aborted。
- 面板头部只挂**一个** badge，词表见下一节「面板结构」。新旧 API 按「`commandTool.scopes` 字段在不在」判：新构建零会话给 `scopes: []`（面板写「当前无会话」）；旧构建没有该字段时只出现一条「接口是旧版构建，逐会话信息不可用；重启 dsh 后可显示」的备注，终局只能按汇总事实给（宿主工具挡不掉而 `envd_shell` 仍可见 → 「工具并存」），**不再**把 `hostOnlyScopes` 与 `sandboxHiddenScopes` 相加凑「约 N 个」。

## 面板结构

`client.js` 的 `EnvDockPanel` 按「一屏说四件事」组织：这台机器默认用哪个终端、模型手里的命令工具是什么、装了哪些工具、有没有问题（**只在 Web 有**：`dsh.client.platform` 只注册 `web`；`tui` / `headless` 装得上但没有面板，简报与 `envd` 工具照常生效）。

### 信息架构

常显只有四块，其余全在触发器后面：

1. **头部一行**：插件名 · 默认终端与版本（`envd-headline`，如 `Git Bash v5.3.15`）· **恰好一个**状态 badge · 右侧「重新探测」。问题数**不**在头部——它的位置在工具链末尾的环境检查行。
2. **置顶接管卡**，自上而下：
   - `终端` chips（自动 / 各终端 / `+` 自定义终端，`+` 展开路径 + 名称 + 参数模板）；
   - `命令` 行：实际命令工具名 + 一句会话计数（单会话只写 `1 个会话`；终局种类 > 1 才加分解 `3 个会话 · 2 直连 · 1 沙箱`）+ 右侧 会话 / 设置 / 详情 三个 ghost 按钮（没有逐会话事实时没有「会话」）。**状态词只在头部 badge 出现一次**，命令行不再挂同文胶囊；
   - 常显备注：每行一句，`muted` / `warn` / `bad` 三档（旧版接口、宿主工具在会话层注册无法遮挡 / 已让路、N 个会话看不到 `envd_shell`、策略未知、N 个会话被围栏、最近错误）。备注只讲**原因**，后果由逐会话行的原因列表达；
   - 设置（默认收起）：接管模式 3 个 chip + 沙箱下接管 2 个 chip，各带组名与 `aria-label`；
   - 逐会话（默认收起，**有异常就自动展开**）：终局相同的会话**合并成一行**（`id1 · id2 · id3`，超过 4 个显示 ` +N`）· 终局 · 工具名 · 原因；完整 id 与「已挡 xxx」在分组的悬停提示里，异常组标红且排最前；
   - 详情（默认收起）：一行对账计数摘要 + 备注条目（红条目只给 `bad`）+ 已识别宿主工具 chips（来自 `syncStats.runtimeShellTools`，`learned` 带 ✦ 标记；默认 0 个 chip）。
3. **工具链**：一行一个工具（分组 / 名称 / 版本 / 路径可点复制 / 行尾「N 个版本 ▾」），版本管理器一行一个（激活版本带 ←），末尾「+ 自定义工具」入口；**环境检查收在工具链末尾一行**：健康时 `✓ 通过`，有问题时 `⚠ N 项` + 第一条标题，点开展开列表。
4. **环境简报一行**（状态 / 复制 / 展开）与**底部一行**：简报注入开关（`!data` 时不渲染，避免 403 时显示假「关闭」）、允许局域网访问开关（403 时仍可点）、复制反馈（`role=status`，`aria-live`）、环境脚注（系统 · 架构 · 主机名 · 更新于）。

### 常显 / 折叠边界

| 内容 | 默认 | 理由 |
|---|---|---|
| 头部、接管卡片的两行标签、工具链、底部 | 常显 | 四个问题必须第一眼能答 |
| 一次一句的**备注** | 常显 | 「坏了 / 为什么是这样」必须一行说完，不能让用户去别处找 |
| 接管设置、逐会话、详情 | 收起（逐会话在**有异常时自动展开**） | 只在排障时需要；异常不许被折叠藏住 |
| 多版本候选 | 收起 | 只有切版本时才看 |
| 环境检查列表 | 收起（健康时根本不出现） | 没问题时只值一行「✓ 通过」 |
| 简报正文 | 收起 | 长文本，看一眼原文才需要 |

「一屏」的量纲是 720px 高的窗口（可用约 600px）：常显内容基本不需要滚动；高度压力靠「每块一行」而不是缩小字号解决。

### 状态词表

面板只有一个状态结论，badge 与卡片状态词用同一句、同一个色调（`statusTone`），按严重程度取一个：

| `kind` | 文案 | 色调 | 什么时候 |
|---|---|---|---|
| `anomaly` | `N 个会话异常` | bad（红） | 有会话零命令工具 / 接管下宿主仍可见 / 挡了却仍可见 |
| `mixed` | `N 个会话未接管` | warn（黄） | 部分会话直连、部分不是（数字 = 非直连会话数） |
| `conflict` | `工具并存` | warn | 拿不到逐会话事实且宿主工具挡不掉、`envd_shell` 仍可见 |
| `yield` | `让路` | warn | 全部会话都在让路 |
| `takeover` | `接管中` | ok（绿） | 工具注册成功且没有会话落到「未接管」 |
| `host` | `未接管` | muted（灰） | 全部会话都没接管 |
| `sandbox` | `沙箱` | muted | 全部会话都被围栏 |
| `none` | `无命令工具` | muted（灰） | 一个命令工具都没探测到（没接管、也没有宿主 shell） |
| `broken` | `无命令工具` | bad（红） | 工具本该可见，会话里却什么命令工具都没有 |
| `reuse` | `由其它插件提供` | muted | 同名工具不是我们登记的那一个 |

### 只有 1 个 badge 的理由

- **一个结论胜过两个**：头部 badge 与卡片状态词说同一句话，用户不会读到「绿色接管中」+「黄色 N 个会话未接管」这种自相矛盾的两行。
- **胶囊只给状态，且全局只有一个**：终端、接管模式这些**选择**用 chip（`aria-pressed` 表达选中），状态只用头部 badge 表达（`.envd-statuschip` 已删除）；同一个结论不在第二处复述。
- **计数降级成一句话**：`3 个会话 · 2 直连 · 1 沙箱` 比五个数字好读，也避免「合计对不上」这类争论；完整字段留给 `/envdock-api`。
- 旧的二级 badge（「N 个会话用宿主工具」「N 个会话命令工具异常」）在重做时合并进这一句结论：混合与异常是**不同严重程度**的同一件事，分两个胶囊只会让人猜哪个更严重。

### 异常必须一行说完

- 备注行：把「为什么」写在同一行，`bad` 只留给硬故障（最近错误 / `envd_shell` 不可见），`warn` 留给设计内终局（让路 / 并存 / 被挡），`muted` 留给「按保守处理」的事实（围栏 / 策略未知）。
- 逐会话行：异常行 `data-kind` + `bad` 类 + 行尾 `envd-sreason`（看不到命令工具 / 宿主 X 仍可见 / 对账异常），`title` 里带全量文本，长名字用省略号而不是截断数据。
- 详情摘要：`diagSummary` 先说硬故障（`N 个会话异常` / 最近错误），健康时就是一句「对账正常」——**不重复**常显备注已经说过的话。

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
node test/panel-render.mjs   # 用极简 React 运行时替身渲染面板，断言结构 / 文案 / 交互（194 条）

node test/simulate.mjs --help   # 手动验证:起假宿主跑真实 index.js，打印 /envdock-api 快照
```

测试共用一套**可复用夹具** `test/fixture/host.mjs`：假 Cordis 服务（`tools` / `webServer` / `slots` / `subprocess` / `shell` / `sandboxPolicy` / `locale`）+ 真实 `index.js`，状态文件写临时 `DSH_HOME`，不碰你真实的 `~/.dsh/envdock.json`；`subprocess` 用固定输出替身（本机沙箱不允许 Node 用管道 stdio 起子进程），所以每次探测起几个子进程是可数的——版本缓存的收益也在断言里。`simulate` 用同一套夹具把 `/envdock-api` 的完整 JSON 打出来（`--mode` / `--sessions` / `--host-tools` / `--unrestrictable` / `--executor` / `--delegate` 复现让路、并存、委托等场景，`--json` 便于管道）。

`panel-render` 不引入 React：桩掉 slots / locale / fetch，加载 `client.js` 捕获真实渲染树，断言 194 条——单 badge 与状态词一致、常显备注、折叠触发词、**异常会话自动展开**、一行一个工具、环境检查一行、长名字溢出、复制兜底、15 秒轮询去重与卸载清定时器。

`npm test` 只在**检出目录**可用：npm 包的 `files` 里没有 `test/`，从 npm 安装的插件没有这些自测可跑。

## 结构

```
index.js          Host：探测、envd 工具、简报注入、终端接替、/envdock-api
client.js         Client：侧边栏图标 + 中央面板
cordis.patch.yml  bundle patch（insert id: envdock）
locale/           meta.title / meta.description
icon.svg          插件图标
CHANGELOG.md      版本变更记录
test/parsers.mjs         版本管理器输出解析自测
test/i18n-check.mjs      client.js 静态自检（词条/占位符/slot）
test/fixture/host.mjs    共享宿主夹具（假 Cordis 服务 + 真实 index.js）
test/host-harness.mjs    Host 半边运行时夹具（替身服务，全链路）
test/simulate.mjs        假宿主跑真实 index.js，打印 API 快照（人工验证 / 管道）
test/panel-render.mjs    面板渲染回归（极简 React 替身，零依赖，194 条断言）
```

Host 半边**不 import 任何 `@deepseek-ai/*` 包**（本地目录安装是 link 检出，包内 import 解析不到 profile 的 node_modules），只用 `node:` 内置模块；命令探测走宿主的 `subprocess` 服务（只跑 `--version` 之类的只读探测，继承 dsh 的工作目录语义）。**接管出来的命令工具默认也走 `subprocess`，而且是唯一的安全理由**：`subprocess.spawn` 没有 `sandboxPolicy` 入口，所以围栏会话绝不自己 spawn。围栏下的降级路径是**委托**：把命令交给带围栏的 `ctx.shell`（`resolve` + `execute`，命令数据经 base64 通道传入——bash 目标 `ENVD_CMD`，PowerShell 目标从 `$env:ENVD_CMD` 解 UTF-8 base64 再 `Invoke-Expression`，宿主命令行里不出现用户命令），围栏挂在宿主进程上、子终端继承，`sandbox.denied` 也如实回显给模型。

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
- 围栏下的委托按阶段记账（解析 / 启动 / 执行 → `delegateFailures`）：执行器 runner 不可用时 `delegateRunnerFailures` +1、`ok:false` 并在输出里标 `[sandbox]`，不伪装成「命令跑完但失败」；命令被取消记 `delegateAborts`。
- 委托执行只支持 **bash / PowerShell 目标**：cmd / WSL / 自定义终端目标没有安全路径（命令会静默不执行），一律拒绝。PowerShell 5.1 作为宿主仍然安全——命令走 `ENVD_CMD` 的 base64 数据通道（`-Command` + `Invoke-Expression`），不拼命令行；但 cmd 目标就是不支持委托。
- 工作目录取**当前会话的工作目录**（不是 dsh 进程 cwd）。
- 探测结果在内存里缓存 45 秒，只有默认终端 / 自定义终端 / 默认版本 / 自定义工具的写入会让它立即失效；「重新探测」强制重扫并清空版本号缓存（版本号本身缓存 10 分钟，key 含 mtime+size）。
- 宿主命令工具必须**此刻真的可见**（或仍在我们自己的遮挡里）才算存在：见过之后又消失会立刻接管兜底；从没见过宿主时给约 60 秒宽限，避免和晚注册的宿主插件抢。
- 面板只在 `web` profile 注册；npm 上发布的包可能落后于仓库，最新功能请用本地目录 / Git 安装（版本号以仓库 `package.json` 为准）。
- 面板每 15 秒静默轮询一次（仅页面可见时），数据最多滞后一个周期；payload 比较会剔除易变计数，所以计数变化本身不一定触发重渲染。
- 探测过期只走 stale-while-revalidate，所以「最后一次数据」可能比系统事实慢一个刷新周期；显式作废与「重新探测」不受影响。
- 宿主把命令工具注册在作用域私有层时 `restrict` 挡不掉它（契约：restrictions "do not affect scoped registrations"）：EnvDock 只能让路。结构性挡不掉的名字 10 分钟重试、不写 `lastError`；临时性的 30 秒重试。dsh-ops 的 `ops_bash` 属于前者，想让 EnvDock 接管需要在 dsh-ops 设置里关掉 Publish Bash。
