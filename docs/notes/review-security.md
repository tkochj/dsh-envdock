# EnvDock 第二轮安全审校(只读,攻击式复审)

审校人:独立安全审校员(第二轮)· 时间 2026-11-08 · 方式:读码 + 夹具复现,未修改任何代码/测试。

## 0. 结论先行

- **没有发现 P0 级“局域网/任意网页可直接 RCE”的通路**:第一轮修的 DNS rebinding、严格同源、413 早拒、allowLan 只读,我逐条打了绕过的方向,**都没打通**(见 §4 已验证 OK)。多 Origin 头、重复 Host、`Origin: null`、端口不同、`X-Forwarded-Host`、`127.0.0.1.evil` 全部挡住。
- 找到 **4 条 P1(诚实性/永久状态,非提权)** 与 **19 条 P2(加固)**。P1 里有 3 条是这次新发现的:
  1. 委托通道 base64 载荷一旦丢失/被 profile 改写 → **静默成功**(ok:true、exit 0、空输出);
  2. 委托通道用 `bash -s` 从 stdin 取脚本 → **命令自己读 stdin 会把脚本吃掉**,语义与直跑 `-lc` 不同;
  3. 面板/简报已经切到新终端,**下一条命令仍用旧终端**执行(窗口 = 一次全量探测);
  4. `restrict` 若“先落地再抛错/不返回 disposer” → 无主 deny,**卸载后该会话永久没有任何命令工具**,而面板报健康。
- 第二轮修复的取舍导致两处**反向误杀**(`localhost.`、`[::ffff:127.0.0.1]` 被 403),属可用性问题。
- 测试覆盖仍有 12 处缺口,恰好都在我上面打中的地方(§6)。

## 1. 快照与方法

- 本报告行号以 **index.js md5 `f8c6de27c10b5cdb6486f439ff31b715` / 4503 行**为准。审校期间另有代理在并发改 index.js(性能补丁):开始时是 `6ab97f4a…`/4483 行,中途变 `231ead44…`/4485 行,收尾是 `f8c6de27…`/4503 行;HTTP 面整体下移约 +18 行,接管面 +2 行。**逻辑未变**(逐段复核过 4140-4350、3230-3260),所以结论不受影响,但引用行号请以 md5 为准。
- 复现脚本(全部只读,不改仓库):`.envdock-verify/work/` 下
  `r2-http.mjs`(Host/Origin/CT/LAN/413/写操作矩阵)、`r2-node-parse.mjs`(真实 Node 解析器对畸形头/重复头的归一化)、
  `r2-delegate.mjs` `r2-delegate2.mjs`(委托与直跑通道)、`r2-takeover.mjs`(接管/守卫/restrict/TTL)、
  `r2-a-stale.mjs`(单实例切终端时序)、`r2-b-orphan.mjs`(restrict 落地后抛错)、`r2-http2.mjs`(allowLan 端口比较 / readBody 挂起)。
- 夹具:`test/fixture/host.mjs` 的 `buildHost()` + 假 req/res。**注意**:夹具的 `req.headers` 是纯对象,测不出“重复头/多值头”的真实语义,所以畸形头这一层我另起真 socket 打了 `r2-node-parse.mjs`;`h.toolsFor(id)` 每次返回**新对象**,要 patch 必须用 `agent.ctx.tools`(踩过一次,已记在排除项里)。

## 2. P1(需要修,但非直接提权)

### P1-1 委托执行:载荷缺失 → 静默成功(ok:true / exit 0 / 空输出)

- 位置:index.js:1616-1655(`delegatedInvocation`),bash 包装串 index.js:1642
  `printf %s $ENVD_CMD | base64 -d | bash -s`
- 场景:`ENVD_CMD` 没被宿主 env 透传、或目标 shell 的 profile 把它 `unset`/改写。
- 期望:载荷缺失必须失败(非 0),否则模型会把“什么都没跑”当成成功。
- 实际(本机实测):
  ```text
  $ ENVD_CMD= bash -lc 'printf %s $ENVD_CMD | base64 -d | bash -s'; echo exit=$?
  exit=0        # 无任何输出,也没有报错
  ```
  同一路径在插件里返回 `{ ok: true, text: '[sandbox] 委托宿主执行器执行(...)\n\n[exit 0]' }`。
