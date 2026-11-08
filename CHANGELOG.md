# Changelog

本文件记录 EnvDock 的重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-11-08

> 0.1.0 之后的公开发布。仓库开发期用过 0.2–0.6 的内部编号，本次对外统一为 0.2.0；对应关系见下方内部迭代记录。

### 本次发布包含
- 按会话只暴露一个语法族：bash 族 / PowerShell 族；bash 族会话遮挡内置 pwsh/powershell（可关）
- 手动选 bash 时优先按你的选择遮挡（即使没有 bash 宿主工具）
- 受限会话里 envd_shell 委托宿主沙箱执行器在沙箱内执行（不再一律拒绝）
- 面板首屏收敏：用途一句、白话二态 badge、bash 语法/其它命令工具、高级设置折叠
- 工具链探测 / 版本管理器 / 默认版本切换 / 环境简报注入 / envd 工具 / 健康检查
- 详细变更见下方 0.5.0 / 0.6.x 内部迭代记录（未发布到 npm）

> 以下 0.5.0 / 0.6.x 为开发期内部版本号，未发布到 npm；对外的发布版本是 0.2.0。（更早的 0.2.0-dev / 0.3.0 / 0.4.0 同样是开发期内部迭代，条目保留原样。）

## [0.6.3] - 2026-11-08

> 手动选 bash 时以用户选择为准：只要 EnvDock 自己的 bash 入口 `envd_shell` 在本会话能跑，即使没有 bash 族宿主工具也遮挡 PowerShell 内置名。自动选族、粘性、重新探测、沙箱委托与注册条件都不变。

### Changed

- **遮挡触发条件扩展（手动 bash 优先）**：第三条「有 bash 入口」从「该会话看得到 bash 族宿主工具」扩展为三选一——① 看得到 bash 族宿主工具；② 上次已经遮过（sticky）；③ **手动选了 bash 且 `envd_shell` 在本会话能跑**（bash 终端可用，且本会话非受限或受限但可委托宿主沙箱执行；注册失败不算）。手动 bash + 宿主只有 `pwsh` 的机器（例如 dsh-ops 关闭时）现在会隐藏 `pwsh` / `powershell`，模型仍用 `envd_shell`（bash）。
- **「未遮挡」只在确实没有可用 bash 命令工具时出现**：手动 bash 且没有 bash 族宿主工具、`envd_shell` 也不可用（没有 bash 终端 / 受限且不能委托 / 注册失败）。简报文案改为「本会话没有可用的 bash 命令工具(也没有 bash 宿主工具),EnvDock 未遮挡 PowerShell 族」；面板改为「这个会话没有可用的 bash 命令工具，未隐藏 PowerShell 工具」，且只在 `hidden` / `refuseOnly` 都为空时出现。
- **其余口径不变**：自动选族、粘性记忆、重新探测重判、沙箱委托执行、注册三条件都不动。

### Fixed

- **「我手动选了 bash，面板却说没隐藏 PowerShell」**：以前手动 bash 但会话看不到 bash 宿主工具时不遮挡，用户的选择和面板结论打架；现在以用户选择为准，只要 `envd_shell` 能跑就遮挡。
- **「未隐藏」备注与事实矛盾**：已隐藏 / 只拒绝时面板不再显示「未隐藏」备注；旧文案「没有 bash 命令工具」也改成「没有可用的 bash 命令工具」。

## [0.6.2] - 2026-11-08

> 受限会话里 `envd_shell` 不再一律拒绝：恢复 0.4 的**沙箱委托执行**，把命令交给宿主的沙箱执行器 `ctx.shell` 在沙箱内执行。注册条件、API、简报与面板文案随之调整；安全边界不变——EnvDock 自己 spawn 的路径**永远不带** `sandboxPolicy`，只有 `ctx.shell` 能挂围栏。

### Changed

