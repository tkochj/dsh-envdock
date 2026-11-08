# EnvDock 设计说明

面向要读代码、改代码的人。用户向的安装与使用说明见 [README](../README.md)。

## 目标

Windows 上做开发时，机器上往往并排躺着好几套 Node / Python / Git，cmd、PowerShell、Git Bash 又在混用。EnvDock 要回答四个问题，并把答案交给 AI：

1. 工具装在哪（全部候选路径，而不是 PATH 上第一个）
2. 是什么版本
3. 该用哪个（用户选定的默认版本）
4. **这个会话里**命令该怎么写（按**语法族**回答，见「两族：选族与遮挡」）

0.6 的核心是**两族**：bash 族（宿主 `bash` / `sh` / `zsh` / `fish` / `ops_bash`）与 PowerShell 族（宿主 `pwsh` / `powershell`）。cmd 与自定义终端不参与自动选族，也不被遮挡。

同时保证：**只增不减**仍是默认——EnvDock 不隐藏、不禁用任何已有工具，只**增补**一个用你终端/PATH 的命令入口（`envd_shell`）；注册条件不满足时只做简报与展示，绝不把用户锁在没有命令工具的状态里。**0.6 的唯一例外**是：bash 族会话里遮挡另一族的**内置** PowerShell 命令工具（`pwsh` / `powershell`）。例外有明确边界——只针对内置名、只在会话族是 bash 且该会话确实看得到 bash 族宿主工具时生效、开关 `blockOtherFamily` 可关闭；bash 族名字与启发式认出的第三方名字永不被遮挡。

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
- **选择性失效**：只有影响探测结果的写入（`defaultShell` / `customShell` / `selections` / `customTools`）才 `invalidateDetection()`；改 `allowLan` 之类的选项不再让面板白跑一次全量重扫。
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

## 命令工具增补（assist model）

0.6 的核心决定：**按会话只暴露一个语法族**。0.5 的「只增不减」保留为默认（EnvDock 仍然只增补 `envd_shell`，不隐藏、不禁用别人的工具），但有一个明确例外：**bash 族会话遮挡另一族的内置 PowerShell 命令工具**。0.5 的完整规格见 `docs/notes/assist-model.md`——该文已标注为历史文档，其中「不调用 `restrict`、不注册 `guard`」的硬不变量已废除。

### 注册条件

三条同时满足才注册（`reconcile()` 每个 tick 复核一次，状态一变就立刻重算）：

1. **主族终端可用**：主族 = **生效族**（手动族可用时就是手动族；手动族不可用会回退 `auto`，见「两族」；`auto` 时按本机宿主工具并集判定，有 bash 族 → bash 族，否则 PowerShell 族）。解析出的终端有可用 path，否则 `skipReason='no-family-terminal'`。
2. **沙箱允许**：没有沙箱执行器（`ctx.shell` 不存在）或执行器不围栏时直接注册；有围栏执行器时，要求**至少一个会话** `sandboxPolicy.resolve` 出 `danger-full-access`——否则注册了也只能在围栏会话里被拒绝，等于死工具（`skipReason='no-unconfined-session'`）。
3. **名字没被占**：`envd_shell` 不在工具表里，且 `ctx.tools.register()` 不抛错、注册后在表里确实是**我们那个定义对象**（登记身份，`tools.get(name) === ownDefinition`）；被别的层盖住算 `taken`，注册抛错算 `error`，失败按 30 秒退避重试，`tools/change` 时跳过退避立即重试。

0.6 删除了原来的「家族不重复」条件与 `skipReason='same-family'`：同一个 shell 出现两份不再算「重复提供」——bash 族会话里 `envd_shell`（Git Bash）与宿主 `ops_bash` 并存是按族划分的预期状态，简报写分工（你的 PATH/终端 vs 后台作业/提权参数）。

注册 / 拆除**只由状态变化驱动**（终端、宿主工具、沙箱任一变化）；稳态 tick 零注册表动作。名字固定成 `envd_shell`（不跟终端走）：切终端只改执行方式，不拆建、不留工具表空窗。

### 执行语义与围栏拒绝

- **按调用会话的族取终端**：bash 族会话用 bash 族终端（本机的 bash 族终端是 Git Bash）；手动 `cmd` / `custom`（无族）或还没判过族的会话按全局默认终端。所以同一台机器上不同会话的 `envd_shell` 可能跑在不同终端里——这正是「每会话一个语法族」的意思。该族**没有可用终端**时明确拒绝并指路（返回 `[terminal]` 文案），不会静默换成另一族的 shell。
- **无围栏**：`ctx.subprocess.spawn` 直跑（工作目录取当前会话，输出截断，支持 `cwd` / `timeoutMs`）。
- **本会话被围栏**：**直接拒绝**，不 spawn、不委托——`ctx.subprocess` 没有 `sandboxPolicy` 入口，自己跑就是绕过沙箱。每一单都按本会话策略复检（检查周期 5 秒，策略可能在这期间变严），被围栏或策略不可知时返回：
  ```
  [sandbox] 本会话被宿主沙箱围栏(<mode>);EnvDock 的 envd_shell 不执行命令。
  请改用宿主工具(宿主自带的命令工具,它在围栏内可执行)。
  ```
