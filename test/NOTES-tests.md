# test/ 变更记录:夹具抽取 + 11 项断言的语义更新 + 新语义用例

对象:`test/host-harness.mjs`(断言)、`test/fixture/host.mjs`(新增共享夹具)、`test/simulate.mjs`(新增模拟器)。
写作用域只有 `test/`;`index.js` / `client.js` / `docs/` 一律未动(面板渲染测试 `test/panel-render.mjs` 归 Lead 维护)。

---

## 0. 判定依据(重要)

`docs/notes/safety-audit.md` 在本次改断言期间**始终没有出现**(`docs/notes/` 下只有 Lead 的 `panel-design.md`),
所以本文所有依据都直接取自工作区里**未提交的 `index.js` 改动本身**(`git diff index.js`,170 行)+ 代码注释。
下面每条都标了具体位置,审计报告出来后可以逐条对照;若结论有出入,以审计报告为准并回来改这里。

判定原则:**没有删任何一条旧断言**。语义确实变了的改断言(并尽量加严),能加的额外断言优先加。
抽取前后跑出的失败清单必须完全一致(实测:抽取后仍是同样 11 项、同样的诊断文案)。

---

## 1. 夹具抽取:`test/fixture/host.mjs`

`host-harness.mjs` 里约 600 行的「假 Cordis 宿主」抽成可复用模块,`host-harness.mjs` 改为 import,行为不变:

| 抽取内容 | 说明 |
| --- | --- |
| `prepareHostEnv()` | import 时自动执行:临时 `DSH_HOME`、从 PATH 摘掉 nvm/fnm/pyenv/conda、缺失工具建空文件桩 → 测试确定性,不碰真实 `~/.dsh` |
| `home` | 本次进程的临时 DSH_HOME(harness 写「损坏状态」用例仍用它) |
| `buildHost(options)` | 假宿主,返回 `{ ctx, services, state, webRoutes, subprocess, makeAgent, emit, toolsFor, setScopeDeny, guardReason, tools, api(), dispose(), stats() }` |
| `makeHarness` | `buildHost` 的历史别名(harness 里 40 处调用保持原样,抽取 diff 更小) |
| `fakeSubprocess` / `fakeSandboxedShell` / `fakeSandboxPolicy` | 三个服务替身,原样搬走 |
| `api(url, init)` / `requestApi()` | 对 `/envdock-api` 发假请求,返回 `{ status, json, raw, headers, bodyRead }` |
| `callApi` / `post` / `pollSnapshot` / `freshDetection` / `waitForBrief` | 原样搬走 |
| `decodeEncodedCommand` / `decodeBashPayload` / `decodePowerShellPayload` / `quotedArgs` / `isReg` / `isVersion` | 断言用解码器(`decodePowerShellPayload` 是新增的,见第 2 节 §2) |

**夹具新增能力**(为了新语义可断言,不改变旧行为):

- `fakeReq.__bodyRead`:请求体有没有被读过(handler 挂了 `data`/`end` 监听器就为 true)。
  → 用来证明 413 / 403 是**在读 body 之前**拒绝的(`requestApi` 把它作为 `bodyRead` 返回)。
- `buildHost().dispose()`:跑掉全部 effect disposer(可重复调用);
- `buildHost().stats()`:夹具状态快照(诊断用);
- `buildHost().api()`:`api()` ≡ `GET /envdock-api`,`api(url, init)` 可带 method/body/headers/remoteAddress。

用法(注意 `DSH_HOME` 在 import 时设定,index.js 必须**动态** import 或在其之后再 import):

```js
import { buildHost, callApi, post } from './fixture/host.mjs'
const host = buildHost({ shippedTools: ['bash'], agentIds: ['agent-a'] })
const { apply } = await import('../index.js')
apply(host.ctx, { syncIntervalMs: 25 })
const snap = (await host.api()).json
host.dispose()
```

---

## 2. 11 项失败:原断言 → 新断言 → 依据

> 行号指向当前工作区(未提交)的 `index.js`。

### §1 `围栏会话调用 envd_shell:拒绝而不是 spawn`(hMix)

- **原**:`ok:false && text.includes('沙箱围栏')`。
- **新**:`ok:false && text.includes('[sandbox]') && text.includes('没有可委托的执行器') && text.includes('请改用宿主自带的命令工具')`,
  并**新增**一条记账断言:`delegateTries+1 / delegateRefusals+1 / delegateFailures 不变 / delegateCalls 不变`。
- **依据**:`runDelegated` 现在先查 `ctx.get('shell')` 的 `resolve/execute`(index.js:2114-2117),缺失即 `refuse('宿主没有可委托的执行器(resolve/execute 缺失)')`;
  `refuse()` 统一加 `[sandbox] ` 前缀与「请改用宿主自带的命令工具」尾注(index.js:2110-2113)。
  hMix 夹具本来就没有 shell 服务,所以原因必然是这个,而不是笼统的「沙箱围栏」——
  后者现在只在 `sandboxTakeover === 'refuse'` 时出现(index.js:2297-2306),那条断言仍是绿的、未改动。

