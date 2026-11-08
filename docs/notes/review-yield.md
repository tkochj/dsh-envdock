# EnvDock 第四轮终审（只读·聚焦）：宿主命令工具挡不掉 → EnvDock 让路

> 角色：第 4 轮终审员（只读，只查「宿主命令工具挡不掉 → EnvDock 让路」这一条真机链路，不扩面）。
> 快照：审校期间仓库被并发推进，HEAD 从 `464ddb1`（任务给的）→ `f6fbad9` → **`ad016ac`**（后者修掉了我原本要报的 `unrestrictable` 残影，见 §5-1）。
> 本文行号以**当前工作树**为准：`index.js` **md5 `cb292ab060d47ae9741b8ab961f1ddcb` / 4569 行**（已提交、干净）。
> 面板以 **HEAD 版 `client.js`（md5 `12661b176866c0246e6bdd34de3cc155` / 1536 行）** 为准；审校末尾工作树里又出现一份**未提交**的面板改动（§4 末尾有它对我结论的影响）。
> 基线（`ad016ac` 工作树复跑）：`parsers` / `i18n-check` / `host-harness`（363 条 ok）/ `panel-render`（199 checks）**四个文件全绿**。
> 方法：只读读码 + `test/fixture/host.mjs` 起真 `apply()` 逐 tick 采样（脚本全在 gitignore 的 `.envdock-verify/work/`，未进仓库，也未改任何仓库代码/测试）。「最小修法」在**仓库副本** `index-fix.js` 上验证，`index.js` 本身没动。

---

## 0. 结论先行

1. **P0：无。**
2. **P1：2 条，同一根因**——「让路」要等 `restrict` **实测失败**之后的下一个 tick 才生效。生效前那一 tick：模型手里**两个命令工具**（`envd_shell` + 宿主 `ops_bash` 并列），事实层 `anomaly:true`、`scopeAnomalies` 非空（面板画红「1 个会话异常」）。两个触发点：
   - **P1-1** TTL 到期重试那一 tick（真机文案 → `hardNames` 10 分钟一次；若走 `badNames` 则 30 秒一次）§3-1；
   - **P1-2** **每个新作用域**（新会话 / 子 agent）的首个 tick §3-2。
   两条都 1 tick 自愈，不是永久态；但它们正是 `464ddb1`（让路判据同时消费 badNames 与 hardNames）要消灭的现网症状，且 P1-2 **每开一个新会话就重演一次**。
3. **P2：1 条**（单会话收紧沙箱 = 整体拆接管，`kind=host` 而不是 `sandbox-host`；facts 与工具表一致，不算缺陷，属「任务期望 / 文档口径」不一致）§2-D1 + §5-3。另有 2 条 P3 观察（§5）。
4. **账本字段之间没有互相矛盾**，唯一矛盾点是 P1 的**求值顺序**：`maskFor()` 会顺手删掉过期 TTL 条目，而 `stuck` 在它**之后**才算 → 过期那一 tick 看不到那个名字。§1 表逐字段列出读写口径，§2 用 A–E 场景逐条打勾。
5. **面板对 `kind=yield` 的显示是对的**：badge/状态 chip/逐会话终局词都是「让路」，不会画成「未接管」或「沙箱」，备注也是「宿主工具 ops_bash 挡不掉，已让路」。§4 用替身模式实测（含 `unrestrictable` 非空这个现网组合）。
6. HEAD `ad016ac`（`syncStats.unrestrictable` 按当前可见性过滤）**已经修掉了我原本要报的「让路解除后 unrestrictable 残留」**——我验证过了（§5-1）。**不含在下面的 P1 里**；它不影响本节两条 P1（`index.js` 与我引的行号都是 `ad016ac` 版）。

---

## 1. 账本字段读写口径表（要求的那张表）

作用域对象定义在 `index.js:2871-2905`；`maskFor` 在 `3031-3052`，`denyScopes` 在 `3180-3334`，`plan` 在 `3829-3857`，`publishScopeFacts` 在 `3073-3178`，`scopesSettled` 在 `3338-3375`，`teardown` 在 `3384-3406`。