- **受限会话恢复委托执行**（0.5 删掉的能力回归，实现从 0.4 搬回）：`gate.confined` 时把命令委托给 `ctx.shell`（`resolve(request)` → `execute(spec)` → `result()`）；围栏挂在宿主进程上，目标终端作为子进程拉起并继承同一份围栏。命令文本按 UTF-8 → base64 经环境变量 `ENVD_CMD` 传入，**不拼字符串、不经 shell 引号**；`request` 带本会话的 `sandboxPolicy`、`workdir`、`timeoutMs`、`signal` 与可选 `dshEnv`（宿主 `shellEnv.collect`）。
- **委托的输出与结局**：输出以 `[sandbox] 委托宿主执行器执行(<mode>)` 开头、末尾 `[exit …]`；`runnerFailed`（围栏 runner 坏了、命令没执行）/ `aborted`（取消）/ `timedOut`（超时）都有独立标记；`runnerFailed` / `aborted` 时 `ok:false`（命令没执行或没跑完，不能报成功）；文件写入被沙箱策略拒绝时标 `[sandbox: 文件操作被沙箱拒绝 —— 这是策略拒绝,不要换旁路重试]`。
- **注册条件放宽**：`skipReason='no-unconfined-session'` 只在「有围栏执行器 + 没有任何 `danger-full-access` 会话 + **这个部署不能委托**」时出现；能委托时即使全部会话受限也照常注册（受限会话里走沙箱内执行）。
- **`/envdock-api`**：`sandbox`（顶层与 `commandTool.sandbox`）新增 `delegatable`——这个部署能不能委托；面板 / 简报据此决定说「会在沙箱内执行」还是「不会执行」。
- **简报（按会话）**：受限 + 能委托 → 追加「本会话受沙箱限制:envd_shell 会通过宿主执行器在沙箱内执行(文件写入可能被拒绝)」；受限 + 不能委托 → 追加「本会话受沙箱限制且无法在沙箱内执行:改用宿主工具」。
- **面板**：受限备注在 `delegatable=true` 时由 warn 降为 muted「另有 N 个会话受沙箱限制：envd_shell 会在沙箱内执行（文件写入可能被拒绝）」；`false` / 旧载荷缺字段保持 warn「…在那些会话里不会执行命令，请改用其它命令工具」。
- **仍然拒绝的边界**：宿主没有 `shell.resolve/execute`；宿主执行器语法族不是 bash / PowerShell（cmd / 认不出）；目标终端是 cmd / WSL / 自定义终端；拿不到合法 `sandboxPolicy`（绝不拿部署默认档冒充）；命令太长（base64 载荷 > 30000）。
- **安全边界不变**：`ctx.subprocess` 仍然没有 `sandboxPolicy` 入口，所以 EnvDock 自己 spawn 的命令永远不带围栏；取不到策略就拒绝，绝不退回无围栏 spawn。

### Fixed

- **「受限会话里 `envd_shell` 完全不能用」**：以前受限会话一律拒绝（只能换宿主工具）；现在能安全委托时命令仍在沙箱内执行，只有真的无法安全委托才拒绝，并说明原因、指路宿主工具。

## [0.6.1] - 2026-11-08

> 只改面板与文档，**宿主行为不变**（探测、两族选族、隐藏与执行语义都和 0.6.0 一致）。面板首屏面向第一次打开的用户重新排布：一句用途 + 白话 badge + 白话备注，技术细节收进「详情 / 高级设置」。

### Changed