### §2 `PowerShell 目标:-EncodedCommand(UTF-16LE base64)且不含 -lc`(hDelegate)

- **原**:命令行含 `-EncodedCommand`;用 `decodeEncodedCommand()`(UTF-16LE)还原命令。
- **新**:命令行含 `-Command` 与 `$env:ENVD_CMD`;**不含** `-EncodedCommand` / `-lc`;
  用新增的 `decodePowerShellPayload(spec)`(env `ENVD_CMD` 的 base64 → UTF-8)还原 = `echo delegated`。
- **依据**:`delegatedInvocation()`(index.js:1594-1636)改成「命令数据一律走 env `ENVD_CMD` 的 base64(UTF-8)载荷」;
  PowerShell 目标改成 `-Command` + 脚本:
  `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $c=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ENVD_CMD)); & { Invoke-Expression $c }; ...`(index.js:1626-1632)。
  注释给了理由:5.1/7 上都没有 CLIXML 噪音、`param()` 开头也正常,并固定 UTF-8 输出编码避免中文乱码。

### §3 `沙箱出现后、对账之前,执行侧拒绝 spawn(无围栏窗口为 0)`(hLife)

- **原**:`text.includes('沙箱')`。
- **新**:`text.includes('[sandbox]') && (text.includes('没有可委托的执行器') || text.includes('本会话信息缺失'))`
  **且**核对没有产生 `echo hi` 的 spawn(新增)。
- **依据**:同 §1——拒绝文案由 `refuse()` 构造(前缀 `[sandbox]`)。这里 `agent` 为 null、夹具 shell 也没有 `resolve/execute`,
  两者谁先命中都会拒绝;断言对两种原因都成立,但「绝不 spawn」这一条是硬要求。

### §4 `本会话 sandboxPolicy 不可得 → 拒绝委托(不拿部署默认档冒充)`(hDelegErr / e4)

- **原**:`e4.delegateFailures === e3.delegateFailures + 1`。
- **新**:`e4.delegateRefusals === e3.delegateRefusals + 1 && e4.delegateFailures === e3.delegateFailures && e4.delegateTries === e3.delegateTries + 1`。
- **依据**:index.js:2148-2152 注释写明「这属于「拒绝」(没执行),不是「失败」(执行阶段出错)」,分支走 `refuse()`;
  `delegateFailures` 只在 `fail(stage, error)` 里 +1(index.js:2173-2182)。
  **加严**:同时钉住「failures 不变」,防止以后又把它混回失败。

### §5 `runner 失败:命令根本没跑 → ok:false + delegateCalls+1`(e5)

- **原**:`e5.delegateCalls === e4.delegateCalls + 1`。
- **新**:`e5.delegateCalls === e4.delegateCalls`(不计数)+ `failures` 不变 + `tries+1`。
- **依据**:index.js:2205-2210「只有**真的执行了**才记 delegateCalls:runnerFailed(命令没跑)与 aborted(取消)不算」。
  这是本次语义改动的核心之一:以前只要拿到 result 就 +1,面板会把「runner 失败、命令根本没跑」算成一次执行。

### §6 `PowerShell 目标:-EncodedCommand(UTF-16LE base64),不用 -lc / ENVD_CMD`(errSpec)

- 同 §2。另外**去掉了**旧断言里的 `!errSpec.env.ENVD_CMD` —— 新约定**恰恰**用 `ENVD_CMD` 承载 base64 载荷,
  所以改成断言载荷能还原出命令 + 命令行不含 `-EncodedCommand`。

### §7 `最终计数自洽:delegateTries 6 / delegateFailures 4 / delegateCalls 2`(e6)

- **原**:`tries === 6 && failures === 4 && calls === 2`。
- **新**:`tries === 6 && failures === 3 && refusals === 1 && calls === 1`,并在断言上方写清算术:
  3 次阶段失败(resolve/启动/结果)+ 1 次拒绝(policy 不可得)+ 1 次 runnerFailed(三计数都不进,只在 tries)+ 1 次成功(calls)。
- **依据**:§4/§5 的两处记账改动。

### §8 `取消(aborted)→ ok:false 且文案带 [aborted]`(e9)

- **原**:`e9.delegateCalls === e8.delegateCalls + 1`。
- **新**:`calls` 不变、`failures` 不变、`tries+1`;`ok:false` 与 `[aborted]` 文案保持不变。
- **依据**:index.js:2206-2210(同 §5)。

### §9 `执行器自称不围栏、策略说围栏 → 仍拒绝(不 spawn、不委托)`(hNoCap)