| 字段 | 谁写（口径） | 谁读（口径） | 清理 | 与 plan 的一致性 |
|---|---|---|---|---|
| `badNames`（每作用域 Map，name→until） | `denyScopes` catch：**非**「unknown global tool」且该名字此刻仍可见 → `+30s`（`3269`） | `maskFor`（`3040-3045`，未过期就剔出掩码）；`plan.stuck`（`3844-3852`，`locked` 判据）；诊断并集（`3298-3313`） | 过期：`maskFor` 顺手删 / 诊断扫描删；**teardown 不删**（`3520-3526` 的注释明确要求保留） | 一致：`stuck` 认「锁定或家族未知」，与 `maskFor` 的排除口径同源；**唯一破口见 P1-1** |
| `hardNames`（结构性挡不掉，`+600s`，`HARD_UNRESTRICTABLE_MS=775`） | `denyScopes`：restrict 返回成功但复读仍可见（`3257`）；restrict 抛 `unknown global tool`（`3266`） | `maskFor`（`3035-3039`）；`plan.stuck`（`3850`）；诊断并集（`3305-3307`） | 同上（过期删，teardown 不删） | 同上 |
| `missNames`（过渡性缺名，`+30s`） | `denyScopes` catch：调用前后都看不见（`3280`） | **只有** `maskFor`（`3046-3050`） | 名字重新可见即删（`3714`）；过期删 | **故意不进 `stuck` / 不进 `unrestrictable`**：缺名 ≠ 挡不掉，一致，无矛盾 |
| `denyKey`（每作用域字符串：`'own\|'` + 真正生效的掩码） | `dropDenies`→`''`（`2990`）；`denyScopes` 零工具风险分支→`''`（`3230`）；收尾写入（`3291`） | `denyScopes` 幂等短路（`3191`）；`publishScopeFacts` 的 `appliedMask`（`3085`）；`liveHostNames` 的 `masked`（`3783`）；`scopesSettled`（`3353/3362/3367/3371`） | `dropDenies`（**先放开再重建**，`teardown` 走 `liftDenies`） | 与 `planKey`（`3054`）**必须逐字相同**才算对完账；让路稳态下就是 `'own\|'`，实测 100 tick 不抖（§2-A） |
| `yieldHost`（**只在 plan 条目里，不落账本**） | `plan`（`3854`） | `publishScopeFacts` 的 `kind`（`3084/3113`）；`yieldTicks`（`3859`）；client 显示 | 每 tick 重算，天然不残留 | **不进 `planKey`**：`yield` 与 `sandbox-host` 掩码相同时 planKey 都是 `'own\|'`。**不是 bug**：`kind` 由每 tick 的 plan 现推，稳态分支也照常 `publishScopeFacts(plan)`；实测 yield→sandbox-host 在稳态 tick 里正确切换（§2-D2） |
| `hideOwn`（只在 plan 条目里） | `plan`：围栏/策略不可知（`3834`）、让路（`3854`）、直连（`3855`） | `planKey`（`3054`）；`denyScopes`（`3189/3203/3228`）；`scopesSettled`（`3348`）；`publishScopeFacts`（`3083/3113/3139`） | 每 tick 重算 | **让路里「挡得掉的其它宿主工具」仍在 mask**：`mask`=`maskFor(hosts)` 剔掉的是挡不掉的，`pwsh` 照挡（实测 §2-B） |

辅助字段：`appliedDenyKey`（effect 作用域，`3947-3954`）= **plan 推导**的聚合键；`cur.denyKey` = **实际生效**。稳态判据要求两者相等（`3867`）。`ownProbeOf`（`3018-3029`）的失效口径是 `visDirty===本 tick` 或 `ownEpoch` 变化 —— 让路分支够用：`denyScopes` 一旦真动过遮挡就置 `cur.visDirty`（`3196/3292`），同一 tick 之后的 `publishScopeFacts`/`scopesSettled` 必然重探；`teardown`/注册/拆工具都 `ownEpoch++`（`3392/3423/3509`）。实测：让路第一 tick 的 `kind` 就是 `yield`（不是晚一 tick 的 `takeover`），说明藏完自己后的重探确实生效。

---

## 2. 场景实测（任务给的 a–e，逐条给期望/实际）

复现：`node .envdock-verify/work/verify-yield.mjs [../../index.js]`（手动 tick：`setOption`→`writeState`→`sync`，逐 tick 采样；`syncIntervalMs=600000` 排掉 interval 干扰）。

