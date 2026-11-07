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

- **宿主自带哪个 shell 是「查出来」的，不是写死的**。启动后把 `pwsh / powershell / cmd / bash / sh / zsh / fish` 在全局与每个 agent 作用域里挨个查一遍（`tools.get(name, agent)`——不传 agent 只见全局视图，这是踩过的坑），谁在，宿主就是哪个家族。
- **默认终端与宿主同族 → 什么都不做**，不重复造工具、不遮挡。
- **固定名注册 + 占名不认领**：接管的命令工具固定叫 `envd_shell`（切终端只改执行方式，不拆建、不留空窗）；同名已被别的插件注册 → 报错并放弃接管，绝不认领别人的工具。
- 注册后按**全局可见性**验证一次「模型看得见」，不是看 `register()` 有没有抛错；各 agent 作用域能不能看见由遮挡层逐个处理。
- **注册失败绝不遮挡宿主工具**：宁可放弃接管，也不让模型一个命令工具都没有。（早期版本在这里把自己锁死过：`bash` 被遮、`pwsh` 被 deny，手上没有任何命令通道。）
- **沙箱按会话判，不按能力位判**：dsh 的 `ctx.shell` 是 ShellExecutor。可围栏的实现会公布 `sandboxMode`——但那是**部署默认档**（`dsh-pwsh-sandbox` 里就是 `sandboxPolicy.defaultMode`），不是本会话的有效策略。拿它当事实会在 `danger-full-access` 的会话里谎报围栏、把接管永久锁死。正确口径（与 `dsh-tool-pwsh` 一致）：能力位 = 执行器会不会围栏；有效策略 = 逐会话 `ctx.sandboxPolicy.resolve({ session })`。只有 `confined === true`（或策略不可知）才拦住 EnvDock 自己的 spawn；一个会话被围栏不影响别的会话，EnvDock 按作用域决定遮宿主的 shell 还是遮自己的 `envd_shell`（两份掩码互斥，任何作用域都不会零命令工具）。
- **宿主 shell 记忆是历史事实**：一旦见过 `pwsh`，即使后来被我们自己遮挡，也仍然记得它是宿主自带的——否则每 5 秒会在「遮住 → 看不见 → 放开 → 又看见」之间来回抖。
- **作用域私有的遮挡失败不株连**：某个 agent 作用域挡不掉的 shell 名只记在那个作用域，不会全局剔除——否则别的挡得掉的作用域会永久漏挡；已遮挡作用域里如果 `envd_shell` 变得不可见，会立刻把宿主 shell 还回去（宁可两个，也不制造零工具）。

## 状态与面板 API

- 状态文件 `~/.dsh/envdock.json` 原子写：先写同目录临时文件再 rename，进程中途被杀不会留下半截 JSON。
- 真的损坏时回落到全自动、把原文件备份成 `envdock.json.corrupt`，并在面板健康检查里给一条 issue（改一次设置即写回正常文件）。
- **非法选项写不进去**：`setShell` 只接受真实探测到的终端名（`auto` 或某个终端 key）；`setOption` 只认白名单（`injectBrief` / `allowLan` 一律归一成布尔，`shellTakeover` 只认 `auto` / `takeover` / `off`），手滑的 key/字符串不会再永久写进状态文件。
- 面板 API 默认只放行 loopback：数据含本机绝对路径与终端，局域网访问要在面板里显式打开（`allowLan`）。例外只有一个——**从局域网打开「允许局域网访问」这个开关本身是放行的**，否则提示里让你去打开它，请求却先被 403 掉，成了死循环。

## 健康检查

红 / 黄 / 灰三档：

- 红：应用商店占位符（`looksLikeStoreStub`）、默认版本路径失效（`staleSelection`）、默认终端不可用、选了 Git Bash 但没找到 `bash.exe`、默认 Python 是 2.x。
- 黄：多版本并存、Node < 18、Python 3.x < 3.9、npm 与 Node 不匹配、PATH 有失效目录、版本管理器激活版本与 PATH 实际解析不一致。
- 灰：dsh 进程里的 PATH 是旧的（探测已按系统当前值刷新，重启只是让两边彻底一致）。

