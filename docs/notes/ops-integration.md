# EnvDock × dsh-ops 0.5.0：shell 接管冲突调查报告

> 只读调查（未修改 `index.js` / `client.js` / `test`）。调查时间 2026-11-08 09:05–09:35（UTC+8）。
>
> **路径别名**
>
> - `[OPS]` = `C:\Users\19270_pyzfxn2\.dsh\profiles\web\node_modules\dsh-ops`（dsh-ops **0.5.0**）
> - `[TOOLS]` = `E:\deepseek harness\node_modules\.pnpm\@deepseek-ai+dsh-tools@0.2._ce93d8815c01c625bef2ed5cbdca65f7\node_modules\@deepseek-ai\dsh-tools`（**0.2.2-rc.1，本机实际在跑的版本**）
> - `[SCOPE]` = `…\.pnpm\@deepseek-ai+dsh-scope@0.2.2-rc.1_@deepseek-ai+cordis@4.1.0\node_modules\@deepseek-ai\dsh-scope`
> - `[CORDIS]` = `…\.pnpm\@deepseek-ai+cordis@4.1.0_@_21d63b4d8d451ad2a3b177004fe67960\node_modules\@deepseek-ai\cordis`
> - `[LOOP]` = `…\.pnpm\@deepseek-ai+dsh-agent-loop_eb19d1f2f3581c2c5aa8c81eeaa4ebe7\node_modules\@deepseek-ai\dsh-agent-loop`
> - `[ENVD]` = `E:\本地库\qq work place\envdock`（工作区；`index.js` / `client.js` 有未提交改动）
> - `[PROFILE]` = `C:\Users\19270_pyzfxn2\.dsh\profiles\web`（本机 web profile：`cordis.patch.yml` / `package.json`）

**版本判定（重要）**：本机 `.pnpm` 里同时存在 dsh-tools `0.2.1-rc.5` 与 `0.2.2-rc.1`。在跑的进程命令行是
`…\@deepseek-ai+dsh@0.2.2-rc.1_…\lib\bin.js web`，`dsh@0.2.2-rc.1` → `dsh-base@0.2.2-rc.1`（`[OPS]` 同级安装树）→
`@deepseek-ai/dsh-tools@0.2.2-rc.1`。所以**本报告所有 dsh-tools 行号都取自 0.2.2-rc.1**（665 行的 bundles 版），
不是 3810 行的 0.2.1 老版。DSH 插件侧 `dsh-ops` 的 `peerDependencies` 也要求 `dsh >=0.2.2-rc.1 <0.2.3-0`。

---

## 0. 结论摘要

1. **`ops_bash` 注册在 Agent 自己的层**，不是全局层也不是 preset 层：dsh-ops 用 `agent.ctx.plugin(...)` 起子 context，Cordis 子 context 原型继承 `[kScope]`，于是 `tools.register()` 落在 `layers.scoped.get(agent)`。
2. **`tools.restrict({deny:['ops_bash']})` 在数学上到不了自己的层**：`view()` 只把「全局 + 祖先层」的名字放进 `restrictableNames`；`restrict()` 遇到不在该集合的名字**直接抛错**（不是静默无效）；即便不抛，restriction 也只对继承面求交，自己的层永远豁免。契约原文：restrictions "do not affect scoped registrations"。
3. 因此面板报「挡不掉」是**结论正确**的：EnvDock **没有任何受支持的 API** 能让 `ops_bash` 从模型工具表里消失。
4. **但存在受支持的协作缝隙**：`tools/pre-execute`（waterfall）与 `tools.guard`。它们不让工具消失，却能在**调用时**拒绝并给出可操作的改道理由。dsh-ops 自己的 `deny-host-shell` 就是这么做的——这是唯一「行为上真接管」的受支持路径。
5. 想让 `ops_bash` **真的消失**只有 dsh-ops 侧的配置：本部署里它由**无门**（`allows:()=>true`）的 legacy 组件路径发布，`publishBashTool:false` 或关掉 `dsh-ops-shell` 行是**全域**生效；四个 mode consumer 另有逐 preset 的 `bash` 开关，但关掉它们也盖不住 legacy 行。
6. EnvDock 工作区新代码**会**把 `ops_bash` 认成宿主 shell（bash 家族）：`SHELL_TOOL_FAMILY` 内置命中后 `shellFamilyFromDefinition()` 立刻短路，**不要求** command 类参数；那条「名字 token + command 参数」的门槛只约束非内置名单的第三方名字。
7. 让路稳态下模型手里**恰好 1 个**命令工具：挡不掉的那个（`ops_bash`）；`envd_shell` 被 `restrict({deny:['envd_shell']})` 藏掉（它是全局注册，挡得掉）。只有两个窗口会并存：新会话 facts 尚未生成、或 `envd_shell` 被「别人登记的同名工具」顶掉。
8. 面板推荐：**逐会话事实表为骨架（候选 B）+ 每会话一个 `restrictable` 布尔（借候选 C 的一个字段）**。只有这个形状能在 `danger-full-access`（`kind=takeover|yield`，`confined:false`）与 `workspace-write`（`kind=sandbox-host|host`，`confined:true`）下都给出正确结论；候选 A/C 各自都会在某一侧说错话。

---

## 1. 机制证据链：ops_bash 到底注册在哪一层，restrict 为什么无效

### 1.1 注册层 = Agent 自己的层（四步链）

| 步 | 事实 | 证据 |
| --- | --- | --- |
| ① | Agent 自己就是作用域 key，`agent.ctx` 带着这个 key | `[LOOP]/lib/index.js:543-544`：`this.scope = createScope(loopCtx, this); this.ctx = this.scope.ctx;` |
| ② | `createScope` 用 `ctx.extend({ [kScope]: key })` 打标签 | `[SCOPE]/lib/index.js:296-306`；`scopeOf(ctx)` 就是读 `ctx[kScope]`（`:312-314`） |
| ③ | Cordis 子 context 原型继承父 context 的**全部**属性（含 symbol） | `[CORDIS]/lib/index.js:1776-1782`（`extend` 用 `Object.create` 建子 context），`:346`（fiber 的 `ctx = parent.extend({fiber})`） |
| ④ | dsh-ops 在 `agent.ctx` 下起子 plugin，再从子 context 注册 | `[OPS]/lib/session-shells.js:285-296`（`attach`：`entry.fiber = agent.ctx.plugin(child => child.inject(['tools'], toolsCtx => { entry.ctx = toolsCtx; … }))`）、`:191`（`entry.ctx.tools.register(definition)`） |

