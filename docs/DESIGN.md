# EnvDock 设计说明

面向要读代码、改代码的人。用户向的安装与使用说明见 [README](../README.md)。

## 目标

Windows 上做开发时，机器上往往并排躺着好几套 Node / Python / Git，cmd、PowerShell、Git Bash 又在混用。EnvDock 要回答四个问题，并把答案交给 AI：

1. 工具装在哪（全部候选路径，而不是 PATH 上第一个）
2. 是什么版本
3. 该用哪个（用户选定的默认版本）
4. 这个终端里命令怎么写

同时保证：**只增不减**。EnvDock 不隐藏、不禁用任何已有工具，最多**增补**一个用你终端/PATH 的命令入口（`envd_shell`）；注册条件不满足时只做简报与展示，绝不把用户锁在没有命令工具的状态里，也绝不去动别人的工具表。

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

0.5 的核心决定：**只增不减**。EnvDock 不调用 `restrict`、不注册 `tools.guard` / `tools/pre-execute`、不隐藏任何工具；它只决定要不要**增补**一个 `envd_shell`，并把「有哪些命令工具、各自什么环境、该用哪个」如实讲清楚。规格见 `docs/notes/assist-model.md`。

### 注册四条件

四条同时满足才注册（`reconcile()` 每个 tick 复核一次，状态一变就立刻重算）：

1. **终端可用**：`resolveShell()` 解析出的默认终端有可用 path（否则 `skipReason='error'`）。
2. **家族不重复**：宿主已识别的命令工具里没有与默认终端**同族**的（同一个 shell 不出现两份；否则 `skipReason='same-family'`，并记下是哪个工具，简报用来说「不重复提供」）。
3. **沙箱允许**：没有沙箱执行器（`ctx.shell` 不存在）或执行器不围栏时直接注册；有围栏执行器时，要求**至少一个会话** `sandboxPolicy.resolve` 出 `danger-full-access`——否则注册了也只能在围栏会话里被拒绝，等于死工具（`skipReason='no-unconfined-session'`）。
4. **名字没被占**：`envd_shell` 不在工具表里，且 `ctx.tools.register()` 不抛错、注册后在表里确实是**我们那个定义对象**（登记身份，`tools.get(name) === ownDefinition`）；被别的层盖住算 `taken`，注册抛错算 `error`，失败按 30 秒退避重试，`tools/change` 时跳过退避立即重试。

注册 / 拆除**只由状态变化驱动**（终端、宿主工具、沙箱任一变化）；稳态 tick 零注册表动作。名字固定成 `envd_shell`（不跟终端走）：切终端只改执行方式，不拆建、不留工具表空窗。

### 执行语义与围栏拒绝

- **无围栏**：`ctx.subprocess.spawn` 直跑（工作目录取当前会话，输出截断，支持 `cwd` / `timeoutMs`）。
- **本会话被围栏**：**直接拒绝**，不 spawn、不委托——`ctx.subprocess` 没有 `sandboxPolicy` 入口，自己跑就是绕过沙箱。每一单都按本会话策略复检（检查周期 5 秒，策略可能在这期间变严），被围栏或策略不可知时返回：
  ```
  [sandbox] 本会话被宿主沙箱围栏(<mode>);EnvDock 的 envd_shell 不执行命令。
  请改用宿主工具(宿主自带的命令工具,它在围栏内可执行)。
  ```
- 沙箱事实分三层：**能力位**（执行器会不会围栏）/ **部署默认档**（`shell.sandboxMode`，只用于展示）/ **本会话有效策略**（逐会话 `sandboxPolicy.resolve({ session })`）。合法策略是闭集 `read-only` / `workspace-write` / `danger-full-access`；resolve 返回 `{}`、空 mode 或闭集外的值一律按「策略不可知」处理，并按「被围栏」保守拒绝——**绝不回落到部署默认档**（回落会让围栏会话被当成无围栏直接 spawn）。
- 删除：`delegatedInvocation` / `runDelegated` / 全部 `delegate*` 计数与包装器、`executorFamily`。

### 宿主命令工具：只用于展示

每个 tick 逐 agent 枚举 `tools.definitions(agent)`（取并集，名字有界 ≤64），用**既有**的家族识别（`shellFamilyFromDefinition` + `SHELL_TOOL_FAMILY`）得到 `hostTools: [{ name, family, learned }]`，排序稳定（内置顺序优先，其余按名字）。`learned` 的语义是「按描述 / 参数启发式认出来的，不是内置名单」。

