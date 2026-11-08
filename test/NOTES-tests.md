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