| # | 场景 | 期望 | 实际 | 严重度 |
|---|---|---|---|---|
| A | dsh-ops 真机文案（`unrestrictableRealMessage`）稳态 ≈100 tick | kind 稳定 `yield`、`envd_shell` 藏、`ops_bash` 可见、`anomaly=false`、registers/disposes/denyApplies 不增长、`lastError=null` | **全部成立**：100/100 tick `kind=yield`、`anomaly=false`、命令工具恰好 `[ops_bash]`；`registers 1→1`、`registerTries 1→1`、`disposes 0→0`、`denyApplies 1→1`；`yieldTicks` 随 ticks 涨；`lastError=null`、`steadyNow=true`；facts `{kind:"yield",tool:"ops_bash",hidden:[],unrestrictable:["ops_bash"]}` | 通过 |
| B | 同一进程里再加一个「挡得掉的」宿主工具 `pwsh` | 该作用域只剩 `ops_bash`（`pwsh` 被挡） | **成立**：`pwsh` 被 restrict 掉（`state.deny` 里真有 `pwsh`）、`ops_bash` 可见、`envd_shell` 藏；facts `hidden:["pwsh"]`（没有把 `ops_bash` 谎报成已挡）；`unrestrictable` 只有 `ops_bash`；稳态后 3 tick `denyApplies/registers/disposes` 不动 | 通过 |
| C | 让路中间 `ops_bash` 被宿主撤掉 | 让路自动解除（`envd_shell` 回来），不许零命令工具 | **成立**：撤掉后第 1 tick 就是 `kind=takeover`、工具 `[envd_shell]`，`anomaly=false`；之后 3 tick 稳定 | 通过 |
| D1 | 单一让路会话 + 沙箱策略 `danger-full-access`→`workspace-write` | 「立刻转 `sandbox-host`（藏 envd_shell、留宿主），facts 与 tools 一致」 | **不转 `sandbox-host`，而是整体拆接管**：`kind=host`、`confined=true`、`mode=workspace-write`、工具 `[ops_bash]`、`envd_shell` **已卸载**（全局也没有）、该作用域 deny 集合为空、facts 与工具表一致、`anomaly=false`。原因：`trustedUnconfined`（`3819`）没有任何「确定无围栏」的会话 → `takeoverWanted=false` → `teardown()`（`3889-3900`）。**没有零命令工具** | P2（口径） |
| D2 | 两个会话：`free` 保持 danger，`tight` 收紧 | 收紧的那个转 `sandbox-host`，另一个不受牵连 | **成立**：`tight: {kind:"sandbox-host",tool:"ops_bash",confined:true,mode:"workspace-write",hidesOwn:true}`，工具 `[ops_bash]`；`free: {kind:"yield",tool:"ops_bash"}`；两作用域都无 anomaly。且这次切换发生在**稳态 tick** 上（`denyKey` 不变、零 register/dispose），说明 `kind` 由 plan 现推是对的 | 通过 |
| E | 关掉接管（`shellTakeover=off`） | 宿主工具全部恢复，无残留遮挡 | **成立**：`ops_bash`+`pwsh` 都回来、全局与作用域里都没有 `envd_shell`、该作用域 deny 集合为空、facts `kind=host / tool=ops_bash / anomaly=false`、`commandTool.denies=[]`；之后 3 tick `registers/disposes/denyApplies` 不动（不会偷偷再注册） | 通过 |

> D1 的「P2」不是 bug：它同时也是安全方向正确的（收紧后不再由 EnvDock 直跑命令）。只是**「转 sandbox-host」这个说法只在还有别的无围栏会话成立**，文档/面板口径需要知道这一点。

---

## 3. P1：让路判定比实测晚一 tick（两个触发点，同一根因）

### 3-1 P1-1：`hardNames` / `badNames` 的 TTL 到期重试那一 tick

- **位置**：`plan`（`3840` 先 `maskFor`，`3844` 才 `stuck`）；`maskFor`（`3035-3050`）在返回 true 的同时把过期条目 **删掉**。
- **场景**：真机 dsh-ops 稳态让路（`ops_bash` 在会话私有层，restrict 抛 `names unknown global tool` → `hardNames` 10 分钟）。
- **期望**：TTL 到期只是「再试一次遮挡」，模型手里始终恰好 1 个命令工具、`kind=yield`、`anomaly=false`。
- **实际**（时间前跳 600001ms，逐 tick 快照）：
  ```text
  i=0  kind=takeover  tools=[envd_shell, ops_bash]  anomaly=true   denyApplies 1→1  ← 双命令工具
  i=1  kind=yield     tools=[ops_bash]              anomaly=false  denyApplies 2
  i=2.. 同 i=1（稳态）
  ```
  即：那一 tick `stuck` 看不到已过期的名字（`maskFor` 刚删掉），plan 翻回直连 → `envd_shell` 复活，而 restart 的 restrict 必然再失败一次；facts 当场报 `anomaly:true`（`3119-3123`），`syncStats.scopeAnomalies` 带上该会话，面板按现有逻辑画成红 badge「1 个会话异常」（§4-5 实测）。