- 沙箱事实分三层：**能力位**（执行器会不会围栏）/ **部署默认档**（`shell.sandboxMode`，只用于展示）/ **本会话有效策略**（逐会话 `sandboxPolicy.resolve({ session })`）。合法策略是闭集 `read-only` / `workspace-write` / `danger-full-access`；resolve 返回 `{}`、空 mode 或闭集外的值一律按「策略不可知」处理，并按「被围栏」保守拒绝——**绝不回落到部署默认档**（回落会让围栏会话被当成无围栏直接 spawn）。
- 删除：`delegatedInvocation` / `runDelegated` / 全部 `delegate*` 计数与包装器、`executorFamily`（0.5 起的精简执行器仍是唯一执行路径）。

### 宿主命令工具的识别

每个 tick 逐 agent 枚举 `tools.definitions(agent)`（取并集，名字有界 ≤64），用**既有**的家族识别（`shellFamilyFromDefinition` + `SHELL_TOOL_FAMILY`）得到 `hostTools: [{ name, family, learned }]`，排序稳定（内置顺序优先，其余按名字）。`learned` 的语义是「按描述 / 参数启发式认出来的，不是内置名单」。

- 内置表命中就短路：`ops_bash`、`pwsh`、`bash`、`cmd`、`wsl` 等按内置家族认领，不要求 command 参数；「名字 token + command 参数」那道门槛只约束第三方发布名。
- **只有命令参数不够、名字带 cmd 也不够**：`run_cmd`（task 参数）、`wc_cmd_palette`（UI 面板）这类会被排除，否则详情里会凭空多出一条假命令工具。
- 0.6 起这个名单**不再只用于展示**：它决定会话选族（有没有 bash 族 → bash / PowerShell 族）与遮挡目标。但遮挡名单只含**内置** PowerShell 名（`pwsh` / `powershell`）；`learned` 为真的 PowerShell 族名字只展示，认不出来只是少一条 chips。

### 两族：选族与遮挡

两族：

- **bash 族** = 宿主 `bash` / `sh` / `zsh` / `fish` / `ops_bash`（含启发式认出的第三方 bash 名）；
- **PowerShell 族** = 宿主 `pwsh` / `powershell`；
- `cmd` 与自定义终端不参与自动选族、也不被遮挡；WSL 手动选时按 bash 语法算（进去跑的就是 bash）。

**自动选族（按会话、判定即锁定）**：会话首次出现在对账里时，能看到 bash 族宿主工具 → bash 族，否则 PowerShell 族；判定后锁定。只在**首次判成 PowerShell 族后的 10 秒内**允许升级一次（兜住 dsh-ops 晚挂载 `ops_bash`）；过了窗口或已经升级过就不再改，避免族来回抖动。无会话时（面板 / API）：任一会话为 bash 族或宿主并集含 bash 族工具 → bash 族，否则 PowerShell 族。

**手动选族**：`defaultShell` 非 `auto` 时所有会话按手动族——`pwsh` / `powershell` → PowerShell 族，`bash` / `wsl` → bash 族；`cmd` / `custom` 时手动族为空，所有会话按「无族」处理（计入 `sessions.other`），不选族也不遮挡。

**手动族不可用 → 回退 auto 并警告**：`defaultShell` 指定的是 bash / PowerShell 族，但**该族没有可用终端**、且**所有会话的宿主工具里都没有该族工具**时，生效族回退成自动选族（会话按自动规则重判，`familySource` 变回 `auto`），并置 `familyFallback=true`。否则面板写着「bash 族」、实际连一个 bash 都跑不了，模型会照着简报写错语法。探测还没就绪时不判不可用（避免启动瞬间来回抖）；手动 `cmd` / `custom` 不参与这条规则（它们本来就不选族）。回退是**逐次对账重算**的：该族恢复可用（装上终端或出现该族宿主工具）后自动回到手动族，不需要改设置。回退后简报与面板都会说明原因。

**遮挡（`blockOtherFamily` 默认开）**：三条同时成立才遮挡——开关开 + 会话族 bash + 该会话看得到 bash 族宿主工具。目标是内置 PowerShell 名 `pwsh` / `powershell`：

- 可 restrict 的（继承层）用 `tools.restrict({ deny })` 直接从工具表隐藏；`restrict` 只在 **agent 作用域**调用（根层调用会抛错），失败时不崩溃——`guard` 仍然兜住执行侧；
- 发布在 agent 自有层、`restrict` 挡不掉的，只用 `guard` 在 dispatch 前拒绝执行（不 spawn）；
- 启发式认出的 PowerShell 族名字**只展示、永不遮挡**；bash 族名字**永不遮挡**。

