# EnvDock 0.5 · 「辅助展示」模型（assist model）规格

> 用户决策：**不遮挡任何工具**（B 只增不减）+ **全删** restrict / deny / guard / 事实 / 委托。
> 实施者严格按本规格改；与规格冲突的旧代码一律删除，不要保留「兼容分支」。

## 0. 一句话

EnvDock 从「抢命令工具」变成「**探测 + 简报 + 面板 + 可选增补命令工具**」：
注册一个**增补**的 `envd_shell`（用你配置的终端与 PATH），**永不隐藏、永不禁用别人的工具**；
面板 / 简报把「有哪些命令工具、各自是什么语法、该用哪个」如实展示给用户和模型。

## 1. 行为契约（index.js）

### 1.1 注册 `envd_shell` 的条件（只增不减）

同时满足才注册：

1. 解析出的默认终端有可用 path；
2. **家族不重复**：宿主已识别的命令工具里，没有与该终端**同族**的（避免同一个 shell 出现两份）；
3. 沙箱条件：没有沙箱执行器（`ctx.shell` 不存在/不围栏）→ 直接注册；
   有执行器 → 只有「至少一个会话 resolve 出 `danger-full-access`」才注册（否则注册了也只能在围栏会话里拒绝，等于死工具）；
4. 注册失败（同名被占 / 报错）→ 不注册，状态里如实写原因，不重试超过既有退避节奏。

注册/拆除**只由状态变化驱动**（终端变了、宿主工具变了、沙箱状态变了），不隐藏、不 `restrict`、不 `guard`。
保留轻量 `tools/change` 监听（只用于重新枚举宿主工具定义 + 必要时重挂/拆自己的工具），不做对账循环。

### 1.2 `envd_shell` 执行语义

- **无围栏**：`ctx.subprocess.spawn` 直跑（现有实现保留）。
- **本会话被围栏**：**直接拒绝**，不 spawn、不委托：
  ```
  [sandbox] 本会话被宿主沙箱围栏(<mode>);EnvDock 的 envd_shell 不执行命令。
  请改用宿主自带的命令工具(它在围栏内可执行)。
  ```
- 策略不可得 → 同「被围栏」保守拒绝。
- 删除：`delegatedInvocation` / `runDelegated` / 所有 delegate 计数与包装器。

### 1.3 宿主命令工具识别（只用于展示）

每 tick（保留 5s tick 或 tools/change 触发，二选一即可）枚举 `tools.definitions(agent)`（逐 agent 一次），
按**已有**的家族识别函数（`shellFamilyFromDefinition` / `SHELL_TOOL_FAMILY`）得到并集：

```
hostTools: [{ name, family, learned }]   // 排序稳定：内置顺序优先，其余按名字
```

- 不需要可见性探测、不需要 restrict、不需要 per-session facts。
- `learned` 的语义改为「按描述/参数启发式认出来的（不是内置名单）」。
- 名字集合要有界（≤64）。

### 1.4 `/envdock-api` 的 `commandTool` 新形状

```jsonc
"commandTool": {
  "name": "envd_shell",            // 固定名
  "registered": true,              // 是否注册成功
  "visible": true,                 // 全局工具表里此刻可见吗（一次 hasTool 探针，仅用于展示真相）
  "skipReason": null,              // 未注册/不可见的原因：'same-family' | 'no-unconfined-session' | 'taken' | 'error' | null
  "shell": { "label": "Git Bash", "family": "bash", "version": "5.3.15", "path": "E:\\Git\\bin\\bash.exe" },
  "refuseWhenConfined": true,
  "hostTools": [ { "name": "ops_bash", "family": "bash", "learned": true } ],
  "sandbox": { "capable": true, "present": true, "defaultMode": "workspace-write", "anyUnconfined": true, "confinedCount": 2, "sessionCount": 3 }
}
```