- 同根因的第二种 TTL：若 restrict 抛的不是真机文案而是别的错（走 `badNames` 30 秒），**每 30 秒**复现一次，且那一 tick 额外写一条 `lastError`（`遮挡 ops_bash 失败: …`）——按 5 秒 tick 算，占空比约 1/6。证据见 `verify-ttl.mjs` 的 T30。
- **严重度**：P1（瞬时 1 tick、自愈；但正是 `464ddb1` 修的现网症状，且 `stuck` 的注释（`3846-3852`）本身就承诺「只查 badNames 会漏判」，这里是另一半漏判）。
- **最小修法**（已在副本验证）：把 `stuck` 挪到 `maskFor` **之前**，并用「map 里存在」而不是「未过期」当粘性判据 —— TTL 只允许重试遮挡，不允许让路消失。只这一处（约 10 行）即可让 T10 与 T30 的窗口都消失（`verify-ttl.mjs` 全绿）。

### 3-2 P1-2：每个新作用域（新会话 / 子 agent）的首个 tick

- **场景**：老会话已是稳态让路；`agent/created` 带来新作用域（= 一个新会话/子 agent）。
- **期望**：新作用域第一 tick 就恰好 1 个命令工具（`ops_bash`），`kind=yield`，不进 `scopeAnomalies`。
- **实际**：
  ```text
  {"tickDelta":1,"kind":"takeover","anomaly":true,
   "tools":["envd_shell","ops_bash"],"scopeAnomalies":["session-real-2"]}
  随后 i=0..2 → kind=yield, tools=[ops_bash]
  ```
  原因：新作用域的 `badNames/hardNames` 是空的，plan 只能先按「直连」去试，restrict 抛错后**下一个 tick** 才转让路。所以每个新会话都会先给模型 5 秒的双命令工具 + 一次假异常。
- **严重度**：P1（每开一个新会话/子 agent 复现一次；1 tick 自愈）。*若 Lead 只按「用户能否看见」分档，这两条可整体降为 P2-高；但违反的是本链路的核心不变量。*
- **最小修法**（已在副本验证）：在 `denyScopes` 里补「同一 tick 就让路」——本轮 `restrict` **抛过错**、且掩码里仍有宿主工具**此刻仍可见**、而自己还可见 → 立刻 `restrict({deny:[envd_shell]})` 收起自己，并置 `cur.quickYield`；`publishScopeFacts` 把 `quickYield` 当成本 tick 的 `hideOwnPlanned/yieldHost`（这样 facts 这一步就报 `yield` 而不是 `host`）。**只对「抛错」生效**：restrict 返回成功却挡不住（agent 层同名）仍按现有口径如实报 `anomaly` —— 仓库里 `host-harness.mjs:1639-1645`（`agent-noop`）钉着这个口径，实测补丁前后它都绿。
- 配套的不变量（同批改动，必须一起）：①藏自己时记下 `ownDisposer`，若这一轮把「仅剩的宿主工具」也挡住了（它后来变得挡得掉了）→ 立刻收回自己的遮挡，不许零工具；②`denyKey` 要记下「本 tick 藏了自己」（不管是计划要求还是临时让路），否则下一 tick 的 steady 判定会把临时的藏当成「没有遮挡」，自己的工具就永久不可见。

---

## 4. 面板对 `kind=yield` 的显示（替身模式实测）

脚本：`node .envdock-verify/work/make-panel-yield.mjs && node .envdock-verify/work/panel-yield.mjs`（复用 `test/panel-render.mjs` 的 React 替身/`mountPanel`，只换载荷；`client.js` 未改）。