- 严重度:P1(沙箱会话里唯一能用的执行通道;“假成功”比报错危险)。
- 最小修法:
  ```js
  // 1) 载荷直接内联(无引号歧义,无 env 依赖);2) 明确 require 非空
  "printf %s '" + payload + "' | base64 -d | bash -s < /dev/null"
  ```
  或保留 env 但加前置守卫:`[ -n \"$ENVD_CMD\" ] || { echo 'ENVD_CMD missing' >&2; exit 127; }`(并把 `$ENVD_CMD` 加引号)。

### P1-2 委托执行:`bash -s` 让命令的 stdin 变成脚本本身

- 位置:同上 index.js:1642。
- 场景:模型执行 `read x` / `cat` / `python -` / `ssh` / 任何会读 stdin 的命令。
- 期望:与直跑通道(`bash -lc line`,stdin=ignore)语义一致。
- 实际(本机实测):
  ```text
  $ ENVD_CMD=$(printf 'echo start\nread x\necho got=$x' | base64 -w0) bash -lc 'printf %s $ENVD_CMD | base64 -d | bash -s'
  start
  exit=1        # got= 那一行被 read 吃掉了
  ```
- 严重度:P1(静默截断 + 幻觉式“命令跑了一半”),不是提权。
- 最小修法:包装串加 `< /dev/null`(至少 stdin 立刻 EOF,不会吃掉脚本);更彻底:`base64 -d > "$TMP" ; bash "$TMP"`(要管临时文件),或直接把解出的脚本交给 `bash -c`(但会给命令行长度上限)。

### P1-3 简报/面板已切终端,执行仍用旧终端(activeShell 迟一拍)

- 位置:index.js:2313(`const shell = activeShell.current || resolveShell(readState(), cache.value)`)与 index.js:3576(`activeShell.current = resolveShell(state, detection)`,只在 sync 里更新);`refreshThenSync` index.js:3476 会等新探测落地再对账。
- 场景:`POST /envdock-api {"op":"setShell","key":"powershell"}`,紧接着模型调 `envd_shell`。
- 期望:简报说 PowerShell → 执行也必须用 PowerShell(第一轮的核心承诺:“终端语法以简报为准”)。
- 实际(单实例,`r2-a-stale.mjs`):
  ```text
  基线(应为 bash): bash
  POST setShell powershell → 200
  切换后紧接着那一单实际用: bash          ← 旧终端
  同一时刻简报默认终端: Windows PowerShell → …\powershell.exe
  200ms 后那一单实际用: powershell
  ```
  窗口长度 = 一次全量探测(真机含 `reg.exe` 查询 + 版本探测,实测量级百毫秒~数秒)。
- 严重度:P1(诚实性:简报与执行不同源;模型会按 PowerShell 语法写命令却进了 Git Bash)。无提权。
- 最小修法(一行):`const shell = resolveShell(readState(), cache.value) || activeShell.current`;或在 `setShell`/`setCustomShell` 写成功后立即 `activeShell.current = next`。

### P1-4 restrict“已生效但 disposer 丢失” → 无主 deny → 卸载后永久零命令工具,面板报健康

- 位置:index.js:3222-3226(`cur.disposers.push(tools.restrict(...))` 在 try 内,紧跟 `restrict`;抛错则连 disposer 一起丢)、index.js:3243-3248(catch 分支把“调用后不可见”归成 `missNames`=临时缺失,不当回事)、index.js:2959-2971(`dropDenies` 只能撤自己手里的 disposer)。
- 场景:真机 `restrict` 先落地再抛(index.js:3217-3219 注释自己写了 `dsh-ops 的 publication reentry`),或 `restrict` 返回的不是函数。
- 复现(`r2-b-orphan.mjs`,单实例):把 `agent.ctx.tools.restrict` 包成“先调用原函数、再抛错”。
  ```text
  注入抛错次数: 2
  抛错后: {"pwshVisible":false,"envdVisible":true}
  面板: {"lastError":"","unrestrictable":[],"blockedScopes":[],"scopes":[["agent-u","takeover",[]]]}
  ★卸载后: {"pwshVisible":false,"envdVisible":false}
  ★卸载后该作用域可见的命令工具: []          ← 零命令工具,永久
  ```
  注意面板 `hidden: []` + `lastError: ''`:它**说没挡,实际挡死了**。
