# EnvDock 安全审计 + 11 项失败测试判定

- 审计对象：`E:\本地库\qq work place\envdock`，工作区未提交改动（`index.js +114/-58`，`test/host-harness.mjs` 1 行）。
- `index.js` 版本：205243 字节，mtime 2026-11-08 08:38，审计期间未变动（下文行号即该版本）。
- 测试行号说明：下文 `test/host-harness.mjs:N` 指 `git show HEAD:test/host-harness.mjs`（2960 行，就是出现 11 项失败的那一版）。工作区 `test/` 在审计期间（09:07–09:20）已被 test-engineer 改写成新语义（`test/fixture/host.mjs`、`test/NOTES-tests.md`），行号已漂移；结论不受影响。
- 方法：源码逐条核对 + `node test/host-harness.mjs` 复现（09:04 跑出 11 项失败）+ 真实终端执行包装串（pwsh 7 / powershell 5.1 / Git Bash）+ 用 `test/fixture/host.mjs` 起真实 `index.js` 打 HTTP/守卫/零工具探针 + 在 `/tmp` 的 `index.js` 副本上验证「必改」补丁（**未修改仓库任何代码文件**）。

---

## 0. 结论摘要

1. **11 项失败里 7 项是「测试过时」**（#1 #2 #3 #4 #6 #9 #11）：新代码的安全性质全部成立（拒绝而不 spawn、委托包装不含用户命令原文、非法策略不执行），失败的只是文案/计数口径/实现机制断言。
2. **3 项是「代码该改」**（#5 #8 #10）：`delegateCalls` 把 `runnerFailed`/`aborted` 排除后，「委托路径走过但 runner 坏了」在聚合计数里完全消失（诊断诚实性缺口）；bash 内层多出来的 `-l` 让登录 profile 执行两次，且代码注释给的理由是反的。
3. **1 项是「语义重定」**（#7）：期望值 6/4/2 必须按新口径重算成 6/3/2（+ refusals 1），代码侧只需 #5/#8 那一处。
4. **PowerShell 包装器的新实现严格优于旧实现**：实测旧 `-EncodedCommand` 路径下 `param()` 开头直接报错、stderr 被 `#< CLIXML` 污染、`cmd /c exit 3` 被报成 exit 1；新路径 `param()` 正常、无 CLIXML、退出码 3 → 3（pwsh 7 与 5.1 均验证）。
5. **安全面最重的一条是真 bug：新代码引入了 DNS rebinding 写路径**（旧代码会 403）。`Host` 与 `Origin` 都是攻击者域名时两者相等，`Origin.host === Host` 的同源判据放行了跨站写；写接口能改自定义终端 argv（≈本机代码执行）。**必修 P1**。
6. 委托执行通道本身是安全的：命令行无用户命令、base64 无引号/长度绕过（env 块实测 60000 字符仍可启动）、带单引号路径的 bash 引号正确；残余是「命令不存在 → exit 0」这一退出码缺口（P3 记录）。
7. allowLan「局域网只读」实测成立（写全 403，唯一例外只会**关掉**开关，fail-closed）；`settings.allowLan`（部署 config）不再生效属行为变更，需在 CHANGELOG 说明。
8. 状态/API 校验合格：op 白名单、setShell/setTool/setCustomShell 参数校验、原型污染均实测通过；残余风险都由 P1 放大。
9. 守卫不撒谎：四个实测场景（接管挡宿主 / 围栏藏自己 / 放开恢复 / 未知工具）结论都与真实可见性一致，替代工具不可见时宁可放行。
10. 归还/幂等正确（先 liftDenies 再 dispose、先建后挡、逐名字 restrict + 逐个 disposer）；**但有一个零命令工具缺口**（P2 可用性）：围栏会话里宿主命令工具不可见时，EnvDock 仍会藏掉自己的 `envd_shell` → 该会话零命令工具（facts 如实报 `anomaly:true`，但模型没工具可用）。

---

## 1. 11 条判定表