因为 ③ 让 `[kScope]` 穿过 `ctx.plugin(...)` 继承下来，④ 的 `tools.register()` 里的 `scopeOf(this.ctx)` 解析到的就是**这个 agent**，
`ScopedLayers.effect()`（`[SCOPE]/lib/index.js:189-218`）于是把注册写进 `this.scoped.get(agent)`——即 `view()` 里的 `own` 层。

> dsh-ops 自己的注释也是这么说的：`[OPS]/lib/session-shells.js:128-131`（"Preset consumers share an Agent's own registry layer"）与
> `:240-243`（"`ops_bash` lands in the Agent's own layer, and `restrict()` masks inherited global names only, so masking it can never succeed"）。

### 1.2 restrict 为什么无效：两层原因，先抛错、后豁免

`ToolsService.restrict()`（`[TOOLS]/lib/index.js:453-468`）：

- `:464` `const known = this.view(scope).restrictableNames;`
- `:465-466` 名字不在集合里就**抛**：`tools.restrict() names unknown global tool "ops_bash"; known global tools: …`
- `:467` 通过检查才落到 `layer.restrictions.append(compiled)`

而 `restrictableNames` 只由**继承面**填充（`[TOOLS]/lib/index.js:477-508`）：

- `:478-484` `inherited` = 全局层 + `chainLayers(scope)` 里除 `own` 外的各层；
- `:489-491` 遍历 `inherited` 时**才** `restrictableNames.add(name)`；
- `:492` 可见性判定 `layers.every((layer) => layer.admits(name))` **只对 inherited 名字**执行；
- `:497-501` `own` 层的注册只进 `knownNames` / `visible`，**既不加进 `restrictableNames`，也不参与 `admits`**。

判定「能不能挡」的 `ToolLayer.admits()` 本身也只被 inherited 循环调用（`:391-395`）。
契约文档把这条写成硬语义：

- `[TOOLS]/lib/types/contracts.d.ts:356-365`：*"Per-scope filter over global tools. Restrictions intersect and **do not affect scoped registrations**."*
- `[TOOLS]/lib/index.js:469-473`（`view` 文档）：*"the viewing scope's own registrations remain exempt"*。

**所以 `ops_bash` 落在一个「restrict 永远看不见」的位置**：EnvDock 拿 `agent.ctx.tools.restrict({deny:['ops_bash']})` 去挡，
得到的是 `:466` 的抛错；EnvDock 侧 `[ENVD]/index.js:3136-3146` catch 之后用 `hasTool()` 复核，仍然可见 → 进 `badNames` → 走「让路」。

反向对照：`envd_shell` 是 EnvDock 在自己的**插件根 context** 注册的（`[ENVD]/index.js:2367` `apply(ctx, config)`、`:3308` `ctx.tools.register(definition)`），
插件行由 bundle patch 插在 profile 根（`[ENVD]/cordis.patch.yml:1-4`），`scopeOf(ctx) === undefined` → 落在**全局层** → 对每个 agent 都是 `inherited` → **挡得掉**。
这就是同一个眼皮底下「一个挡得掉、一个挡不掉」的原因，也解释了现网 `denies:['pwsh']` 与 `unrestrictable:['ops_bash']` 同时存在（见 §1.4）。

### 1.3 dsh-ops 侧的发布路径（决定它为什么总在）

- 组件路径（**本机在用**）：`[OPS]/lib/components/shell/index.js:22-26` → `[OPS]/lib/legacy/host.js:97-144`；其中 `:134-139`
  `root.inject(['tools'], ctx => { if (shells) mountSessionBash(ctx, config, shells); … })` —— **没有传第 4 个参数 `gate`**。
- `mountSessionBash(ctx, config, shells, gate = { allows: () => true })`（`[OPS]/lib/session-shells.js:132-139`）：默认门**放行所有 agent**，
  唯一的开关是 `config.publishBashTool`（`:133-134`）。
- 因此 legacy 行在 `publishBashTool:true`（`[OPS]/lib/config.js:191` 默认值；profile patch `cordis.patch.yml:268-275` 显式 true）时，
  **每一个 agent** 都会被发布 `ops_bash`，与 preset 无关。
- 另一条路径（preset/mode 集成）：`[OPS]/lib/consumer/mount.js:16-20` → `mountSessionBash(inner, core, shells, gate)`；
  门来自 `[OPS]/lib/integration/index.js:19`（`binding.allows(agent)`）或 `[OPS]/lib/presets/builtin.js:22-23`（`modeOf(root, agent) === mode`）。
  这一条是**逐 preset / 逐 mode** 的（`[OPS]/lib/consumer/registry.js:4-15, 39-42`；`modeOf` 见 `[OPS]/lib/presets/detect.js:4-7`）。
- 两条路径都开时，同层同名注册后者会失败（`[TOOLS]/lib/index.js:385` `NamedEntries` 重名报错），dsh-ops 会 `catch` 并保留上一次成功的定义
  （`[OPS]/lib/session-shells.js:190-207`）——见 §7 诊断项 D。

### 1.4 现网实证（GET `/envdock-api`，只读）

进程 `dsh … web`（PID 9048，启动于 2026-11-07 21:47:42）上取到的关键字段：

```text
shell.family = bash            shell.path = E:\Git\bin\bash.exe
commandTool.name = envd_shell  takeover = true   visible = true
commandTool.denies = ["pwsh"]  commandTool.hostName = "pwsh"
syncStats.unrestrictable = ["ops_bash"]
syncStats.denyApplies = 49     syncStats.sandboxBlocked = false   lastError = null
sandbox.capable = true  defaultMode = workspace-write
sandbox.scopes = 9 项：8 个 danger-full-access/confined:false，1 个 workspace-write/confined:true
```

读法：`pwsh`（官方、全局注册）被成功挡掉；`ops_bash`（dsh-ops、agent 层）挡不掉 → 进 `unrestrictable`。
这与 §1.1–1.2 的静态结论完全一致。

> ⚠️ 口径限制：该进程**加载的是 11-07 21:47 的构建**，而工作区 `index.js` mtime 是 11-08 08:38。
> 现网快照里 `commandTool.scopes` 为 `undefined`、`yieldTicks` / `guardReady` 等字段缺失，正说明它比现行代码旧。
> 因此 §4 的「新代码结论」是**静态推导**，现网只能用来验证「挡不掉」这个老事实。