- 期望:至少如实记账(“有一个我们撤不掉的 deny”),并在 teardown 尽力回滚;`restrict` 返回值必须做 `typeof === 'function'` 校验。
- 严重度:**P1,是否升 P0 待 Lead 裁决**(取决于 dsh-ops `restrict` 单名前调用是否真会“边加边抛”;若会,任何一次缓存抖动就等于该会话永久失去命令工具)。
- 最小修法:
  ```js
  let disposer = null
  const visibleBefore = stillVisible(name)                 // 调用前
  try { disposer = tools.restrict({ deny: [name] })
        if (typeof disposer === 'function') cur.disposers.push(disposer)
        else cur.lostDenies.push(name)                     // 无法撤销的 deny
  } catch (e) {
    if (visibleBefore && !stillVisible(name)) {            // ← 我们落地了,但撤不掉
      cur.lostDenies.push(name); setLastError('遮挡 ' + name + ' 已生效但 disposer 丢失: ' + e.message)
    } else …原有分支…
  }
  ```
  并把 `lostDenies` 端到面板(hidden 里要显示),teardown 时若有 `tools.unrestrict/lift` 则尽力回滚。

## 3. P2(加固清单)

| # | 场景 | 期望 | 实际 / 证据 | 最小修法 |
|---|---|---|---|---|
| 2-1 | `Host` 解析过宽:取“第一个冒号前”当主机名 | 严格解析或拒绝 | `A9 127.0.0.1:3080@evil.com`→200、`A14 127.0.0.1:3080.`→200、`A15 127.0.0.1:3080,evil.com`→200、`A16 localhost:3080?x=1`→200、`A17 [::1]:3080@evil.com`→200(index.js:4150-4160)。浏览器不可达(Host 是禁止头),写请求另有同源 Origin 挡住(B22=403) | 用 `new URL('http://' + raw)` 取 `hostname`,并要求 `url.username===''`、`url.port` 合法;GET/POST 复用同一个判定函数 |
| 2-2 | 合法回环字面量被误杀 | 放行 | `A6 localhost.:3080`→403、`A7 [::ffff:127.0.0.1]:3080`→403、`A8 127.0.0.1.:3080`→403、`B21` 同源写也 403(index.js:1956-1965 `isLoopbackHost`) | 去尾点;剥离 `::ffff:` 前缀后按 v4 判;`127.0.0.0/8` 整段已是回环 |
| 2-3 | 同源比较口径不一:`URL().host` 对**原始** Host 头字符串相等 | 两边同一套归一化 | `B16 Host:127.0.0.1:80 + Origin:http://127.0.0.1`→403(默认端口被 URL 吃掉);`B17` 双省略→200(index.js:4329-4338) | 抽 `sameOrigin(headers)`:两边都 `new URL(...)`,比较 `hostname` + 规范化端口 |
| 2-4 | Content-Type 用 `includes` 子串 | essence 精确匹配 | `B10 content-type: text/plain;application/json` → **200**(index.js:4340)。浏览器不可达(CORS 简单请求只允许三种 safelisted 值),但别留 | `String(ct).split(';')[0].trim().toLowerCase() === 'application/json'` |
| 2-5 | LAN 关 allowLan 的同源只比 hostname,不比端口 | 与回环分支同口径 | `X1 Origin: http://192.168.1.9:9999 + Host: 192.168.1.9:3080` → **200**(index.js:4320-4324)。方向安全(只能关),但两条分支定义不一致是隐患 | 复用 2-3 的 `sameOrigin()` |
| 2-6 | “LAN 关开关”在 allowLan 已关时根本走不到 | 文档/面板口径一致 | `C3` → 403:index.js:4259 的早拒(`!remoteLoopback && !lanAllowed`)挡在 4289 的例外前面。无害,但别把它当可用能力宣传 | 注释说明,或把例外判断挪到早拒之前并保持只关不开 |
| 2-7 | “无 Origin”路径免 Content-Type 校验 | 明确它只服务 CLI | `X2 sec-fetch-site: ''` + 无 Origin → 200;`sec-fetch-site: same-site`→403、`Same-Origin`(大写)→403(index.js:4344-4348) | 文档写清“无 Origin = 本机脚本通道”;或要求 `sec-fetch-site: none` 才走这条 |
| 2-8 | `readBody` 无超时/无 close/abort 处理 | 有上限、能返回 | `X3` 客户端只发数据不发 `end` → handler **永不返回**(实测 400ms 仍挂着);靠宿主 Node `requestTimeout`(默认 300s)兜底。chunked 超限也要读完才 413(`D1`=413,内存受控) | `req.setTimeout(ms, () => resolve(TOO_LARGE))` + 监听 `close`;`size > limit` 时立即 `json(413)` 并 `req.destroy()` |
| 2-9 | allowLan 打开后的读信息面 | 可接受但要说清 | `C11`:GET 返回 `state`(含 `customShell.args`、`selections`)、`pathInfo`(整条 PATH)、用户名、`brief`、`syncStats`、各工具绝对路径 | README 明示“allowLan = 把本机路径/用户名/终端 argv 广播到局域网”;或 LAN 读时剔除 `customShell.args`/`selections` |
| 2-10 | 反代/隧道暴露 dsh web 时信任模型失效 | 明确边界 | 若中间层把 Host 改写成 `127.0.0.1:3080`(cloudflared 等默认用源站 Host),`remoteAddress` 恒为回环 → 读接口全量可读(同源 Origin 只挡写) | 见到任意 `x-forwarded-*` 头即按非本机处理;或给写接口加 CSRF token。**待 Lead 裁决** |
| 2-11 | `addCustomTool` 的 `key` 无字符校验 | 白名单 | `F1 key=__proto__`、`F2 key=constructor`、`F3 key="A B/C:D*E"` 均写入状态文件(index.js:4428-4429;`normalizeCustomTool` 也保留显式 key,index.js:84-86)。目前消费端没有对象下标写入,未造成污染,但别留 | 统一 `^[a-z0-9_-]{1,64}$`,非法即 400 |
| 2-12 | `setCustomShell` 的 `args` 宽松 | 限长限类型 | `E3 args:"a b {command}"`→ 按空格拆成 `["a","b","{command}"]`;`E4` 非字符串被 `String()` 成 `"[object Object]"/"null"`;`E7` 5000 项→ 状态文件 95KB(index.js:4385-4391) | ≤32 项、每项 ≤4096、只收字符串 |
| 2-13 | `setCustomShell` 只校验 `isFile` | 至少提示 | 可指向 `.bat/.cmd`(经 libuv/cmd 语义执行,引号/元字符规则不同)或任意非终端文件(`E1` 用 node.exe 当终端成功) | 校验扩展名/家族,`.bat/.cmd` 给出警告或拒绝 |
| 2-14 | `addCustomTool` = 落一次写就自动执行该路径 | 威胁模型写清 | 下一次探测会用 `--version` 起它(index.js:4420-4433);与 P1-1 同一类“本地写=执行” | README“威胁模型”章节明示:本机同源写 ≈ 任意代码执行 |
| 2-15 | `hardNames` 10 分钟 TTL 期间不重试(`HARD_UNRESTRICTABLE_MS`,index.js:775 + `maskFor` index.js:3010) | 宿主能力变化后应尽快恢复接管 | `H4`:宿主后来变得可挡,500ms 内 `restrictTries` 仍 `[1,1]`、`unrestrictable` 仍报 `pwsh`、仍是“让路”状态(我们的工具对被让路的会话不可见)。方向安全(用的是宿主工具),但“关开接管/改配置都不清 hardNames”值得修 | `liftDenies()`/`teardown()`/写 `defaultShell` 时清空 `hardNames` |
| 2-16 | 超时仍 `ok:true` | 与宿主 shell 工具口径一致 | `V2 timedOut → {ok:true, exit timeout}`(direct 路径同样) | **待 Lead 裁决** |
| 2-17 | `setTool` 用空白字符串清空选择 | 友好 | `G2 path:"    "` → 400(只有 `""` 能清空) | trim 后再判 |
| 2-18 | `addCustomTool` 的 `label` 原样存储 | 面板侧必须转义 | `F4 label:"<img src=x onerror=alert(1)>"` 写进状态文件。客户端渲染路径不在本次范围,未确认是否 `innerHTML` | 面板侧确认转义;或 API 侧剥控制字符/限长 |
| 2-19 | `Host` 少了端口:`127.0.0.1`(无端口)放行 | 无所谓 | `A13`→200(端口不参与校验) | 无需修,记录在案 |