- **夹具变更**:`const noCapShell = {}` → `fakeSandboxedShell({ className: '' })` 后 `delete noCapShell.sandboxMode`。
  原因:新 `runDelegated` **先**查 `resolve/execute` 再看能力位(index.js:2114-2122),空对象 `{}` 会先撞上
  「没有可委托的执行器」分支,于是永远测不到「自称不围栏」那条拒绝。改成「真实执行器形状、只是不公布 sandboxMode」
  才对准这个用例的本意(能力位 `capable=false`)。
- **原**:`text.includes('沙箱围栏') && delegateTries 不变`(以前根本不进委托路径)。
- **新**:`text.includes('自称不围栏') && tries+1 && refusals+1 && failures 不变 && 宿主执行器 execute 未被调用 && 不 spawn`。
- **依据**:index.js:2121-2122
  `if (gate && gate.capable === false) return refuse('宿主执行器自称不围栏,委托无法保证围栏生效')`;
  该判断的位置已前移到「host/agent 检查之后、语法族判定之前」,所以进委托路径必然 `tries+1`。

### §10 `bash 执行器 + bash 目标终端:ENVD_CMD 是 base64 载荷,目标端 base64 -d | bash -s 解码`(hFamBash)

- **原**:`includes('base64 -d | bash -s')`。
- **新**:`includes('base64 -d | bash -l -s')`(+ 命令行不含用户原文、载荷 == `echo bf-ok`)。
- **依据**:index.js:1616-1619:脚本改成 `printf %s $ENVD_CMD | base64 -d | bash -l -s`,
  注释「`-l` 保持与直跑 `-lc` 一致的 profile 语义」。断言收紧到 `-l -s`,以后丢 `-l` 会立刻红。

### §11 `runDelegated 遇到非法/缺失 policy → 拒绝委托(delegateFailures+1…)`(hMixedUnknown)

- **原**:`muAfter.delegateFailures === muBefore.delegateFailures + 1`。
- **新**:`refusals+1 && failures 不变 && tries+1 && 宿主执行器 execute 未被调用`。
- **依据**:同 §4(index.js:2148-2152)。这条覆盖「policy 服务返回非法 mode(`not-a-mode`)」的另一条入口。

---

## 3. 新增测试(11 条 check)

### 3.1 拒绝/失败/执行/取消 的计数口径(4 条)

| 用例 | 断言 | 依据 |
| --- | --- | --- |
| 拒绝单独记账(hMix) | `tries+1 / refusals+1 / failures 不变 / calls 不变` | §1 |
| `runnerFailed` 只进 tries | 第二次 runnerFailed 后 `calls/failures/refusals` 都不动、`tries+1` | index.js:2205-2210 |
| 缺会话信息 → 拒绝 | `text 含「本会话信息缺失」 && refusals+1 && calls/failures 不变` | index.js:2118-2120「没有会话就没有本会话策略可交给宿主执行器」 |
| 命令太长 → 拒绝 | `text 含「命令太长」 && refusals+1 && calls 不变 && 宿主执行器一次都没 execute` | index.js:1616(`payload.length > 30000` → `{error:'too-long'}`)+ 2130-2132 |

### 3.2 同源校验(Origin / Host / Content-Type / Sec-Fetch-Site,5 条)

| 用例 | 断言 |
| --- | --- |
| 回环但端口不同(`Origin: http://127.0.0.1:3081`,`Host: 127.0.0.1:3080`) | 403 |
| 同源但 `Content-Type: text/plain` | 403 |
| 没有 Origin 却带 `Sec-Fetch-Site: same-origin` | 403 |
| `Sec-Fetch-Site: cross-site` | 403 |
| 没有 Origin + `Sec-Fetch-Site: none`(本机 CLI) | 200 且 `ok:true` |

依据:index.js:4112-4135。注释写的是「任意 127.0.0.1/localhost 端口上的网页都能发 text/plain 简单 POST(免预检)……
other-port.localhost 就能改默认终端 argv(= 命令注入)」,所以 Origin 的 `host:port` 必须与 `Host` 完全一致且必须是 JSON。
已有的两条(evil Origin 403 / 同源 JSON 200)未改动。

### 3.3 413 在读 body 之前拒绝(2 条)

- 声明 `Content-Length: 2000000`(body 只有几十字节)→ **413 且 `bodyRead === false`**;
- 同一个请求的 body 是 `{"op":"setShell","key":"cmd"}` → 校验默认终端**没有**被改成 `cmd`(= 操作没有被执行)。

依据:index.js:4050-4054 —— `declaredLength > 1_000_000` 时在 `readBody(req)` 之前就回 413;
对照组是原有的「>1MB 实际 body → 413」(没带 Content-Length,走 `readBody` 里的 `TOO_LARGE` 分支)。

---

## 4. `delegate*` 计数口径(改完之后,`syncStats` 里这几个数这样读)