---

## 2. 受支持的协作缝隙：逐个判定

先给判定口径：**「消失」** = 模型工具表里看不到这个名字；**「不用」** = 模型仍看得到，但调用被受支持地拒绝并改道。
EnvDock 需要的是前者到自己头上；后者是它真正能拿到的。

| # | 缝隙 | 出处 | 能让 ops_bash「消失」 | 能让模型「不用」 | 判定 |
| --- | --- | --- | --- | --- | --- |
| A | `ctx.tools.guard(fn)` | `[TOOLS]/lib/index.js:649-651`；执行点 `:657-662`；契约 `contracts.d.ts:366-374` | ❌ | ✅ 单向前缀拒绝（不可被后续 guard 翻案） | **可行（当前最优）** |
| B | `ctx.on('tools/pre-execute')` | `[TOOLS]/lib/pipeline.js:385-386, 402-418`；事件契约 `events.d.ts:7-17` | ❌ | ✅ 可 deny / ask / cancel | **可行** |
| C | `agent.ctx.tools.restrict({deny})` | `[TOOLS]/lib/index.js:453-467, 477-508` | ❌ | ❌ | **不可行（现方案）** |
| D | 同层抢名：自己在 agent 层注册 `ops_bash` | `[TOOLS]/lib/index.js:433-445`（重名报错 `:385`） | ⚠️ 会打赢竞态，但 dsh-ops 报错降级、语义被污染 | ❌ | **不可行（不建议）** |
| E | 事件层取消别人的注册 | `events.d.ts:48-55`（`tools/change` 是 **emit** 通知） | ❌ | ❌ | **不可行** |
| F | `tools.setExecutor()` 自当执行器 | `[TOOLS]/lib/index.js:598-618`（每 scope 一个）；执行器契约见 `…dsh-tool-executor-native/lib/index.js:5-18` | ❌（工具表不变） | ✅ 但代价是接管该 scope 全部调用 | **技术可行、实践否决** |
| G | dsh-ops 自己的配置/门 | `[OPS]/lib/config.js:191`（`publishBashTool`）、`:28/:177-186`（`shellPolicy`）、`legacy/host.js:136`（无门）、`consumer/registry.js:39-42`（逐 preset 门）、`presets/config.js:48` + `settings/merged.js:165`（逐 mode `bash`） | ✅ **唯一真正消失的路径** | — | **可行，但属于 dsh-ops 侧、且本部署只能全域** |
| H | 只读诊断面：`tools.view(agent).restrictableNames` / `registrations` | `[TOOLS]/lib/index.js:477-508`、`:519-534` | ❌ | ❌（但能**事前**判定，不用再「抛错→让路→30s 重试」） | **可行（建议采纳）** |

### A. `tools.guard()` —— 受支持的「调用级拒绝」

- API：`[TOOLS]/lib/index.js:644-651`，注册到 `guards`（`:415`，同样是 `ScopedLayers`）；执行：`:652-662`，
  `for (const layer of [this.guards.global, ...this.guards.chainLayers(exec.agent)])` → 先全局后作用域链，**第一个返回字符串的就拒绝**。
- 契约：`contracts.d.ts:366-374` —— *"A monotonic execution guard evaluated after every `tools/pre-execute` listener and before the tool body.
  Returning a reason denies the call… Because guards have no `allow` result, listener ordering cannot turn a denial back into permission."*
  即：**守卫只会加锁，不会被别的插件解锁**。
- 现成范例：**dsh-ops 自己**就这么用 —— `[OPS]/lib/legacy/host.js:78-80`（`ctx.effect(() => ctx.tools.guard(exec => hostShellRefusal(...)?.reason))`）。
- EnvDock 现状：已经注册了（`[ENVD]/index.js:3863-3883`，`tools.guard(shellRefusal)`），但 `shellRefusal` 只有两个方向
  （`:3815-3843` 拒绝被藏的 `envd_shell`；`:3845-3861` 拒绝「已被我们藏掉」的宿主 shell），
  **让路会话里 `ops_bash` 是可见的，方向二的前置 `!hasTool(...)`（`:3849`）不成立 → 不拒绝**。
- 结论：**这是 EnvDock 现在就能用的、受支持的「行为接管」缝隙**，缺的只是「方向三」。

### B. `tools/pre-execute` —— 更早、更可表达的同一层

- 事件契约：`events.d.ts:7-17`，`@mode waterfall`，`(exec, next) => Promise<PreToolDecision>`；
  `PreToolDecision`（`contracts.d.ts:312-336`）= `allow` / `deny{reason,info?}` / `cancel` / `ask{reason,displayReason?}`。
  **注意 `:318-319` 明确排除参数改写**："Input rewriting is excluded because arguments are already logged and presented." —— 所以缝隙只能「准/不准/问」，不能改参数。
- 执行点：`[TOOLS]/lib/pipeline.js:385-386`（`scopeTarget(this.tools, exec.agent)` 做作用域路由；`ctx.waterfall(...)`），
  `:402-403`（`allow` 之后才跑 guards；`deny` 的 reason 直接成为模型看到的原因），`:404-418`（`deny` → `content:[{type:'text', text:'Error: '+reason}], isError:true, error.message=reason`）。
- 作用域路由语义：`[SCOPE]/lib/index.js:327-338` —— 未打标签的监听器**全局受理**，agent 作用域监听器只收自己那个 agent 的调用（事件向上流，不向下）。
- 现成范例同样是 dsh-ops：`[OPS]/lib/legacy/host.js:74-77`。
- 与 guard 的分工：`allow` 路径下 guards 一定跑（`:402`）；`deny` 路径下 guards 不跑。两者可叠加，EnvDock 选一个即可（guard 更简单，pre-execute 能给 `info`）。

### C. `tools.restrict()` —— 不可行（已在 §1.2 证明）

任何作用域上调用都一样：`restrict` 的语义是「在**继承面**上求交」，自己的层豁免。**没有 API 能取消别的插件在自己层里的注册**：
`ToolsService` 的公开方法是 `register / restrict / guard / view / get / executable / definitions / schemas / resolve / setExecutor / selectExecutor / execute / checkGuards`（`[TOOLS]/lib/index.js:404-663` 全体），**没有 `unregister(name)` 这种越权入口**。

### D. 同层抢名 —— 不可行（不建议）