## 自测

```powershell
node test/parsers.mjs        # 版本管理器输出解析
node test/i18n-check.mjs     # 中英词条键/占位符一致、slot 注册仍在
node test/host-harness.mjs   # 用 Cordis 服务替身把 apply() 真跑起来，走完所有 API op / envd action / 接管路径
```

`host-harness` 把状态文件写在临时 `DSH_HOME` 里，不会碰你真实的 `~/.dsh/envdock.json`；`subprocess` 用固定输出的替身（本机沙箱不允许 Node 用管道 stdio 起子进程），所以每次探测起几个子进程是可数的——版本缓存的收益也在断言里。

## 结构

```
index.js          Host：探测、envd 工具、简报注入、终端接替、/envdock-api
client.js         Client：侧边栏图标 + 中央面板
cordis.patch.yml  bundle patch（insert id: envdock）
locale/           meta.title / meta.description
icon.svg          插件图标
test/parsers.mjs       版本管理器输出解析自测
test/i18n-check.mjs    client.js 静态自检（词条/占位符/slot）
test/host-harness.mjs  Host 半边运行时夹具（替身服务，全链路）
```

Host 半边**不 import 任何 `@deepseek-ai/*` 包**（本地目录安装是 link 检出，包内 import 解析不到 profile 的 node_modules），只用 `node:` 内置模块；命令探测走宿主的 `subprocess` 服务（只跑 `--version` 之类的只读探测，继承 dsh 的工作目录语义）。**接管出来的命令工具默认也走 `subprocess`，而且是唯一的安全理由**：`subprocess.spawn` 没有 `sandboxPolicy` 入口，所以围栏会话绝不自己 spawn。围栏下的降级路径是**委托**：把命令交给带围栏的 `ctx.shell`（`resolve` + `execute`，命令经 `ENVD_CMD` 环境变量传入，避免三层引号），围栏挂在宿主进程上、子终端继承，`sandbox.denied` 也如实回显给模型。

## 已知边界

- 版本探测器探的是「可执行文件与版本」，不解析 `.nvmrc` / `pyproject.toml` / `package.json` 里的版本要求。
- `python` / `python3` / `py` 三个名字都解析到同一条 Python 记录：`py.exe` 是启动器不是解释器，`resolve` 会单独把它的路径和 `py -3.10` 用法讲清楚。
- 「重新探测」重读系统 PATH 依赖 Windows 注册表（`reg query`，机器级 + 用户级）。POSIX、或宿主没有 `subprocess` 服务时，只能退回 dsh 进程启动时的 `process.env.PATH`——那种情况下改了系统 PATH 仍然要重启 dsh。Windows 上「进程里多出来但目录真实存在」的 PATH 项会保留（那是启动器/终端自己塞的，不属于系统 PATH）。
- Volta / asdf 只报「在场」，不解析版本列表。
- 版本探测依赖宿主 `subprocess` 服务；没有它时只做 PATH 扫描，版本列显示「版本未知」。
- 接管后的命令工具是**精简执行器**：单次前台、输出截断、支持 `cwd` / `timeoutMs`；没有后台作业、没有 tail 落盘文件、没有 `sandbox_permissions` 升级参数。要这些能力就切回「只给简报」用宿主自带的。围栏会话下它按「沙箱下接管」选项工作：`delegate`（默认）= 经带围栏的宿主执行器执行，`refuse` = 不接管（等价「只给简报」）。
- 工作目录取**当前会话的工作目录**（不是 dsh 进程 cwd）。
- 版本探测结果缓存在内存里 10 分钟（key 含 mtime+size），升级二进制会自动重测；纯环境切换（比如 `nvm use` 换了另一个路径）也是新路径 → 天然重测。