遮挡是**粘性**的：一旦某个 bash 族会话遮过 `pwsh`，之后即使 bash 族宿主工具（如 dsh-ops 的 `ops_bash`）暂时消失，会话族仍是 bash（锁定）、`pwsh` 也保持隐藏——否则工具表会在会话里反复闪。粘性一直保持到「重新探测」、开关关闭或会话族真正变化。

**「重新探测」是两族重判的边界**：显式刷新探测（面板「重新探测」/ `envd` 工具的 `refresh` / API `refresh`）会让族代数（`epoch`）+1，下一次对账作废**所有会话的族锁定与遮挡记忆**，按当下的工具表重新判定，并把重判排到下一轮事件循环立刻落地（不等 5 秒 tick）。45 秒 TTL 自动过期与切终端 / 改选项这类普通状态写入不涨代数，不动族锁定与遮挡记忆。

撤销：开关关闭、会话族变化、agent disposed、插件卸载。

**手动 PowerShell + 会话里有 `ops_bash`**：不遮挡，简报 / 面板警告「两族同时可见，各按自己的语法写命令，不要混写」。

### 简报口径

简报按**会话**写：同一个 dsh 进程里，bash 族会话与 PowerShell 族会话拿到的「命令工具」那行不同（族、看得到的工具、遮挡结果都按本会话算）。禁止再说「已接管 / 让路 / 沙箱下接管」。示例（随机器与族变化）：

- bash 族、已注册：`· 命令工具(bash 族): 宿主 ops_bash + envd_shell(EnvDock 增补,Git Bash,同语法)`，并写执行分工——需要你机器上的版本（node / pnpm / python / git）用 `envd_shell`，需要后台作业或沙箱提权参数用宿主工具。
- PowerShell 族、手动选择：`· 命令工具(PowerShell 族,手动选择): …`；宿主 `pwsh` 与 bash 族工具并存时追加「两族同时可见，各按自己的语法写命令，不要混写」。
- 遮挡生效：补一句 `PowerShell 族宿主工具已隐藏(pwsh),不要调用 pwsh`；只有 guard 挡不掉（自有层发布）时改成「(`pwsh`) 在本会话调用会被拒绝」。
- 开关关闭（`blockOtherFamily=false`）：不遮挡；bash 族简报写 `PowerShell 族宿主工具未隐藏(pwsh),两族同时可见,各按自己的语法写命令,不要混写`。手动 PowerShell 且会话里有 `ops_bash`：不遮挡，简报写「两族同时可见，各按自己的语法写命令，不要混写」。
- 手动族回退 auto：补一句 `;手动选择的族不可用(该族既没有终端、也没有按该族发布的宿主工具),已回退自动选族`。
- 未注册：按 `skipReason` 写原因（`no-family-terminal` / `no-unconfined-session` / `taken` / 注册失败）；只说事实，不再有「与 X 同族，不重复提供」。
- 本会话被围栏：追加拒绝提示与**同语法**的出路（有 bash 族宿主工具就指向它，没有就直说没有）。
- 只展示的（启发式认出的 PowerShell 族名字）单独列一句，声明未遮挡。
- 末尾两行保持：工具绝对路径与版本、`envd` 只能解析已探测工具。

## 与 dsh-ops 的兼容

同一台机器上 EnvDock 与 dsh-ops 常一起用（dsh-ops 的 cordis 模式会把官方 `pwsh` 换成 `ops_bash`）。0.6 之后共存仍然**不需要任何设置**，但两者的分工变了：

- **`ops_bash` 按 bash 族认领**：它发布在 **agent 自有层**，EnvDock 永远 `restrict` 不掉它，也不会去挡它（bash 族名字永不遮挡）。它决定会话选族（有 `ops_bash` → bash 族），并作为「该会话看得到 bash 族宿主工具」的依据让遮挡成立。
- **两层保护，单调叠加、不冲突**：dsh-ops 的 `deny-host-shell` 是 **guard**（dispatch 前拒绝），EnvDock 是 **restrict + guard**（继承层可 restrict 的直接隐藏，自有层挡不掉的才用 guard 拒绝）。同时开启时会有两层遮挡——同一批内置 PowerShell 名既被 EnvDock 挡、也被 dsh-ops 挡，**重复但无冲突**，不需要改 dsh-ops 配置。
- **不再有「Publish Bash」这类话术**：两者并存即可，EnvDock 不争工具表；`ops_bash` 与 `envd_shell` 同属 bash 族，同时可见是**按族划分的预期状态**，分工写在简报里（需要你机器上的版本用 `envd_shell`，需要后台作业 / 提权参数用宿主工具）。
- **借鉴来的做法仍在**：① 事件驱动（`tools/change` + 40ms 合并定时器）只用于「重新识别宿主工具 + 必要时重挂/拆自己的工具」，不做对账循环；② 登记身份（`tools.get(name) === 我注册的定义对象`）——同名工具被别的层盖住时，名字还在不代表是我们的，不能认领别人的发布生命周期；③ 宿主没有 `tools.definitions` 时按内置候选名各探一次可见性，名字集合有界。
- **不学的部分**：dsh-ops 的 `ops_bash` 同样走 `ctx.subprocess`（没有 `sandboxPolicy` 入口），所以 EnvDock 自己的执行闸门原样保留：围栏会话绝不直连，只能拒绝。