| # | 失败断言（HEAD 行号） | 实得 | 结论 | 一句话依据 |
|---|---|---|---|---|
| 1 | `围栏会话调用 envd_shell:拒绝而不是 spawn`（`test:1165`） | 拒绝 ✓、不 spawn ✓，文案 =「宿主没有可委托的执行器」 | **KEEP-CODE** | 行为正确；`runDelegated` 改自拒后调用方那句含「沙箱围栏」的兜底文案不再触发（`index.js:2294-2296`） |
| 2 | `PowerShell 目标:-EncodedCommand…`（`test:1214-1218`） | `-Command` + `$env:ENVD_CMD` | **KEEP-CODE** | 新实现实测更好：`param()` 可用、无 CLIXML、退出码透传（附录 A） |
| 3 | `沙箱出现后、对账之前,执行侧拒绝 spawn`（`test:1338`） | 同 #1 | **KEEP-CODE** | 拒绝成立、无 spawn；断言卡的「沙箱」二字随文案变化 |
| 4 | `本会话 sandboxPolicy 不可得 → 拒绝委托`（`test:2218-2222`） | failures `[3,3]`（没涨），文案 ✓ | **KEEP-CODE** | 非法策略走 `refuse()` 记 `delegateRefusals`（`index.js:2148-2152`），不是执行阶段失败 |
| 5 | `runner 失败:… delegateCalls+1`（`test:2227-2231`） | calls `[0,0]` | **KEEP-TEST** | 排除 runnerFailed 后，该状态在 calls/failures/refusals 三个计数里都不留痕（`index.js:2205-2210`） |
| 6 | `PowerShell 目标:-EncodedCommand…不用 ENVD_CMD`（`test:2244-2249`） | 同 #2 | **KEEP-CODE** | 同 #2 |
| 7 | `最终计数自洽:6/4/2`（`test:2264-2268`） | `6/3/1` | **BOTH** | 新口径应为 tries 6 / failures 3 / calls 2（修 #5 后）/ refusals 1 |
| 8 | `取消(aborted)→ ok:false 且文案带 [aborted]`（`test:2285-2289`） | calls `[1,1]`，ok/text ✓ | **KEEP-TEST** | aborted 是「已启动后被取消」，不计 calls 会让取消在聚合里只剩 tries |
| 9 | `执行器自称不围栏、策略说围栏 → 仍拒绝`（`test:2357-2361`） | 拒绝 ✓、不 spawn ✓；文案「没有执行器」；tries `[0,1]` | **KEEP-CODE** | 夹具 `shell={}` 先命中「缺 resolve/execute」分支（`index.js:2114-2117`）；tries 计数点前移（`index.js:2109`） |
| 10 | `bash 执行器 + bash 目标终端:… bash -s`（`test:2392-2399`） | `base64 -d \| bash -l -s`，payload/ok ✓ | **KEEP-TEST** | 外层 `-lc` 已是登录 shell，内层再加 `-l` = profile 跑两次（`index.js:1619`，注释理由反了） |
| 11 | `runDelegated 遇到非法/缺失 policy → 拒绝委托(delegateFailures+1)`（`test:2656-2664`） | failures `[0,0]`，文案 ✓、executed 0 ✓、tries+1 ✓ | **KEEP-CODE** | 同 #4 |

**分布：KEEP-CODE 7（#1 #2 #3 #4 #6 #9 #11）｜KEEP-TEST 3（#5 #8 #10）｜BOTH 1（#7）。**

### 1.1 逐条证据

**#1 / #3 / #9 —— 拒绝文案（同一根因）**

新代码把「返回 null 交给调用方投降」改成了「自己拒绝并结束」：

- `index.js:2110-2113`：`refuse()` 统一产出 `[sandbox] …;请改用宿主自带的命令工具` 并记 `delegateRefusals`。
- `index.js:2114-2117`：宿主缺 `resolve/execute` → `refuse('宿主没有可委托的执行器(resolve/execute 缺失)')`。
- `index.js:2290-2296`：只有 `delegated` 为假才回落到那句含「沙箱围栏」的文案；而 `refuse()` 返回的是真值对象，所以永远走不到。
- 9 号夹具 `shell={}`（`test:2340`）同时满足「缺执行器」和「capable=false」两个条件，代码先判前者，于是文案是「没有执行器」而不是「自称不围栏」——两句话都是真的，只是取了先命中的那条。

安全性质（拒绝而不 spawn、不委托）三项**都成立**（原断言的副条件也通过）。失败的只有 `includes('沙箱围栏')` / `includes('沙箱')` 这类文案断言，以及 9 号里「tries 不该涨」这一计数口径。判定 KEEP-CODE；建议顺手把围栏事实写进文案（见必改 P3），既恢复可读性又不丢信息。

**#2 / #6 —— PowerShell 包装器换了机制**

`index.js:1624-1631`（新）：`-Command` + `$env:ENVD_CMD`（UTF-8 base64）+ `Invoke-Expression`；旧实现（`git show HEAD:index.js` 同一函数）：`-EncodedCommand`（UTF-16LE base64），并在载荷前拼 `$ProgressPreference='SilentlyContinue'; `。

用真实终端执行**抽取出来的原函数输出**（附录 A）：