| 字段 | 何时 +1 | 备注 |
| --- | --- | --- |
| `delegateTries` | 每次**进入** `runDelegated`(含随后被拒) | 用来区分「根本没走到委托」和「走到了但被拒」 |
| `delegateRefusals` | 没执行就拒绝:缺执行器 / 缺会话 / 能力位 false / 执行器族或目标族不支持 / policy 不可得 / 命令太长 | 拒绝 ≠ 失败 |
| `delegateFailures` | 执行阶段抛错:resolve / 启动 / result 抛错、result 为空 | 不含拒绝 |
| `delegateCalls` | **只数真的执行了的**:成功拿到 result 且 `runnerFailed=false && aborted=false` | runner 失败、取消都不算 |

恒等式(便于以后加断言):`delegateTries = delegateFailures + delegateRefusals + delegateCalls + (runnerFailed/aborted 次数)`。
注意最后一项在 `syncStats` 里**没有独立计数**(这是当前实现的已知空洞;如果以后加 `delegateRunnerFailures` / `delegateAborts`,把这里补上)。

---

## 5. `test/simulate.mjs`(新增,给面板/接管验证用)

用同一套夹具起真实 `index.js`,打印 `/envdock-api` 的完整 JSON 与关键事实。不联网、不碰真实 `~/.dsh`。

```bash
node test/simulate.mjs                                         # 1 个 workspace-write 会话 + 宿主 bash
node test/simulate.mjs --mode danger-full-access                # 无围栏会话 → 应看到 takeover
node test/simulate.mjs --sessions 4 --mode workspace-write,danger-full-access
node test/simulate.mjs --host-tools ops_bash --unrestrictable ops_bash --mode danger-full-access  # 让路(yield)
node test/simulate.mjs --executor none                          # 非沙箱部署(没有 ctx.shell)
node test/simulate.mjs --sessions 2 --mode danger-full-access,workspace-write --delegate "echo hi" # 走委托路径
node test/simulate.mjs --json                                   # 单行机器可读 JSON
```

- 默认 `--pretty`:场景 → shell/sandbox → `commandTool` + **scopes 表**(id/kind/tool/hostTool/confined/mode/visible/hidesOwn/hidden/hostTools/anomaly)
  → **`syncStats` 关键字段** → 可选 `--brief` → 委托结果(含执行器命令行/env/policy/dshEnv)→ 完整 JSON(多行)。
- `--json`:**单行 JSON** `{"scenario":{…},"snapshot":{…/envdock-api…},"delegated":{…}|null}`,除这一行没有任何其它 stdout。
- 参数全表见文件头或 `--help`(`--mode/--sessions/--host-tools/--unrestrictable/--executor/--shell-sandbox/--policy/--takeover/--delegate/--delegate-session/--brief/--pretty/--json/--wait`)。
- 脚本末尾显式 `host.dispose() + process.exit()`:插件的对账 interval 会一直吊住事件循环,不 exit 脚本不会结束。

---

## 6. 未改动 / 已知边界

- **没有删任何旧断言**;`panel-render.mjs`、`client.js`、`index.js`、`docs/` 均未改。
- `test/panel-render.mjs` 当前在**工作区**是红的,与本次改动无关:它读的是 Lead 正在重写的 `client.js`(未提交)。
  验证方法:`git archive HEAD | tar -x -C <tmp>` 后在 HEAD 副本里跑,`panel-render` **全绿**;
  工作区 `test/panel-render.mjs` 本身 `git status` 未修改。
- 依赖本机「有没有某族终端」的分支保持原样:没有该终端时明确 `SKIP`,不伪造 ok。
- 求解器/终端探测仍走夹具固定输出(`CANNED`),所以断言与这台机器实际装了哪个工具链无关
  (`ENVDOCK_FULL_PATH=1` 可以关掉 PATH 过滤,仅排查用)。

---

# 0.6「两族」模型的测试改造(推翻 0.5 的硬不变量)

> 对象:`test/fixture/host.mjs`、`test/host-harness.mjs`、`test/family.mjs`(新增)、`test/simulate.mjs`。
> 依据:Lead 冻结的「共享契约 v1」(族判定 / 遮挡三条 / 注册条件 / 简报文案 / API 形状 / 8 个纯函数),
> 实现见工作区的 `index.js`(未提交)。写作用域只有 `test/`。

## 7. 判定模型的变更(0.5 → 0.6)

| 0.5(辅助展示) | 0.6(两族) |
| --- | --- |
| 硬不变量:`tools.restrict` 恒 0 次、`tools.guard` 一次都不注册 | bash 族会话**按会话** restrict 掉 PowerShell 族内置名(pwsh/powershell),挡不掉的自有层名字走根层 guard 拒绝 |
| 注册条件第 2 条「宿主有同族工具 → `skipReason='same-family'`」 | 删除;`skipReason` 只剩 `'no-family-terminal' \| 'no-unconfined-session' \| 'taken' \| 'error'` |
| 简报「优先 `envd_shell`」「与默认终端同族,EnvDock 不重复提供」 | 按会话族写:bash 族「宿主 ops_bash + envd_shell(EnvDock 增补,Git Bash,同语法);PowerShell 族宿主工具已隐藏(pwsh),不要调用 pwsh」;PowerShell 族「未检测到 bash 族工具」 |
| 命令工具固定跟「默认终端」 | 手动选终端 → 手动族;auto → 该会话能看到 bash 族宿主工具就是 bash,否则 powershell;首次判定后锁定,10s 内允许一次 powershell→bash 升级 |
| API 无族字段 | 顶层 + `commandTool` 新增 family / familySource / blockOtherFamily / sessions / hidden / refuseOnly / displayOnly / mixed,`hostTools[].group`;`syncStats` +`restrictApplied` / `guardRefusals` |