## 4. 已复核:第一轮修复都还在(攻击方向打不通)

- **多 Origin 头**(真 socket):Node 把重复头合并成 `"http://evil.example, http://127.0.0.1:3080"` → `new URL` 抛错 → `originHost='invalid'`/`originHostPort=''` → **403**(两种顺序都拒)。
- **重复 Host**:Node 只保留第一个 → 第二个 Host 无法走私。
- **`X-Forwarded-Host`**:完全不参与判定(被忽略),没有“信任代理头”的口子。
- **`Origin: null`** → 403;Origin 端口不同 → 403;`Origin: http://127.0.0.1.evil.example:3080` → 403;`Sec-Fetch-Site: cross-site`/大写 → 403;`Host: evil.example` / Host 空 → 403;裸 IPv6 `Host: ::1` → 403(判为畸形)。
- **DNS rebinding**:Host=Origin=攻击者域名的写/读 → 403。
- **allowLan**:LAN 打不开开关(`C2`=403);LAN 写一律 403(含 `refresh`,`C9/C10`=403);LAN 关开关必须同源(`C7`=403)。
- **413**:声明 Content-Length 超限 → 413 且 `bodyRead=false`(没读 body);chunked 1.1MB → 413。
- **body 校验**:坏 JSON / 数组 / `null` / `op:"__proto__"` 全 400,无原型污染;并发 `setTool`+`addCustomTool` 不互相覆盖(`G3`)。
- **委托通道**:命令原文从不出现在宿主命令行(只出现 base64);`ENVD_CMD` 解码与原文逐字节一致;too-long 边界精确(22500 字符放行、22501 拒绝且**不下发执行**);目标 cmd/WSL/自定义终端一律拒绝且不下发;无 agent / 策略非法(yolo)/ resolve|execute|result 三阶段抛错 全部 `ok:false` 且文本可诊断;`runnerFailed`/`aborted` 都 `ok:false`;`denied` 是策略结果,`ok:true` 合理。
- **直跑通道**:argv 数组、无 shell 字符串拼接;cwd 不存在拒绝;空命令拒绝;自定义终端 `{command}` 替换到独立 argv 元素(`B4` 注入串原样成为参数)。
- **接管**:先建后挡;卸载后宿主工具还原(`H1`);别的插件把 `envd_shell` 藏掉时立刻放开宿主工具并记 `blockedScopes`,还回来后自动恢复(`H3`);守卫方向正确(自己可见时不拦自己、无关工具不拦、每次真的拒绝 `+1`,`H1`);`guardReady/guardError` 如实。