| 场景 | 旧 `-EncodedCommand` | 新 `-Command + env` |
|---|---|---|
| `param($x) …` 开头 | **失败**：`param: The term 'param' is not recognized`（前缀语句让 param 不再是脚本第一条） | 正常输出 `x=` |
| 非终止错误时的 stderr | `#< CLIXML …` 垃圾（污染 stderr） | 干净的纯文本 |
| `cmd /c exit 3` | 报 **exit 1**（真实退出码丢失） | 报 **exit 3** |
| `powershell.exe 5.1` + `cmd /c exit 4` | — | 报 **exit 4** |
| 中文输出 / 多行脚本 / 引号 | 正常 / 正常 / 正常 | 正常 / 正常 / 正常 |
| 目标终端路径不存在 | — | exit **127**（`$LASTEXITCODE` 为 null 的显式兜底，`index.js:1607-1611`） |

原断言的**安全意图**是「命令行里没有用户原文」，新实现同样满足（命令经 env 传 base64）。断言却把机制（`-EncodedCommand`、UTF-16LE）写死了 → 测试过时。判定 KEEP-CODE，新断言应改成语义断言：命令行不含用户原文、载荷可还原、退出码透传、`param()` 可用。

**#4 / #11 —— 拒绝 vs 失败的分桶**

`index.js:2148-2152`：policy 缺失/非法 → `refuse(...)`；`refuse()` 只涨 `delegateRefusals`（`2110-2113`），`fail()` 才涨 `delegateFailures`（`2172-2174`）。字段注释也明确分开（`index.js:2434-2437`：「委托在 resolve/启动/结果三个阶段抛错的次数」vs「因目标终端/执行器不支持安全委托而直接拒绝的次数」）。

这两条的安全性质（**不拿部署默认档执行**）实测成立：`executed.length === 0`、`delegateTries+1`、文案含「策略不可得或非法」。失败只是「该记 failures 还是 refusals」。判定 KEEP-CODE。

**#5 / #8 —— `delegateCalls` 的语义（代码侧）**

`index.js:2205-2210`：

```js
const runnerFailed = Boolean(result.sandbox && result.sandbox.runnerFailed)
const aborted = result.aborted === true
if (stats && typeof stats === 'object' && !runnerFailed && !aborted) stats.delegateCalls++
```

而 `delegateCalls` 的既定契约是 **「委托路径真的跑起来了」**（`index.js:2400-2401` 注释、`test:1227-1229` 注释都在说「区分『围栏会话根本没走过委托』和『走了、但宿主执行器拒绝/失败』」）。`runnerFailed` / `aborted` 恰恰属于「走了、宿主出问题」——排除后：

- 「每次委托都 runnerFailed」与「委托从没跑过」在聚合计数上**只差 tries**，而面板（`client.js:1071-1073`）只平铺显示 calls/tries/failures/refusals，没有「tries − calls − failures − refusals」这个未分类量 → 面板无法表达「runner 坏了」。
- `aborted` 是**已启动后被取消**，不是「没执行」，把它从 calls 里删掉属于概念混淆（`ok:false` + `[aborted]` 已经说明「没跑完」）。

实测（附录 A，真实 `index.js` + 夹具）：正常委托 `calls 1 / tries 1`；runnerFailed 后 `calls 1 / tries 2 / failures 0 / refusals 0`；aborted 后 `calls 1 / tries 3 / failures 0 / refusals 0`。判定 KEEP-TEST（代码改），修法见必改 P2。

**#7 —— 计数必须重算**

按当前代码实得 `tries 6 / failures 3 / calls 1`；采纳 P2（runnerFailed 计入 calls 并加独立计数）后应为 **`tries 6 / failures 3 / calls 2 / refusals 1`**（+ `delegateRunnerFailures 1`）。判定 BOTH：测试按新口径重算，代码只需 P2 一处。

**#9 —— tries 的计数点**

`index.js:2109` 把 `delegateTries++` 挪到函数最前面（注释：进入委托路径就记一次）。于是「缺执行器/缺会话/能力位不在」这类拒绝也会 +1。这本身可接受（面板能把「被拒」与「根本没走到」分开），但 `index.js:2432` 的字段注释「发起委托的次数(含失败)」需要改成「进入委托路径的次数（含被拒）」。9 号原断言「tries 不变」属于旧设计（tries++ 在 host/agent/capable 三项检查之后）；新语义下应改断言。

**#10 —— bash 内层多了一个 `-l`**

`index.js:1617-1620`：

```js
if (family === 'bash') {
  // 目标 bash:解码后以登录 shell 执行(-l 保持与直跑 -lc 一致的 profile 语义)
  return { ...wrap([shell.path, '-lc', 'printf %s $ENVD_CMD | base64 -d | bash -l -s']), envValue: payload }
}
```