## 状态与面板 API

- 状态文件 `~/.dsh/envdock.json` 原子写：先写同目录临时文件再 rename，进程中途被杀不会留下半截 JSON。
- 真的损坏时回落到全自动、把原文件备份成 `envdock.json.corrupt`，并在面板健康检查里给一条 issue（改一次设置即写回正常文件）。
- **非法选项写不进去**：`setShell` 只接受真实探测到的终端名（`auto` 或某个终端 key）；`setOption` 只认白名单（`injectBrief` / `allowLan` / `blockOtherFamily` 一律归一成布尔），手滑的 key/字符串不会再永久写进状态文件。`shellTakeover` / `sandboxTakeover` 在 0.5 已删除：旧状态文件里出现时忽略（不报错、不迁移）。
- 面板 API 默认只放行 loopback：数据含本机绝对路径与终端。打开「允许局域网访问」（`allowLan`）后**局域网只能读**（GET）；所有写操作只允许本机，唯一例外是同源页面把 `allowLan` **关掉**（`Origin.host:port` 必须与 `Host` 完全一致，避免任意网页替用户关掉）。理由：写操作能改默认终端 argv，等于把命令注入面开到局域网。
- **API 加固**：回环来源必须配**回环 Host 字面量**——攻击者把自己的域名重新解析到 `127.0.0.1`（DNS rebinding）后来源地址是回环，但 `Host` 仍是攻击者域名；只比较「Origin 与 Host 一致」会放行这种跨站写（实测可改自定义终端 argv ≈ 本机代码执行），所以 `Host` 为空或非回环一律 403，读写都覆盖。**严格同源**：写请求要求 `Origin.host:port === Host`（不只是「都是回环」——`other-port.localhost` 也能发跨源简单 POST）、`Content-Type` 含 `application/json`、`sec-fetch-site: cross-site` 一律 403、没有 `Origin` 却带 `Sec-Fetch-Site` 的按非面板处理。请求体 >1 MB 时在读 body **之前**就回 413（直接 `destroy` 会让客户端看到 `ECONNRESET`，既不是 413 也不可诊断）；`isLoopbackHost` 严格匹配（`localhost` / `::1` / `127.0.0.0/8`，`127.0.0.1.evil.example` 不算）；非 GET / POST 回 405，坏 JSON 回 400。
- `/envdock-api` 的 `commandTool` 现在回答「模型在**这个会话**里到底能用什么」：注册了吗（`registered` + `skipReason`）、当前族与来源（`family` / `familySource`，来源是 `auto` 或 `manual`；手动 `cmd` / `custom` 时 `family` 为空）、手动族是否回退（`familyFallback`）、逐会话族的**聚合计数**（`sessions`：`total` / `bash` / `powershell` / `other`，只报数量、不外泄逐会话账本）、被隐藏的名字（`hidden`，`tools.restrict` 已生效）、只能拒绝的名字（`refuseOnly`，agent 自有层发布、`restrict` 挡不掉）、只展示的名字（`displayOnly`，启发式认出的 PowerShell 族）、是否两族同时可见（`mixed`）、开关当前值（`blockOtherFamily`），以及既有的 `shell{label,family,version,path}` / `refuseWhenConfined` / `hostTools[{name,family,learned,group}]` / `sandbox{...}`。0.5 删掉的 `scopes` / `kind` / `hostName` / `denies` 仍然不存在——遮挡只报**结果**（谁被藏了、谁只能拒绝），不报逐会话账本。载荷顶层另有 `family` / `familySource` / `familyFallback`（全局默认族、来源与回退标志），面板没有具体会话时用它（`shell` 行也按它解析，保证与简报的「默认终端」一致）。
- `sandbox` 顶层仍是聚合值：`{ present, capable, defaultMode, policyKnown, sessionCount, confinedCount, anyUnconfined }`（无 `scopes`）。`confinedCount` 只用于面板的「N 个会话被围栏」与简报追加句。
- `syncStats` 收敛为 11 个字段：`ticks` / `lastAt` / `intervalMs` / `detections` / `lastDetectMs` / `hostToolScans` / `registerTries` / `restrictApplied` / `guardRefusals` / `lastError` / `lastErrorAt`。它们是**稳态证据**：`ticks` 涨而 `registerTries` / `restrictApplied` 不涨，说明注册表与遮挡都没被反复拆建；`guardRefusals` 只在模型真的去调被拒绝的内置 PowerShell 名时才涨。
- **过渡期旧版 API**：client.js 是热更新的，宿主进程里的 index.js 要重启 dsh 才换。旧载荷没有 `registered` / `hostTools`，也没有 0.6 的 `family` / `familySource` / `familyFallback` / `sessions` / `hidden` / `refuseOnly` / `displayOnly` / `mixed`；面板用旧的 `visible` 推断注册、用旧 `hostName` 填宿主工具，并显示「接口是旧版构建，重启 dsh 后可显示命令工具信息」——不把不知道的事说成「`—` / 未识别到」。