理论上 EnvDock 也能 `agent.ctx.plugin(...)` 抢先把 `ops_bash` 注册进 agent 层，让 dsh-ops 的 `register()` 因重名失败（`[TOOLS]/lib/index.js:385`），
dsh-ops 侧会走 `[OPS]/lib/session-shells.js:190-207` 的 catch 分支（打 warn、保留旧定义）。但：

1. 谁先注册是竞态（取决于 bundle 加载顺序与 `agent/created` 时机），**不稳定**；
2. 语义被污染：模型看到 `ops_bash` 却跑的是 EnvDock 的终端，工具名与实现不一致；
3. 违背 EnvDock 自己的设计（`[ENVD]/index.js:756-765` 明确「名字刻意取 envd_ 前缀，不和宿主/其它插件的 shell 名争抢」）；
4. dsh-ops 的 `gate.watch` / `agent-preset/selected`（`[OPS]/lib/session-shells.js:334-343`）随时会重建定义，抢名会被反复打回。

### E. 事件层 —— 不可行

`events.d.ts` 里与注册表相关的事件只有 `tools/change()`（`:48-55`，`@mode emit`，**通知**）：
"Unfiltered registry notification: scoped listeners receive changes from every scope"。**没有可取消注册的钩子**。
`agent/created` / `agent/disposed`（dsh-ops 在用：`[OPS]/lib/session-shells.js:326-333`）只能拿到 agent，不能动别人的注册。

### F. `tools.setExecutor()` —— 技术可行、实践否决

`[TOOLS]/lib/index.js:598-618`：每个 scope 只允许一个执行器（`:600` 抛 "Only one tool executor may be registered in each scope"），
执行器契约极薄（`describe(tools)` + `execute(input)`，见 `…dsh-tool-executor-native/lib/index.js:5-18`）。
EnvDock 理论上能在某个 agent 作用域挂自己的执行器并委托，从而**在 dispatch 前**吞掉 `ops_bash`。但代价是：该会话**全部**工具调用都要过 EnvDock，
等于把插件从「终端接管」升级成「工具执行器接管」——故障域、生命周期、PTC 折叠全部要重做。**不建议**。

### G. dsh-ops 配置/门 —— 唯一能让它真的消失

分三层，粒度不同：

1. **组件行（本机在走这条）**：`publishBashTool`（`[OPS]/lib/config.js:191`，默认 true；`[PROFILE]/cordis.patch.yml:268-275` 显式 true）
   直接卡住 `mountSessionBash` 的入口（`[OPS]/lib/session-shells.js:133-134`）。**全域生效**，不分 preset。
2. **mode consumer**：`global.bash`（`[OPS]/lib/settings/merged.js:165`：`bash: flag(raw,'bash',true) && global.bash`）与逐 mode 的 `bash`
   （`[OPS]/lib/presets/config.js:48`）。四套 mode 的 plan 都是 `shell: true`（`[OPS]/lib/presets/defaults.js:9-12`），
   所以除非显式关，每个 mode 都会给自己的 agent 发 `ops_bash`。**逐 preset 粒度**。
3. **自定义 preset 集成**：`[OPS]/lib/consumer/registry.js:4-15, 39-42` 按 `config.preset === preset` 绑定，`shell:false` 即不发布。

**关键判定**：本机 `dsh-ops-shell` 组件行开着（`cordis.patch.yml:268-275`，`publishBashTool: true`），它用的是**无门**路径，
所以只关 mode 的 `bash` **盖不住它**。要让 `ops_bash` 在本机真正消失，必须
`dsh-ops-shell` 行 `publishBashTool: false`（或直接 `disabled: true`），以及（可选）`global.bash: false`。
这是**用户的部署决策**，不是 EnvDock 代码能做到的事——面板应当把这句话说出来，而不是只说「挡不掉」。

### H. 只读诊断面 —— 建议采纳

`tools.view(agent)`（`[TOOLS]/lib/index.js:477-508`）**事前**就能回答「这个名字能不能挡」：`restrictableNames.has('ops_bash') === false`。
EnvDock 现在靠「先 `restrict` 抛错、再 catch、再 30 秒重试」来发现这件事（`[ENVD]/index.js:3123-3148`），
既制造日志噪声（见 §7-Bug1），也让面板只能事后报「挡不掉」。改成事前判定后：

- `ops_bash` 永远不进 `mask` → 不再有周期性抛错 → 不再有「遮挡失败」红字；
- 面板在**第一次**就能说「这个工具注册在会话层，restrict 到不了它」，并且能区分「会自愈的失败」与「结构上不可能」。

> 注意：`view()` 每次调用都会重建可见集合（`[ENVD]/index.js:3481-3484` 已在同 tick 复用 `defsSet` 规避 ~10 次/会话/ tick 的探针开销），
> 采纳时应用同一套「每 tick 一次快照」缓存，不要每名字一次。

---

## 3. EnvDock 工作区新代码：ops_bash 会被识别成宿主 shell 吗

**会，而且不依赖任何启发式。** 识别有两条路，`ops_bash` 走的是**最短的那条**。

### 3.1 内置名单短路（命中路径）

- `[ENVD]/index.js:594-605` `SHELL_TOOL_FAMILY`，其中 `:604` `ops_bash: 'bash'`（注释 `:602-603` 说明这是为了别同时看到两个命令工具）。
- `[ENVD]/index.js:642-663` `shellFamilyFromDefinition()`：
  - `:646-647` `const exact = SHELL_TOOL_FAMILY[name.toLowerCase()]; if (exact) return exact` → **在检查参数之前就返回**；
  - `:648-654`（`hasCommandParam`）**只对不在内置名单里的名字生效**。
- `[ENVD]/index.js:608` `SHELL_TOOL_ORDER = IS_WIN ? ['pwsh','powershell','cmd','bash','ops_bash'] : [...]`（`ops_bash` 排最后）。
- `[ENVD]/index.js:666-671` `familyOf()` 先查 `runtime.learnedShells`，再回落到 `SHELL_TOOL_FAMILY[key]`。

**结论**：即使 `ops_bash` 的参数里没有 `command` / `cmd` / `script` / `commandline`，甚至在 `tools.definitions` 拿不到
（`dsh-ops` 的 `ops_bash` 参数确有 `command`，见 `[OPS]/lib/shells/constants.js:44` 的 `BASH_ARGUMENTS`），也一样被认成 `bash` 家族。

### 3.2 token + command 参数（给第三方发布名用的那条）

只有当名字**不在**内置名单里才走到这里：