## 8. 夹具升级(`test/fixture/host.mjs`)

`tools` 试身按真机 `dsh-tools` 重写为**三层**,并提供 0.6 用例需要的观察点:

- **全局层**:root `ctx.tools.register()` / `shippedTools`;可被 restrict。
- **祖先层**:`options.shellDefinitions`(preset / 第三方发布);可被 restrict。
- **作用域自有层**:`options.agentTools = { agentId: [name|definition] }` / `host.registerAgentTool()`;
  只有该 agent 看得见,**restrict 挡不掉**(真机原话):
  `tools.restrict() names unknown global tool "pwsh"; known global tools: ...`。
- `tools.view(agent)` 返回**真机形状** `{ visible: Map, knownNames: Set, restrictableNames: Set }`
  (另附 `visibleNames` / `visibleDefinitions` 两个数组方便断言);`restrictableNames` 只含继承层。
- `tools.get(name, scope)` / `executable(name, scope)` 的第二个参数是 agent(省略 = 服务绑定的作用域)。
- **根层 `ctx.tools.restrict` 直接抛错**(`tools.restrict() requires a scoped context (agent.ctx)...`),
  夹具不允许从根层遮住所有 agent —— 这是 0.6 用例 11 的硬不变量。
- `ctx.tools.guard(fn)` 在根层注册;`h.guardReason(name, agent)` 用真机形状 `fn({ name, agent, arguments: {} })`
  求第一条字符串理由,并计 `guardRefusals`。
- `h.disposeAgent(agent)`:撤销该作用域的 restrict disposer → 清 deny → 清自有层 → 从 `agents.list()`
  移除 → 派发 `agent/disposed`({ agent })(真机 payload 就是这个形状)。
- `h.stats()` 新增:`successfulRestrictCalls`、`restrictAttempts[{ scope, deny, ok, error }]`
  (含抛错的尝试;`scope='(root)'` 表示根层调用)、`activeDenies`(每作用域,空对象 = 无残留)、
  `guards` / `guardScopes` / `guardRefusals`、`ownLayers`。
- `withPath(predicate, fn)` + `makeStubBin(files)`:「本机没有 Git Bash」场景把 PATH 换成只有 git.exe 桩的目录,
  跑完恢复。**探测缓存是进程共享的**:改完/还原 PATH 都必须 `freshDetection(h)`(`POST {op:'refresh'}`),
  否则后面的夹具会吃到桩环境的探测结果(用例 15 结尾就是这么收的)。
- 删掉的 0.5 夹具开关(不再有用):`unrestrictable` / `unrestrictableFor` / `unrestrictableRealMessage` /
  `restrictNoop` / `restrictApplyThenThrow`;`executableFor` 保留(ptc 折叠诊断)。
- 修了一处隐蔽的转义坑:`regOutput()` 的行分隔必须是真 CRLF(`join('\r\n')`),否则 `reg.exe` 输出解析不出
  「系统 PATH」,`pathInfo.source` 会一直报 `process`、PATH 漂移类用例全红。

## 9. `test/family.mjs`(新增,零依赖纯函数自测)

`node test/family.mjs`(88 条断言)。import 前把 `DSH_HOME` 指到临时目录,不碰真实 `~/.dsh`;函数缺失时明确报
「index.js 还没实现 0.6 的纯函数」并退出 1。覆盖:

- `shellToolGroup`:内置名单 + 名字 token(`ops_bash` / `tenant_bash` / `pwsh_persistent` / `tenant_pwsh` /
  `gitbash` / `cmd` / `wsl` / `envd_shell` / 空)。
- `manualFamilyOf`:`pwsh/powershell`→powershell、`bash/wsl`→bash、`cmd/custom/auto`→''。
- `autoFamilyOf`:有 bash 族工具→bash,否则 powershell;cmd/wsl 不算;脏数组项跳过。
- `resolveSessionFamily`:首次判定、锁定(record 原样返回)、10s 内(含边界)升级一次、超 10s 不升级、
  升级只一次、不会从 bash 回退、手动族优先、自动↔手动重判、非法 manual → 当自动、`now` 省略用 Date.now()。