## 面板结构

`client.js` 的 `EnvDockPanel` 面向「第一次打开面板」的用户：首屏只回答四件事——这台机器用哪个终端、这一轮该写哪套语法、装了哪些工具、有没有问题；技术细节（计数、`hidden` / `refuseOnly`、开关语义）收进「详情」与「高级设置」。**只在 Web 有**：`dsh.client.platform` 只注册 `web`；`tui` / `headless` 装得上但没有面板，简报与 `envd` 工具照常生效。

### 术语：首屏不用内部黑话

首屏默认信息里不出现「族 / 宿主 / 围栏 / 增补」（`panel-render` 会把「宿主 / 围栏 / 增补」钉死不存在；边界备注也一律说「bash 命令工具 / PowerShell 命令工具」，不写「族」）：

| 内部说法 | 面板首屏 |
|---|---|
| 语法族（bash 族 / PowerShell 族） | `bash 语法` / `PowerShell 语法`（两族模型本身见「两族：选族与遮挡」） |
| 宿主命令工具 | `其它：ops_bash` 这类「其它命令工具」 |
| 围栏 / confined | `受沙箱限制` |
| 增补出来的 `envd_shell` | 直接叫 `envd_shell`（不写「增补」） |

技术词仍保留在「详情」与「高级设置」里，以及本文的模型章节；面板日常说明一律白话。

### 信息架构

首屏四块（头部 + 命令卡 + 工具链 + 环境简报）+ 折叠项（命令卡里的「详情」与独立的「高级设置」），footer 只放反馈与脚注：

1. **头部**（`envd-headblock`）：图标 + `EnvDock` · 默认终端名与版本（`envd-headline`，如 `Git Bash v5.3.15`）· **恰好一个三态**状态 badge（`就绪` / `受限` / `只展示`，**不带族后缀**，悬停给出原因）· 右侧「重新探测」。下面常显**一句用途**：「告诉 AI 你的工具装在哪、用哪个版本、命令该写哪套语法。」问题数**不**在头部——它在工具链末尾的环境检查行。
2. **置顶「命令工具」卡**：
   - `终端` chips：`自动` / 各终端 / `+` 自定义终端（`+` 展开路径 + 名称 + 参数模板）。chips **只显示终端名，不带族小标**；`自动` 的悬停说明是「按会话自动选语法族（推荐）」。
   - `命令` 行：语法标签（`bash 语法` / `PowerShell 语法`；**手动选择时才带「· 手动」**，自动不带后缀）· `envd_shell`（没提供时写 `—`）· `其它：ops_bash · pwsh`（没有就写「没有其它命令工具」）· 右侧「详情」。
   - 备注（最多两行，全白话）：没提供的原因 / `N 个会话受沙箱限制：envd_shell 在那些会话里不会执行命令，请改用其它命令工具` / `已隐藏 pwsh（避免两套语法混用）` / `手动选了 PowerShell 语法：PowerShell 与 bash 工具都在，各按自己的语法写，别混用` / 环境差异提示。
   - 详情（默认收起）：见「详情与轮询」。
3. **工具链**：一行一个工具（分组 / 名称 / 版本 / 路径可点复制 / 行尾「N 个版本 ▾」），版本管理器一行一个（激活版本带 ←），末尾「+ 自定义工具」入口；**环境检查收在工具链末尾一行**：健康时 `✓ 通过`，有问题时 `⚠ N 项` + 第一条标题，点开展开列表。
4. **环境简报**：一行「已注入给 AI / 未注入」+ **行内注入开关** + 复制 + 展开；展开才显示简报正文。开关挪到这里之后，底部 footer 不再重复同一件事。
5. **高级设置**（默认收起）：展开后是「隐藏另一族命令工具」（`blockOtherFamily`，默认开；可见说明一行「bash 会话里隐藏 PowerShell 的 pwsh / powershell」，「关掉则两族同时可见」在悬停里）+「允许局域网访问面板 API」。两个不常动的开关从首屏收走。
6. **底部 footer**：有数据时**零开关**——只剩复制反馈（`role=status`，`aria-live`）与右侧平台 / 更新时间脚注；拿不到数据（403 / 接口没响应）时简报区不存在，「允许局域网访问」开关保留在 footer 作为**唯一入口**（否则用户没有解法）。