直跑语义是**一次**登录 shell（`index.js:1579`：`[shell.path, '-lc', line]`）。委托路径外层已经是 `-lc`，内层再 `-l` 就是**两次** profile 执行——注释说的「一致」正好相反。实测本机（`HOME=/tmp/probe-home` 放 `.bash_profile`）嵌套 `-l` 没有可见差异，但用户机器上登录 profile 会改 PATH/打印内容的场合会重复生效；这是没有收益的语义漂移。改 `bash -s` 一行、风险极低。判定 KEEP-TEST。

---

## 2. 六个安全面独立复审

### 面 1｜委托执行（`index.js:1594-1632`、`2107-2232`）

**结论：通道安全；退出码与聚合计数有两个诚实性缺口。**

- **base64 通道不会被引号/长度/编码绕过**
  - 命令行里只有 shell 路径 + 固定脚本：实测 `command` 不含用户命令原文（含 `SECRET-MARKER` 的命令 → `false`）。目标 bash 的命令走 `ENVD_CMD`（`index.js:1619`），目标 PowerShell 的命令也在 `ENVD_CMD`（`1631`），宿主层只看到固定脚本。
  - 长度上限：payload > 30000 → `{error:'too-long'}`（`index.js:1615-1616`），调用方转成拒绝（`2130-2132`）。环境变量上限实测：`ENVD_CMD` 到 60000 字符仍能正常启动进程（附录 A），30000 有余量；命令行本身不受 32767 限制（脚本约 200 字符）。
  - 引号：bash `quote()`（`1599-1602`）对含 `'` 的路径生成 `'C:/a'\''b/bash.exe'`，真实 bash 解析回 `C:/a'b/bash.exe`（实测）——正确。
- **env 传递不泄漏敏感信息**：只看得到 `ENVD_CMD`（base64 的命令本身）和 `dshEnv`（受管 `DSH_*` 快照走专用字段，`index.js:2153-2172`，与官方 shell 工具同款）。残余：`ENVD_CMD` 对子/孙进程可读，但内容就是它自己这条命令，不构成额外泄漏。
- **`$LASTEXITCODE` / 退出码语义**
  - 原生退出码现在**正确**：`cmd /c exit 3` → 3；powershell 5.1 `exit 4` → 4；`bash exit 5` → 5；`bash false` → 1。
  - `$LASTEXITCODE` 为 null 时显式 `exit 127`（`index.js:1607-1611`），覆盖「目标终端没起来」——实测缺路径的终端 → 127，不会伪装成 0。
  - **缺口**：命令不存在（CommandNotFound）这类非终止错误 → `exit 0`（pwsh 7 / powershell 5.1 都复现；stderr 有错误文本）。旧实现会报 1，但它把 3 报成 1、`param()` 直接跑挂，整体更差。修法不容易：`Invoke-Expression` 的 `$?` 恒为 True（实测），没有干净的一行修法；建议记为已知限制，或在 `[exit 0]` 且 stderr 非空时追加一行提示。
- **`aborted` / `timedOut` / `runnerFailed` 的 ok 语义**：`runnerFailed`、`aborted` → `ok:false`（`index.js:2206-2210`、`2232`，实测）；`timedOut` → `ok:true` 但文案有 `[timeout]`（`2223`、`2230`）——与直跑路径一致（`2357`），属既有约定，可建议两条路径一起改成 `ok:false`。

### 面 2｜Loopback 与同源（`index.js:1917-1935`、`3957-4136`）

**结论：同源矩阵基本正确，但新代码引入 DNS rebinding 写路径（安全回归，必修）。**

实测矩阵（夹具 + 真实 handler；`remoteAddress` 区分本机/局域网）：

| 请求 | 结果 | 判定 |
|---|---|---|
| 本机 + 同源 `Origin`/`Host` + `application/json` | 200 | ✓ 正常面板 |
| 本机 + 缺 `content-type` | 403 | ✓ |
| 本机 + `content-type: text/plain`（免预检简单请求） | 403 | ✓ 挡住 CSRF |
| 本机 + 别的端口 `Origin`（`127.0.0.1:4000`） | 403 | ✓ |
| 本机 + `Origin` 与 `Host` 不一致 / `Host` 为空 | 403 | ✓ |
| 本机 + 无 `Origin`、无 `Sec-Fetch-Site`（curl 等非浏览器） | 200 | 可接受（本机进程本来就有全权；浏览器 POST 必带 Origin） |
| 本机 + 无 `Origin` 但 `Sec-Fetch-Site: same-origin` | 403 | fail-closed |
| **`Host=Origin=evil.example:3080`（DNS rebinding）** | **200** | **✗ 跨站写** |
| 非本机 + `allowLan=off` | 403，且 `bodyRead=false` | ✓ 读 body 前拒绝 |
| `content-length: 2MB` | 413，且 `bodyRead=false` | ✓ 读 body 前拒绝 |