- **面板首屏信息层级收敛**：头部下方常显一句用途「告诉 AI 你的工具装在哪、用哪个版本、命令该写哪套语法。」；`终端` chips 只显示终端名（去掉族小标）；`命令` 行改成「`bash 语法` / `PowerShell 语法` · `envd_shell` · `其它：ops_bash` · 详情」，语法标签只在手动选择时带「· 手动」；备注全部白话化，最多两行。
- **状态 badge 白话二态**：`就绪` / `只展示`（不再带族后缀；悬停给出原因）。「有会话受沙箱限制」不上面板级 badge——面板是全局的，没主语的「受限」会被当成插件坏了，只留在备注里。
- **备注与详情收尾**：「受沙箱限制」补主语（「另有 N 个会话…」）；环境差异长句从备注挪到 `其它：…` 的悬停（普通状态备注为空）；详情去掉历史累计的隐藏 / 拒绝次数（累计值在 PowerShell 族下会显示「隐藏 9 次」这种误导信息，API 字段仍在）。
- **开关归位**：简报注入开关挪到「环境简报」行内（以前底部 footer 与简报区各说一遍）；「隐藏另一族命令工具」与「允许局域网访问面板 API」收进默认收起的「高级设置」；有数据时底部 footer **零开关**，只剩复制反馈与平台 / 更新时间脚注。
- **403 时保留入口**：拿不到数据（403 / 接口没响应）时简报区不存在，「允许局域网访问」开关留在 footer 作为唯一入口，否则用户没有解法。
- **术语改法**：首屏不再出现「族 / 宿主 / 围栏 / 增补」——族 →「bash 语法 / PowerShell 语法」，宿主命令工具 →「其它命令工具」，围栏 →「受沙箱限制」；技术词保留在「详情 / 高级设置」与 DESIGN 的模型章节。
- **文档**：DESIGN 面板章节与 README（中英）面板小节按新结构重写；首屏截图更新。

### Fixed

- **同一个开关在面板里出现两遍**：简报注入开关以前同时出现在底部 footer 与简报区，现在只在简报行出现一次。
- **首屏黑话让新人看不懂**：「族 / 宿主 / 围栏 / 增补」这些内部说法从首屏移到详情与文档模型章节；首屏每句话都能直接回答「我该写哪套语法」或「这个工具是什么」。

## [0.6.0] - 2026-11-08

> **破坏性变更（BREAKING）**：从「只增不减」改成「**按会话只暴露一个语法族**」。默认终端、简报口径、工具表都可能变：bash 族会话里宿主的**内置** `pwsh` / `powershell` 会被遮挡（可 restrict 的直接隐藏，挡不掉的调用即拒绝）；`envd_shell` 改为按**调用会话的族**取终端（bash 族 → Git Bash）。`skipReason='same-family'` 删除。0.5 的「永不遮挡」不再是硬不变量，例外只针对另一族的**内置**命令工具。

### Added