1. 必须有命令类参数：`props.command | props.cmd | props.script | props.commandline` 之一（`:651-654`）；没有就 `''`（不认，**不挡**）；
2. 名字里的 token 命中家族表 `SHELL_FAMILY_TOKENS`（`:618-623`：`pwsh|powershell` / `cmd` / `wsl` / `bash|gitbash|msys|sh|zsh|fish`），按 `[^a-z0-9]+` 切词（`:630-633`）；
3. 名字没 token 时，才看描述里是否提到 bash/PowerShell/cmd/WSL（`:657-661`）。

所以「名字带 cmd 但不是命令工具」的 `run_cmd` / `wc_cmd_palette` 被 `:651-654` 挡住，不会被误挡——这正是注释 `:649-650` 说的事。

### 3.3 学到之后进哪里（面板 `runtimeShellTools` 的来源）

- 每 tick 枚举 `scopeTools.definitions(agent)`（`:3472-3484`），对每个定义跑 `shellFamilyFromDefinition()`，
  命中即 `rt.learnedShells.set(name, family)`、`rt.seenShells.add(name)`、`cur.hostSeen.add(name)`（`:3488-3493`）；
- 再按名字对所有候选探一遍可见性（`:3497-3505`），挡住之后靠 `hostSeen` 记忆；
- 汇总成 `syncStats.runtimeShellTools`（`:3532-3538`），面板 `.envd-shellchip`（`[ENVD]/client.js:1059-1076`）就是它。

### 3.4 未提交改动有没有动识别逻辑

**没有。** `git diff index.js` 的 23 个 hunk 全部落在：`delegatedInvocation`（1595-1621 区）、`isLoopback`、`commandTool` 的委托路径、
`sandboxGate`/`shellCapability` 的 `capable → present` 语义、`addScope` 清理、API 鉴权（同源 + Content-Type + body 上限）。
`SHELL_TOOL_FAMILY` / `SHELL_TOOL_ORDER` / `SHELL_FAMILY_TOKENS` / `shellFamilyFromDefinition` / `denyScopes` / `plan` / `scopesSettled`
**一个字节都没动**（`git diff -U0 index.js | grep '^@@'` 可复核）。所以 §3.1 的结论对「工作区版」成立，且与 HEAD 版一致。

---

## 4. 「让路」语义下，模型手里最终有几个命令工具

### 4.1 判定路径（逐行）

1. 收口条件：`wants = Boolean(shell.path) && (mode === 'takeover' || !familyMatches)`（`:3586`）；`takeoverWanted = wants && trustedUnconfined`（`:3592-3593`）。
   `trustedUnconfined` 只在「有会话**证明** `confined === false`」或「根本没有围栏执行器」时为真（`:3592`）。
2. 逐作用域出计划 `plan`（`:3602-3624`）：
   - `takeoverWanted === false` → `{mask:[], hideOwn:false}`（`:3603`，**不挡任何东西**，模型用宿主工具）；
   - `gate.confined !== false`（`true` 或 `null`）→ `{mask:[], hideOwn:true}`（`:3607`，藏 `envd_shell`，**不遮挡宿主**，围栏会话用宿主带围栏的工具）；
   - `envd_shell` 在本作用域可见但不是我们登记的那份 → 不挡（`:3610-3611`）；
   - 否则 `mask = maskFor(cur, hosts)`（`:3613`），再算 `stuck`：`(被 badNames 锁定 || 认不出家族) && 此刻可见`（`:3617-3621`）；
     `stuck.length > 0` → `{mask, hideOwn:true, yieldHost:true, stuck}`（`:3622`）——**这就是让路**；否则 `{mask, hideOwn:false}`（`:3623`，直连接管）。
3. 落地 `denyScopes(plan)`（`:3060-3155`）：
   - `hideOwn` 时对**本作用域** `tools.restrict({deny:[ENVD_SHELL_NAME]})` 并**复读确认**不可见（`:3083-3101`，复读 `:3095`）；
   - `mask` 里**逐个名字** restrict（`:3123-3148`；注释 `:3120-3122` 说明为什么不能批量），成功返回后仍要复读（`:3130-3132`），
     仍可见的进 `badNames`（30s TTL）。
4. 记账：`cur.denyKey = (hideOwn && (ownHidden || !visibleOwn) ? 'own|' : '') + appliedMask.join(',')`（`:3153`）；
   `syncStats.unrestrictable` 由各作用域仍锁定的 `badNames` 并集得到（`:3159-3170`）。
5. 面板事实：`publishScopeFacts()`（`:2955-3046`）按**实测可见性**推导 `kind`（`:2993`）：
   `ownVisible ? 'takeover' : hideOwnPlanned ? (yieldHost ? 'yield' : 'sandbox-host') : 'host'`，
   并算 `hidden` / `leaked` / `anomaly`（`:2994-3003`）。

### 4.2 结论：稳态下**恰好 1 个**

以本机为例（`danger-full-access` 会话 + `ops_bash` 挡不掉）：

| 名字 | 谁注册 | 层 | 让路 tick 的终局 |
| --- | --- | --- | --- |
| `envd_shell` | EnvDock | 全局 | **被藏**（`hideOwn:true` + `restrict` 成功，`:3092-3095`） |
| `ops_bash` | dsh-ops | agent 自己 | **保留**（`restrict` 抛错 → `badNames` → 不挡） |
| `pwsh` 等 | 宿主 base | 全局/祖先 | 被挡（`mask` 里挡得掉的部分） |

→ 模型手里 1 个命令工具 = `ops_bash`，事实记为 `kind:'yield'`、`hidden:[]`、`hidesOwn:true`、`anomaly:false`。
`workspace-write` 会话则是：`envd_shell` 被藏（`:3607`）、宿主工具**原样保留**（含 `ops_bash`）→ 也是 1 个，但 `kind:'sandbox-host'`、`confined:true`。
**两种模式的「1 个工具」语义不同**，这是面板必须分开表达的根本原因（见 §5）。

### 4.3 会「两个并存」/「零个」的例外窗口

1. **新会话 facts 尚未生成**：`publishScopeFacts` 在 reconcile 末尾写 `rt.scopeToolFacts`（`:3028`），新 agent 在 `addScope` 之后到下一次 sync 之间读不到自己的 fact，
   `commandToolState`/`brief` 只能退到全局视图。窗口 ≈ 一个 `tools/change` 合并延迟（40ms，`:3764-3785`）或 5s tick。