- **DNS rebinding 链路**：用户访问 `http://evil.example:3080` → 攻击者把域名解析切到 `127.0.0.1` → 浏览器认为仍同源 → `Origin: http://evil.example:3080`、`Host: evil.example:3080`，`Sec-Fetch-Site: same-origin`。新判据只要求 `new URL(Origin).host === Host`（`index.js:4116-4135`），两者都是攻击者域名 → 全部通过。写接口能改默认终端/自定义终端 argv（`4142-4182`），等于本机代码执行。
- **为什么是回归**：旧代码在回环分支上还有一道 `else if (originHost && !isLoopbackHost(originHost)) → 403`（见 `git diff HEAD -- index.js`），要求 Origin 的 **hostname 是回环字面量** → `evil.example` 被拒。新代码替换成 `Origin===Host`，对 rebinding 反而更弱。
- **GET 分支**（`3957-3968`）只判 loopback/allowLan，完全不看 Host/Origin → rebinding 还能**读**面板（本机路径、终端、brief）。
- **代理头**：`isLoopback` 只认 `socket.remoteAddress`（`1929-1935`），不信任 `X-Forwarded-For` —— 方向正确。残余：同机反向代理/隧道会把所有远端请求变成 127.0.0.1，等于把写接口暴露出去；文档应明确「不要把 dsh 挂在反向代理后面」。
- **修法（已验证）**：见必改 P1，要求 `Host`（以及本机分支的 `Origin`）hostname 是**回环字面量**。

### 面 3｜allowLan 只读语义（`index.js:3961-3968`、`4076-4111`、`4240-4243`）

**结论：写操作确实全部只限本机；唯一例外的例外面很小且 fail-closed。**

- `allowLan=true` 之后实测：局域网 GET → 200（只读，符合设计）；局域网 `POST setOption(injectBrief)` → 403；`POST setShell(cmd)` → 403；`POST setOption(allowLan:true)` → 403；关掉开关后立刻回到「非本机一律 403」。
- 唯一例外：`op=setOption`、`allowLan===false`、body 只含 `op`/`allowLan`（`index.js:4076-4077`），且 `Origin` hostname === `Host` 去端口（`4106-4111`）。它只会**收紧**可见性，不会放开写，可接受。残余：非浏览器的局域网客户端可以伪造 Host/Origin 替用户关掉开关（DoS 级）；rebinding 页面同样能关。建议把「关」也限制为 loopback，成本一行。
- **行为变更**：`settings.allowLan`（部署 config）不再生效（`3961-3963` 只读 state）——这是修「config 永久盖住面板开关」的正确方向，但要在 CHANGELOG/README 说明，否则用 config 打开局域网的人会以为坏了。

### 面 4｜状态文件与 API 输入校验（`index.js:29-231`、`4137-4270`）

**结论：校验合格；没有 path 注入 / 原型污染；残余风险由 P1 放大。**

- **op 白名单**：只有 `refresh / setShell / setCustomShell / setTool / addCustomTool / removeCustomTool / setOption`，其它 400（`index.js:4270`）。
- **argv 注入**：`setCustomShell` 要求路径是**现存文件**（`4163-4171`）、args 必须是含 `{command}` 的模板（`4172-4178`）；这是「用户显式配置自己的终端」，写接口又只限本机 → 设计内的能力，不是注入。
- **路径注入**：写盘路径固定 `STATE_FILE`（`index.js:21-22`）；原子写 tmp+rename，EPERM/EBUSY 有退让分支（`188-207`）；`setShell` 只接受探测到的 key（`4147-4157`），`setTool` 的 target 必须在候选里（`4193-4196`）。
- **原型污染**：实测 `{"op":"setOption","__proto__":{"polluted":1}}` → 400，且 `Object.prototype.polluted === undefined`。`readState` 的 `{...DEFAULT_STATE, ...raw}` 用对象展开（own enumerable → CreateDataProperty，不触发 setter），`writeState` 的 options 只经 `normalizeOptions` 白名单（`182-186`）。
- 残余：`body.key/label` 等字符串无长度上限（只能本机写）；`allowLan` 的 config 覆盖问题见面 3。

### 面 5｜守卫诚实性（`index.js:3793-3883`）

**结论：守卫不撒谎（四个场景实测一致），只有零工具场景的文案需要改。**