- **两族模型**：`bash` 族 = 宿主 `bash` / `sh` / `zsh` / `fish` / `ops_bash`（含启发式认出的第三方 bash 名）；`PowerShell` 族 = 宿主 `pwsh` / `powershell`。`cmd` 与自定义终端不参与自动选族、也不被遮挡；WSL 手动选时按 bash 语法算。
- **按会话自动选族，判定后锁定**：会话首次出现在对账里时，能看到 bash 族宿主工具 → bash 族，否则 PowerShell 族。只在**首次判成 PowerShell 族后的 10 秒内**允许升级一次（兜住 dsh-ops 晚挂载 `ops_bash`）。无会话时（面板 / API）：任一会话为 bash 族或宿主并集含 bash 族工具 → bash 族，否则 PowerShell 族。
- **手动选族**：`defaultShell` 非 `auto` 时所有会话按手动族（`pwsh` / `powershell` → PowerShell 族，`bash` / `wsl` → bash 族）；`cmd` / `custom` 不遮挡。
- **手动族不可用时回退 auto 并警告**：手动选的是 bash / PowerShell 族，但**该族没有可用终端**、且**所有会话的宿主工具里都没有该族工具**时，生效族回退成自动选族（会话按自动规则重判，`familySource` 变回 `auto`），并置 `familyFallback=true`。否则面板写着「bash 族」、实际连一个 bash 都跑不了，模型会照着简报写错语法。探测还没就绪时不判不可用（避免启动瞬间来回抖）；手动 `cmd` / `custom` 不参与这条规则。
- **遮挡另一族的内置命令工具**：`blockOtherFamily`（默认开）+ 会话族 bash + 该会话看得到 bash 族宿主工具 → 遮挡内置 `pwsh` / `powershell`。可 restrict 的（继承层）用 `tools.restrict({ deny })` 从工具表隐藏（只在 agent 作用域调用）；发布在 agent 自有层、`restrict` 挡不掉的只用 `guard` 在 dispatch 前拒绝执行（不 spawn）。启发式认出的 PowerShell 族名字只展示、永不遮挡；bash 族名字永不遮挡。撤销：开关关闭、会话族变化、agent disposed、插件卸载。
- **遮挡记忆（sticky）**：一旦某个 bash 族会话遮过 `pwsh`，之后即使 bash 族宿主工具（如 dsh-ops 的 `ops_bash`）暂时消失，会话族仍是 bash（锁定）、`pwsh` 也保持隐藏——避免工具表在会话里反复闪。
- **「重新探测」是两族重判的边界**：显式刷新探测（面板「重新探测」/ `envd` 工具的 `refresh` / API `refresh`）会作废所有会话的族锁定与遮挡记忆，按当下工具表重新判定并立刻对账（不等 5 秒 tick）；45 秒 TTL 自动过期与切终端 / 改选项这类普通写入不算重新探测，不动锁定。
- **新选项 `blockOtherFamily`**（默认开）：关掉即「两族同时可见」，简报与面板只警告、不遮挡。
- **`/envdock-api` 新字段**：`commandTool` 与载荷顶层新增 `family` / `familySource` / `familyFallback`；`commandTool` 另有 `sessions` / `hidden` / `refuseOnly` / `displayOnly` / `mixed`；`syncStats` 新增 `restrictApplied` / `guardRefusals`（分别是 restrict 落地次数与 guard 拒绝次数，稳态可用来证明没有反复拆建）。

### Changed

- **`envd_shell` 注册条件改变**：删除「同族不重复提供」（`skipReason='same-family'` 与面板备注「与 X 同族，EnvDock 不重复提供」一并删除）。新条件 = 主族终端可用（主族 = **生效族**：手动族可用时是手动族，手动族不可用会回退 `auto`）+ 沙箱允许 + 名字没被占；没有终端时 `skipReason='no-family-terminal'`。
- **执行侧按调用会话的族取终端**：bash 族会话用 bash 族终端（本机 Git Bash）；被围栏会话仍然直接拒绝，不 spawn、不委托。
- **默认终端随族变**：本机（会话里有 `ops_bash`，判为 bash 族）的 `envd_shell` 从 PowerShell 7 改成 **Git Bash**，简报改成 bash 族口径——模型不再同时拿到两套命令语法指令。
- **简报按会话族重写**：开头标出族（`bash 族` / `PowerShell 族`，手动选择会注明），列出本会话真正看得到的命令工具；被隐藏 / 只拒绝 / 只展示分别说明；开关关闭或手动 PowerShell + `ops_bash` 时追加「两族同时可见，各按自己的语法写命令，不要混写」；手动族不可用回退 auto 时追加「手动选择的族不可用(该族既没有终端、也没有按该族发布的宿主工具),已回退自动选族」；围栏会话追加拒绝提示与同语法出路。执行分工保留：需要你机器上的版本（node / pnpm / python / git）用 `envd_shell`，需要后台作业或沙箱提权参数用宿主工具。
- **宿主命令工具的用途变了**：名字识别不再只用于展示——它决定会话选族与遮挡目标；但**遮挡名单只含内置 PowerShell 名**（`pwsh` / `powershell`），启发式认出的名字只展示。
- **文档**：DESIGN / README（中英）/ CHANGELOG 按两族口径重写；`docs/notes/assist-model.md` 标注为 0.5 历史文档，§3 的「`restrict` 恒为 0 / 不注册 `guard`」硬不变量废除。