### 已删除的渲染

接管期语义早就删除：接管模式 / 沙箱下接管 chips、逐会话表、状态胶囊 `.envd-statuschip`、异常 / 让路 / 工具并存渲染、`kind` 推导。0.6.1 再删一轮「技术味太重」的装饰：终端 chip 上的族小标、badge 的族后缀、底部与简报区重复的开关、首屏的「族 / 宿主 / 围栏 / 增补」措辞。面板仍然只有一处状态结论，也不重新引入逐会话表。

### 三态 badge

面板只有一个状态结论，由「是否提供且可见」+「有没有会话受沙箱限制」推出（文案是白话，不挂族）：

| 条件 | 文案 | 色调 | 含义 |
|---|---|---|---|
| `registered && visible`，且 `confinedCount > 0` | `受限` | warn（黄） | `envd_shell` 提供了，但有会话受沙箱限制、在那些会话里不会执行命令 |
| `registered && visible`，没有受限会话 | `就绪` | ok（绿） | 命令入口可用 |
| 未提供（没有可用终端 / 没有不受沙箱限制的会话 / 被别的插件重名 / 注册失败） | `只展示` | muted（灰） | 面板只列其它命令工具，原因写在备注里 |

badge 的悬停文本 = 最多两条备注；badge 自身不挂计数、不带族。语法在命令行那一行说。

### 备注规则（最多两行，全白话）

- **没提供时**只说原因，按 `skipReason` 分支：`no-family-terminal` → 「没找到可用的终端（bash 语法需要 Git Bash，PowerShell 语法需要 pwsh）」；`no-unconfined-session` → 「没有不受沙箱限制的会话，暂时不会提供 envd_shell」；`taken` → 「和别的插件重名了，暂时不提供 envd_shell」；`error` → 「没能提供命令工具（注册失败）」。
- **受沙箱限制**：一行 `N 个会话受沙箱限制：envd_shell 在那些会话里不会执行命令，请改用其它命令工具`。
- **手动选的语法不可用**：一行 `手动选的语法不可用（没有对应终端，也没有对应命令工具），已自动改回按会话选择`。
- **两套语法同时可见**（手动 PowerShell + 会话里有 bash 工具）：一行 `手动选了 PowerShell 语法：PowerShell 与 bash 工具都在，各按自己的语法写，别混用`。
- **隐藏生效**：一行 `已隐藏 pwsh（避免两套语法混用）`；开关关掉时写「PowerShell 的命令工具没有隐藏（开关已关）」；手动 bash 但会话看不到 bash 命令工具时写「这个会话没有 bash 命令工具，未隐藏 PowerShell 工具」。
- **环境差异**：一行 `其它命令工具的环境和 PATH 跟你的终端可能不一样；要用你自己的工具时用 envd_shell`——没提供命令工具时不说这句（那时让人「用 envd_shell」是假话）。
- 备注是「一句人话 + 一个原因」，按上面的优先级截到两行；计数只出现在详情里。

### 详情与轮询

- 详情默认收起：`扫描 N 次 · 最近 Nms · 注册尝试 N`（只读 `syncStats` 白名单）+ 隐藏次数（`restrictApplied`）/ 拒绝次数（`guardRefusals`）+ 命令工具 chips（`learned` 带 ✦，被隐藏的标「已隐藏」，只能拒绝的标「调用会被拒绝」，启发式认出的标「只展示（没有隐藏）」）+ 最近错误（截断到 140 字符）。计数只在这里出现，常显区不放数字。
- 面板每 15 秒静默拉一次 `/envdock-api`，只在 `document.visibilityState === 'visible'` 时拉；payload 比较前剔除 `ticks` / `lastAt` / `lastErrorAt` / `now` / `updatedAt` 等易变键（否则每个 tick 都会被当成「有变化」重渲染）。复制优先 `navigator.clipboard`，局域网 http 退到 `textarea + execCommand('copy')`，失败给可见提示。

## 健康检查

红 / 黄 / 灰三档：

- 红：应用商店占位符（`looksLikeStoreStub`）、默认版本路径失效（`staleSelection`）、默认终端不可用、选了 Git Bash 但没找到 `bash.exe`、默认 Python 是 2.x。
- 黄：多版本并存、Node < 18、Python 3.x < 3.9、npm 与 Node 不匹配、PATH 有失效目录、版本管理器激活版本与 PATH 实际解析不一致。
- 灰：dsh 进程里的 PATH 是旧的（探测已按系统当前值刷新，重启只是让两边彻底一致）。

## 自测