2. **`envd_shell` 被别人的同名工具顶掉**：`:3610-3611` 不挡宿主；同时 `hideOwn` 的 restrict 会因「不在继承面」而抛错 → 藏不掉 →
   这个会话真的会有两个命令工具，`anomaly` 在 `:2999-3003` 标出（`ownVisible && visibleHosts.length > 0`）。
3. **零工具**：`:3204-3210`（`scopesSettled` 里「已遮挡作用域里 `envd_shell` 不可见 → 立刻把宿主还回去」）与
   `:3108-3112`（`denyScopes` 的「自己不可见且没有 hideOwn 计划 → 一律不挡」）是两条防线，`anomaly` 兜底（`:3000`）。

### 4.4 现网对照

现网 `unrestrictable: ["ops_bash"]`、`denyApplies: 49` 与上面的推导一致；`sandbox.scopes` 里 8 个 `danger-full-access` 会话
本应全部是 `yield`。**但**现网构建较旧（无 `scopes` 字段），无法从 API 直接看到 `kind:'yield'`，需重启后复核。

> 补充：本次调查所在的子会话（subagent）工具表里 `ops_bash` 与 `envd_shell` **同时可见**——这不是稳态，而是旧构建 + 新会话 facts 尚未生成的典型表现，
> 也说明 §4.3 窗口 1 在真实使用中会命中。现行代码（`hideOwn` + 复读确认）正是为消掉它而写的。

---

## 5. 面板可视化的 3 个候选信息结构（并推荐一个）

前提：面板必须能在 **`danger-full-access`** 与 **`workspace-write`** 下都正确表达。这两者的区别不是「挡不挡得住」，
而是 **`confined` 三态**（`true` 被围栏 / `false` 确定无围栏 / `null` 策略不可知）+ **`kind` 四值**（takeover / yield / sandbox-host / host）。

### 候选 A｜「结论一句话」汇总（= 现状，最小改动）

```text
commandTool: { name, takeover, visible, denies[], hostName }
syncStats:   { unrestrictable:['ops_bash'], blockedScopes[], hostOnlyScopes[] }
面板:  徽章「已接管」 + 一行「模型可见 envd_shell」 + 一条 warn「宿主工具 ops_bash 挡不掉，已让路」
```

- ✅ 零改动（`[ENVD]/client.js:824-889` 现在就是这么算的）；`danger-full-access` 与 `workspace-write` 都能渲染。
- ❌ 主语错了：以「挡不掉」为结论，用户读不到「那我这个会话到底能用什么」。
- ❌ 两种模式共用一条 warn 文案：`workspace-write` 下的「让路」是**设计行为**（`:3607`），`danger-full-access` 下的让路是**冲突降级**（`:3622`），
  面板说成同一句话就是不诚实。
- ❌ 无逐会话粒度时（旧 API），`unrestrictable` 是全局并集，会误导「所有会话都中招」。

### 候选 B｜「逐会话事实表」为骨架（= 现有 `publishScopeFacts` 的直出）

```text
commandTool.scopes[i] = {
  id,
  kind: 'takeover' | 'yield' | 'sandbox-host' | 'host',
  tool,                 // 这个会话模型手里那个命令工具的名字
  hostTools: [],        // 这个会话里仍然可见的宿主工具
  ownVisible, hidesOwn,
  confined: true | false | null,   // 三态！不许压成布尔
  mode, policyKnown,
  hidden: [], leaked: [], anomaly
}
头部: 只做聚合计数（N 接管 / N 让路 / N 沙箱 / N 冲突）
每会话一行: 状态词 + `模型手里：<tool>` + 原因（围栏 / 作用域私有 / 策略未知）
```

- ✅ 字段**全部已在** `publishScopeFacts`（`[ENVD]/index.js:2955-3046`）与 `commandToolState`（`:832-887`）里算好，服务端零新增数据源。
- ✅ `danger-full-access`：`kind='yield'` + `confined:false` → 「让路（宿主工具在会话层，挡不掉）」；
  `kind='takeover'` + `confined:false` → 「接管中」。两者不会互相污染。
- ✅ `workspace-write`：`kind='sandbox-host'` + `confined:true`（或 `host`+`confined:true`）→ 「沙箱 · 用宿主带围栏的工具」，与「冲突」彻底分开。
- ❌ 会话多时占高度（本机 9 个会话）；需要默认折叠 + 只把 `anomaly` 的置顶。
- ❌ 仍然回答不了「为什么挡不掉」——只能回答「这个会话用谁」。

### 候选 C｜「命令工具清点表」（以工具为主语）

```text
commandTools[] = [
  { name:'envd_shell', owner:'envdock', layer:'global', restrictable:true,  visibleScopes:[…] },
  { name:'ops_bash',   owner:'dsh-ops',  layer:'agent',  restrictable:false, unblockable:true, visibleScopes:[…] }
]
```

- ✅ 唯一能直接回答「**为什么**挡不掉」的形状：`layer:'agent'` + `restrictable:false` 就是机制本身。
- ✅ 天然表达「另一个插件提供的工具」（`owner`），也天然解释「用户该去关谁的开关」（对应 §2-G）。
- ❌ 需要新 API：`layer` / `restrictable` 要逐个作用域问 `tools.view(agent).restrictableNames`（`[TOOLS]/lib/index.js:488-492`），
  `owner` 只能靠登记身份比对（`[ENVD]/index.js:2727-2738` 的 `isOwnDefinition`），**拿不到别的插件的身份**（dsh-tools 不暴露 definition→owner 映射）。
- ❌ 它回答的是「注册表事实」，不是「模型手里有什么」——单独用它做面板会出现「两个工具都在表里，但某个会话只有一个可见」的歧义。

### 推荐：**B 为骨架 + C 的一个布尔**

```
每会话一行（主结构，B）  +  该行的 supplement: { restrictable: boolean }  ← 取自 C 的判定，逐会话现问 tools.view
```

理由（按优先级）：

1. **只有 B 能同时正确表达两种权限模式**：`confined` 三态 + `kind` 四值 的组合是 `danger-full-access` 与 `workspace-write` 的唯一充分信息
   （`[ENVD]/index.js:3592-3624` 的计划就是按这个组合分支的）；候选 A 会把两种语义压成一句 warn，候选 C 根本不区分会话策略。
2. **零新增数据源**：B 的所有字段已经算好并在 `/envdock-api` 里（只是旧构建没发 `scopes`）。C 的 `restrictable` 只需在 `publishScopeFacts`
   里加一次 `tools.view(cur.actx).restrictableNames.has(name)`（每个会话每 tick 一次，可复用同 tick 的 `defsSet` 快照，见 §2-H 的注意项）。