- 内置表命中就短路：`ops_bash`、`pwsh`、`bash`、`cmd`、`wsl` 等按内置家族认领，不要求 command 参数；「名字 token + command 参数」那道门槛只约束第三方发布名。
- **只有命令参数不够、名字带 cmd 也不够**：`run_cmd`（task 参数）、`wc_cmd_palette`（UI 面板）这类会被排除，否则详情里会凭空多出一条假命令工具。
- 这个名单**只用于展示**：认不出来只是详情里少一条 chips，不改变模型怎么调那个工具，也不影响 EnvDock 是否增补。没有可见性探测、没有逐会话事实、没有遮挡。

### 简报口径

简报按**当前事实**写，禁止再说「已接管 / 让路 / 沙箱下接管」：

- 注册成功：`· 命令工具: envd_shell(EnvDock 增补,用 <终端> 语法) + 宿主 <a,b>(<家族>);二者都可用,优先 envd_shell(它用你的 PATH/终端),需要宿主语义时再用宿主工具`
- 宿主里已有同族工具：`· 命令工具: <宿主工具>(与默认终端同族,EnvDock 不重复提供)`
- 其它未注册原因：`· 命令工具: 用宿主的 <a,b>` + 一句原因（`no-unconfined-session` / `taken` / 注册失败）。
- 本会话被围栏时追加：`;envd_shell 在本会话被围栏,会被拒绝,请用宿主工具`。
- 末尾两行保持：工具绝对路径与版本、`envd` 只能解析已探测工具。

## 与 dsh-ops 的兼容

同一台机器上 EnvDock 与 dsh-ops 常一起用（dsh-ops 的 cordis 模式会把官方 `pwsh` 换成 `ops_bash`）。0.5 之后共存**不需要任何设置**：

- **`ops_bash` 只是宿主命令工具**：EnvDock 认出它的 bash 家族、列进 `hostTools` 与面板详情，不遮挡、不禁用。模型手上同时有 `ops_bash` 与 `envd_shell` 是**预期行为**，优先级写在简报里。
- **不再有「Publish Bash」这类话术**：以前 EnvDock 想接管就得请用户去 dsh-ops 关掉发布；现在两者并存即可，EnvDock 不争工具表。
- **借鉴来的做法仍在**：① 事件驱动（`tools/change` + 40ms 合并定时器）只用于「重新识别宿主工具 + 必要时重挂/拆自己的工具」，不做对账循环；② 登记身份（`tools.get(name) === 我注册的定义对象`）——同名工具被别的层盖住时，名字还在不代表是我们的，不能认领别人的发布生命周期；③ 宿主没有 `tools.definitions` 时按内置候选名各探一次可见性，名字集合有界。
- **不学的部分**：dsh-ops 的 `ops_bash` 同样走 `ctx.subprocess`（没有 `sandboxPolicy` 入口），所以 EnvDock 自己的执行闸门原样保留：围栏会话绝不直连，只能拒绝。

## 状态与面板 API