- 接管态（`bash` 被藏）：`guard(bash)` → 「已被 EnvDock 接管，改用 `envd_shell`」——`envd_shell` 确实可见（实测 `get('envd_shell')=true`），没有编造工具名。
- 围栏会话（`envd_shell` 被藏）：`guard(envd_shell)` → 「本会话被宿主沙箱围栏(workspace-write)，改用宿主 `bash`」——`bash` 确实可见；`guard(bash)` → 放行（`undefined`）。
- 放开遮挡后：`guard(bash)` 立刻变回 `undefined`，不会永久误拒。
- 未知工具 / 不是我们接管的会话：一律放行（`3793-3811`、`3845-3849`）。
- 方向二只在「替代工具此刻可见」且「登记身份是我们那份」时才拒绝（`3849-3850`），不会把模型逼成零工具。
- 注册器如实：`guardReady`/`guardError` 记录注册成败（`3863-3883`），disposer 进 `cleanups`，卸载时摘掉（`3907-3914`，测试已断言）。
- 缺口（P3）：零工具场景下文案仍是「请使用工具表里可用的命令工具」，但表里没有 → 应改「本会话当前没有可用的命令工具，请让用户检查接管/围栏设置」。

### 面 6｜归还 / 幂等 / 零命令工具窗口（`index.js:2891-3250`、`3602-3709`）

**结论：归还与幂等正确；零命令工具窗口只在 hideOwn 分支存在（P2 可用性）。**

- **拆的顺序**：`teardown()` 先 `liftDenies()` 再 `disposeTool()`（`3228-3250`）→ 不会出现「宿主的还挡着、我们的已没了」。
- **建挡顺序**：`ensureOwnTool()` 成功后才 `denyScopes`（`3687-3709`）；注册失败/查不到/登记身份被顶掉 → `liftDenies()` 把宿主的还回去（`3688-3706`、`3325-3345`）。
- **幂等**：`cur.denyKey === key` 直接 continue（`3071-3075`）；逐名字 `restrict`、每个成功单独 `disposers.push`（`3123-3148`），中途抛错不会像批量调用那样丢掉已生效的 disposer；`dropDenies` 统一归还（`2891-2903`）；agent 销毁 `dropScope` → `dropDenies` + 清诊断（`2820-2845`，含新增的 `sandboxScopes` 清理）。
- **零命令工具缺口**：`plan` 里围栏会话直接 `hideOwn:true`（`3602-3607`），**不看本作用域有没有宿主命令工具**。实测（附录 A 探针 B）：混合部署里把 `locked` 作用域的宿主 `bash` 遮掉（等价于「宿主 shell 不在这个会话」）后，`locked` 会话可见命令工具 = `[]`；facts 如实报 `visible:false, anomaly:true`，`scopeAnomalies:["locked"]` 也记了，但模型没工具可调，且 `scopesSettled` 对 hideOwn 的复检只查「我们自己藏没藏住」，不会自愈。
  - 最小修法 (b)：保持隐藏（fail-closed），把「零工具」做成显式状态（guard 文案 + DESIGN.md 已知限制 + 面板 anomaly 文案）。
  - 完整修法 (a)：hideOwn 前要求「本作用域至少一个宿主工具此刻可见」；我在 `/tmp` 副本上验证过——行为对了（`locked` 保留 `envd_shell`，调用时被 gateAt 拒绝），但 fact 的 `kind` 会从 `sandbox-host` 变 `takeover`（`ownVisible=true`），面板会误报「已接管」→ **必须同时给 fact 加 degraded 字段/新 kind 并改 `client.js`**，不能只改一处。
- **顺手的文档瑕疵**：`delegatedInvocation` 的 doc 还写「返回 null」（`1585-1592`）、`runDelegated` 的 doc 也写「返回 null」（`2104-2105`），实际永远不会返回 null；`index.js:3961-3963` 的 `allowLan` 那三行缩进错位（功能无影响）。

---

## 3. 必改清单（按优先级）

### P1（安全，必修）——堵 DNS rebinding

`index.js:3957-3968`（GET 分支）与 `4112-4136`（POST 本机分支）。在 handler 入口、方法分派**之前**加一道：`Host` 的 hostname 必须是回环字面量；本机分支再要求 `Origin` 的 hostname 也是回环字面量（恢复旧检查）。

```js
// handler 顶部,method 分派之前
const hostNameOf = (value) => {
  const raw = String(value || '')
  if (!raw) return ''
  try { return new URL('http://' + raw).hostname.toLowerCase() } catch { return '' }
}
if (isLoopback(req) && !isLoopbackHost(hostNameOf(req.headers && req.headers.host))) {
  json(res, { ok: false, error: '跨站请求被拒绝(面板 API 只接受本机同源调用)' }, 403)
  return
}
// POST 本机分支(originHost 存在时)追加:
if (!isLoopbackHost(originHost)) { json(res, { ok:false, error:'跨站请求被拒绝…' }, 403); return }
```