```powershell
npm test                     # 五个自测一次跑完（只在源代码检出目录可用）

node test/parsers.mjs        # 版本管理器输出解析
node test/i18n-check.mjs     # 中英词条键/占位符一致、slot 注册仍在
node test/host-harness.mjs   # 用 Cordis 服务替身把 apply() 真跑起来，走完所有 API op / envd action / 注册 / 两族遮挡与围栏拒绝
node test/panel-render.mjs   # 用极简 React 运行时替身渲染面板，断言结构 / 文案 / 交互
node test/family.mjs         # 两族纯逻辑：选族 / 锁定 / 10 秒升级窗 / 手动族 / 遮挡名单 / 简报行

node test/simulate.mjs --help   # 手动验证:起假宿主跑真实 index.js，打印 /envdock-api 快照
```

测试共用一套**可复用夹具** `test/fixture/host.mjs`：假 Cordis 服务（`tools` / `webServer` / `slots` / `subprocess` / `shell` / `sandboxPolicy` / `locale`）+ 真实 `index.js`，状态文件写临时 `DSH_HOME`，不碰你真实的 `~/.dsh/envdock.json`；`subprocess` 用固定输出替身（本机沙箱不允许 Node 用管道 stdio 起子进程），所以每次探测起几个子进程是可数的——版本缓存的收益也在断言里。`simulate` 用同一套夹具把 `/envdock-api` 的完整 JSON 打出来，用来复现「注册 / 不注册 / 围栏拒绝 / 宿主工具识别 / 选族与遮挡」；参数随模型变，用 `--help` 看当前清单。

关键断言（0.6 的硬不变量）：

- **遮挡只针对另一族的内置名**：`restrict` 的 `deny` 集合恒为 `{ pwsh, powershell }` 的子集，只在「开关开 + 会话族 bash + 该会话看得到 bash 族宿主工具」时调用；bash 族名字与启发式认出的名字**永不出现**在 deny / guard 名单里。
- **「同族不重复提供」已删除**：`skipReason='same-family'` 在 API 与面板词条里都不再出现（断言不存在）。
- **注册三条件各有用例**：无主族终端 → `no-family-terminal`；无执行器 → 注册；全部会话围栏 → `no-unconfined-session`；有会话无围栏 → 注册；名字被占 → `taken`。
- **选族按会话并锁定**：会话首次判定后不再变；只有首次判成 PowerShell 族的 10 秒内允许升级一次；手动族覆盖自动族；`cmd` / `custom` 不被遮挡。
- **遮挡记忆与「重新探测」边界**（host-harness 5.5）：`ops_bash` 出现后消失，会话族仍 bash、`pwsh` 仍 hidden（不来回闪）；显式 refresh 后族与遮挡一起重判（family 回 powershell、hide 空、deny 空），TTL 过期不触发。
- **遮挡可撤销**：开关关闭 / 会话族变化 / agent disposed → 之前 restrict 掉的工具重新可见（restrict 返回的撤销句柄被调用）；guard 只拒绝、不 spawn。
- **围栏会话调用 `envd_shell`** → 拒绝、**不 spawn**、文案含「围栏」与「宿主工具」；无围栏会话照常执行，且 bash 族会话用的是 bash 族终端（夹具断言 argv）。
- **`/envdock-api`**：`commandTool` 有 `family` / `familySource` / `sessions` / `hidden` / `refuseOnly` / `displayOnly` / `mixed`，`syncStats` 为 11 项白名单（含 `restrictApplied` / `guardRefusals`）；0.5 的 `scopes` / `kind` / `denies` 仍不存在。
- **状态文件**：旧 `shellTakeover` / `sandboxTakeover` 被忽略（读取不报错、写回不保留）。

`family.mjs` 不依赖宿主夹具：选族、锁定、10 秒窗、遮挡名单与简报行都是纯函数，用表驱动用例钉住——「不挡 PowerShell 以外的名字 / 不挡 bash 名」这条边界最便宜的回归就在这里。

`panel-render` 不引入 React：桩掉 slots / locale / fetch，加载 `client.js` 捕获真实渲染树，断言首屏用途一句、白话三态 badge（就绪 / 受限 / 只展示）、终端 chips 无族标、命令行语法标签（手动才带「· 手动」）、两行白话备注、简报行内注入开关、高级设置折叠里的两个开关、footer 有数据时零开关 / 403 时保留 allowLan 入口、详情里的计数与标签（共 387 条），并保留**不存在**逐会话表 / 接管 chips / `.envd-statuschip`、首屏不出现「宿主 / 围栏 / 增补」黑话，以及长名字溢出、复制兜底、15 秒轮询去重与卸载清定时器。

`npm test` 只在**检出目录**可用：npm 包的 `files` 里没有 `test/`，从 npm 安装的插件没有这些自测可跑。

## 结构

```
index.js          Host：探测、envd 工具、简报注入、命令工具增补、/envdock-api
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
test/panel-render.mjs    面板渲染回归（极简 React 替身，零依赖）
test/family.mjs          两族纯逻辑回归（选族 / 锁定 / 遮挡名单 / 简报行，零依赖）
```