- 状态文件 `~/.dsh/envdock.json` 原子写：先写同目录临时文件再 rename，进程中途被杀不会留下半截 JSON。
- 真的损坏时回落到全自动、把原文件备份成 `envdock.json.corrupt`，并在面板健康检查里给一条 issue（改一次设置即写回正常文件）。
- **非法选项写不进去**：`setShell` 只接受真实探测到的终端名（`auto` 或某个终端 key）；`setOption` 只认白名单（`injectBrief` / `allowLan` 一律归一成布尔），手滑的 key/字符串不会再永久写进状态文件。0.5 删除了 `shellTakeover` / `sandboxTakeover`：旧状态文件里出现时忽略（不报错、不迁移）。
- 面板 API 默认只放行 loopback：数据含本机绝对路径与终端。打开「允许局域网访问」（`allowLan`）后**局域网只能读**（GET）；所有写操作只允许本机，唯一例外是同源页面把 `allowLan` **关掉**（`Origin.host:port` 必须与 `Host` 完全一致，避免任意网页替用户关掉）。理由：写操作能改默认终端 argv，等于把命令注入面开到局域网。
- **API 加固**：回环来源必须配**回环 Host 字面量**——攻击者把自己的域名重新解析到 `127.0.0.1`（DNS rebinding）后来源地址是回环，但 `Host` 仍是攻击者域名；只比较「Origin 与 Host 一致」会放行这种跨站写（实测可改自定义终端 argv ≈ 本机代码执行），所以 `Host` 为空或非回环一律 403，读写都覆盖。**严格同源**：写请求要求 `Origin.host:port === Host`（不只是「都是回环」——`other-port.localhost` 也能发跨源简单 POST）、`Content-Type` 含 `application/json`、`sec-fetch-site: cross-site` 一律 403、没有 `Origin` 却带 `Sec-Fetch-Site` 的按非面板处理。请求体 >1 MB 时在读 body **之前**就回 413（直接 `destroy` 会让客户端看到 `ECONNRESET`，既不是 413 也不可诊断）；`isLoopbackHost` 严格匹配（`localhost` / `::1` / `127.0.0.0/8`，`127.0.0.1.evil.example` 不算）；非 GET / POST 回 405，坏 JSON 回 400。
- `/envdock-api` 的 `commandTool` 只回答四件事：注册了吗（`registered` + `skipReason`）、此刻全局可见吗（`visible`，一次 `hasTool` 探针）、用哪个终端（`shell`）、宿主还有哪些命令工具（`hostTools`）。字段：`{ name, registered, visible, skipReason, shell{label,family,version,path}, refuseWhenConfined, hostTools[{name,family,learned}], sandbox{...} }`。**没有** `scopes` / `kind` / `hostName` / `denies` / `hostOnlyScopes` / `sandboxHiddenScopes` / `scopeAnomalies` —— EnvDock 不再遮挡别人，就不存在「每个会话的终局」。
- `sandbox` 顶层是聚合值：`{ present, capable, defaultMode, policyKnown, sessionCount, confinedCount, anyUnconfined }`（无 `scopes`）。逐会话明细不外泄；`confinedCount` 只用于面板的「N 个会话被围栏」与简报追加句。
- `syncStats` 收敛为 9 个字段：`ticks` / `lastAt` / `intervalMs` / `detections` / `lastDetectMs` / `hostToolScans` / `registerTries` / `lastError` / `lastErrorAt`。它们是**稳态证据**：`ticks` 涨而 `registerTries` 不涨，说明注册表没被反复拆建。
- **过渡期旧版 API**：client.js 是热更新的，宿主进程里的 index.js 要重启 dsh 才换。旧载荷没有 `registered` / `hostTools`，面板用旧的 `visible` 推断注册、用旧 `hostName` 填宿主工具，并显示「接口是旧版构建，重启 dsh 后可显示命令工具信息」——不把不知道的事说成「`—` / 未识别到」。

## 面板结构

`client.js` 的 `EnvDockPanel` 按「一屏说四件事」组织：这台机器默认用哪个终端、模型手里有哪些命令工具、装了哪些工具、有没有问题（**只在 Web 有**：`dsh.client.platform` 只注册 `web`；`tui` / `headless` 装得上但没有面板，简报与 `envd` 工具照常生效）。

### 信息架构

常显只有四块，其余全在触发器后面：

1. **头部一行**：插件名 · 默认终端与版本（`envd-headline`，如 `PowerShell 7 v7.4.6`）· **恰好一个三态**状态 badge · 右侧「重新探测」。问题数**不**在头部——它的位置在工具链末尾的环境检查行。
2. **置顶「命令工具」卡**：
   - `终端` chips（自动 / 各终端 / `+` 自定义终端，`+` 展开路径 + 名称 + 参数模板）；
   - `命令` 行：`envd_shell`（未注册写 `—`）· `宿主 ops_bash · pwsh`（没有就写「未识别到宿主命令工具」）+ 右侧「详情」；
   - 备注（最多两行）：未注册原因 / `N 个会话被围栏：envd_shell 会拒绝，请用宿主工具` / 环境差异提示；
   - 详情（默认收起）：`扫描 N 次 · 最近 Nms · 注册尝试 N` + 宿主工具 chips（`learned` 带 ✦）+ 最近错误。
3. **工具链**：一行一个工具（分组 / 名称 / 版本 / 路径可点复制 / 行尾「N 个版本 ▾」），版本管理器一行一个（激活版本带 ←），末尾「+ 自定义工具」入口；**环境检查收在工具链末尾一行**：健康时 `✓ 通过`，有问题时 `⚠ N 项` + 第一条标题，点开展开列表。
4. **环境简报一行**（状态 / 复制 / 展开）与**底部一行**：简报注入开关（`!data` 时不渲染，避免 403 时显示假「关闭」）、允许局域网访问开关（403 时仍可点）、复制反馈（`role=status`，`aria-live`）、环境脚注（系统 · 架构 · 主机名 · 更新于）。