已用 `/tmp` 副本验证：正常面板（`127.0.0.1:3080` / `localhost:3080` / `[::1]:3080`）全部 200；rebinding（`evil.example`）403；`Origin` 与 `Host` 不一致 403；本机 curl（无 Origin）仍 200；别的端口 403。**注意 GET 也必须加**（我第一版只加在 POST 分支，GET 仍 200）。

### P2（诊断诚实性，必修）——补委托计数空洞

`index.js:2205-2210`（计数）、`2400-2401`（`delegateCalls` 注释）、`2432-2437`（字段注释）。二选一：

- **方案 A（推荐，改动最小、面板语义最清）**：`delegateCalls` 恢复「拿到 result 就 +1」（含 runnerFailed/aborted，回到测试期望），另加两个独立计数：

  ```js
  stats.delegateCalls = (Number(stats.delegateCalls) || 0) + 1
  if (runnerFailed) stats.delegateRunnerFailures = (Number(stats.delegateRunnerFailures) || 0) + 1
  if (aborted) stats.delegateAborts = (Number(stats.delegateAborts) || 0) + 1
  ```

  恒等式：`delegateTries = delegateFailures + delegateRefusals + delegateCalls`，其中 `delegateCalls ⊇ {成功, runnerFailed, aborted}`，未分类缺口由两个新字段消掉。面板加两列即可看出「runner 坏了」。
- **方案 B（不改 calls 语义）**：保留现在「只数真的执行」，只加 `delegateRunnerFailures` / `delegateAborts`，并把 `client.js:1071-1073` 的诊断条补上这两项（否则空洞仍在）。

已按方案 A 的数值口径复核 #7：应为 `tries 6 / failures 3 / calls 2 / refusals 1`（+ `delegateRunnerFailures 1`）。

### P3（诚实性，1 行）——拒绝文案带上围栏事实

`index.js:2110-2113` 的 `refuse()` 改成：

```js
const refuse = (reason) => {
  if (stats && typeof stats === 'object') stats.delegateRefusals = (Number(stats.delegateRefusals) || 0) + 1
  const mode = gate && gate.mode ? '(' + gate.mode + ')' : ''
  return { ok: false, text: '[sandbox] 本会话命令执行受沙箱围栏' + mode + ',' + reason + ';请改用宿主自带的命令工具' }
}
```

理由：模型需要分清「这工具坏了」还是「沙箱不让跑」；旧文案本来有这条信息，新文案丢了。改完 #1/#3/#9 的文案断言意图也自然满足（不必为了绿而弱化断言）。

### P4（低风险，1 行）——bash 内层去掉 `-l`

`index.js:1619`：`'printf %s $ENVD_CMD | base64 -d | bash -l -s'` → `... | bash -s`。同时把 `1618` 的注释改成「外层已经是 `-lc`（登录 shell），内层不再重复 profile」。

### P5（可用性，P2）——让「零命令工具」至少是显式状态

`index.js:3602-3607` + 守卫文案 `3824-3831` + `docs/DESIGN.md`。建议先做方案 (b)：

- 守卫在没有替代工具时改文案：「本会话当前没有可用的命令工具（围栏会话 + 宿主命令工具不可见），请让用户检查接管/围栏设置」；
- `scopeAnomalies` 的原因文案在面板可见（`client.js:574` 一带已有 anomaly 通道）；
- DESIGN.md 记一条已知限制：`hideOwn` 只在「本作用域有宿主命令工具」时才有意义。
- 方案 (a)（不藏自己）需要 client.js 同步加 degraded 展示，别单独改。

### P6（顺手）——文档/格式

- `1585-1592` 与 `2104-2105` 的「返回 null」注释改成「返回 { error } / 恒返回对象」。
- `2432` 的 `delegateTries` 注释改成「进入委托路径的次数（含被拒/失败）」。
- `3961-3963` 缩进错位。

---

## 4. 可以不改（含已知限制）

| 项 | 为什么可以不改 |
|---|---|
| 测试 #2/#6 的 `-EncodedCommand` 机制 | 新机制的**安全意图**（命令行无用户原文）与旧机制等价，且功能严格更好（`param()`、CLIXML、退出码）；机制属实现细节 |
| 非法 policy 记 refusals 而不是 failures（#4/#11） | 拒绝 ≠ 执行阶段失败；面板两列都在显示；字段注释本来就分开 |
| `delegateTries` 在 refused 时 +1（#9） | 「走到委托路径但被拒」对面板是有用信息；只需要改注释措辞 |
| 本机无 Origin 的写请求被放行 | 本机进程本来就有全权；浏览器 POST 必带 Origin；跨站写路径已由 P1 堵住 |
| 局域网可「关掉」allowLan（可伪造 Host/Origin） | 只会收紧可见性，fail-closed；要更严可以把「关」也限 loopback（一行），非必需 |
| `settings.allowLan` 不再生效 | fail-closed 的正确方向（旧行为会让面板开关永远关不掉）；在 CHANGELOG/README 说明即可 |
| 命令不存在 → `exit 0` | 没有干净修法（IEX 下 `$?` 恒 True 已验证）；stderr 有原文，属已知限制；可在 `[exit 0]` + stderr 非空时加提示 |
| `timedOut` → `ok:true`（有 `[timeout]`） | 与直跑路径一致，属既有约定；要改就两条路径一起改 |
| `ENVD_CMD` 对子进程可见 | 内容是命令自身，不构成敏感信息泄漏；比「命令行传参」并不更差 |
| 反向代理/隧道让远端看起来是本机 | 部署约束，写进 README 提醒即可 |