- `familyMask`:三条同时成立才 active;`blockOtherFamily=false` / powershell 族 / 没有 bash 族宿主工具 → 不遮;
  agent 自有层名字进 refuse 不进 hide;`restrictable` 省略 = 全可;启发式 PowerShell 名只 displayOnly;
  bash 族名字(含各式拼写)永不进 hide/refuse;`sticky=true` 且 bash 工具暂时消失仍 active(遮挡记忆)。
- `familyBriefLine`:全部必需文案子串(bash 族 + envd_shell、已隐藏/不要调用 pwsh、PowerShell 族/未检测到
  bash 族工具、mixed 三连、未隐藏、未遮挡、本会话被围栏 + ops_bash 且**不含**旧「优先 envd_shell」、未找到、
  PowerShell 族围栏「改用宿主」、只展示、使用分工);空 spec 不抛。

## 10. `test/host-harness.mjs` 的两族用例(§5,17 个)

编号与规划 §5 一一对应,test name 以 `5.N` 开头:

| # | 场景 | 关键断言 |
| --- | --- | --- |
| 1 | 无 bash 族(只有 pwsh) | 会话族 powershell、envd_shell 用 PowerShell 7(`-NoLogo -Command`)、restrict 0 次、guard 不拒绝 pwsh、简报「未检测到 bash 族工具」 |
| 2 | 有 ops_bash | 会话族 bash、envd_shell 注册且 `skipReason=null`(不再 same-family)、argv 走 `bash -lc`、ops_bash 与 envd_shell 同时可用 |
| 3 | ops_bash + 全局层 pwsh | deny 正好 `{pwsh}`、ops_bash 不在其中、`hidden=[pwsh]`、restrict 只发生在 agent 作用域、guard 根层一次、拒绝文案含「隐藏/ops_bash/bash 语法」且不 spawn、定义面看不到 pwsh 但 knownNames 仍有 |
| 4 | pwsh 在 agent 自有层 | 不 restrict(hide 空/0 次)、`refuseOnly=[pwsh]`、直接 restrict 抛真机错误、guard 拒绝、自有层注册没被拆 |
| 5 | ops_bash 出现后消失 | 10s 内升级 bash 并遮挡;消失后族仍 bash + pwsh 仍隐藏(sticky 记忆);`freshDetection` 后回 powershell、hide/deny 全清 |
| 6 | 手动 PowerShell + ops_bash | 不遮挡不拒绝、`mixed=true`、简报「两族同时可见 / 不要混写 / 手动选择」 |
| 7 | 手动 bash + pwsh | 遮挡 pwsh,deny `{pwsh}` 不含 ops_bash,guard 拒绝 |
| 8 | `blockOtherFamily=false` | 不发 restrict、guard 放行、pwsh 仍可见、简报「未隐藏」 |
| 9 | 启发式 PowerShell 名(tenant_pwsh) | 只 displayOnly,不进 hide/refuse、不 restrict、guard 放行、简报「只展示」 |
| 10 | 不变量 | 所有快照的 hide/refuseOnly/displayOnly + 所有夹具 deny/restrict 目标都不含 bash 族名字 |
| 11 | 不变量 | 夹具根层 restrict 直接抛错;全程(除有意探针)没有根层 restrict,更没成功落地 |
| 12 | agent/disposed | 该作用域 deny 全清、agents.list 移除、pwsh 重新可见、简报不再说已隐藏;关开关后一个对账周期内 deny 全清 |
| 13 | 振荡 | 稳定后连续 10 次对账 restrict 调用 ≤1 次、deny/hidden 不漂移 |
| 14 | 受限 bash 族会话 | 简报「沙箱内执行」+ ops_bash、不含「会拒绝」/旧「优先 envd_shell」;执行走**委托宿主执行器**(不自己 spawn);无法委托的同构 fixture(5.14b)简报「无法在沙箱内执行」、执行被拒绝且指向 ops_bash |
| 15 | 无 Git Bash + ops_bash | `skipReason='no-family-terminal'`、envd_shell 未注册、会话族仍 bash、遮挡仍生效、简报「未找到」 |
| 16 | 手动 bash 但会话没有 bash 族工具 | 不遮挡(0 次/hide 空)、guard 放行、简报警告「未遮挡」 |
| 17 | 手动 bash 但该族**既没有终端、也没有宿主工具** | 回退 auto:`familySource='auto'`、API 顶层与 `commandTool` 都 `familyFallback=true`、生效族按自动规则重判(powershell);简报追加「手动选择的族不可用……已回退自动选族」;注册该族宿主工具后**下一轮对账**自动回到 `manual`(`familyFallback=false`,不用重新探测) |

> 用例 17(与 15 同一套环境技巧)靠 `withPath` + `makeStubBin` 造「该族没有终端」:先在真实 PATH 下把默认终端写成 bash,
> 再把 PATH 换成只含 `git.exe` + `pwsh.exe` 桩的目录,并在**桩环境里** `freshDetection(h517)` 让共享探测缓存落到桩环境;
> 断言完在 `finally` 里 `resetState(h)` + `freshDetection(h)` 还原,避免后面的夹具吃到桩环境。
> 「重新可用」那一步只往全局层注册 `ops_bash`(**不需要重新探测**),用来验证逐轮对账会自动回到手动族。