3. **能同时说两句真话**：逐会话行说「模型手里是 `ops_bash`（让路）」，该行的 `restrictable:false` 说「它注册在会话层，restrict 到不了」——
   这正是用户需要知道的两件事：现状 + 原因 + 唯一解法（去 dsh-ops 关 bash）。
4. **与既有面板规格对齐**：`docs/notes/panel-design.md` §4.1 的五态（conflict / sandbox / yield / takeover / host）就是 B 的投影，
   本推荐不引入新状态，只补一个字段，避免两份规格打架。

验收矩阵（推荐方案必须全绿）：

| 场景 | 关键字段 | 面板一句话 | 颜色/语气 |
| --- | --- | --- | --- |
| `danger-full-access` + 接管成功 | `kind:'takeover'`, `confined:false`, `hostTools:[]` | 接管中 · 模型手里 `envd_shell` | ok |
| `danger-full-access` + 宿主工具在会话层 | `kind:'yield'`, `confined:false`, `hidesOwn:true`, `restrictable:false` | 让路 · 模型手里 `ops_bash`（会话层，挡不掉） | warn（**设计内**，不是故障；附「想接管请关 dsh-ops 的 bash」） |
| `workspace-write`（围栏） | `kind:'sandbox-host'\|'host'`, `confined:true`, `mode:'workspace-write'` | 沙箱 · 用宿主带围栏的工具 | info（蓝，中性） |
| 策略不可知 | `confined:null`, `policyKnown:false` | 沙箱 · 策略未知（保守按围栏处理） | info + 原因「策略未知」 |
| 冲突 | `anomaly:true` / `leaked:[]≠[]` / `tool:null` / 接管下 `hostTools` 非空 | 冲突 · 这个会话命令工具异常 | bad |

**明确不要做**：把「挡不掉」当成面板主结论（现状）；用全局 `unrestrictable` 推到每个会话（会误伤 `workspace-write` 会话——那里的「让路」是围栏导致的，跟作用域私有无关）。

---

## 6. 建议的最小改动（文件 / 行号 / 行为变化 / 风险）

> 本节只是建议，未落笔。按「收益 ÷ 风险」排序。

### 改动 1（面板诚实性，纯客户端，最小）

- 文件：`client.js:885`（`noteUnrestrictable` 那条 note）、`client.js:88-89`（zh 文案）、`client.js:215-216`（en 文案）。
- 行为：把「宿主工具 `{names}` 挡不掉，已让路」改成以模型视角陈述，例如
  「宿主工具 `ops_bash` 挡不掉（注册在会话自己的层）：这些会话用宿主的 `ops_bash`，EnvDock 的工具已收起」，并在 hint 里给一行**可执行**的解法
  （「想让它接管：在 dsh-ops 的 shell 行关闭 Publish Bash」）。
- 风险：`test/panel-render.mjs` 有 i18n / 文案断言，需要同步；低。

### 改动 2（服务端补两个字段，低风险）

- 文件：`index.js:832-887` `commandToolState()`（新增顶层 `unblockableNames`）+ `:2955-3046` `publishScopeFacts()`（新增 per-scope `restrictable`）。
- 行为：面板可以逐会话说「它注册在会话层，restrict 到不了」；旧客户端忽略新字段，无破坏。
- 风险：`tools.view()` 是 O(工具数) 重建，必须**每 tick 每会话一次**并复用 `defsSet` 快照（`:3481-3484` 已有先例），否则每 tick 多出 ~10n 次探针。

### 改动 3（消掉周期性红字，等价于修 Bug 1）

- 文件：`index.js:3136-3146`（catch 分支）、`:3159-3170`（`unrestrictable` 汇总）。
- 行为：catch 里区分两类错误——「名字不在可挡集合」（`restrict` 抛 unknown，结构上不可能）与「restrict 真的失败」。
  前者只进 `badNames`/`unrestrictable` 且**不写 `lastError`**，并标记为 `structural:true`（不再 30s 重试）。

### 改动 4（可选：行为接管，「真接管」的唯一受支持路径）

- 文件：`index.js:3805-3862` `shellRefusal()`，新增「方向三」；注册点 `:3863-3883` 不用改。
- 行为：当该会话 `fact.kind === 'yield'` 且 `fact.mode === 'danger-full-access'` 且 `fact.restrictable === false` 时，
  对 `ops_bash` 返回一条可操作拒绝：「本会话已由 EnvDock 接管，请用 `envd_shell`（语法见简报）」。
  同时把 `hideOwn` 关掉（让 `envd_shell` 保持可见）——即**从「让路」改成「守卫接管」**。
- 行为变化：模型仍能看到两个命令工具（守卫不改工具表，`[TOOLS]/lib/index.js:649-651`），但它一调用 `ops_bash` 就拿到改道理由；
  净效果是「同一会话永远跑 EnvDock 的终端」，代价是最多浪费 1 次调用。
- 风险：
  1. 模型可能反复试 `ops_bash`（守卫不可翻案，`contracts.d.ts:369-370`）；需要文案足够强（点名工具名 + 一句话为什么）。
  2. 与 `workspace-write` 互斥：围栏会话**绝不能**这么干（那里宿主工具是唯一合法执行路径，`:3607` 的 `hideOwn` 必须保留）。
  3. 与 dsh-ops 的 `deny-host-shell` 策略叠加时，谁先拒绝取决于注册顺序（都是全局 guard，`:658` 先全局后链）——两者都会 deny，文案不同而已，可接受。
  4. 需要用户显式选择：「接管优先」vs「让路优先」应做成 EnvDock 的一个选项，而不是默认行为（默认保持现状最安全）。

### 不做的事（明确排除）

- ❌ 不要用同层抢名（§2-D）：竞态 + 语义污染 + 违背自身设计。
- ❌ 不要让 EnvDock 去改 dsh-ops 的配置文件（越权、且是用户级决策）。
- ❌ 不要用 `tools.setExecutor`（§2-F）：故障域过大。

---

## 7. 发现的 EnvDock 现有代码问题（真 bug / 疑似，带行号）

> 均为**只读观察**，未修改代码。严重度按「用户可见影响」排序。

### Bug 1｜让路稳态下每约 30 秒闪一次「遮挡失败」红字（中，确定）