| # | 载荷 | 结论 |
|---|---|---|
| 1 | `kind=yield` + `unrestrictable:['ops_bash']` + `hostTools:['ops_bash']`（现网组合） | badge = `envd-badge warn` **「让路」**；状态 chip「让路」warn（HEAD 版有这颗 chip，见下方并发提醒）；`.envd-tool` 只列 `ops_bash`（不列已藏的 `envd_shell`）；备注 `⚠宿主工具 ops_bash 挡不掉，已让路`；逐会话行 `data-kind=yield`、终局词「让路」、行 warn 点；**整页文字里没有「未接管」「沙箱」** |
| 2 | 1 让路 + 1 直连 | badge「1 个会话用宿主工具」（`statusMixed`），会话计数「2 个会话 · 1 直连 · 1 让路」 |
| 3 | `kind=yield` 但 `unrestrictable:[]`（防御） | 不编造「挡不掉」备注；badge 仍是「让路」 |
| 4 | 对照 `kind=sandbox-host` | badge「沙箱」、行内「沙箱」——与「让路」是两个词，没有被混画 |
| 5 | **P1 那一 tick 的真实事实**（`kind=takeover`、`ownVisible:true`、`hostTools:['ops_bash']`、`anomaly:true`） | badge = `envd-badge bad` **「1 个会话异常」** —— 面板确实是红的（这是 P1 的用户可见面） |
| 6 | 让路解除后 `unrestrictable` 残留（宿主工具已不存在） | badge「接管中」但备注「宿主工具 ops_bash 挡不掉，与 envd_shell 并存」——**谎报**；后端已在 `ad016ac` 去掉这个输入（§5-1），这格只证明「若输入仍在，面板会说假话」 |

**并发提醒**：上面 6 组是在 **HEAD 版 `client.js`（md5 `12661b17…`）** 上跑的全绿（26/26 条断言）。审校收尾时工作树里又出现一份**未提交**的面板改动（删掉命令行 `.envd-statuschip`、把「已识别宿主工具」挪进「详情」、`noteConflict` 文案改成「在会话层注册，无法遮挡」、单会话不再拼会话计数）。我在同一组载荷上重跑：**badge / 工具名 / 逐会话终局词 / 让路备注仍然正确**；只有脚本里「状态 chip 存在」与「`noteConflict` 旧文案」两条断言按其改动失效（不是回归）。那份 WIP 落地后这两处要再复核一次。

代码口径（HEAD 版）：`client.js` 里那个函数叫 `scopeKindText`（`613-626`），只有 `kind==='host'||'sandbox-host'` 才看 `confined` 决定说「未接管/沙箱」，`yield` 直接走映射表 → `sessionKindYield`「让路」。所以**不会**把 yield 画成未接管或沙箱。`toolNames`（`916-925`）与 `noteUnrestrictable`（`951-956`）在「有 scopes 且有人 yield」时都走让路分支。**结论：面板显示无缺陷。**

---

## 5. 顺带核实 / 已修 / 观察

- **5-1（已修，`ad016ac`）**：`syncStats.unrestrictable` 只在 `denyScopes` 里算（`3298-3325`），让路解除后（宿主撤掉 `ops_bash`）会残留到下一次遮挡应用。`f6fbad9` 版实测：撤掉后 5 tick 仍报 `unrestrictable:["ops_bash"]`、`kind=takeover`；面板按 §4-6 会写「与 envd_shell 并存」（假）。**`ad016ac` 那 12 行（`anyScopeVisible` 过滤，`3325`）已实测修好**：撤掉后同一 tick 就 `unrestrictable:[]`。所以**不进 P1**。
- **5-2（P3）**：`plan` 里 `!familyOf(rt, name)`（`3852`）这条让路判据实际是死分支 —— `hostSeen` 只可能收到「家族已知」的名字（`definitions` 认族才收，`3677-3681`；候选名全在 `SHELL_TOOL_FAMILY` / `learnedShells`）。不造成错误，但注释说的「认不出家族的宿主工具必须让路」实际不会发生。
- **5-3（P2，口径）**：§2-D1 —— 单会话把策略收紧到 `workspace-write` 时是 `teardown()`（`kind=host`、`envd_shell` 卸载），不是 `sandbox-host`；`sandbox-host` 只在「另有一个确定无围栏的会话」时出现。facts/tools 一致、无零工具，属预期设计，但「收紧 → sandbox-host」的说法需要在文档里限定条件。
- **5-4（P3，文案）**：让路稳态下 `steadyNow=true`，但面板「详情」里的「稳态」标记（`client.js:979`）要求 `!unrestrictable.length`，而让路天然 `unrestrictable` 非空 → 让路会话永远看不到「稳态」二字（数字面板里的 `yieldTicks` 照涨）。纯文案。
- **5-5（实测通过，非缺陷）**：让路里「自己的 `envd_shell` 也藏不掉」（`restrictNoop`，agent 层同名）时，`denyApplies` 从第 3 tick 到第 8 tick **零增长**（`ownHideFailedKey` 去抖有效），且 facts 如实报 `anomaly`。`verify-ownhide.mjs`。
- **5-6**：`teardown()` 不碰 `badNames/hardNames`（`3520-3526` 的注释要求保留），也不碰 `lostDenies`；与「撤不掉的无主 deny」口径一致，无矛盾。