收尾硬不变量(替换 0.5 的「restrict 恒 0 / guard 不注册」):
1. bash 族名字永不进任何 deny / refuse 集合(夹具侧 + 17 键快照侧各一条);
2. `restrict` 只在 agent 作用域调用(根层调用抛错,且全程无真实根层调用);
3. 稳态不反复施加 restrict(§5.13 断言 ≤1 次;全局上限每个夹具 ≤2 次);
4. 关开关后一个对账周期内 deny 全清(§5.8 / §5.12);
5. 卸载后 deny / guard 全清(所有夹具 dispose 后 `activeDenies` 为空、`guards=0`)。
另外钉死「guard 只在根层注册一次」(没有逐会话重复注册)。

## 11. `test/simulate.mjs`(两族场景)

保持向后兼容(`--mode/--sessions/--host-tools/--executor/--shell-sandbox/--policy/--brief/--pretty/--json/--wait`),
新增:

```bash
node test/simulate.mjs --host-tools ops_bash,pwsh --mode danger-full-access          # bash 族 → 遮挡 pwsh
node test/simulate.mjs --host-tools ops_bash,pwsh --shell-family powershell          # 手动 PowerShell → mixed=true
node test/simulate.mjs --host-tools ops_bash,pwsh --block-other-family off           # 关遮挡 → 不隐藏
node test/simulate.mjs --host-tools ops_bash,pwsh --shell bash                       # 直接指定默认终端
```

- 新增参数:`--shell <auto|key>`、`--shell-family <bash|powershell>`(手动选该族第一个可用终端)、
  `--block-other-family [on|off]` / `--no-block-other-family`。
- 人读输出新增「══ 两族(family) ══」段:全局默认族 / 会话族 / fallback / blockOtherFamily / sessions /
  hidden / refuseOnly / displayOnly / mixed;`syncStats` 从 9 字段扩到 11 字段(加 restrictApplied /
  guardRefusals),`hostTools` 打印 `name(group)`。
- `--json` 仍是单行 `{"scenario","snapshot"}`,scenario 只是**加字段**(shell / shellFamily / blockOtherFamily)。

## 12. 已知边界

- §5.15(无 Git Bash)靠「PATH 里只有 git.exe 桩 + 硬编码兜底路径不存在」造环境;若某台机器在
  `C:\Program Files\Git` 等固定路径真有 Git Bash,该用例明确 `SKIP`(不伪造 ok)。
- §5.17(手动族不可用)同样需要「该族没有终端」:桩环境里若仍探测到 bash 终端就 `SKIP`;
  另外它要求本机在真实 PATH 下有 bash 族终端(否则前置的 `setShell bash` 就会 400)。
- 依赖本机终端的用例(1/2/6/7/16/17)同样按快照里的 terminals 决定 SKIP,不假设机器装了什么。
- `test/panel-render.mjs` 归 Lead 维护,未改;面板对新增字段的渲染不在本文件的断言范围。
- `familyFallback` 在 `test/host-harness.mjs` §5.17(真实服务路径)与 `test/family.mjs`(familyBriefLine 的 fallback 文案)两边都有断言。


---

## 13. 0.6.2:沙箱委托执行(从 0.4 搬回 `runDelegated`)

> 行为:受限会话不再一律拒绝。`envd_shell.execute` 在 `gate.confined` 时把命令**委托给宿主沙箱执行器**
> (`ctx.shell.resolve/execute/result`),在宿主围栏内拉起目标终端;EnvDock 自己**不 spawn**。
> 只有「无法安全委托」才拒绝(宿主没有 resolve/execute、执行器族不是 bash/powershell、目标终端是
> cmd/wsl/custom、取不到合法 sandboxPolicy、命令 base64 超过 30000)。

### 13.1 夹具(`test/fixture/host.mjs`)本轮**不需要改**

`fakeSandboxedShell` 早就具备这次要观察的全部能力,直接复用:

| 能力 | 用途 |
| --- | --- |
| `calls.resolved[]` / `calls.executed[]` | 断言「委托了一次」、检查 `request`/`spec` 透传 |
| `resolve(request)` 返回 `{...request, onExpiry, stdoutMaxBytes}` | `spec.command/workdir/timeoutMs/env/sandboxPolicy` 原样可见 |
| `execute(spec).result()` 返回 `sandbox:{mode,denied,runnerFailed}` + stdout/stderr/exitCode | 断言成功文本、runnerFailed、denied 三类结果 |
| `state.runnerFailed` / `state.denied` / `state.abort()` / `state.fail='resolve'\|'execute'\|'result'` | 分阶段失败注入 |
| `className:'BashSandboxExecutor'` | 让 `executorFamilyOf` 认成 bash 族,固定委托包装串的口径 |