- 位置：`index.js:2919-2934`（`maskFor`，TTL 到了会删 `badNames`，于是又被打回 `mask`）→ `:3123-3146`（逐个 restrict；`ops_bash` 必然抛错 → `:3145` `setLastError('遮挡 … 失败: …')`）→
  `:3153` 记账 → `:3635-3653`（只有**稳态**才会 `setLastError(null)`，而这一 tick `denyKey` 刚变过，不是稳态）→ `:3719`（本 tick 刚报的错不清）。
- 现象：`syncStats.lastError` 周期性变成 `tools.restrict() names unknown global tool "ops_bash"; …`，面板 `client.js:889` 的「最近错误」跟着变红、诊断条 `client.js:900` 的 `diagTone` 变 `danger`。
- 影响：用户以为出了新故障；实际是结构上不可能成功的一次重试。
- 修法：见 §6 改动 3。

### Bug 2｜`commandTool.hostName` 在让路会话里指错工具（中，确定）

- 位置：`index.js:3564-3568`（`shippedName` 按 `SHELL_TOOL_ORDER` 排名取，`pwsh` 优先于 `ops_bash`）→ `:3713`（`rt.denyName = shippedName`）→
  `:842-843`（字段注释写「沙箱会话里它才是模型能用的那个」）→ `client.js:801-812`（面板/旧客户端读它）。
- 事实：现网 `commandTool.hostName = "pwsh"`，而 `syncStats.unrestrictable = ["ops_bash"]`——模型实际拿到的是 **bash 家族的 `ops_bash`**，
  面板却报 PowerShell 家族的 `pwsh`。若 UI 据此给语法建议，会教错（bash vs PowerShell）。
- 缓解现状：`brief()` 已经优先用逐会话事实（`:1741-1754`），所以**简报是对的**；错的只有 `commandTool.hostName` 这个顶层字段。
- 修法：`hostName` 只在「该名字在至少一个会话里仍然可见」时给；或新增 `hostTools[]`（逐会话并集）并让面板不再单点它。

### Bug 3｜`denyScopes(plan, candidates)` 的 `candidates` 是死参数（低，确定）

- 位置：`index.js:3060` 定义；调用点 `:3648`（`denyScopes(plan, [...allHostNames])`）、`:3715`（同上）、`:3181`（`liftDenies → denyScopes([], [])`）。
- 事实：函数体内**从未引用** `candidates`（按 3060-3180 全文核对）。读代码的人会以为「它会挡任意候选名」，实际只挡 `entry.mask`。
- 修法：删参；或真的用它做兜底（把「本作用域可见、属 shell 家族、但 plan 里漏掉」的名字补进 mask）。

### Bug 4｜`familyOf()` 的大小写口径与 `shellFamilyByName()` 不一致（低，潜在）

- 位置：`index.js:666-671`（`SHELL_TOOL_FAMILY[key]`，**不做小写化**）对比 `:626-635`（`shellFamilyByName` 先 `toLowerCase()`）。
- 后果：`familyOf(rt,'OPS_BASH')` 返回 `''`。目前靠 `learnedShells`（`:3490`）兜住，但如果某次 `definitions` 快照失败而名字探测（`:3497-3505`）命中，
  这个名字会以「认不出家族」参与 `stuck`（`:3617-3621`）→ 直接让路。属于「可能被误判成冲突」的隐患。
- 修法：`familyOf` 里也走 `toLowerCase()`。

### 诊断项 D｜同一 `ops_bash` 有多条发布路径，会打 warn（低，噪声）

- 事实：本机同时开着 package 根 row（`[OPS]/cordis.patch.yml:9-41`，四套 mode 全 `enabled:true`，`global.bash:true`）与 legacy 组件行
  （profile `cordis.patch.yml:268-275`，`publishBashTool:true`）。两条路径都会在 agent 层注册同名 `ops_bash`，
  后到者触发 `NamedEntries` 重名（`[TOOLS]/lib/index.js:385`），dsh-ops 走 `[OPS]/lib/session-shells.js:190-207` 的 catch 并打 warn。
- 影响：日志噪声，不改变结论（最终仍只有一个 `ops_bash` 定义存活）。**但**它意味着「关掉某一个开关」不一定能让 `ops_bash` 消失，
  必须同时确认四套 mode 与 legacy 行的状态（见 §2-G 的「关键判定」）。

---

## 8. 复现步骤与证据

```bash
# 1) 版本与运行实例
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Select ProcessId,CommandLine"
#   → ...\@deepseek-ai+dsh@0.2.2-rc.1_...\lib\bin.js web  ⇒ dsh-tools 0.2.2-rc.1
readlink -f "$BASE/node_modules/.pnpm/@deepseek-ai+dsh-base@0.2.2_*/node_modules/@deepseek-ai/dsh-tools"
#   → ...\@deepseek-ai+dsh-tools@0.2._ce93d88...\node_modules\@deepseek-ai\dsh-tools

# 2) 关键源码（每条结论的 file:line 都在 §1-§4 里）
grep -n "restrictableNames\|restrict(filter)\|checkGuards" [TOOLS]/lib/index.js
grep -n "pre-execute\|denialReason" [TOOLS]/lib/pipeline.js
grep -n "ops_bash\|can never succeed" [OPS]/lib/session-shells.js
grep -n "mountSessionBash" [OPS]/lib/legacy/host.js [OPS]/lib/consumer/mount.js

# 3) 现网事实（只读 GET，loopback）
curl -s http://127.0.0.1:3080/envdock-api | node -e "…取 commandTool / syncStats.unrestrictable…"
```

**证据强度分级**

| 结论 | 强度 | 依据 |
| --- | --- | --- |
| `ops_bash` 在 agent 自己的层 | 强（源码 4 跳 + dsh-ops 自述 + 现网 `unrestrictable`） | §1.1、§1.4 |
| `restrict` 对它必然失败 | 强（抛错路径 + 契约原文 + `restrictableNames` 构造） | §1.2 |
| 存在 `guard` / `pre-execute` 缝隙 | 强（API + 契约 + dsh-ops 自身用法） | §2-A/B |
| 让路后只剩 1 个命令工具 | 强（静态推导）；现网因旧构建未直接观测到 `kind:'yield'` | §4.2、§4.4 |
| 面板 3 个候选与推荐 | 判断（设计建议，非事实） | §5 |

**未做/未验证**：未重启宿主进程（会打断正在跑的会话），所以「现行代码的 `kind:'yield'` 实测」只能靠下次重启后复核；
未联网；未改任何代码。
