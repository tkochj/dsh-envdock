[English](README.en.md) | **中文**

# EnvDock · 环境码头

[![npm](https://img.shields.io/npm/v/dsh-envdock?logo=npm)](https://www.npmjs.com/package/dsh-envdock)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6)
![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B32C3)

> 让 AI 开口之前就知道：你的 Windows 上 Node / Python / Git 装在哪、该用哪个版本、这个终端里命令该怎么写。

![EnvDock 面板：头部一行、命令工具卡、一行一个工具的工具链](https://raw.githubusercontent.com/tkochj/dsh-envdock/main/docs/panel.png)

> 截图是一屏里的**常显部分**：头部一行（插件名 · 默认终端与版本 · 一个三态 badge——这台机器上宿主已有同族的 `pwsh`，所以是灰色「只展示」）、置顶的「终端 / 命令」卡片（`命令` 行是 `— · 宿主 pwsh · ops_bash`，下一行是未注册原因「与 pwsh 同族，EnvDock 不重复提供」）、工具链一行一个工具、末尾一行环境检查、一行环境简报；详情默认收起。

Windows 上做开发，机器里常常并排放着好几套 Node / Python / Git，cmd、PowerShell、Git Bash 又各有各的语法。没有 EnvDock 时，AI 要先 `where node` 试探、猜路径、写错命令再重试——慢，而且容易在版本和语法上踩坑。

**EnvDock 是 DeepSeek Harness（dsh）的插件**：启动时把本机工具链探测清楚，把一份「环境简报」直接写进 AI 的上下文；需要时再增补一个用你终端语法的命令工具（`envd_shell`），让 AI 用正确的方式干活。你不用填任何配置。

**适合谁**：在 Windows 上用 dsh 写代码的人；机器上装了多套 Node / Python / Git 的人；经常在 PowerShell、cmd、Git Bash 之间切换的人；希望 AI 少问「你用的哪个 node」的人。

**它不做什么**：不安装工具、不改系统 PATH、不替你决定版本、也**不隐藏或禁用任何已有工具**——只负责把事实探清楚并告诉 AI，最多再增补一个命令入口。

## 为什么需要它

| 没有 EnvDock | 有 EnvDock |
|---|---|
| AI 每次都要 `where` / `Get-Command` 试探 | 简报里直接给绝对路径与版本 |
| 多版本并存，AI 猜不到你想用哪个 | 面板点一下设定默认版本 |
| 默认是 PowerShell，AI 却写 bash 语法 | 简报写明当前终端的语法要点 |
| `nvm use` / `fnm use` 与 PATH 不一致，问题难查 | 健康检查直接点出来 |
| 装了新工具要重启 dsh 才「看得见」 | 「重新探测」按系统当前 PATH 重扫 |

## 功能一览

- **工具链探测**：node、npm、pnpm、yarn、bun、deno、python、pip、uv、git、conda，列出**全部**候选路径与版本。
- **版本管理器探测**：nvm-windows、pyenv-win、conda、fnm、mise 会解析已装版本（前四还解析当前激活项）；Volta、asdf 只报「在场」，不猜输出格式。只有命令在 PATH 上或根目录真实存在才算在场。
- **默认版本一键切换**：多版本并存时，在面板里把某个绝对路径设为默认，AI 下一轮就按它来。
- **环境简报注入**：系统、默认终端、各工具绝对路径与版本、终端语法要点，一次写进运行上下文。
- **命令工具增补（可选）**：默认终端与宿主自带的命令工具不同族时，额外注册一个固定名字的 `envd_shell`（用你的终端与 PATH）；**不隐藏、不禁用**宿主工具，两者同时可用，简报写明「优先 `envd_shell`」。围栏会话里 `envd_shell` 直接拒绝执行，请用宿主工具。
- **健康检查**：应用商店占位符、失效的 PATH 目录、旧版本、npm/Node 不配套、版本管理器激活版本与 PATH 不一致等。
- **`envd` 工具**：让 AI 随时按名字解析工具（`resolve`）、取简报（`summary`）、查健康（`check`）、切换默认版本（`set_default`）。

## 安装

**前置条件**：Windows + 已安装 DeepSeek Harness（dsh）。插件以当前 profile 为单位安装，下面以 `web` 为例。

> **npm 上的版本可能滞后于本仓库**。想用最新的功能（一屏面板、命令工具增补、环境简报注入），请用下面的本地目录 / Git 方式安装；npm 上的包跟随发布更新，安装前可以先看仓库 `package.json` 里的版本号。

### 方式一：从 npm 安装（版本可能滞后）

```powershell
dsh plugin --profile web add dsh-envdock
```

安装后在插件页确认 EnvDock 已启用，然后重启 dsh。其他 profile 把 `web` 换成对应名字。

### 方式二：在 dsh 插件页安装（本地目录 / Git，推荐）

1. 打开 dsh 侧边栏的 **插件** 页。
2. 选择「安装」，填入插件来源，二选一：
   - 本地目录：`link:D:\plugins\envdock`（换成你的实际路径）
   - Git 地址：本仓库的 git URL
3. 确认 **EnvDock** 处于开启状态，然后重启 dsh。

### 方式三：命令行（本地目录，推荐）

```powershell
# 把插件装进 web profile；link: 后面是插件目录的绝对路径
dsh plugin --profile web add link:D:\plugins\envdock

# 重启 web
dsh web
```

安装后如果插件页里 EnvDock 没有自动启用，手动打开开关再重启。其他 profile（`tui`、`headless` 等）把 `web` 换成对应名字即可。

> **面板只在 Web（`web` profile）里有**：插件的 `dsh.client.platform` 只有 `web`。`tui` / `headless` 可以安装，环境简报与 `envd` 工具照常生效，但没有可视化面板可点。

> 从源码使用：`git clone https://github.com/tkochj/dsh-envdock.git envdock`，再用上面的 `link:` 方式安装。源码改动需要重启 dsh 生效。

### 验证安装

- 侧边栏出现 **EnvDock** 入口，点开能看到默认终端与工具链。
- 新开会话时，AI 的上下文里会出现「本机环境 (EnvDock 实测,优先于猜测)」简报。
- 在对话里问 AI「我的 node 在哪」，它应该直接给出绝对路径，而不是现搜。

## 快速上手

1. **打开面板**：侧边栏 → EnvDock。
2. **看一眼探测结果**：工具链、版本管理器、健康检查。
3. **按需调整**：在置顶的「命令工具」卡里切默认终端；在工具链里点路径复制、点「N 个版本」选默认版本。
4. **回到会话**：AI 已经拿到新的环境简报，直接干活。

## 面板导览

面板按「一屏说四件事」组织：**这台机器默认用哪个终端**、**模型现在手里的命令工具是什么**、**装了哪些工具**、**有没有问题**。常显的只有头部一行、一张置顶的「命令工具」卡、一节工具链和底部一行；详情、环境检查列表、简报正文都收在触发词后面。720px 高的窗口（可用约 600px）里，常显内容基本不需要滚动。

| 区域 | 常显内容 |
|---|---|
| **头部（一行）** | 插件名 · 默认终端与版本（如 `PowerShell 7 v7.4.6`）· **恰好一个三态**状态 badge · 右侧「重新探测」（按系统**当前** PATH 重扫，Windows 会重读注册表并清空版本缓存）。 |
| **状态 badge** | 整个面板唯一的状态结论，三态取一：绿「增补就绪」（`envd_shell` 已注册且此刻可见）、灰「只展示」（没注册，面板只展示宿主命令工具）、黄「围栏」（有会话被围栏，`envd_shell` 在那些会话里会拒绝执行）。悬停能看到最多两条备注原文。 |
| **命令工具卡 · 终端** | `终端` chips：`自动` + 探测到的各终端 + `+`（自定义终端：路径 / 名称 / 参数模板）。切终端立即生效。 |
| **命令工具卡 · 命令** | `命令` 行：`envd_shell`（**没注册时显示 `—`**）· 宿主工具名（如 `宿主 ops_bash · pwsh`；一个都没识别到就写「未识别到宿主命令工具」）+ 右侧「详情」。悬停分别解释两者的环境 / PATH 来自哪里。 |
| **备注（最多两行）** | 只在需要时出现：没注册的原因（`与 ops_bash 同族，EnvDock 不重复提供` / `没有无围栏会话，暂不注册` / `与其它插件同名，未注册` / `注册失败，未注册`）、`N 个会话被围栏：envd_shell 会拒绝，请用宿主工具`、以及一句静态提示「宿主工具的环境/PATH 未必等于你的；需要你的终端时用 envd_shell」。 |
| **详情（默认收起）** | `扫描 N 次 · 最近 Nms · 注册尝试 N` + 宿主工具 chips（`名字 · 家族`，靠名字 / 描述启发式认出来的带 ✦「自动识别」）+ 最近错误。 |
| **工具链** | 每个工具**一行**：分组名（只在该组第一行出现）· 名称 · 版本 · 路径（**点路径即复制**）· 行尾「N 个版本 ▾」（点开才列候选与「设为默认」）。版本管理器也一行一个（激活版本带 ←），末尾是「+ 自定义工具」入口。 |
| **环境检查（工具链末尾一行）** | 健康时 `✓ 通过`；有问题时 `⚠ N 项` + 第一条标题，点开展开完整列表（红 / 黄 / 灰分档）。 |
| **环境简报（一行）** | 状态（已注入给 AI / 简报注入已关闭）+「复制」+「展开」；展开才显示简报正文。 |
| **底部（一行）** | 两个开关（简报注入、允许局域网访问——被 403 挡在门外时也能点）+ 复制反馈（`aria-live`）+ 脚注（系统 · 架构 · 主机名 · 更新于）。 |

面板已经没有「接管模式 / 沙箱下接管」设置 chips，也没有逐会话表与状态胶囊：EnvDock 不遮挡任何工具，就不存在「每个会话的终局」可说。面板每 15 秒静默拉一次 `/envdock-api`（只在页面可见时拉；payload 没变就不重渲染，所以计数变化本身不一定刷新界面）。任何操作失败都会出现可关闭的错误条，复制失败也会明确提示，不再静默吞掉。

## AI 看到什么

### 环境简报

插件会把类似下面的一段文字写进运行上下文（具体内容随机器变化）：

```text
## 本机环境 (EnvDock 实测,优先于猜测)
- 系统: Windows_NT 10.0.26300 (x64),用户 LAPTOP-XXXX
- 默认终端: Windows PowerShell → C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe (v5.1.26100)
  · 串联用 `;`,条件串联 `&&`/`||` 只有 PowerShell 7 支持
  · 环境变量 `$env:NAME`,调用外部程序要 `& $exe` 或用完整路径
  · 命令工具: `envd_shell`(EnvDock 增补,用 Windows PowerShell 语法) + 宿主 `ops_bash`(bash / sh);二者都可用,优先 `envd_shell`(它用你的 PATH/终端),需要宿主语义时再用宿主工具
- 工具(绝对路径,直接用,不必再 where/which):
  · Node.js v24.18.0 → C:\Program Files\nodejs\node.exe [另有 v20.19.0 ...]
  · Python v3.12.10 → D:\python\python.exe [...]
  · Git v2.55.0 → E:\Git\cmd\git.exe
- 版本管理器: pyenv-win(...) [2 个版本], fnm(...) [1 个版本,激活 v20.19.0]
- `envd` 工具只能解析上面已探测到的工具;没列出的不在探测范围内(需要时用 `command -v` / `Get-Command` 自行确认,别用 `envd` 试探)。
```

### `envd` 工具

| action | 作用 | 何时用 |
|---|---|---|
| `summary`（默认） | 完整环境简报 | 想看 AI 拿到的原文 |
| `resolve` | 按名字返回默认路径、版本、全部候选、终端 | 需要精确路径或确认版本 |
| `check` | 返回健康问题清单 | 排查环境问题 |
| `set_default` | 把某个候选路径设为默认 | 切换版本 |

`resolve` 支持别名：`python` / `python3` / `py` 会命中同一条 Python 记录；`py.exe` 是启动器，结果里会单独说明 `py -3.10` 这类用法。

### 命令工具：增补而不是接管

EnvDock **不隐藏、不禁用任何工具**：宿主自带的命令工具（`ops_bash` / `pwsh` / `bash` …）原样可用，EnvDock 只决定要不要**再增补一个** `envd_shell`——它用你配置的默认终端与 PATH 跑命令。

- **什么时候注册**（四条同时满足）：① 默认终端解析出可用的可执行文件；② 宿主已识别的命令工具里**没有与它同族**的（同一个 shell 不重复提供两份）；③ 沙箱允许——没有沙箱执行器（或执行器不围栏）就直接注册，有执行器时要求**至少一个会话** resolve 出 `danger-full-access`（否则注册了也只能在围栏会话里被拒绝，等于死工具）；④ 名字 `envd_shell` 没被别的插件占用、注册不报错。任何一条不满足就不注册，面板备注与 `/envdock-api` 的 `commandTool.skipReason` 会给出原因（`same-family` / `no-unconfined-session` / `taken` / `error`）；注册失败按 30 秒退避重试，`tools/change` 时立即重试。
- **围栏会话里直接拒绝执行**：`envd_shell` 走 `ctx.subprocess.spawn`，那条路没有 `sandboxPolicy` 入口——自己跑就等于绕过沙箱。所以每一单都按**本会话**的有效策略复检：被围栏时返回 `[sandbox] 本会话被宿主沙箱围栏(<mode>);EnvDock 的 envd_shell 不执行命令`，并请模型改用宿主工具；不 spawn、也不委托。无围栏会话照常执行（工作目录取当前会话的，输出有截断，支持 `cwd` / `timeoutMs`）。
- **沙箱按会话判，不按部署默认档判**：执行器公布的 `sandboxMode` 只是**部署默认档**，真实策略逐会话 `sandboxPolicy.resolve({ session })`；合法策略是闭集 `read-only` / `workspace-write` / `danger-full-access`，返回 `{}`、空 mode 或闭集外的值一律按「策略不可知」处理，并按「被围栏」保守拒绝（绝不回落到部署默认档）。`/envdock-api` 的 `sandbox` 只给聚合值（`sessionCount` / `confinedCount` / `anyUnconfined`），不含逐会话明细。
- **简报按「模型实际能用什么」说话**：注册成功时写 `envd_shell`（增补，用你的终端）+ 宿主工具，并说明**优先 `envd_shell`**（它用你的 PATH / 终端）、需要宿主语义时再用宿主工具；与宿主同族时写「`<宿主工具>`（与默认终端同族，EnvDock 不重复提供）」；其它未注册原因写「用宿主的 `<工具>`」+ 一句原因。本会话被围栏时再追加一句「`envd_shell` 在本会话被围栏，会被拒绝，请用宿主工具」。
- **宿主命令工具只用于展示**：从 `tools.definitions`（逐 agent 一次）按内置家族表与「描述提到 bash / PowerShell / cmd / WSL 且参数里有 command 类字段」认出来，排序后放进 `commandTool.hostTools` 与面板详情。`ops_bash` 属于内置 bash 家族，命中内置表就不再要求 command 参数；`run_cmd`（task 参数）、`ops_read_files` 这类不会被误认。这个名单只回答「有哪些命令工具」，**不参与任何遮挡或禁用**。
- **不调用 `restrict`，也不注册 `guard` / `tools/pre-execute`**：这是本模型最硬的不变量（测试断言 `restrict` 调用次数为 0）。EnvDock 的注册表动作只有两个：注册 `envd_shell` 和它自己的 disposer。
- **和 dsh-ops 共存不需要任何设置**：dsh-ops 的 cordis 模式会把官方 `pwsh` 换成 `ops_bash`；EnvDock 认出它是 bash 家族、当成宿主命令工具展示，并在默认终端不同族时另外增补 `envd_shell`。两个工具同时可用是**预期行为**（简报写明优先级），不需要在本插件或 dsh-ops 里改任何开关。
- **不注册也不会让模型没工具用**：宿主工具一直原样在，EnvDock 只是少一个增补入口。

## 设置与状态

配置保存在 `~/.dsh/envdock.json`（原子写入；损坏时自动备份为 `envdock.json.corrupt` 并回落到默认值）。

| 选项 | 默认 | 说明 |
|---|---|---|
| 简报注入 | 开 | 是否把环境简报写进 AI 上下文 |
| 允许局域网访问 | 关 | 打开后局域网只能**读**面板数据。所有写操作（切终端、改默认版本、加自定义工具 / 终端 argv、改选项）都只允许在本机发起；唯一例外是同源页面把本开关**关掉**（打开必须在本机，否则等于把命令注入面开到局域网） |
| 自定义工具 | 空 | 补充 PATH 之外的工具 |

> **0.5 起没有「接管」选项**：旧版本里的 `shellTakeover`（终端接管：自动 / 总是接管 / 只给简报）与 `sandboxTakeover`（沙箱下接管：委托执行 / 直接拒绝）已删除。旧状态文件里出现这两个字段会被**忽略**（不报错、不迁移）；EnvDock 永远只增补 `envd_shell`，是否注册由终端 / 宿主工具 / 沙箱条件决定，不是配置项。

### 重置 / 卸载

```powershell
# 重置所有设置（默认终端、默认版本、选项）
Remove-Item ~/.dsh/envdock.json

# 卸载：在插件页移除 EnvDock，然后重启 dsh
```

删掉状态文件即回到全自动，不会影响其他插件。

## 常见问题

**为什么模型手里有两个命令工具（`envd_shell` 和 `ops_bash`）？**

这是 0.5 的设计：EnvDock **只增补、不遮挡**。宿主命令工具（`ops_bash` / `pwsh` …）按原样保留，EnvDock 在满足注册条件时再注册一个 `envd_shell`（用你配置的终端与 PATH）。两个都能用，简报会写清优先级：**优先 `envd_shell`**（它用你的 PATH / 终端），需要宿主语义（比如你就是要走宿主那套环境）时再用宿主工具。想少一个入口，把默认终端切到与宿主同族即可——那时 EnvDock 认为「同一个 shell 不重复提供两份」，不注册 `envd_shell`（面板备注会写「与 `ops_bash` 同族，EnvDock 不重复提供」）。

**为什么围栏会话里 `envd_shell` 会直接拒绝执行？**

因为本会话的有效策略不是 `danger-full-access`（例如 `workspace-write`）。EnvDock 通过 `ctx.subprocess` 执行，那条路没有 `sandboxPolicy` 入口——自己 spawn 就等于绕过围栏。所以 `envd_shell` 每一单都按**本会话**策略复检：被围栏（或策略不可知）时直接返回 `[sandbox] 本会话被宿主沙箱围栏(<mode>);EnvDock 的 envd_shell 不执行命令`，并请模型改用宿主工具；不执行、也不委托。宿主命令工具本身带围栏，可以正常用。想让这个会话也用 EnvDock 的终端，把会话权限切到 `danger-full-access`（下一次检查就生效）；如果**全部**会话都被围栏，EnvDock 干脆不注册（面板备注「没有无围栏会话，暂不注册」）。

**装了但侧边栏没有 EnvDock？**
去插件页确认 EnvDock 已启用，并重启 dsh。用命令行安装时，确认 `add` 的是正确的 profile。

**健康检查说「版本管理器激活的版本和 PATH 不一致」？**
典型场景：`fnm` 激活了 v20，但 PATH 上的 `node` 仍解析到系统安装的 v24。按提示在命令里用绝对路径，或先 `fnm use` / `pyenv shell` 让 PATH 跟上。

**改了系统 PATH，面板还是旧的？**
点「重新探测」。Windows 上会重读机器级 + 用户级注册表；POSIX 或宿主没有 `subprocess` 服务时只能读 dsh 启动时的进程 PATH，需要重启 dsh。

**局域网能做什么、不能做什么？**
局域网默认什么都读不到。在面板打开「允许局域网访问」后，局域网只能**读**面板数据；写操作（切终端、改默认版本、加自定义工具 / 终端 argv、改选项）一律只允许在本机发起。唯一允许的局域网写是**同源页面把「允许局域网访问」关掉**（打开必须在本机）——否则局域网里就能改默认终端的 argv，等于把命令注入面开到整个局域网。被 403 挡在门外时，面板底部的这个开关本身仍然可点。

**红黄灰三档健康检查各代表什么？**
红 = 错误（应用商店 Python 占位符、默认版本路径失效、默认终端不可用等）；黄 = 警告（多版本并存、版本过旧、PATH 有失效目录、版本管理器激活版本不一致等）；灰 = 提示（如 dsh 进程里的 PATH 是旧的）。

## 已知边界

- 探测的是**可执行文件与版本**，不解析 `.nvmrc` / `pyproject.toml` / `package.json` 里的版本要求。
- 版本探测依赖宿主的 `subprocess` 服务；没有它时只做 PATH 扫描，版本列显示「版本未知」。
- Volta / asdf 只报「在场」，不解析版本列表（输出格式随平台变，宁可不猜）。
- **EnvDock 不遮挡、不禁用任何工具**：宿主命令工具原样保留，`envd_shell` 只是增补入口。所以「模型手里同时有两个命令工具」是预期行为，优先级写在简报里；这不是配置项，也没有开关能让 EnvDock 去隐藏别人的工具。
- 增补出来的 `envd_shell` 是**精简执行器**：单次前台、输出截断、支持 `cwd` / `timeoutMs`，没有后台作业 / tail 落盘 / `sandbox_permissions` 升级。要这些能力就用宿主自带的命令工具（它一直在）。
- 围栏会话里 `envd_shell` 直接拒绝（不 spawn、不委托）：`ctx.subprocess` 没有 `sandboxPolicy` 入口，自己跑就是绕过沙箱；策略不可知按「被围栏」处理。
- 注册的四条条件（终端可用 / 宿主无同族命令工具 / 沙箱允许 / 名字没被占）任一不满足就不注册，面板只展示宿主工具；原因在备注与 `commandTool.skipReason` 里。全部会话被围栏时属「沙箱不允许」，不会出现「注册了却永远用不了」的死工具。
- 宿主命令工具靠名字 token / 描述启发式识别，**只用于展示**：认不出来只是详情里少一条 chips，不影响模型怎么调它，也不影响 EnvDock 要不要增补。
- 探测结果在内存里缓存 45 秒：只有改默认终端 / 自定义终端 / 默认版本 / 自定义工具会让它立即失效，改「允许局域网访问」这类选项不再触发全量重扫；「重新探测」会强制重扫并清空版本号缓存（版本号本身缓存 10 分钟，key 含 mtime+size）。
- 工作目录取**当前会话的工作目录**，不是 dsh 进程的 cwd。
- 定位以 Windows 为主；PATH 分隔符、`PATHEXT`、`.cmd/.bat` 垫片、POSIX 终端目录等跨平台细节已处理，但 Windows 之外的探测能力弱于 Windows。

更深的实现细节、设计取舍与自测说明见 [docs/DESIGN.md](https://github.com/tkochj/dsh-envdock/blob/main/docs/DESIGN.md)；各版本改了什么见 [CHANGELOG.md](https://github.com/tkochj/dsh-envdock/blob/main/CHANGELOG.md)。

## 开发

```
index.js          Host：探测、envd 工具、简报注入、命令工具增补、/envdock-api
client.js         Client：侧边栏图标 + 中央面板
cordis.patch.yml  bundle patch（insert id: envdock）
locale/           meta.title / meta.description（中英）
icon.svg          插件图标
CHANGELOG.md      版本变更记录
test/parsers.mjs        版本管理器输出解析自测
test/i18n-check.mjs     client.js 静态自检（词条/占位符/slot）
test/fixture/host.mjs   共享宿主夹具（假 Cordis 服务 + 真实 index.js，下面两个测试共用）
test/host-harness.mjs   Host 运行时夹具（替身服务，全链路）
test/simulate.mjs       用共享夹具跑真实 index.js，打印 /envdock-api 快照（人工排查 / 管道）
test/panel-render.mjs   面板渲染回归（极简 React 替身，零依赖，266 条断言）
docs/             设计文档与截图
```

```powershell
npm test                    # 四个自测一次跑完（只在源代码检出目录可用）

node test/parsers.mjs        # 版本管理器输出解析
node test/i18n-check.mjs     # 中英词条键/占位符一致、slot 注册仍在
node test/host-harness.mjs   # 用 Cordis 服务替身跑 apply()，覆盖所有 API op / envd action / 增补注册与围栏拒绝
node test/panel-render.mjs   # 用极简 React 运行时替身渲染面板，断言面板结构、文案与交互

node test/simulate.mjs --help   # 手动验证:起假宿主、打印面板载荷（--mode / --host-tools / --executor / --policy …）
```

`npm test` 只适用于**检出目录**：npm 包里不带 `test/`，从 npm 安装的插件没有这些自测可跑。欢迎 Issue / PR。提交前请保证四条自测全绿。

## 许可

[MIT](LICENSE) © 2026 EnvDock contributors