### 已删除的渲染

接管模式 / 沙箱下接管 chips、逐会话表（含同终局会话合并）、状态胶囊 `.envd-statuschip`、异常 / 让路 / 工具并存渲染、`kind` 推导、`diagSummary` 的「N 个会话异常」——这些都属于「接管期」的语义；不遮挡就没有「每个会话的终局」，也就没有第二个状态结论。

### 三态 badge

面板只有一个状态结论，由「是否注册且可见」+「有没有会话被围栏」推出：

| 条件 | 文案 | 色调 | 含义 |
|---|---|---|---|
| `registered && visible`，且 `confinedCount > 0` | `围栏` | warn（黄） | `envd_shell` 在已注册，但有会话被围栏、在那些会话里会拒绝 |
| `registered && visible`，没有围栏会话 | `增补就绪` | ok（绿） | 增补入口可用 |
| 未注册（同族 / 无无围栏会话 / 被占用 / 注册失败） | `只展示` | muted（灰） | 面板只展示宿主命令工具，原因写在备注里 |

badge 的悬停文本 = 最多两条备注；badge 自身不再挂计数。

### 备注规则（最多两行）

- **未注册时**只说原因，按 `skipReason` 分支：`same-family` 点名同族的宿主工具（`与 ops_bash 同族，EnvDock 不重复提供`）、`no-unconfined-session`、`taken`、`error`（其余原因统一写「注册失败，未注册」）。
- **注册成功且被围栏**：一行 `N 个会话被围栏：envd_shell 会拒绝，请用宿主工具`。
- **注册成功**：一行静态提示「宿主工具的环境/PATH 未必等于你的；需要你的终端时用 envd_shell」——没注册时不说这句话（那时让人「用 envd_shell」是假话）。
- 备注是「一句人话 + 一个原因」，计数只出现在详情里。

### 详情与轮询

- 详情默认收起：`扫描 N 次 · 最近 Nms · 注册尝试 N`（只读 `syncStats` 白名单）+ 宿主工具 chips + 最近错误（截断到 140 字符）。计数只在这里出现，常显区不放数字。
- 面板每 15 秒静默拉一次 `/envdock-api`，只在 `document.visibilityState === 'visible'` 时拉；payload 比较前剔除 `ticks` / `lastAt` / `lastErrorAt` / `now` / `updatedAt` 等易变键（否则每个 tick 都会被当成「有变化」重渲染）。复制优先 `navigator.clipboard`，局域网 http 退到 `textarea + execCommand('copy')`，失败给可见提示。

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
node test/host-harness.mjs   # 用 Cordis 服务替身把 apply() 真跑起来，走完所有 API op / envd action / 注册与围栏拒绝（209 条）
node test/panel-render.mjs   # 用极简 React 运行时替身渲染面板，断言结构 / 文案 / 交互（266 条）

node test/simulate.mjs --help   # 手动验证:起假宿主跑真实 index.js，打印 /envdock-api 快照
```

测试共用一套**可复用夹具** `test/fixture/host.mjs`：假 Cordis 服务（`tools` / `webServer` / `slots` / `subprocess` / `shell` / `sandboxPolicy` / `locale`）+ 真实 `index.js`，状态文件写临时 `DSH_HOME`，不碰你真实的 `~/.dsh/envdock.json`；`subprocess` 用固定输出替身（本机沙箱不允许 Node 用管道 stdio 起子进程），所以每次探测起几个子进程是可数的——版本缓存的收益也在断言里。`simulate` 用同一套夹具把 `/envdock-api` 的完整 JSON 打出来，用来复现「注册 / 不注册 / 围栏拒绝 / 宿主工具识别」：`--mode`（逐会话策略）、`--sessions`、`--host-tools`、`--executor`（=none 表示没有沙箱执行器）、`--shell-sandbox`、`--policy`、`--brief`、`--json`。

关键断言（本模型的硬不变量）：

- **`restrict` 调用次数为 0**：任何场景下 EnvDock 都不去动别人的工具表。
- 注册四条件各有一个用例：无执行器 → 注册；宿主有同族工具 → `skipReason='same-family'`；全部会话围栏 → `no-unconfined-session`；有会话无围栏 → 注册。
- 围栏会话调用 `envd_shell` → 拒绝、**不 spawn**、文案含「围栏」与「宿主工具」；无围栏会话照常执行（夹具断言 argv）。
- `/envdock-api` 新形状：没有 `scopes` / `kind` / `denies` / `yieldTicks` 等字段，`syncStats` 只剩白名单 9 项。
- 状态文件里的旧 `shellTakeover` / `sandboxTakeover` 被忽略（读取不报错、写回不保留）。

`panel-render` 不引入 React：桩掉 slots / locale / fetch，加载 `client.js` 捕获真实渲染树，断言 266 条——三态 badge 各一条、命令行与「—」、备注两行、详情里的宿主工具 chips 与扫描计数、**不存在**逐会话表 / 接管 chips / `.envd-statuschip`，以及既有的长名字溢出、复制兜底、15 秒轮询去重与卸载清定时器。

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
test/panel-render.mjs    面板渲染回归（极简 React 替身，零依赖，266 条断言）
```