Host 半边**不 import 任何 `@deepseek-ai/*` 包**（本地目录安装是 link 检出，包内 import 解析不到 profile 的 node_modules），只用 `node:` 内置模块；命令探测走宿主的 `subprocess` 服务（只跑 `--version` 之类的只读探测，继承 dsh 的工作目录语义）。增补出来的 `envd_shell` **只走 `subprocess.spawn`**：那条路没有 `sandboxPolicy` 入口，所以围栏会话里它绝不执行——直接拒绝，让模型用宿主工具（宿主执行器自带围栏）。这是「增补」模型里唯一需要的执行闸门；0.6 的遮挡走 `tools.restrict` / `tools.guard` 两条注册表通道，不碰子进程。

## 已知边界

- 版本探测器探的是「可执行文件与版本」，不解析 `.nvmrc` / `pyproject.toml` / `package.json` 里的版本要求。
- `python` / `python3` / `py` 三个名字都解析到同一条 Python 记录：`py.exe` 是启动器不是解释器，`resolve` 会单独把它的路径和 `py -3.10` 用法讲清楚。
- 「重新探测」重读系统 PATH 依赖 Windows 注册表（`reg query`，机器级 + 用户级）。POSIX、或宿主没有 `subprocess` 服务时，只能退回 dsh 进程启动时的 `process.env.PATH`——那种情况下改了系统 PATH 仍然要重启 dsh。Windows 上「进程里多出来但目录真实存在」的 PATH 项会保留（那是启动器/终端自己塞的，不属于系统 PATH）。
- Volta / asdf 只报「在场」，不解析版本列表。
- 版本探测依赖宿主 `subprocess` 服务；没有它时只做 PATH 扫描，版本列显示「版本未知」。
- **遮挡是唯一例外，且有代价**：bash 族会话看不到宿主的 **Windows 原生能力**——注册表、COM、`Get-*` 命令都只有 PowerShell 才有。出路是**手动选 PowerShell 族**（`defaultShell` 设成 `pwsh` / `powershell`）或**关掉 `blockOtherFamily`**；两条都在下一次对账 / 探测后生效，不需要改配置或重启（改状态文件本身有 API 写入口）。
- **选族是单向锁定的**：会话首次判定后不再来回切；只有「首次判成 PowerShell 族」的 10 秒内允许升级到 bash 族一次。之后 dsh-ops 再晚挂 `ops_bash` 也不会改判——要改就手动选族。
- **非 Windows 没有测试覆盖**：两族判定依赖 Windows 上常见的宿主命令工具名（`pwsh` / `powershell` / `ops_bash` …）。POSIX 上逻辑同构但没跑过；族是按名字认的，不区分真实 shell 二进制。
- **遮挡是否触发取决于该会话的工具表**：只有宿主工具里确实有内置 `pwsh` / `powershell` 时才会遮挡；dsh-ops 已经把官方 `pwsh` 顶掉的部署里就看不到遮挡效果（只有 `ops_bash`）。两种情况都由测试夹具覆盖，现场以 `/envdock-api` 的 `hidden` / `refuseOnly` 与简报里「已隐藏 / 会被拒绝」那句为准。
- 增补出来的 `envd_shell` 是**精简执行器**：单次前台、输出截断、支持 `cwd` / `timeoutMs`；没有后台作业、没有 tail 落盘文件、没有 `sandbox_permissions` 升级参数。要这些能力就用宿主自带的命令工具（它一直在）。
- 围栏会话里 `envd_shell` 直接拒绝（不 spawn、不委托）：`ctx.subprocess` 没有 `sandboxPolicy` 入口；策略不可知按「被围栏」保守处理。
- 注册三条件任一不满足就不注册（面板只展示宿主工具），原因在备注与 `commandTool.skipReason` 里；全部会话被围栏时属「沙箱不允许」，不会创建死工具。
- 宿主命令工具的家族靠名字 token / 描述启发式认：认不出来会影响选族依据与 chips，但**永不影响模型怎么调那个工具**；遮挡名单只认内置 PowerShell 名，启发式认出的名字只展示。
- 工作目录取**当前会话的工作目录**（不是 dsh 进程 cwd）。
- 探测结果在内存里缓存 45 秒，只有默认终端 / 自定义终端 / 默认版本 / 自定义工具的写入会让它立即失效；「重新探测」强制重扫并清空版本号缓存（版本号本身缓存 10 分钟，key 含 mtime+size）。
- 探测过期只走 stale-while-revalidate，所以「最后一次数据」可能比系统事实慢一个刷新周期；显式作废与「重新探测」不受影响。
- 面板只在 `web` profile 注册；npm 上发布的包可能落后于仓库，最新功能请用本地目录 / Git 安装（版本号以仓库 `package.json` 为准）。
- 面板每 15 秒静默轮询一次（仅页面可见时），数据最多滞后一个周期；payload 比较会剔除易变计数，所以计数变化本身不一定触发重渲染。