---

## 6. 最小修法（已在 `index-fix.js` 副本验证，仓库代码未动）

三处 delta，合计约 30 行，**四个测试文件在补丁副本上全绿**（`parsers`/`i18n-check`/`host-harness` 363 ok/`panel-render` 199 checks）；A–E、T10、T30、newscope 场景全绿。

1. `plan`（`3829-3857`）：**先算 `stuck` 再算 `mask`**，`stuck` 用 `cur.badNames.has(name) || cur.hardNames.has(name) || !familyOf(rt,name)`（不看 TTL 是否过期）→ 治 P1-1（10 分钟 / 30 秒窗口）。
2. `denyScopes`（`3180-3334`）：
   - 藏自己时记 `ownDisposer`；
   - 本轮 `restrict` 抛过错 + 掩码里仍有宿主工具可见 + 自己可见 → 同 tick 藏自己并置 `cur.quickYield` → 治 P1-2；
   - 掩码成功后若「自己藏着 + 宿主全被挡」→ 立刻收回自己的遮挡（`ownDisposer()`）→ 不许零命令工具；
   - `denyKey` 记「藏了自己」：`hideOwn ? (ownHidden || !visibleOwn) : ownHidden` → 否则 steady 判定会把临时的藏当成没有遮挡。
3. `publishScopeFacts`（`3083-3084`）：`hideOwnPlanned`/`yieldHost` 认 `cur.quickYield === syncStats.ticks` → 临时让路那一 tick 的事实就报 `yield`（而不是 `host`/`sandbox-host`）。

**如果只想修一条**：只做 1（+ `denyKey` 的 `ownRecorded`）就能消掉 P1-1；P1-2 需要 2+3。

---

## 7. 复现清单（全部只读、全部在 `.envdock-verify/work/`）

```bash
cd "E:/本地库/qq work place/envdock"
node .envdock-verify/work/verify-yield.mjs ../../index.js 现行   # A–E + TTL 窗口（现状：T 两项失败）
node .envdock-verify/work/verify-yield.mjs ./index-fix.js 补丁版  # 同上（全绿）
node .envdock-verify/work/verify-ttl.mjs   ../../index.js 现行   # T10/T30 逐 tick 采样
node .envdock-verify/work/verify-ttl.mjs   ./index-fix.js 补丁版  # 全绿
node .envdock-verify/work/verify-newscope.mjs ../../index.js     # 新作用域首 tick（现状：4 项失败）
node .envdock-verify/work/verify-newscope.mjs ./index-fix.js     # 全绿（首 tick 即 yield）
node .envdock-verify/work/verify-stale.mjs ../../index.js        # 5-1（ad016ac 已修，现在会看到 unrestrictable 立刻清空）
node .envdock-verify/work/verify-ownhide.mjs ../../index.js      # 5-5（收敛）
node .envdock-verify/work/make-panel-yield.mjs && node .envdock-verify/work/panel-yield.mjs  # §4
node .envdock-verify/work/make-fix.mjs                           # 生成补丁副本 index-fix.js
```

- 夹具：`makeHarness({ shippedTools:['ops_bash'], unrestrictable:['ops_bash'], unrestrictableRealMessage:true, sandboxPolicy:{resolve:()=>({mode:'danger-full-access'})} })`；手动 tick 用 `post(h,{op:'setOption',shellTakeover:'takeover'})`（`writeState`→`notifyStateChange`→`sync`），采样用 `callApi(h)`；真实可见性查 `h.toolsFor(id).get(name)`（**注意每次返回新对象，别跨调用缓存**），遮挡集合查 `h.state.deny`。
- TTL 触发用 `Date.now` 位移（`+600001` / `+30001`），跑完立刻还原。

**未覆盖**：真机 `restrict` 的「批量边加边抛」组合（夹具逐名字 restrict，与实现一致）；`lostDenies`（无主 deny）与让路的交叉（会被 `appliedMask` 过滤掉，理论不触发零工具，但没构造用例）；多进程/热重载下 `rt` 换代与让路的关系。