---

## 5. 与 test-engineer 新测试的关系（避免两份结论打架）

审计期间 `test/` 已被改写为新语义（`node test/host-harness.mjs` 09:31 全绿，12163 ms；见 `test/NOTES-tests.md`）。9 条判定一致，2 处不同：

1. **#5/#8 计数**：新测试把 runnerFailed/aborted 排除出 `delegateCalls`，并在 NOTES §4 自己承认「没有独立计数（已知空洞）」。我的判定是**代码该补洞**（P2），补完新测试可以继续绿（方案 B）或按方案 A 回到 calls+1（需改两处断言）。
2. **#10 `bash -l -s`**：新测试把 `-l` 写成了新契约。我判定是**代码去掉 `-l`**（P4，1 行），理由是「外层已 `-lc`，内层 `-l` = profile 两次」且注释理由反了；不改也无安全影响，但建议按 P4 处理，别把错误理由固化进注释与测试。

其余新测试（拒绝计数、`-Command`+env 载荷、同源矩阵、413 读 body 前拒绝）方向都对；**但没有任何一条覆盖 DNS rebinding**（新测试的 `evilOrigin` 用例是 `127.0.0.1.evil.example` 这种「Origin 不是回环」的变体，rebinding 的 `Origin===Host===攻击者域名` 恰好绕过它）——建议按 P1 补一条 `Host/Origin 都是 evil.example → 403` 的断言。

---

## 附录 A｜探针证据（可复现）

所有探针都在 `/tmp`（`C:\Users\19270_pyzfxn2\AppData\Local\Temp\`），未写入仓库；`index.js` 只读、未改。

1. **复现 11 项失败**：`cd envdock && node test/host-harness.mjs`（09:04，HEAD+1 行版本）→ 末尾「11 项失败」，逐条实得值见第 1 节表格。
2. **包装器真实执行**（抽取 `delegatedInvocation` 原函数源码，`new Function` 还原后调用，用真实 pwsh 7 / powershell 5.1 / Git Bash 执行）：
   - NEW：`echo hello` → 0；`cmd /c exit 3` → 3；`exit 7` → 7；`param($x)…` → 0 且输出 `x=`；中文 → `中文-测试-é`；不存在命令 → **0** + stderr 原文；目标终端不存在 → **127**。
   - OLD：`cmd /c exit 3` → **1**；`param()…` → **失败**（`param: The term 'param' is not recognized`）+ `#< CLIXML`；非终止错误 stderr → `#< CLIXML`。
   - bash 目标：`echo hi-bash` → 0；`exit 5` → 5；`false` → 1；中文+引号/多行 → 正确；含 `'` 的路径 → 实参解析为 `C:/a'b/bash.exe`。
   - env 上限：`ENVD_CMD` 20000/24000/28000/30000/32000/40000/60000 字符全部正常启动（`total block chars` 64596 仍 OK）。
3. **HTTP 鉴权矩阵 + 零工具探针**（`buildHost` 起真实 `index.js`）：见第 2 节面 2/面 3/面 6 的表格。
4. **守卫诚实性**（用夹具真实 agent 对象）：接管态 `guard(bash)` 拒绝并点名可见的 `envd_shell`；`guard(envd_shell)` 放行；围栏态 `guard(envd_shell)` 说明 workspace-write 并点名可见 `bash`；放开后 `guard(bash)` 立刻放行。
5. **必改补丁验证**：把 `index.js` 复制到 `/tmp` 打 P1 + hideOwn 补丁后跑同一批探针：rebinding POST → 403、正常/localhost/IPv6 → 200、别的端口 → 403、curl → 200；hideOwn 补丁使 `locked` 会话保留 `envd_shell`（调用时被 gateAt 拒绝），但 fact 变 `takeover`（所以 P5 方案 (a) 需配合 client.js）。

> 备注：本报告只做判定与建议，没有修改 `index.js` / `client.js` / `test/*`；工作区的 `client.js` 在审计期间被其它任务改动（`git status` 可证），不在本审计范围。