### Removed

- **「永不遮挡」硬不变量**：0.5 的「只增不减」在 0.6 保留为默认行为，但有一个明确例外——按会话遮挡另一族的**内置**命令工具。
- **`envd_shell` 的「家族不重复」注册条件与 `skipReason='same-family'`**：同一个 shell 出现两份不再算「重复提供」；bash 族会话里 `envd_shell`（Git Bash）与宿主 `ops_bash` 并存是按语法族划分的**预期**状态（语法相同，分工写在简报里）。
- **「模型手里同时有两个命令工具是预期行为」的笼统说法**：现在按族分开说——同族并存看分工、跨族并存（开关关闭或手动 PowerShell + `ops_bash`）会明确警告不要混写、bash 族会话看不到内置 PowerShell 名。

### Fixed

- **手动选的族不可用却显示成该族**：以前面板与简报会照着「手动 bash 族」写语法，但机器上既没有该族终端、也没有按该族发布的宿主工具，模型照着写必然失败。现在回退自动选族并说明原因（`familyFallback=true`），该族恢复可用后会自动回到手动族。
- **同时看到两套命令语法指令**：以前默认终端是 PowerShell、宿主命令工具是 `ops_bash` 时，简报会同时给 PowerShell 与 bash 两个口径。0.6 按会话选族后用遮挡 / 拒绝把另一族收掉，模型只按一个族的语法写命令。
- **dsh-ops 晚挂载 `ops_bash`**：会话先被判成 PowerShell 族、`ops_bash` 稍后才出现时，10 秒升级窗把它纠正成 bash 族（只允许升级一次，避免族来回抖动）。

## [0.5.0] - 2026-11-08

> **破坏性变更**：EnvDock 不再遮挡、不禁用、不接管任何工具，只做「探测 + 简报 + 面板 + 可选增补 `envd_shell`」。删除 `shellTakeover` / `sandboxTakeover` 两个选项与全部逐会话接管事实；旧状态文件里的这两个字段会被忽略。

### Added

- **辅助展示模型（assist model）**：EnvDock 只**增补**一个固定名字的 `envd_shell`（用你配置的默认终端与 PATH），**永不隐藏、永不禁用**别人的工具；面板与简报如实列出模型手上有哪些命令工具、各自的环境是什么、该优先用哪个。规格见 `docs/notes/assist-model.md`。
- **`envd_shell` 注册四条件**：① 默认终端解析出可用可执行文件；② 宿主已识别的命令工具里没有与它同族的；③ 沙箱允许（没有执行器 / 执行器不围栏直接注册，有执行器时要求至少一个会话 `danger-full-access`）；④ 名字未被占用且注册不报错。不注册时 `commandTool.skipReason` 给出 `same-family` / `no-unconfined-session` / `taken` / `error`，面板一行备注说清原因；注册失败按 30 秒退避，`tools/change` 时立即重试。
- **围栏会话直接拒绝执行**：`envd_shell` 每一单按本会话有效策略复检，`confined`（含策略不可知）时返回 `[sandbox] 本会话被宿主沙箱围栏(<mode>);EnvDock 的 envd_shell 不执行命令` 并请模型改用宿主工具——不 spawn、不委托。
- **简报三套模板 + 围栏追加**：注册成功写「`envd_shell`（增补，用你的终端）+ 宿主 `<工具>`（家族）；二者都可用，优先 `envd_shell`……需要宿主语义时再用宿主工具」；同族写「`<宿主工具>`（与默认终端同族，EnvDock 不重复提供）」；其它未注册原因写「用宿主的 `<工具>`」+ 一句原因；本会话被围栏时追加「`envd_shell` 在本会话被围栏，会被拒绝，请用宿主工具」。
- **`/envdock-api` 新 `commandTool` 形状**：`{ name, registered, visible, skipReason, shell{label,family,version,path}, refuseWhenConfined, hostTools[{name,family,learned}], sandbox{...} }`；`sandbox` 收敛为聚合值 `{ present, capable, defaultMode, policyKnown, sessionCount, confinedCount, anyUnconfined }`。`syncStats` 收敛为 9 个字段：`ticks / lastAt / intervalMs / detections / lastDetectMs / hostToolScans / registerTries / lastError / lastErrorAt`。
- **面板三态 + 详情**：头部唯一 badge 三态（绿「增补就绪」/ 灰「只展示」/ 黄「围栏」）；命令行 `envd_shell`（未注册显示 `—`）· `宿主 ops_bash · pwsh`（没有就写「未识别到宿主命令工具」）；最多两行备注（未注册原因 / N 个会话被围栏 / 环境差异提示）；「详情」展开 `扫描 N 次 · 最近 Nms · 注册尝试 N` + 宿主工具 chips（`learned` 带 ✦）+ 最近错误。
- **测试重写**：`panel-render` 按新 DOM 重写（**266 条断言**，覆盖三态 badge、命令行与「—」、备注、详情、无逐会话表 / 无接管 chips，以及既有的轮询去重 / 复制兜底 / 无数据用例）；`host-harness` 重写为 **209 条断言**（注册四条件、围栏拒绝且不 spawn、宿主工具识别、API 新形状、旧字段忽略，并断言 `restrict` 调用次数为 0）；`test/simulate.mjs` 参数随模型改写（`--executor` / `--policy` / `--shell-sandbox` …，移除 `--unrestrictable` / `--takeover` / `--delegate`）。