`fakeSandboxPolicy` 也够用:回调按 `session.key` 给 mode;传非法 mode(如 `'not-a-mode'`)可造「策略非法」;
不传 `sandboxPolicy` 服务可造「策略不可得」。

### 13.2 `test/host-harness.mjs`:§3.3 / §3.4 重写

**§3.3 注册条件(委托可用性)**

- 全部会话受限 + `fakeSandboxedShell` + policy → **注册**(`sandbox.delegatable=true`),不再是 `no-unconfined-session`;
- 执行器只有 `{ sandboxMode }`(没有 resolve/execute)+ 全部受限 → `skipReason='no-unconfined-session'`,
  `delegatable=false`,简报「无法在沙箱内执行 + 改用宿主」;
- 没有 `sandboxPolicy` 服务 + 全部受限 → 同样 `no-unconfined-session`、`delegatable=false`;
- 有 `danger-full-access` 会话的混合部署 → 注册,`sandbox.delegatable=true`。

**§3.4 委托执行 / 无法委托时拒绝**(a–i)

| 用例 | 断言 |
| --- | --- |
| (a) 委托成功 | `ok:true`、`[sandbox] 委托宿主执行器执行(workspace-write)`、宿主 stdout `host-ran`、`[exit 0]`;`subprocess` 增量 **0**;宿主 `execute` 恰好一次;`ENVD_CMD` base64 解码 == `echo owned`;`spec.sandboxPolicy.mode==='workspace-write'`;`spec.workdir`/`timeoutMs`;`spec.command` 按**执行器族**包装(bash:`; exit?`)且含目标终端 path;`resolve` 收到的 request 带 `sandboxPolicy` + `env.ENVD_CMD` |
| (b) runnerFailed | `ok:false`、文本含「围栏 runner 失败」「这条命令没有执行」 |
| (c) denied | 文本含「文件操作被沙箱拒绝」(命令本身执行了) |
| (d) 无围栏会话 | 仍直跑(自己 spawn,argv 按会话族语法) |
| (e) 无会话信息 | 拒绝(`[sandbox]` + 「本会话信息缺失」),不 spawn |
| (f) 简报 | 受限会话「会通过宿主执行器在沙箱内执行」且不含「会拒绝」;无围栏会话不提沙箱限制;新会话首步也按自己的会话判 |
| (g) 执行器不可委托 | 混合部署(为拿到注册)里受限会话 → 拒绝(`[sandbox]`+「无法在沙箱内执行」+「宿主命令工具」+「没有可委托的沙箱执行器」),不 spawn |
| (h) 手动 cmd 目标终端 | 拒绝(「不支持安全委托执行」),不 spawn;`setShell` 复位 |
| (i) 策略不可得/非法 | 拒绝(「策略不可得」+「无法在沙箱内执行」),不 spawn |

**API 形状**:`sandbox`(顶层 + `commandTool.sandbox`)新增 `delegatable:boolean`;§3.6 的形状断言
从 7 键扩到 8 键,并额外断言「没有 `ctx.shell` 时 `delegatable===false`」。

**§5.14 重写**:受限 bash 族会话 → 简报含「会通过宿主执行器在沙箱内执行」+ `ops_bash`、不含「会拒绝」;
执行时**委托**宿主执行器(`ok:true`、不自己 spawn),不再断言旧「围栏拒绝」文案。
另加同构的 5.14b(`shell:{sandboxMode}` 无法委托):简报「无法在沙箱内执行」、执行被拒绝且指向 `ops_bash`。

### 13.3 `test/family.mjs`(`familyBriefLine` 的 confined 两态)

- `delegate=true` → 「本会话受沙箱限制:envd_shell 会通过宿主执行器在沙箱内执行(文件写入可能被拒绝)」,
  不含「会拒绝」;
- `delegate=false` → 「本会话受沙箱限制且无法在沙箱内执行:…」(bash 指向 `ops_bash` / powershell「改用宿主」);
- bash / powershell 各两边,共 4 条;

### 13.4 结果(本机)

- `node test/family.mjs` → **92/92**
- `node test/host-harness.mjs` → **320/320**、exit 0、0 SKIP
- `parsers` / `i18n-check` / `panel-render`(Lead 维护)保持全绿;`simulate.mjs` 未改
  (它的文件头注释仍写「围栏拒绝」,属描述性文字,不在 task-7 写作用域)。

### 13.5 已知边界

- (a) 里「按执行器族包装」用 `className:'BashSandboxExecutor'` 固定成 bash 包装串;不传 className 时
  `executorFamilyOf` 走平台默认(Windows → powershell),两种都能委托,只是包装串不同。
- (i) 用「policy 服务存在但返回非法 mode」造策略不可得;「policy 服务缺失」在 §3.3 里单独覆盖(此时不可委托、不注册)。
- `runnerFailed`/`denied` 直接改夹具 shell 的 `state`,同一 fixture 内连续断言,记得用完复位(用例已复位)。

