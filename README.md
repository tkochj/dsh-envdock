[English](README.en.md) | **中文**

# EnvDock · 环境码头

[![npm](https://img.shields.io/npm/v/dsh-envdock?logo=npm)](https://www.npmjs.com/package/dsh-envdock)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6)
![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B32C3)

> 让 AI 开口之前就知道：你的 Windows 上 Node / Python / Git 装在哪、该用哪个版本、这个终端里命令该怎么写。

![EnvDock 面板：头部一行、置顶接管卡片、一行一个工具的工具链](https://raw.githubusercontent.com/tkochj/dsh-envdock/main/docs/panel.png)

> 截图是一屏里的**常显部分**：头部一行（插件名 · 默认终端与版本 · 一个状态 badge）、置顶的「终端 / 命令」卡片（这台机器上是旧版接口 + 宿主工具挡不掉，所以挂黄色「工具并存」并列两个工具名）、工具链一行一个工具、末尾一行环境检查、一行环境简报；设置 / 逐会话 / 详情默认收起。

Windows 上做开发，机器里常常并排放着好几套 Node / Python / Git，cmd、PowerShell、Git Bash 又各有各的语法。没有 EnvDock 时，AI 要先 `where node` 试探、猜路径、写错命令再重试——慢，而且容易在版本和语法上踩坑。

**EnvDock 是 DeepSeek Harness（dsh）的插件**：启动时把本机工具链探测清楚，把一份「环境简报」直接写进 AI 的上下文；需要时再接管命令工具，让 AI 用正确的终端语法干活。你不用填任何配置。

**适合谁**：在 Windows 上用 dsh 写代码的人；机器上装了多套 Node / Python / Git 的人；经常在 PowerShell、cmd、Git Bash 之间切换的人；希望 AI 少问「你用的哪个 node」的人。

**它不做什么**：不安装工具、不改系统 PATH、不替你决定版本——只负责把事实探清楚并告诉 AI。

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
- **终端接管（可选）**：默认终端与宿主自带的命令工具不同族时，注册一个固定名字的 `envd_shell` 并隐藏宿主 shell；切换终端立即生效，不出现「没有命令工具」的空窗；宿主命令工具按运行时工具定义识别（`ops_bash`、第三方发布名等），挡不掉或认不出家族就让路，仍然只留一个命令工具。
- **健康检查**：应用商店占位符、失效的 PATH 目录、旧版本、npm/Node 不配套、版本管理器激活版本与 PATH 不一致等。
- **`envd` 工具**：让 AI 随时按名字解析工具（`resolve`）、取简报（`summary`）、查健康（`check`）、切换默认版本（`set_default`）。

## 安装

**前置条件**：Windows + 已安装 DeepSeek Harness（dsh）。插件以当前 profile 为单位安装，下面以 `web` 为例。

> **npm 上的版本可能滞后于本仓库**。想用最新的功能（一屏面板、逐会话接管事实、托管命令工具的动态识别等），请用下面的本地目录 / Git 方式安装；npm 上的包跟随发布更新，安装前可以先看仓库 `package.json` 里的版本号。

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
3. **按需调整**：在置顶的接管卡片里切终端；点「设置」改接管模式；在工具链里点路径复制、点「N 个版本」选默认版本。
4. **回到会话**：AI 已经拿到新的环境简报，直接干活。

## 面板导览

面板按「一屏说四件事」组织：**这台机器默认用哪个终端**、**模型现在手里的命令工具是什么**、**装了哪些工具**、**有没有问题**。常显的只有头部一行、一张置顶接管卡、一节工具链和底部一行；设置、逐会话、详情、环境检查列表、简报正文都收在触发词后面。720px 高的窗口（可用约 600px）里，常显内容基本不需要滚动。

| 区域 | 常显内容 |
|---|---|
| **头部（一行）** | 插件名 · 默认终端与版本（如 `Git Bash v5.3.15`）· **恰好一个**状态 badge · 右侧「重新探测」（按系统**当前** PATH 重扫，Windows 会重读注册表并清空版本缓存）。 |
| **状态 badge** | 整个面板唯一的状态结论，按严重程度只取一个：红「N 个会话异常」（或工具本该可见却变成「无命令工具」）> 黄「N 个会话未接管」/「让路」/「工具并存」> 绿「接管中」> 灰「未接管」/「沙箱」/「由其它插件提供」（一个命令工具都没探测到时也是灰「无命令工具」）。悬停能看到命令工具名、会话数和备注原文。 |
| **接管卡 · 终端** | `终端` chips：`自动` + 探测到的各终端 + `+`（自定义终端：路径 / 名称 / 参数模板）。切终端立即生效。 |
| **接管卡 · 命令** | `命令` 行：状态词 chip（与头部 badge 是同一句结论）+ 实际命令工具名（接管时是 `envd_shell`，让路时是 `ops_bash`，并存时两个都列如 `envd_shell · ops_bash`）+ 一句会话计数（`3 个会话 · 2 直连 · 1 沙箱`）+ 右侧 会话 / 设置 / 详情 三个 ghost 按钮（没有逐会话事实时没有「会话」）。 |
| **常显备注** | 每行一句、只说用户需要知道的事实：接口是旧版构建（逐会话信息不可用）、宿主工具挡不掉已让路 / 与 `envd_shell` 并存、N 个会话看不到 `envd_shell`、沙箱策略未知、N 个会话被围栏、最近错误。 |
| **设置（默认收起）** | 点「设置」展开两组 chip：接管模式（自动 / 总是接管 / 只给简报）、沙箱下接管（委托执行 / 直接拒绝）。 |
| **逐会话（默认收起，异常自动展开）** | 每个会话一行：id 前 8 位 · 终局（直连 / 未接管 / 让路 / 沙箱）· 实际工具名 · 围栏或已挡信息 · 原因。异常行整行标红、原因写在行尾；只要有一个异常会话，这一节就自动展开、异常行排在最前。 |
| **已识别宿主工具（一行）** | 运行时**真的见过**的宿主命令工具 chips（`名字 · 家族`）；靠名字 / 描述启发式认出来的带 ✦「自动识别」标记；一个都没有就写「未识别到宿主工具」。 |
| **详情（默认收起）** | 对账计数：注册 / 拆除 / 遮挡 / 释放 / tick、委托（尝试 · 调用 · 失败 · 拒绝 · runner 失败 · 取消）、守卫拒绝、让路轮次、执行器族、探测次数与耗时；有问题时摘要先写「N 个会话异常」。完整字段见 `/envdock-api` 的 `syncStats`。 |
| **工具链** | 每个工具**一行**：分组名（只在该组第一行出现）· 名称 · 版本 · 路径（**点路径即复制**）· 行尾「N 个版本 ▾」（点开才列候选与「设为默认」）。版本管理器也一行一个（激活版本带 ←），末尾是「+ 自定义工具」入口。 |
| **环境检查（工具链末尾一行）** | 健康时 `✓ 通过`；有问题时 `⚠ N 项` + 第一条标题，点开展开完整列表（红 / 黄 / 灰分档）。 |
| **环境简报（一行）** | 状态（已注入给 AI / 简报注入已关闭）+「复制」+「展开」；展开才显示简报正文。 |
| **底部（一行）** | 两个开关（简报注入、允许局域网访问——被 403 挡在门外时也能点）+ 复制反馈（`aria-live`）+ 脚注（系统 · 架构 · 主机名 · 更新于）。 |

面板每 15 秒静默拉一次 `/envdock-api`（只在页面可见时拉；payload 没变就不重渲染，所以计数变化本身不一定刷新界面）。任何操作失败都会出现可关闭的错误条，复制失败也会明确提示，不再静默吞掉。

## AI 看到什么

### 环境简报

插件会把类似下面的一段文字写进运行上下文（具体内容随机器变化）：

```text
## 本机环境 (EnvDock 实测,优先于猜测)
- 系统: Windows_NT 10.0.26300 (x64),用户 LAPTOP-XXXX
- 默认终端: Windows PowerShell → C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe (v5.1.26100)
  · 串联用 `;`,条件串联 `&&`/`||` 只有 PowerShell 7 支持
  · 环境变量 `$env:NAME`,调用外部程序要 `& $exe` 或用完整路径
  · 命令工具: `envd_shell`(EnvDock 已接管),里面只能写 Windows PowerShell 语法
- 工具(绝对路径,直接用,不必再 where/which):
  · Node.js v24.18.0 → C:\Program Files\nodejs\node.exe [另有 v20.19.0 ...]
  · Python v3.12.10 → D:\python\python.exe [...]
  · Git v2.55.0 → E:\Git\cmd\git.exe
- 版本管理器: pyenv-win(...) [2 个版本], fnm(...) [1 个版本,激活 v20.19.0]
- 未列出的工具仍可用 `envd` 工具按名字解析(resolve),不要用 where/which 反复试探。
```

### `envd` 工具

| action | 作用 | 何时用 |
|---|---|---|
| `summary`（默认） | 完整环境简报 | 想看 AI 拿到的原文 |
| `resolve` | 按名字返回默认路径、版本、全部候选、终端 | 需要精确路径或确认版本 |
| `check` | 返回健康问题清单 | 排查环境问题 |
| `set_default` | 把某个候选路径设为默认 | 切换版本 |

`resolve` 支持别名：`python` / `python3` / `py` 会命中同一条 Python 记录；`py.exe` 是启动器，结果里会单独说明 `py -3.10` 这类用法。

### 命令工具接管

- 宿主自带的命令工具是 `pwsh` / `bash` 等；当你的默认终端与它不是同一族时，EnvDock 会注册固定名字的 `envd_shell`，并隐藏宿主 shell，避免模型在两种语法之间猜。
- 与宿主同族时**什么都不做**，不会重复造工具。
- **沙箱按会话判，不按部署默认档判**：dsh 的执行器公布 `sandboxMode`（那是**部署默认档**），真实策略要逐会话 `sandboxPolicy.resolve({ session })`，而且是三态：**确定无围栏 / 确定有围栏 / 策略不可知**。合法策略只有 `read-only` / `workspace-write` / `danger-full-access` 三种闭集：resolve 返回 `{}`、空 mode 或闭集之外的值时一律按「策略不可知」保守处理，**不再回落到部署默认档**。只有**至少一个会话证明无围栏**时才注册 `envd_shell`；一个会话被围栏不影响别的会话（`read-only` / `workspace-write` 的会话保留宿主命令工具）。策略不可知（resolve 抛错、没有策略服务、返回非法值）按「有围栏」保守处理：该会话藏 `envd_shell`、留宿主工具，绝不拿部署默认档冒充。反向也一样：执行器自称不围栏、但策略服务明确说本会话受围栏时，EnvDock 仍然拒绝自己 spawn / 委托（按有围栏处理）。如果**所有**会话都被围栏，EnvDock 干脆不注册工具——每个会话都是「未接管」，模型直接用宿主工具（注册了也只能被自己藏起来，还多一次拆建）。
- **宿主命令工具是运行时认出来的，不是写死名单**：有 `tools.definitions` 的宿主上，EnvDock 枚举工具定义，按名字里的家族 token（`ops_bash`、`tenant_pwsh` 之类）以及「描述提到 bash / PowerShell / cmd / WSL 且参数里有 command 类字段（`command` / `cmd` / `script` / `commandline`）」认出宿主的命令工具，再按家族参与接管判定。`ops_bash` 属于**内置 bash 家族**，命中内置表就短路，不要求 command 参数；「名字 token + command 参数」那道门槛只管第三方发布名。反过来，**名字里带 cmd 不等于命令工具**：`run_cmd`（参数是 task）、`wc_cmd_palette`（UI 面板）这类没有命令参数的工具不会被认领，否则接管会静默挡掉无关工具。认不出的名字不进遮挡名单；认得出工具、却认不出它的家族时**让路**——教不了语法就不猜。
- **挡不掉或认不出的宿主 shell 自动让路**：宿主把 `ops_bash` 这类工具注册在作用域私有层时，`restrict` 实测挡不掉它，EnvDock 反过来藏自己的 `envd_shell`，该会话只留宿主那一个命令工具。判定按**作用域**：官方 `pwsh` 全局注册、`ops_bash` 按会话发布时，每个会话只挡它自己真见过的宿主 shell，挡不掉的那个还在就让路——不会出现 `envd_shell` 与宿主工具并列。挡不掉的名字只记在它所在的作用域（不株连别的会话：那边挡得掉就照挡），计划按「每个会话只留一个命令工具」设计。
- **两种「挡不掉」，处理方式不同**：**结构性**挡不掉——宿主工具注册在 agent 自己的层里，而 `restrict` 的 `restrictableNames` 只含继承面（契约原文：restrictions "do not affect scoped registrations"），重试也没用：这类名字给 10 分钟 TTL、**不写 `lastError`**、不每 30 秒刷一次红。**临时性**挡不掉（publication reentry、热重载空窗）——30 秒后自动重试，并如实记一条错误；过渡性缺名只进 30 秒重试窗口，不永久判死。
- **新增终局「工具并存」**：面板拿不到逐会话事实时（`/envdock-api` 是旧版构建），如果宿主工具挡不掉、`envd_shell` 又同时可见，只能挂黄色「工具并存」并在命令行列两个工具名（如 `envd_shell · ops_bash`）——不谎报「接管中」，也不说成「让路」（EnvDock 的工具还看得见）。有新接口时按逐会话终局判，终局里没有「并存」这一档；并存本身是「一个会话两个命令工具」的信号，备注会说明是旧接口无法逐会话核对。
- **和 dsh-ops 共存**：`ops_bash` 由 dsh-ops 在会话层发布，EnvDock **挡不掉**它 → 让路（藏 `envd_shell`，模型用 `ops_bash`，每个会话仍然只有一个命令工具，简报会写明「EnvDock 已让路」）。想让这个会话用 EnvDock 的终端接管，唯一受支持的入口是在 **dsh-ops 的设置里关掉它的 Publish Bash**（没有 unregister API，EnvDock 侧无法代劳）。
- **委托执行只支持 bash / PowerShell 目标**：包装串跟**宿主执行器**的语法族走（`executorFamily`：先看 `ctx.shell` 对象 / 类名里的线索，判不出来时按平台默认，win32 是 PowerShell，其余平台是 bash）。命令数据**不走命令行**——bash 目标把用户命令 base64 放进环境变量 `ENVD_CMD`，由 `printf %s $ENVD_CMD | base64 -d | bash -s` 解码执行（外层 `-lc` 已经是登录 shell，内层不再带 `-l`，避免 profile 跑第二遍）；PowerShell 目标用 `-NoProfile -NonInteractive -Command`，脚本先从 `$env:ENVD_CMD` 解 UTF-8 base64 再 `Invoke-Expression`，并把 `[Console]::OutputEncoding` 固定成 UTF-8（非 65001 代码页下不出现中文乱码）。这样宿主命令行里永远不出现用户命令，PowerShell 5.1 吞参数引号的 bug 无从触发；宿主是 MSYS/Git Bash 时也不会把 cmd 的 `/d /s /c` 改写成路径。**cmd / WSL / 自定义终端目标一律拒绝委托**（那些路径上命令会静默不执行）。执行器族判成 cmd、执行器不存在、没有会话信息、或拿不到合法本会话 policy 时同样拒绝，绝不猜、也不拿部署默认档冒充；拒绝文案会带上事实（「本会话策略 X」「本会话被沙箱围栏」「本会话沙箱策略不可知」），不让模型以为工具坏了或命令写错了。
- **工具表一变就立刻对账**（监听 `tools/change`，同一轮变更合并成一次）：别的插件晚一步注册或撤销 shell 时，遮挡是立即收敛，不用等 5 秒轮询。
- **被藏掉的命令工具直呼时给可操作拒绝**（`tools.guard`）：宿主 shell 被藏时告诉你「已由 EnvDock 接管，改用 `envd_shell`」；反过来，让路 / 沙箱会话里 `envd_shell` 被藏后仍被直呼时，会指出该会话里真的可见的宿主工具（原因取自逐会话事实：沙箱围栏，还是宿主 shell 作用域私有）。都不是没头没尾的 `UNKNOWN_TOOL`。守卫按「替代品此刻能不能用」判：宿主提供 `tools.executable` 时按可执行面，没有时只能按可见性；判不出时给「暂时无法判定」或直接放行，绝不编造工具名。注意它不是安全边界：PTC 模式下模型直呼可能被折叠进 `run_code`，守卫不一定看得到那次调用；而且 dsh-ops 0.5.0 可能**先**挂自己的 `tools/pre-execute` deny / guard，那种情况下调用根本走不到 EnvDock，方向二的文案不一定出现、`guardDenials` 也可能一直是 0——这是正常的，不代表守卫失效。
- **接管诊断带常用计数**：面板悬停 / 详情区显示注册尝试 / 注册、拆除、遮挡、tick、委托尝试 / 委托调用 / 委托失败 / **委托拒绝** / **runner 失败** / **委托取消**、守卫拒绝、让路轮次、释放遮挡、执行器语法族、探测次数与耗时、守卫是否注册成功、本 tick 是否稳态、最近错误及龄期。完整字段（`ownHides` / `hostDenyApplies` / `denyNoops` / `transientMisses` / `steadySinceAt` / `scopeAnomalies` / `runtimeShellTools` / `hasExecutableApi` …）在 `/envdock-api` 的 `syncStats` 里。委托计数分开记：进入委托路径就 +1 尝试；目标 / 执行器不支持记「委托拒绝」；只有拿到合法执行结果且命令真的执行了才 +1「委托调用」；围栏 runner 坏了、命令没跑记「runner 失败」；命令被取消记「委托取消」——三种结局都有痕迹，不会把「没走委托」和「runner 挂了」混成一个 0。
- **`commandTool.hostName` 取真正的宿主工具**：优先从逐会话事实里取（所有会话的 `hostTools` 并集只有一个名字时就是它），dsh-ops 场景下报的是 `ops_bash`，不再误报成 `pwsh`；拿不到逐会话事实时才退回运行时登记的 shippedName。
- 注册失败或被同名工具占用时，EnvDock 放弃接管并保留宿主工具，不会让你一个命令工具都没有。

## 设置与状态

配置保存在 `~/.dsh/envdock.json`（原子写入；损坏时自动备份为 `envdock.json.corrupt` 并回落到默认值）。

| 选项 | 默认 | 说明 |
|---|---|---|
| 简报注入 | 开 | 是否把环境简报写进 AI 上下文 |
| 终端接管 | 自动 | `自动`：不同族才接管；`总是接管`：强制接管；`只给简报`：不注册命令工具 |
| 沙箱下接管 | 委托执行 | 围栏会话里 EnvDock 自己的工具还没被摘掉时：`委托执行` 把命令经带围栏的宿主执行器转发（不绕过沙箱；只支持 **bash / PowerShell 目标**，包装串按执行器语法族、命令走 base64 数据通道；这次调用的终端选择仍生效）；cmd / WSL / 自定义终端目标会拒绝委托。`直接拒绝` 一律报错。稳态围栏会话用的是宿主命令工具 |
| 允许局域网访问 | 关 | 打开后局域网只能**读**面板数据。所有写操作（切终端、改默认版本、加自定义工具 / 终端 argv、改选项）都只允许在本机发起；唯一例外是同源页面把本开关**关掉**（打开必须在本机，否则等于把命令注入面开到局域网） |
| 自定义工具 | 空 | 补充 PATH 之外的工具 |

### 重置 / 卸载

```powershell
# 重置所有设置（默认终端、默认版本、选项）
Remove-Item ~/.dsh/envdock.json

# 卸载：在插件页移除 EnvDock，然后重启 dsh
```

删掉状态文件即回到全自动，不会影响其他插件。

## 常见问题

**为什么模型看到的是 `ops_bash` 而不是 `envd_shell`？**

命令工具是**逐会话**定终局的：同一台 dsh 里，不同会话的模型可能拿到不同的命令工具。看到 `ops_bash` 通常意味着 EnvDock 在这个会话里**让路**或**没接管**了，不是接管坏了。宿主命令工具是运行时认出来的（`ops_bash`、第三方发布名……），认不出家族就不猜语法、直接让路。四种逐会话终局（外加一种旧接口下的汇总态）与面板表现：

| 终局 | 什么时候出现 | 模型手里 | 面板 |
|---|---|---|---|
| 直连接管（takeover） | 至少有一个会话无围栏（EnvDock 才注册 `envd_shell`），且本会话里宿主 shell 已被成功遮挡 | `envd_shell`（只能写默认终端的语法） | 所有会话都直连接管时挂绿「接管中」；否则挂黄「N 个会话未接管」 |
| 未接管（host） | EnvDock 没接管这个会话：「只给简报」、注册失败 / 名字被占用、与宿主同族，或**所有会话都被围栏（根本不注册工具）** | 宿主工具 | 混合时「N 个会话未接管」；全部未接管 / 全部围栏时头部只有灰色 badge（「未接管」/「沙箱」），不挂黄色告警 |
| 让路（yield） | 宿主 shell 挂在作用域私有层、`restrict` 实测挡不掉（dsh-ops 的 cordis 模式就把 `ops_bash` 按会话挂），或认不出这个工具的家族 | 宿主那个工具（如 `ops_bash`） | 「N 个会话未接管」；全部会话都是让路时直接挂「让路」 |
| 沙箱让路（sandbox-host） | **混合部署**里本会话被围栏：工具已经为别的无围栏会话注册，本会话藏掉 `envd_shell` | 宿主带围栏的命令工具 | 「N 个会话未接管」 |
| 工具并存（仅旧接口的汇总态） | `/envdock-api` 是旧版构建、拿不到逐会话事实，而宿主工具挡不掉、`envd_shell` 仍可见 | 两个（如 `envd_shell` 与 `ops_bash`） | 黄色「工具并存」+ 命令行列出两个工具名，不谎报接管 |

注意 `sandbox-host` 只在「至少一个无围栏会话 + 本会话被围栏」时出现；**单会话或全部会话都被围栏时是 `host`**——EnvDock 根本不注册 `envd_shell`（注册了也只能被自己藏起来，还多一次拆建）。

让路时 EnvDock 反过来藏自己的 `envd_shell`，保证这个会话里只有一个命令工具；简报会直说：

```text
· 命令工具: `ops_bash`(宿主自带,用 bash / sh 语法);宿主 shell 在这个会话里挡不掉或无法替代,EnvDock 已让路,直接用这个
```

计划按「这个会话只留一个命令工具」设计；万一真的出现「零命令工具」或「接管后宿主仍可见」，逐会话事实里的 `anomaly` 会标出来（面板挂「N 个会话异常」），不靠汇总数字掩盖。

**面板头部的「N 个会话未接管」「N 个会话异常」是什么意思？**

EnvDock 逐会话对账，不搞「全局接管成功 / 失败」一刀切：

- **N 个会话未接管**（黄）：N = 没有在直连接管上的会话数（未接管 / 让路 / 沙箱让路）。数字直接从 `commandTool.scopes` 推，不再用 `sandboxHiddenScopes` 之类汇总值凑数。只有「部分接管 + 部分未接管」才挂黄色；**全部会话都没接管时头部是灰色「未接管」**，不会把一个都没接管说成混合告警。
- **N 个会话异常**（红）：该会话里既看不到 `envd_shell` 也看不到宿主命令工具（零工具），或者接管后宿主工具仍然可见（两个），或者挡了却仍可见（`leaked` 非空）。这是该修的状态，不是正常终局；「让路」本身不算异常，详情里不再给它挂 ⚠。
- 悬停 badge 的 title 会给出命令工具名、会话数与常显备注原文；逐会话细节点「会话」展开，对账计数点「详情」展开，字段全集见 `/envdock-api`。
- `/envdock-api` 的 `commandTool.scopes` 就是同一份事实：`id`、`kind`、`tool`、`hostTool` / `hostTools`（该会话里实际可见的宿主工具）、`ownVisible`、`hideOwnPlanned`、`visible`、`hidden`（实际生效的遮挡）、`leaked`、`hidesOwn`、`confined`（**三态**：true / false / null=策略不可知）、`policyKnown`、`mode`、`anomaly`。新构建在没有会话时给 `scopes: []`，面板会写「当前无会话」，不会误报成旧版构建。
- 如果 `/envdock-api` 是旧版构建（没有 `scopes` 字段），面板会出现一条「接口是旧版构建，逐会话信息不可用；重启 dsh 后可显示」的备注，只能按汇总事实给一个终局（宿主工具挡不掉而 `envd_shell` 仍可见时是「工具并存」）；重启 dsh 加载新版本后才逐会话列出，也没有「会话」按钮。
- 只有工具注册成功、且没有会话落到「未接管」时，头部才挂「接管中」（还没有任何会话时也算：工具本身已经在了）。

**沙箱会话为什么没有 `envd_shell`？**

因为本会话解析出的有效策略不是 `danger-full-access`（例如 `workspace-write`）。EnvDock 自己的执行走 `ctx.subprocess`，那条路没有 `sandboxPolicy` 入口——自己 spawn 就等于绕过沙箱。分几种情形：

- **全部会话都被围栏**：EnvDock 不注册 `envd_shell`，每个会话的 `kind` 都是 `host`（未接管），模型直接用宿主自带、带围栏的命令工具；头部只挂灰色 badge（执行器会围栏时是「沙箱」，否则「未接管」），卡片状态词是「未接管」——不会出现「接管中」，也不是黄色混合告警。
- **混合部署（至少一个会话无围栏）**：工具注册了；围栏会话的 `kind` 是 `sandbox-host`——本会话把 `envd_shell` 藏掉。
- **策略不可知**（`sandboxPolicy.resolve` 抛错 / 没有策略服务 / 返回 `{}`、空 mode 或闭集外的值）：按「有围栏」保守处理，同样藏 `envd_shell`、留宿主工具；`commandTool.scopes[].confined` 是 `null`、`policyKnown` 为 `false`，面板会标「策略未知」。合法策略只有 `read-only` / `workspace-write` / `danger-full-access`，非法值不会回落到部署默认档。

两种情形的简报都按围栏说（工具名随机器变化）：

```text
· 命令工具: `pwsh`(宿主自带,用 PowerShell 语法);本会话被沙箱围栏(workspace-write):EnvDock 不接管(接管会绕过沙箱),以工具表里那个工具为准
```

注意 `sandboxMode` 只是**部署默认档**：能力位（执行器会不会围栏）/ 部署默认 / 本会话有效策略是三层事实，最后一层逐会话问 `sandboxPolicy.resolve({ session })`。想在这个会话里也用 EnvDock 的终端，把会话权限切到 `danger-full-access`，下一次对账就接管（工具表变更时更快）；但如果宿主 shell 是作用域私有、`restrict` 挡不掉，即使无围栏也还是走让路，模型仍用宿主工具。

「沙箱下接管 → 委托执行」不是「围栏下也能用 EnvDock 终端」的开关：委托把命令经带围栏的宿主执行器转发（`resolve` + `execute`，命令数据走 `ENVD_CMD` 的 base64 通道，围栏挂在宿主进程上、子进程继承），只在 `envd_shell` 还没从该会话工具表里摘掉的极短窗口（策略刚变严、对账还没跑到）有意义——稳态下这个会话根本没有 `envd_shell`。包装串按**宿主执行器**的语法族生成（`executorFamily`），不是按模型手里的工具名；而且**只支持 bash / PowerShell 目标**：bash 目标下用户命令在 `ENVD_CMD` 里以 base64 传入、由 `printf %s $ENVD_CMD | base64 -d | bash -s` 执行（外层 `-lc` 已是登录 shell，内层不再重复 profile），PowerShell 目标用 `-Command` 从 `$env:ENVD_CMD` 解 UTF-8 base64 再 `Invoke-Expression`、并固定 `[Console]::OutputEncoding`，所以 PowerShell 5.1 吞引号、MSYS 改写 cmd 参数这两类「命令静默不执行」的坑都绕开了、非 65001 代码页也不会乱码。cmd / WSL / 自定义终端目标直接拒绝委托；执行器族判成 cmd、执行器不存在、没有会话信息、或拿不到合法本会话 policy（空 / 非法 mode 也算）时同样拒绝，绝不用部署默认档冒充。

**装了但侧边栏没有 EnvDock？**
去插件页确认 EnvDock 已启用，并重启 dsh。用命令行安装时，确认 `add` 的是正确的 profile。

**接管后模型只能用一个 `envd_shell`，能力变少了？**
这是精简执行器的取舍：单次前台、输出截断、支持 `cwd` / `timeoutMs`，没有后台作业、tail 文件、`sandbox_permissions` 升级。把这些能力看得更重要时，在面板把「终端接管」切到 **只给简报**，宿主工具立刻回来。

**为什么面板说「本会话被沙箱围栏，EnvDock 不接管」？**
因为本会话的有效策略不是 `danger-full-access`（降级行为见上文「沙箱会话为什么没有 `envd_shell`」）。dsh 执行器公布的 `sandboxMode` 只是**部署默认档**，不代表你的会话真的被围栏——面板把「能力位 / 部署默认 / 本会话有效策略」三层分开写，逐会话策略在 `/envdock-api` 的 `sandbox.scopes` 里逐个给出（`confined` 三态 + `policyKnown`）。想让这个会话也用 EnvDock 的终端：把会话权限切到 `danger-full-access`，下一次对账就接管（工具表变更时更快）。

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
- 接管后的命令工具是精简执行器（见上文），不提供后台作业等宿主 shell 的高级能力。
- 宿主把命令工具注册在作用域私有层时，`restrict` 挡不掉它（契约：restrictions "do not affect scoped registrations"）：EnvDock 只能让路，该会话不出现 `envd_shell`（这不是配置项）。结构性挡不掉的名字 10 分钟重试一次、不写 `lastError`；临时性的 30 秒重试并如实记错误。dsh-ops 的 `ops_bash` 属于前者，想让 EnvDock 接管就得在 dsh-ops 设置里关掉 Publish Bash。
- 宿主命令工具靠名字 / 描述启发式识别：认不出家族的命令工具不会被遮挡也不会被教语法，EnvDock 让路，模型继续用它原来的用法。
- 拒绝守卫是「可操作提示」，不是安全边界：宿主没有 `tools.executable` 时它只能按可见性判断；PTC 模式下模型直呼可能被折叠进 `run_code`；dsh-ops 0.5.0 还可能先用自己的 `tools/pre-execute` deny / guard 拦掉，EnvDock 的方向二文案不一定出现（`guardDenials` 甚至可能一直是 0）。
- 委托执行只支持 **bash / PowerShell 目标**：cmd / WSL / 自定义终端目标会被拒绝（命令会静默不执行）；`read-only` / `workspace-write` 这类围栏策略下也不会自己 spawn，只走委托或拒绝。PowerShell 5.1 作为宿主仍是安全的——命令走 `ENVD_CMD` 的 base64 数据通道（`-Command` + `Invoke-Expression`），不拼命令行；但 cmd 目标就是不支持委托。
- 全部会话都被围栏时 EnvDock 不注册 `envd_shell`（每个会话都是「未接管」），头部是灰色 badge 而不是「接管中」；`sandbox-host` 只在混合部署（至少一个有围栏、一个无围栏）里出现。
- 探测结果在内存里缓存 45 秒：只有改默认终端 / 自定义终端 / 默认版本 / 自定义工具会让它立即失效，改「允许局域网访问」这类选项不再触发全量重扫；「重新探测」会强制重扫并清空版本号缓存。
- 宿主命令工具必须**此刻真的可见**（或仍在我们的遮挡里）才算存在：见过之后又消失了，EnvDock 会接管兜底，不会永远以为「与宿主同族」而不干活；从没见过宿主时给约 60 秒宽限，避免和晚注册的宿主插件抢。
- 工作目录取**当前会话的工作目录**，不是 dsh 进程的 cwd。
- 定位以 Windows 为主；PATH 分隔符、`PATHEXT`、`.cmd/.bat` 垫片、POSIX 终端目录等跨平台细节已处理，但 Windows 之外的探测能力弱于 Windows。

更深的实现细节、设计取舍与自测说明见 [docs/DESIGN.md](https://github.com/tkochj/dsh-envdock/blob/main/docs/DESIGN.md)；各版本改了什么见 [CHANGELOG.md](https://github.com/tkochj/dsh-envdock/blob/main/CHANGELOG.md)。

## 开发

```
index.js          Host：探测、envd 工具、简报注入、终端接替、/envdock-api
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
test/panel-render.mjs   面板渲染回归（极简 React 替身，零依赖，194 条断言）
docs/             设计文档与截图
```

```powershell
npm test                    # 四个自测一次跑完（只在源代码检出目录可用）

node test/parsers.mjs        # 版本管理器输出解析
node test/i18n-check.mjs     # 中英词条键/占位符一致、slot 注册仍在
node test/host-harness.mjs   # 用 Cordis 服务替身跑 apply()，覆盖所有 API op / envd action / 接管路径
node test/panel-render.mjs   # 用极简 React 运行时替身渲染面板，断言面板结构、文案与交互

node test/simulate.mjs --help   # 手动验证:起假宿主、打印面板载荷（--mode / --host-tools / --unrestrictable …）
```

`npm test` 只适用于**检出目录**：npm 包里不带 `test/`，从 npm 安装的插件没有这些自测可跑。欢迎 Issue / PR。提交前请保证四条自测全绿。

## 许可

[MIT](LICENSE) © 2026 EnvDock contributors