### Changed

- **不遮挡成为硬不变量**：不再调用 `tools.restrict`、不注册 `tools.guard` / `tools/pre-execute`；注册表动作只剩「注册 `envd_shell`」与「拆自己那一份」。测试把「`restrict` 调用 0 次」钉成断言。
- 宿主命令工具改为**只用于展示**：每个 tick 逐 agent 枚举 `tools.definitions` 取并集（名字有界 ≤64、排序稳定：内置顺序优先、其余按名字），`learned` 的语义改为「按描述 / 参数启发式认出来的（不是内置名单）」。识别不影响模型调用方式，也不参与任何遮挡。
- 注册 / 拆除只由**状态变化**驱动（终端变了、宿主工具变了、沙箱状态变了）；5 秒检查周期只做「重新枚举宿主工具 + 复核注册条件」，`tools/change` 用 40ms 合并定时器触发轻量重扫，稳态 tick 零注册表动作。
- 简报不再出现「已接管 / 让路 / 沙箱下接管」字样，也不再有「本会话策略未知」这类接管期结论；只说当前哪些工具可用、优先用哪个。
- 面板再减一轮：删除「会话」/「设置」两个按钮、逐会话表、状态胶囊与 `kind` 推导；常显只保留一句状态结论 + 一句命令工具清单，其余进「详情」。

### Removed

- **遮挡与接管全链**（index.js 4623 → 3023 行，净删 1600 行）：`restrict` 调用、`denyScopes` / `liftDenies` / `maskFor` / takeover `plan` / `publishScopeFacts` / `scopesSettled` / `badNames` / `hardNames` / `missNames` / `lostDenies` / `quickYield` / `denyKey` / `appliedSig*`、`shellCandidates` / `collectShellNames`、`tools.guard` 与 `shellRefusal`、`tools/pre-execute`。
- **委托执行链**：`delegatedInvocation` / `runDelegated` / 全部 `delegate*` 计数与包装器、`executorFamily`（含 `ENVD_CMD` base64 通道与 PowerShell 包装串）。
- **逐会话事实**：`commandTool.scopes` / `kind` / `hostName` / `denies` / `hostOnlyScopes` / `sandboxHiddenScopes` / `scopeAnomalies`、`sandbox.scopes` 与 `sandboxGate` 的逐会话部分；`syncStats` 里的 deny / delegate / guard / steady / yield 等计数。
- **两个选项**：`shellTakeover`（自动 / 总是接管 / 只给简报）与 `sandboxTakeover`（委托执行 / 直接拒绝），连同默认值、归一化与 `setOption` 白名单；旧状态文件里出现时忽略（不报错、不迁移）。
- **面板**（client.js 1552 → 1208 行）：接管模式 / 沙箱下接管 chips、逐会话表与同终局会话合并、状态胶囊 `.envd-statuschip`、异常 / 让路 / 工具并存渲染；相关词条一并删除（`i18n-check` 仍要求中英成对）。