Host 半边**不 import 任何 `@deepseek-ai/*` 包**（本地目录安装是 link 检出，包内 import 解析不到 profile 的 node_modules），只用 `node:` 内置模块；命令探测走宿主的 `subprocess` 服务（只跑 `--version` 之类的只读探测，继承 dsh 的工作目录语义）。增补出来的 `envd_shell` **也只走 `subprocess.spawn`**：那条路没有 `sandboxPolicy` 入口，所以围栏会话里它绝不执行——直接拒绝，让模型用宿主工具（宿主执行器自带围栏）。这是「只增补」模型里唯一需要的执行闸门。

## 已知边界

- 版本探测器探的是「可执行文件与版本」，不解析 `.nvmrc` / `pyproject.toml` / `package.json` 里的版本要求。
- `python` / `python3` / `py` 三个名字都解析到同一条 Python 记录：`py.exe` 是启动器不是解释器，`resolve` 会单独把它的路径和 `py -3.10` 用法讲清楚。
- 「重新探测」重读系统 PATH 依赖 Windows 注册表（`reg query`，机器级 + 用户级）。POSIX、或宿主没有 `subprocess` 服务时，只能退回 dsh 进程启动时的 `process.env.PATH`——那种情况下改了系统 PATH 仍然要重启 dsh。Windows 上「进程里多出来但目录真实存在」的 PATH 项会保留（那是启动器/终端自己塞的，不属于系统 PATH）。
- Volta / asdf 只报「在场」，不解析版本列表。
- 版本探测依赖宿主 `subprocess` 服务；没有它时只做 PATH 扫描，版本列显示「版本未知」。
- **EnvDock 不遮挡、不禁用任何工具**：「模型手里同时有两个命令工具」是预期行为，优先级写在简报里；没有开关能让 EnvDock 去隐藏别人的工具。
- 增补出来的 `envd_shell` 是**精简执行器**：单次前台、输出截断、支持 `cwd` / `timeoutMs`；没有后台作业、没有 tail 落盘文件、没有 `sandbox_permissions` 升级参数。要这些能力就用宿主自带的命令工具（它一直在）。
- 围栏会话里 `envd_shell` 直接拒绝（不 spawn、不委托）：`ctx.subprocess` 没有 `sandboxPolicy` 入口；策略不可知按「被围栏」保守处理。
- 注册四条件任一不满足就不注册（面板只展示宿主工具），原因在备注与 `commandTool.skipReason` 里；全部会话被围栏时属「沙箱不允许」，不会创建死工具。
- 宿主命令工具的家族靠名字 token / 描述启发式认，**只用于展示**：认不出来只是详情里少一条 chips，不影响模型怎么调那个工具，也不影响 EnvDock 要不要增补。
- 工作目录取**当前会话的工作目录**（不是 dsh 进程 cwd）。
- 探测结果在内存里缓存 45 秒，只有默认终端 / 自定义终端 / 默认版本 / 自定义工具的写入会让它立即失效；「重新探测」强制重扫并清空版本号缓存（版本号本身缓存 10 分钟，key 含 mtime+size）。
- 探测过期只走 stale-while-revalidate，所以「最后一次数据」可能比系统事实慢一个刷新周期；显式作废与「重新探测」不受影响。
- 面板只在 `web` profile 注册；npm 上发布的包可能落后于仓库，最新功能请用本地目录 / Git 安装（版本号以仓库 `package.json` 为准）。
- 面板每 15 秒静默轮询一次（仅页面可见时），数据最多滞后一个周期；payload 比较会剔除易变计数，所以计数变化本身不一定触发重渲染。