- **删除**：`scopes` / `kind` / `hostName` / `denies` / `hostOnlyScopes` / `sandboxHiddenScopes` / `scopeAnomalies` / 所有 yield/conflict/anomaly 字段。
- `syncStats` 收敛为：`{ ticks, lastAt, intervalMs, detections, lastDetectMs, hostToolScans, registerTries, lastError, lastErrorAt }`。
- `sandbox` 顶层改为 `{ present, capable, defaultMode, policyKnown, sessionCount, confinedCount, anyUnconfined }`（无 `scopes`）。
- 顶层其余字段（state/shell/platform/pathInfo/tools/terminals/versionManagers/issues/brief/detectedAt/hasSubprocess）保持不变。

### 1.5 设置项

- **删除** `shellTakeover`（自动/总是/只给简报）与 `sandboxTakeover`（委托/拒绝）：不再有「接管」概念。
- 保留 `injectBrief`、`allowLan`。
- 状态文件里出现旧字段时**忽略**（不报错、不迁移）。

### 1.6 简报（brief）

按当前事实写，禁止再说「已接管 / 让路 / 沙箱下接管」：

- 注册成功时：
  `· 命令工具: envd_shell(EnvDock 增补,用 <终端> 语法) + 宿主 <a,b>(<家族>);二者都可用,优先 envd_shell(它用你的 PATH/终端),需要宿主语义时再用宿主工具`
- 未注册（`skipReason='same-family'`）：
  `· 命令工具: <宿主工具>(与默认终端同族,EnvDock 不重复提供)`
- 未注册（其它原因）：`· 命令工具: 用宿主的 <a,b>` + 一句原因。
- 围栏会话时追加：`;Envd_shell 在本会话被围栏,会被拒绝,请用宿主工具`（措辞见 `envd_shell` 拒绝文案）。
- 末尾两行保持：PATH/工具清单、「`envd` 只能解析已探测工具」。

### 1.7 删除清单（index.js，按符号搜索）

`restrict` / `denyScopes` / `liftDenies` / `scopesSettled` / `maskFor` / `plan`(takeover plan) / `publishScopeFacts` /
`badNames` / `hardNames` / `missNames` / `lostDenies` / `quickYield` / `denyKey` / `ownProbeOf` / `hostNamesAt` /
`shellCandidates` / `collectShellNames` / `scopeToolFacts` / `scopeAnomalies` / `yieldTicks` / `denyApplies`(等全部 deny 计数) /
`guard` / `guardDenials` / `pre-execute` / `appliedSig` / `appliedDenyKey` / `appliedOwned` / `mutating` / `pendingSync` /
`delegatedInvocation` / `runDelegated` / `delegate*` / `executorFamily` / `sandboxGate` 的 per-session 部分（只留聚合） /
`HARD_UNRESTRICTABLE_MS` / `SANDBOX_TAKEOVER_MODES` / `shellTakeover` 相关 API 与 defaults。

保留：`isLoopbackHost` / `isLoopback`（HTTP 安全不动）、探测与版本、健康检查、状态文件、`envd` 工具、`shellInvocation`。

## 2. 面板契约（client.js）

### 2.1 结构（在现有「简洁一屏」基础上再减）

```
[icon] EnvDock   默认终端 vX        [● 状态 badge]                     [重新探测]

终端   [自动][PowerShell 7][…][cmd][Git Bash] [+]
命令   envd_shell   ·   宿主 ops_bash · pwsh                          设置  详情
       ⚠/· 一句备注（只在需要时出现，最多 2 行）
       [设置展开] 只有「简报注入 / 允许局域网」不在这里 → 它们本来就在底部
       [详情展开] 扫描计数 + 宿主工具识别结果（chips，含 ✦）
```

- **删掉**：接管模式 chips、沙箱下接管 chips、逐会话表、状态胶囊、异常会话/工具并存/让路的全部渲染、`kind` 推导。
- **badge 三态**（唯一状态结论）：
  - `ok`「增补就绪」：envd_shell 已注册且可见；
  - `muted`「只展示」：未注册（同族/无无围栏会话/被占用），面板只展示宿主工具；
  - `warn`「围栏」：有会话被围栏，envd_shell 在那些会话里会拒绝。