### Fixed

- **过渡期旧版 API 不再显示假事实**：client.js 热更新、宿主 index.js 还没重启时，旧载荷没有 `registered` / `hostTools`。面板改为识别旧形状：用旧的 `visible` 推断是否注册、用旧 `hostName` 填宿主工具，并显示一条「接口是旧版构建，重启 dsh 后可显示命令工具信息」，不再把不知道的事说成「`—` / 未识别到」。
- 不再有「同一会话两个命令工具」被当成故障、也不再有「挡不掉的名字 30 秒重试 / 每 30 秒刷红」这类运维噪音：不遮挡就不存在这些状态。
- 面板不再把「注册失败 / 同名被占」说成「已接管」或「让路」：只展示宿主工具并给一行原因。
- `envd_shell` 在围栏会话里的行为从「被直接藏起来、模型看不见」变成「注册在、但每一单明确拒绝并指路宿主工具」，模型不会再猜「工具是不是坏了」，简报也会提前说明。

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
- **同一 tick 就让路（终审 P1）**：两处会让模型短暂看到两个命令工具——新会话 / 子 agent 的首个 tick（作用域里还没有「挡不掉」的记忆），以及 TTL 到期重试的那一 tick（`maskFor` 先删过期条目，让路判据就空了）。现在：①让路判据在 `maskFor` **之前**算，且「曾判定挡不掉」是粘性的（TTL 只允许重试遮挡，不允许让路消失）；②`denyScopes` 本轮 `restrict` 抛错且掩码里仍有宿主工具可见时，**同一 tick 收起 `envd_shell`** 并把事实报成 `yield`；③补一条零命令工具护栏（让路重试后若「藏了自己 + 挡住仅剩宿主工具」，立刻放开自己的遮挡）。新增「新作用域首 tick 不得并列」回归用例。
- **`syncStats.unrestrictable` 不再留残影（终审 P2）**：`badNames` / `hardNames` 是「别重试」的记忆（30 秒 / 10 分钟 TTL，故意不删），但宿主静默撤回工具后记忆还在——直接端给面板会让它一直说「宿主工具 ops_bash 挡不掉、与 envd_shell 并存」。现在诊断字段按**此刻可见性**过滤（记忆本身不动，不影响重试窗口），新增「静默撤工具」回归用例。
- **让路判据补上结构性挡不掉（现网回归）**：真机 `restrict` 对会话私有注册抛的是 `names unknown global tool`，这条走 `hardNames`（10 分钟 TTL）；而「让路」的判据原来只查 `badNames`（30 秒），于是既有 10 分钟硬 TTL 又把让路判据饿死——模型手里 `envd_shell` 与 `ops_bash` **并列**，逐会话事实报 `anomaly`，面板挂红。现在让路判据同时查 `badNames` 与 `hardNames`，dsh-ops 场景稳定让路（只有一个命令工具、不报异常、不刷红）。新增用真机错误文案的回归用例。
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

## [0.2.0-dev] - 2026-11-07

> 开发期内部迭代（未发布到 npm），与上面的对外 0.2.0 不是同一个版本；条目内容保留原样。

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