## 5. 测试覆盖缺口(建议补的用例)

1. **Host 变体全缺**:`localhost.`、`127.0.0.1.`、`[::ffff:127.0.0.1]`、userinfo、逗号多值、裸 IPv6(harness 里 `::ffff` 0 处、`localhost\.` 0 处)。
2. **Content-Type 带参数/大写/子串**(`charset` 0 处)——`B10` 那种子串放行正是没测出来的。
3. **重复头/多值头**:夹具 `req.headers` 是纯对象,真实解析器行为测不出;建议直接用真 socket 打 Node server 的用例(我用的 `r2-node-parse.mjs` 可以搬进 test/)。
4. **`restrict` “先落地再抛”**:现有只有 `unrestrictableFor`(落地前就抛)和 `restrictNoop`(返回 disposer 但挡不住),**恰恰缺代码注释里点名的真机故障**(`publication reentry` 0 处)。→ 这条缺口直接对应 P1-4。
5. **`restrict` 返回非函数 disposer** 的类型校验无用例。
6. **“简报里的终端 == 执行用的终端”没有端到端断言**:切终端用例只断言“不出现零命令工具”(`切终端` 0 处、`activeShell` 0 处)。→ 对应 P1-3。
7. **委托 bash 通道的 stdin / ENVD_CMD 缺失语义**无用例(0 处)。→ 对应 P1-1/P1-2。
8. **`readBody` 不结束 / abort** 无用例(0 处)。
9. **`setCustomShell` 的 args 类型/超长、`.bat` 路径**无用例(只有“路径不存在 / 缺占位 / 正常”三条)。
10. **`addCustomTool` 的 key/label 注入**(`__proto__`/HTML)无用例。
11. **allowLan 关闭通道的端口比较**无用例。→ 对应 2-5。
12. **守卫在 PTC `executable` 折叠下的结论**没有和“工具其实还能用”对齐的用例(只有 `hasExecutableApi` 口径)。

## 6. 待 Lead 裁决

1. **P1-4 是否算 P0**:取决于 dsh-ops `restrict({deny:[单名]})` 在 publication reentry 时是“抛在落地前”还是“落地后抛”。若后者,这是“一次抖动=该会话永久失去命令工具”。
2. **`timedOut` 仍报 `ok:true`** 是否与宿主 shell 工具口径一致。
3. **反代/隧道暴露 dsh web** 是否纳入威胁模型(2-10 可能要升 P1)。
4. **ENVD_CMD 依赖环境变量**是否改为“base64 内联到包装串”(影响宿主 env 白名单兼容性与 30000 字符上限校准)。
5. **P1-3 修法**:是在 `execute` 里每次现算终端(推荐,代价一次 `existsSync`),还是让 `setShell` 同步写 `activeShell.current`(少一次磁盘 stat,但 `customShell` 失效时仍可能指向已删除文件)。