- **命令行文案**：`envd_shell`（未注册时写 `—`）+ `宿主 ops_bash · pwsh`（宿主工具为空时写「未识别到宿主命令工具」）。
- **备注**（最多两行，按需）：
  - 未注册原因：`与 <工具> 同族，EnvDock 不重复提供` / `没有无围栏会话，暂不注册` / `与其它插件同名，未注册`；
  - 围栏：`<n> 个会话被围栏：envd_shell 会拒绝，请用宿主工具`；
  - 环境差异提示（静态一句话）：`宿主工具的环境/PATH 未必等于你的；需要你的终端时用 envd_shell`。
- **详情**：`扫描 3 次 · 最近 12ms · 注册尝试 2` + 宿主工具 chips + `最近错误`。
- 底部两个开关、工具链、环境检查、简报一行全部不变。

### 2.2 词条

- 删除与「接管/让路/并存/异常会话/逐会话/沙箱下接管」相关的词条（`statusTakeover` 等）。
- 新增：`statusAdditive`（增补就绪）、`statusDisplayOnly`（只展示）、`statusConfined`（围栏）、`cmdHintEnvDock`、`cmdHintHost`、`skipSameFamily`、`skipNoUnconfined`、`skipTaken`、`envHint`（环境差异提示）、`hostToolsNone`。
- 中英成对；`i18n-check` 必须过。

## 3. 测试契约

- **host-harness**：删除「接管/遮挡/让路/委托/guard/事实」相关用例；新增并保留：
  1. 无执行器 → 注册 `envd_shell`；`commandTool.registered=true / visible=true / skipReason=null`；
  2. 宿主有同族工具 → `skipReason='same-family'`，且**不调用** `restrict`（断言 restrict 调用次数为 0，这是本模型的硬不变量）；
  3. 有执行器 + 全部会话围栏 → `skipReason='no-unconfined-session'`；有会话无围栏 → 注册；
  4. 围栏会话调用 `envd_shell` → 拒绝、**不 spawn**、文案含「围栏」与「宿主工具」；无围栏会话照常执行（假 subprocess 断言 argv）；
  5. `hostTools` 识别：内置 `ops_bash`/`pwsh` + 启发式 `tenant_bash`（有 command 参数）；`run_cmd` / `ops_read_files` 不误认；
  6. `/envdock-api` 新形状：没有 `scopes`/`kind`/`denies`/`yieldTicks` 等字段；`syncStats` 只剩白名单字段；
  7. 状态文件里旧 `shellTakeover`/`sandboxTakeover` 字段被忽略（读取不报错、写回不保留）；
  8. 现有探测/版本/健康/HTTP 安全/413/rebinding 用例全部保留并通过。
- **panel-render**：按新 DOM 重写；必须断言：
  1. 整树 0 个 `.envd-statuschip`；badge 三态各一条；
  2. 命令行 = envd_shell + 宿主工具列表；未注册时「—」+ 原因备注；
  3. 没有逐会话表 / 接管模式 chips / 沙箱下接管 chips 节点（断言不存在）；
  4. 详情里有宿主工具 chips 与扫描计数；
  5. 围栏备注一条；环境差异提示一条；
  6. 轮询/复制/错误/无数据等既有用例保留。
- 目标：`npm test` 四个文件全绿，且总断言数不少于 200。

## 4. 文档

README（中英）/DESIGN/CHANGELOG：把「命令工具接管」整节改写为「命令工具：增补而不是接管」，说明
① 不隐藏任何工具；② envd_shell 何时注册、围栏时为什么拒绝；③ 面板怎么读；④ 与 dsh-ops 共存无需任何设置；
⑤ 0.5.0 的破坏性变更：删除 `shellTakeover`/`sandboxTakeover` 选项与逐会话接管事实。
