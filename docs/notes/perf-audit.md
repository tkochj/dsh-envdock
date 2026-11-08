# EnvDock Host 侧性能审计(低频路径)与低侵入补丁

> 审计人:perf-auditor(task-2)· 只读审计,未修改 `index.js` / `client.js` / `test/**`
> 审计快照:`index.js` md5 `448506ac8e784ca62dfc8f2d72b27816`(4371 行,2026-11-08 09:52 取样);
> `client.js` md5 `fcdb653707db5dde81106451e0cf3317`(1472 行,09:44 取样)。
> 行号按上述快照。工作区在审计期间仍被并发修改,**补丁请按代码片段(anchor)定位,不要只按行号**。
> 基线:`node test/host-harness.mjs --timing` → **336 项全部通过,12.7s**(同快照复跑,见 §2.1)。
> 所有测量脚本在 `.envdock-verify/work/`(未提交目录,提交前请删除或加进 `.gitignore`)。

---

## 一、结论摘要(10 行)

1. **稳态对账本身已经健康**:5 类场景 ×66–103 个 tick、真机 60s×13 tick,`registers`/`disposes`/`denyApplies` 全部 **+0**——没有 restrict 抖动;卸载后 Timeout 2→0、监听器 3→0、guard 1→0。
2. **唯一值得动的 tick 成本是「同一 tick 内重复的工具表探针」**:1/2/4 个作用域分别 **35 / 58 / 103 次探针/tick**;其中同一批候选名被探了三遍(逐作用域候选探 + `collectShellNames` 又探一遍 + `liveHostNames` 再探一遍),`envd_shell` 的可见性/归属被问了两遍。
3. **补丁 A**(同 tick 探针去重,~45 行)→ 35 / 58 / 103 降到 **15 / 26 / 47**;`payload` 逐字节不变、宿主夹具 336 项全通过。
4. **补丁 B**(稳态 tick 信任同 tick `definitions` 快照,~20 行,带 60s 兜底)→ 进一步降到 **7.6 / 11.2 / 17.8**(纯稳态 tick 是 5 / 10 / 15,兜底轮摊平)。合计降幅 **-78% ~ -85%**。
5. **第二个真实热点是 `GET /envdock-api` 在探测缓存 45s 到期时同步等一次全量探测**:夹具 **152ms**;真机部署实例(进程里是旧构建)实测 **1.08–1.73s**,面板每第 3 次 15s 轮询撞一次。
6. **补丁 C**(过期探测改 stale-while-revalidate,~12 行)→ GET **151.9ms → 1.3ms**;显式作废(改终端/选项/refresh)仍同步等新探测,语义不变。
7. **client.js 不需要补丁**:15s 轮询去重实测有效(相隔 3 个 tick 的两份 payload 只有 `ticks`/`steadyTicks`/`lastAt` 三个易变键不同,去重签名完全相同 → `setData` 被跳过);CSS 是常量文本,每次渲染不产生 DOM 写入。
8. **不建议动**:`refresh`(force) 清版本缓存 + 16 个子进程(「重新探测」的语义)、5s tick / 15s 轮询(既有契约)、每 tick 每作用域一次 `definitions()`(真实宿主唯一可靠的「此刻真相」)。
9. 三个补丁合计 **~80 行、零新依赖、不改接管/围栏/安全语义**;已在夹具上完成「payload 逐字节一致 + 336 项测试通过」验证,建议按 **C → A → B** 落地。
10. 唯一可选的低收益项:探测过期时重查系统 PATH(`LIVE_PATH_TTL_MS=30s` < `CACHE_TTL_MS=45s`),去掉每 45s 的 2 次 `reg.exe`;与 C 叠加后只是省后台 CPU,可不做。

---

## 二、基线与测量方法

### 2.1 `node test/host-harness.mjs --timing`(审计快照,全部通过)

| 阶段 | 耗时 | 说明 |
| --- | --- | --- |
| `apply()` | 8 ms | 插件装配 |
| 首次探测(等待简报) | 140 ms | 含真实 PATH 扫描(夹具过滤过 PATH),子进程为固定输出替身 |
| `GET /envdock-api`(warm) | 3 ms | 探测缓存命中时的稳态 GET |
| `POST refresh` | 99 ms | 新增 **16** 个子进程(`force` 会清版本缓存) |
| 事件驱动对账(`tools/change`) | 83 ms | 单次事件合并后的一轮对账 |
| 20 个稳态 tick | 172 ms | ≈ **8.6ms/tick 墙钟**(含夹具轮询开销;CPU 实测见 §2.3) |
| 8 次终端切换 × 3 tick | 1274 ms | 切换只改执行用的终端,注册表不动 |
| 接管建立(固定名 `envd_shell`) | 186 ms | |
| 逐个 restrict / 30s 重试窗口 | 776 ms | 30s 重试是设计行为,不是抖动 |
| 挡不掉的名字 / denyBlocked 自愈 | 1584 / 700 ms | 让路与自愈路径 |
| 僵尸 PATH 项 / 系统 PATH 新目录 | 662 / 160 ms | 探测重扫 |
| 卸载 / 再启用 | 334 ms | |
| 沙箱:按会话判策略 | 3422 ms | 多场景集合,含等待 tick |

### 2.2 稳态 tick 的探针次数(决定性指标)

计数方式:在 `test/fixture/host.mjs` 的假工具表外包一层计数门面,给 `tools.get` / `tools.executable` /
`tools.definitions` / `tools.restrict` / `tools.register` 记次数,并用异常栈把每次探针**归因回 `index.js` 的具体行**。
夹具里的探针是 Map 查询(便宜),真机每次 `executable`/`definitions` 都要重建 view 集合(代码注释 3543–3544 也这么说),
所以**探针次数**是这里的主指标,CPU 只作参考。

| 场景(稳态) | 作用域 | 基线探针/tick | 补丁 A 后 | 补丁 A+B 后 | 注册表动作/tick(基线→补丁) |
| --- | --- | --- | --- | --- | --- |
| 接管(宿主 pwsh,默认终端 bash) | 1 | **35** | 15 | **7.6** | 0/0 → 0/0 |
| 同上 | 2 | **58** | 26 | **11.2** | 0/0 → 0/0 |
| 同上 | 4 | **103** | 47 | **17.8** | 0/0 → 0/0 |
| 让路(dsh-ops `ops_bash` 作用域私有、挡不掉) | 1 | **30** | 13 | **5.6** | 0/0 → 0/0 |
| 围栏会话(`workspace-write`) | 1 | **30** | 13 | **5.6** | 0/0 → 0/0 |
| 老宿主(没有 `tools.definitions`) | 1 | **42** | 31 | **31** | 0/0 → 0/0 |

基线归因(1 个作用域,纯对账 34 次/tick;另外 ~1 次来自测量窗口里并发的面板 GET):

| 探针 | 次数/tick | 位置(基线快照) | 说明 |
| --- | --- | --- | --- |
| `executable` | 8 | `index.js:3559` | 逐作用域把 8 个内置候选名各探一次 |
| `get` | 8 | `index.js:2917` | `collectShellNames()` 又对同一批名字做一次**全局**探 |
| `executable` | 8 | `index.js:2919` | `collectShellNames()` 里再对每个作用域探一次(**与 3559 完全重复**) |
| `definitions` | 1 | `index.js:3539` | 每作用域一次定义面快照(必要) |
| `executable` | 1 | `index.js:3615` | `liveHostNames` 把 `hostSeen` 再探一遍(与 3559 重复) |
| `get` | 1 | `index.js:3623` | 全局 `seenShells` 逐个再探 |
| `executable`+`get` | 2 | `index.js:3672`+`3673` | plan 里问「`envd_shell` 可见吗/是我们的吗」 |
| `executable`+`get` | 2 | `index.js:3022`+`3023` | `publishScopeFacts` 再问一遍同样两件事 |
| `executable` | 1 | `index.js:3250` | `scopesSettled` 再问一遍可见性 |
| `get` | 1 | `index.js:3706` | 稳态分支 `hasTool(ctx, ENVD_SHELL_NAME)`(必要) |

→ 34 次里有 **16 次是同一批数据的重复探**,另 **4 次是 `envd_shell` 可见性/归属的重复探**。

### 2.3 CPU 与敏感性(夹具,主指标仍是探针数)

| 配置 | 基线 | 补丁 A+B |
| --- | --- | --- |
| 1 作用域,探针=Map 查询 | 0.6–2.5 ms/tick | 0.5–1.6 ms/tick |
| 4 作用域,探针=Map 查询 | 3.1 ms/tick | 0.8 ms/tick |
| 1 作用域,模拟 50µs/探针 + 300µs/`definitions` | 4.1 ms/tick(3 次中位数) | 2.9 ms/tick |
| 4 作用域,同上 | 9.9–11.1 ms/tick | 6.2 ms/tick |

本机在审计期间有并发任务,CPU 抖动大;趋势与探针数一致:探针数 ≈ 其他所有 tick 逻辑之和,所以按探针数优化。

### 2.4 GET / 探测 / refresh / brief / 事件 / 守卫 / 泄漏

| 指标 | 基线 | 补丁 C 后 | 备注 |
| --- | --- | --- | --- |
| warm GET | 0.4–1.0 ms(夹具)/ 3–8 ms(真机) | 不变 | payload 8.3–8.8KB |
| GET(探测被显式作废,如改终端) | 7.5–8.2 ms | 不变(仍同步等新探测) | 语义必须保留 |
| GET(探测只是 45s TTL 到期) | **151.9 ms**(夹具)/ **1.08–1.73 s**(真机旧构建) | **1.3 ms** | 后台刷新落地后,下一次 GET 的 `detectedAt` 前进;`refresh` 仍同步返回新 `detectedAt` |
| `POST refresh`(force) | 16 个子进程,99–131 ms | 不变 | 「重新探测」的语义 |
| 探测(缓存作废后,不 force) | 8 ms,0 子进程(版本/管理器缓存命中) | 不变 | |
| 探测(45s TTL 到期,不 force) | 151.9 ms,2 个子进程(`reg.exe`) | 不变(只是不再挡 GET) | 见可选补丁 D |
| `brief()`(每次模型请求 + 每次 GET) | 0.22–0.33 ms,2–4 次探针 | 不变 | 可接受 |
| `tools/change` 合并 | 60 枚事件(46ms 内)→ **2** 次对账;8ms 间隔事件流 400ms → 8 次 | 不变 | 合并窗口 40ms + `pendingAfterMutate` 补跑 |
| 全局 guard(每次工具调用都会跑) | 非命令工具名 1.5µs/次;命令工具名 2.7µs/次 | 不变 | 两次 Set 查表,不探工具表 |
| 卸载残留 | Timeout 2→**0**、监听器 3→**0**、guard 1→**0** | 不变 | `getActiveResourcesInfo()` 实测 |

### 2.5 真机在线采样(只读 GET,`127.0.0.1:3080/envdock-api`)

- payload **8478 B**;warm GET **3–8 ms**;每 ~45s 一次 **1.08–1.73 s** 的尖峰(= TTL 到期探测,见 §2.4)。
- 60s 采样 16 次:13 个 tick,`registers`/`disposes`/`denyApplies` 全程 **+0**(稳态不抖)。
- 注意:该进程里加载的是旧构建(`syncStats` 缺 `steadyNow`/`detections` 等新字段),它的冷 GET 数字只作旁证;
  当前工作区代码的等价成本是上面的 151.9ms(夹具)。

---

## 三、热点清单(按收益/风险比排序)

### 补丁 C(P0,最低风险):GET 探测过期时改 stale-while-revalidate

**位置**:`index.js:24`(`CACHE_TTL_MS`)、`index.js:4050-4060`(GET 分支)、`index.js:1284`(`detect`)

**现状**:GET 无条件 `await getDetection(false)`。探测缓存只是「过了 45s TTL」时,这一次 GET 要陪它等完整的
全量探测(PATH 重扫 + 2 次 `reg.exe`);面板 15s 轮询每第 3 次就撞一次,真机上是 1 秒级的响应尖峰。

**低侵入改法**(替换 GET 分支里那 7 行):

```js
const state = getState()
let detection = null
// 只是「过了 TTL」而不被显式作废(cache.at===0)时:先端上一份快照,后台再刷新。
// 45s TTL 意味着面板每第 3 次 15s 轮询会撞上一次全量探测;让 GET 干等它没有意义,
// 面板下一次轮询就会拿到新快照。显式作废(改终端/选项/refresh)仍然同步等新数据。
const staleOnly = cache.value && cache.at > 0 && Date.now() - cache.at >= CACHE_TTL_MS
if (staleOnly) {
  detection = cache.value
  getDetection(false).catch(() => {})
} else {
  try {
    detection = await getDetection(false)
  } catch (error) {
    json(res, { ok: false, error: '环境探测失败: ' + String((error && error.message) || error) }, 500)
    return
  }
}
```

**预期收益**:过期 GET **151.9ms → 1.3ms**(夹具);真机旧构建的 1.08–1.73s 尖峰消失。探测总工作量不变,只是移出响应路径。

**风险:低**。只有 `cache.at > 0 && 已过期` 才走 SWR;`invalidateDetection()` 把 `at` 置 0 → 仍然同步等新探测
(改终端/改选项/refresh 的既有语义与测试契约都不变)。后台探测失败被 `.catch(() => {})` 吞掉,下一轮 tick/轮询会重试。
已在本机夹具验证:显式作废路径 7.5–8.2ms 不变;过期路径 151.9→1.3ms;后台落地后下一次 GET 的 `detectedAt` 前进;
`POST refresh` 仍同步返回新 `detectedAt`。

---

### 补丁 A(P0,低风险):同一 tick 的探针去重

**位置**:
- `index.js:2911-2923`(`collectShellNames`,只在 3575 被调用一次)
- `index.js:2956`(`shellCandidates()` 在作用域循环内被调用 → 每个作用域重建一份 Set)
- `index.js:3559-3571`(逐作用域候选探)
- `index.js:3611-3626`(`liveHostNames` 把 `hostSeen` 再探一遍)
- `index.js:3022` / `3250` / `3672`(`envd_shell` 可见性+归属被问三遍)

**现状**:同一 tick 内,同一批候选名被探三遍;`envd_shell` 的「可见/是我们的」被问 3 次(每次 2 次探针)。
1 个作用域 35 次/tick 里 20 次属于重复;作用域越多浪费越大(4 个作用域 103 次/tick)。

**低侵入改法**(三段,合计 ~45 行;以下代码已在本机夹具跑通):

`(A-1)` 候选名单本 tick 只算一次,并用 `seenThisTick` 取代重复的 `collectShellNames()`:

```js
// ── 认宿主命令工具:…(原注释)──
const candidates = [...shellCandidates()]
const candidateSet = new Set(candidates)
const seenThisTick = new Set()
for (const cur of scopes.values()) {
  // …原有 definitions 快照逻辑不变…
  for (const name of candidates) {
    if (name === ENVD_SHELL_NAME) continue
    try {
      if (hasTool(cur.actx, name, cur.agent)) {
        cur.hostSeen.add(name)
        rt.seenShells.add(name)
        seenThisTick.add(name)
      }
    } catch {}
  }
  // …原有 missNames 逻辑不变…
}
// 全局注册面:本 tick 只问一次 definitions(),取代「按名字探 8 次 hasTool(ctx, …)」
const globalToolsView = toolsOf(ctx)
let globalDefs = null
if (globalToolsView && typeof globalToolsView.definitions === 'function') {
  try { globalDefs = globalToolsView.definitions() || [] } catch { globalDefs = null }
}
if (globalDefs) {
  for (const def of globalDefs) {
    const name = def && def.name ? String(def.name) : ''
    if (name && candidateSet.has(name)) seenThisTick.add(name)
  }
} else {
  for (const name of candidates) {
    if (name === ENVD_SHELL_NAME) continue
    try { if (hasTool(ctx, name)) seenThisTick.add(name) } catch {}
  }
}
for (const name of seenThisTick) {
  if (rt.ownNames.has(name)) continue
  rt.seenShells.add(name)
}
```

`(A-2)` `liveHostNames` 复用本 tick 已有的快照:

```js
const liveHostNames = new Set()
const defsCurrent = (cur) => cur.defsSet instanceof Set && cur.defsStamp === syncStats.ticks
for (const cur of scopes.values()) {
  const known = defsCurrent(cur)
  for (const name of cur.hostSeen) {
    try {
      if (known ? cur.defsSet.has(name) : hasTool(cur.actx, name, cur.agent)) liveHostNames.add(name)
    } catch {}
  }
  const masked = String(cur.denyKey || '').replace(/^own\|/, '')
  if (masked) for (const name of masked.split(',')) if (name) liveHostNames.add(name)
}
const globalNameSet = globalDefs
  ? new Set(globalDefs.map((def) => (def && def.name ? String(def.name) : '')).filter(Boolean))
  : null
for (const name of rt.seenShells) {
  try {
    if (globalNameSet ? globalNameSet.has(name) : hasTool(ctx, name)) liveHostNames.add(name)
  } catch {}
}
```

`(A-3)` `envd_shell` 可见性/归属每 tick 每作用域只问一次(沿用 `visDirty` 的既有失效口径):

```js
/**
 * 同一 tick 内「envd_shell 在这个作用域可不可见 / 是不是我们登记的那一份」只问一次。
 * 计划、遮挡、事实三处都要问,以前每处各探一遍(hasTool 走 executable,身份走 get)。
 * 用 visDirty 做失效标记:本 tick 里遮挡真的动过(denyScopes 置位)就重新探。
 */
const ownProbeOf = (cur) => {
  const dirty = cur.visDirty === syncStats.ticks
  if (!dirty && cur.ownProbe && cur.ownProbe.tick === syncStats.ticks) return cur.ownProbe
  const visible = hasTool(cur.actx, ENVD_SHELL_NAME, cur.agent)
  const ours = visible ? isOwnDefinition(cur.actx, cur.agent) : false
  const value = { tick: syncStats.ticks, visible, ours }
  if (!dirty) cur.ownProbe = value
  return value
}
```

然后把三处调用改成:
- `publishScopeFacts`(`index.js:3022-3024`):`const own = ownProbeOf(cur); const ownNameVisible = own.visible; const ownOurs = own.ours;`
- `scopesSettled`(`index.js:3250`):`const visible = ownProbeOf(cur).visible`
- plan(`index.js:3672-3673`):`const ownHere = ownProbeOf(cur); if (ownHere.visible && !ownHere.ours) return { cur, gate, mask: [], hideOwn: false }`

**预期收益**:35 → **15**(1 作用域)、58 → **26**(2)、103 → **47**(4)探针/tick;顺带省掉每 tick 每作用域一次
`new Set()` 重建。夹具 payload **逐字节一致**,336 项测试全通过,`restrict`/`register` 仍是 0/tick。

**风险:低**。所有探针都还在,只是不再重复;全局 8 次按名探换成 1 次 `definitions()`(老宿主没有该方法时原样回退,已用
`definitions:false` 场景验证:42 → 31,没有退化)。`collectShellNames` 改完后只剩定义、没有调用,可一并删掉。

---

### 补丁 B(P1,中低风险):稳态 tick 信任同 tick 的 `definitions` 快照

**位置**:`index.js:3559-3571`

**现状**:本 tick 已经用 `scopeTools.definitions(cur.agent)` 建好 `defsSet`(3545,= 该作用域此刻可见的工具面),
却还对 8 个内置候选名逐个 `hasTool`——每作用域 8 次单点探。真实宿主每次探针都要重建 view 集合,这是 4 个作用域
时最大的剩余开销。

**低侵入改法**(替换逐作用域候选探那一段):

```js
// 本 tick 已经拿到这个作用域的 definitions 快照时,直接用快照算「此刻可见的宿主工具名」——
// 它就是最新可见面(publishScopeFacts 里 defsSet 复用也是同一条口径)。
// 老宿主(没有 tools.definitions)才退回按名字逐个探;每 60s 再强制逐名探一轮兜底。
const forceNameProbe = syncStats.ticks % 12 === 0
if (!forceNameProbe && cur.defsSet instanceof Set && cur.defsStamp === syncStats.ticks) {
  for (const name of candidates) {
    if (name === ENVD_SHELL_NAME || !cur.defsSet.has(name)) continue
    cur.hostSeen.add(name)
    rt.seenShells.add(name)
    seenThisTick.add(name)
  }
} else {
  for (const name of candidates) {
    if (name === ENVD_SHELL_NAME) continue
    try {
      if (hasTool(cur.actx, name, cur.agent)) {
        cur.hostSeen.add(name)
        rt.seenShells.add(name)
        seenThisTick.add(name)
      }
    } catch {}
  }
}
```

**预期收益**:15 → **7.6**(1 作用域)、26 → **11.2**(2)、47 → **17.8**(4)(含每 60s 兜底轮的平均值;
纯稳态 tick 是 5 / 10 / 15)。与 A 合计:1/2/4 作用域分别 **-78% / -80% / -83%** 探针。

**风险:中低**。前提是 `definitions(scope)` 覆盖所有「模型此刻能用」的命令工具。依据:
1. 夹具语义如此,`publishScopeFacts` 已经拿同一个快照当可见性(3461–3470 的 `defsSet` 复用),口径一致;
2. 老宿主(没有 `definitions`)自动回退逐名探,已经验证 42 → 31 且 payload 不变;
3. 兜底:`ticks % 12 === 0` 强制逐名探一轮(60s),加上 `tools/change` 驱动的对账本来就更频繁。
**建议先真机观察 24h** `syncStats.runtimeShellTools` / `unrestrictable` / `scopeAnomalies` 三个字段再决定是否常开。

---

### 补丁 D(P2,可选):探测过期时不要重查系统 PATH

**位置**:`index.js:300`(`LIVE_PATH_TTL_MS = 30_000`)、`index.js:1284`(`detect` → `ensureLivePath`)、`index.js:24`(`CACHE_TTL_MS = 45_000`)

**现状**:探测缓存 45s 到期时,`livePath` 的 30s TTL 也已过期 → 非 force 探测也会多跑 2 次 `reg.exe`(Windows 每次
~20–40ms),并重扫 PATH;夹具实测 TTL 到期探测 **151.9ms**、2 个子进程。

**改法**:`const LIVE_PATH_TTL_MS = 120_000`(或 300_000)。`force`(`refresh` 按钮、改设置)仍强制重查,不受影响。

**预期收益**:去掉每 45s 的 2 次 `reg.exe`,探测从 ~150ms 级降到 ~10ms 级;与补丁 C 叠加后主要是省后台 CPU。

**风险:中低**。系统 PATH 变更(装新工具、删失效目录)在**不点「重新探测」**时的自动发现延迟从 ≤45s 变成 ≤2–5min;
`test/host-harness.mjs` 的「系统 PATH 新目录」「僵尸 PATH 项」用例都走 `op=refresh`(force),不受影响。
收益不大,可放过。

---

### 补丁 E(P3,微优化,合计 <1ms/次)

1. **`allowLan()` 连读两次 state**(`index.js:4025`):`Boolean(getState().options && getState().options.allowLan === true)`
   每次读都做 1 次 `statSync`。改成一次:
   ```js
   const allowLan = () => {
     const st = getState()
     return Boolean(st.options && st.options.allowLan === true)
   }
   ```
2. **GET 里 `healthIssues` 算了两遍**(`index.js:4101` 给 `issues` 字段、`index.js:1924` 在 `brief()` 里又算一遍):
   给 `brief()` 加一个可选入参 `precomputedIssues`,GET 侧传进去;或把 `brief` 的健康检查段提到调用方。
   收益 ~0.02–0.05ms/GET,可选。
3. **`readBody` 缺 `close`/`aborted` 监听**(`index.js:3994-4006`):客户端读到一半断开时 Promise 不会 settle
   (不算插件状态泄漏,但 promise + 闭包一直挂着直到 GC)。加一行兜底:
   ```js
   req.on('close', () => resolve(tooLarge ? TOO_LARGE : ''))
   ```

---

### 补丁 F:client.js 核查结论——**不需要补丁**

- **15s 轮询去重有效**:`client.js:481` `POLL_MS=15000`,`:484` 剔除 7 个易变键,`:697` 命中即跳过 `setData`。
  实测:相隔 3 个 tick 的两份 `/envdock-api` payload,只有 `.syncStats.ticks` / `.steadyTicks` / `.lastAt` 变化,
  去重签名 **完全相同** → 事实不变时不会重渲染。
- **只在可见时拉取**(`:720-723`)、请求序号防覆盖(`isCurrent`)、失败静默轮询不刷红:都正确。
- **payload 8.3–8.8KB / 15s**,`JSON.stringify` 一把 ~0.05ms,可忽略。
- **CSS 注入**(`:1457` `h('style', {}, CSS)`):CSS 是模块内常量字符串,React 每次渲染只比对孩子文本,不写 DOM;
  如果追求洁癖可以提到组件外只注入一次,收益可忽略。
- 大 payload 重渲染:tools ≤14、terminals ≤7,单次渲染开销可忽略;未发现每渲染 O(n²)。

---

## 四、已核查、确认不需要改的项

| 项 | 位置 | 实测/结论 |
| --- | --- | --- |
| restrict 幂等(不抖动) | `index.js:3111` 起(`denyKey === key` 直接 `continue`) | 5 类场景 ×66–103 tick、真机 13 tick:`restrict` **0/tick**、`denyApplies` 不涨 |
| 30s 重试窗口(挡不掉的名字) | `index.js:2964`(`badNames`)、`index.js:3111-3231`(`denyScopes`) | 只每 30s 重试一次,是设计行为;稳态不制造额外抖动 |
| `tools/change` 事件合并 | `index.js:3826-3872`(40ms debounce + `pendingAfterMutate`) | 60 枚事件(46ms 内)只触发 **2** 次对账 |
| 定时器/监听器泄漏 | `index.js:3957-3976` 清理路径 | 卸载后 Timeout 2→0、监听器 3→0、guard 1→0、effect 0 |
| 探测缓存 | `index.js:709-734`(45s TTL、`inflight` 去重、`detectGeneration` 代数保护) | 并发 force 也只跑一份探测 |
| 版本缓存 | `index.js:718-754`(10min TTL、mtime+size 键、上限 256) | `force` 清空是「重新探测」语义,不要优化 |
| 状态文件缓存 | `index.js:146-180`(mtime+size 签名) | 每次读取 1 次 `statSync`;写入原子 rename + 失败退让 |
| 工具定义快照复用 | `index.js:3545`(建快照)+ `index.js:3026-3029`(复用) | 已经生效;补丁 B 只是把复用面从「事实」扩到「发现」 |
| 全局 guard | `index.js:3867`(`shellRefusal`) | 非命令工具名 1.5µs/次;不探工具表 |
| `brief()` | `index.js:1737-1926` | 0.22–0.33ms/次、2–4 次探针;每次模型请求也可接受 |
| `refresh`(force) | `index.js:1289` 起 | 16 子进程是「重新探测」的定义;不要改成复用版本缓存 |
| 状态机/接管语义 | 全文件 | 本次补丁不碰 `denyScopes` / `ensureOwnTool` / `teardown` / guard 判定 |

---

## 五、建议落地顺序与验证清单

1. **补丁 C**(GET SWR):改完跑 `node test/host-harness.mjs`(336 项);再跑
   `.envdock-verify/work/perf-ttl3.mjs` 类用例(把 TTL 注入成短值)确认「过期 GET <10ms,`detectedAt` 不变,
   下一次 GET 前进;显式作废 GET 仍等新探测」。
2. **补丁 A**(tick 探针去重):跑 `node test/host-harness.mjs` + 用 `.envdock-verify/work/perf-compare2.mjs`
   对比 base/patched 的 **payload 逐字节一致**与 `probesPerTick`(期望 35/58/103 → 15/26/47)。
3. **补丁 B**(信任 definitions):同 A 的验证(期望 → 7.6/11.2/17.8);另加真机 24h 观察
   `syncStats.runtimeShellTools` / `unrestrictable` / `scopeAnomalies`。
4. **补丁 D/E**:可选;不做也不影响前三条。
5. 不要动 `client.js`(当前正被并发重构,等稳定后再看要不要把 `<style>` 提到组件外)。

回归门槛建议:每条补丁都保持
「`syncStats.registers/disposes/denyApplies` 稳态 +0」「`denyNames`/`scopeToolFacts`/`runtimeShellTools` 与改前逐字节一致」
「host-harness 336 项全通过」。

---

## 六、附录:快照、复现命令、测量局限

**快照**:`index.js` md5 `448506ac8e784ca62dfc8f2d72b27816`(4371 行)、`client.js` md5 `fcdb653707db5dde81106451e0cf3317`(1472 行)、
`test/fixture/host.mjs` md5 `b2989d1d9043a5b1aeac03c554c8d5e1`(*未修改,只被 import*)。

**复现**(全部只读,写临时 DSH_HOME,不碰 `~/.dsh/envdock.json`):

```bash
cd "E:/本地库/qq work place/envdock"
node test/host-harness.mjs --timing                     # 基线(336 项)
node .envdock-verify/work/perf-compare2.mjs --mod=repo    # 基线探针计数 + payload
node .envdock-verify/work/perf-compare2.mjs --mod=patched # 补丁后(需先生成 patched 副本)
node .envdock-verify/work/perf-attr4.mjs --mod=repo --scopes=4   # 探针归因
node .envdock-verify/work/perf-ttl3.mjs                   # GET 冷/热/过期三种路径
node .envdock-verify/work/perf-events.mjs                 # 事件合并 / guard / 卸载残留
node .envdock-verify/work/perf-client-dedupe.mjs          # 面板去重签名稳定性
```

**临时脚本清单**(`.envdock-verify/work/`,未提交):
`apply-patch.mjs`(把 9 处补丁应用到快照副本)、`index-base-current.js`(审计快照副本)、
`index-patched-current.js`(打好 A+B+C 的副本)、`perf-compare2.mjs`(探针计数 + payload 逐字节对比)、
`perf-attr4.mjs`(探针归因 + CPU)、`perf-ttl*.mjs`(GET 探测三种路径)、`perf-events.mjs`、`perf-leak.mjs`、
`perf-client-dedupe.mjs`、`perf-swr-check.mjs`。
补丁后的副本跑宿主夹具:**336 项全通过**(`variant2-harness.log`)。

**测量局限**:
1. 夹具里的 `tools.get`/`executable`/`definitions` 是 Map 查询,真实宿主每次要重建 view 集合(见 `index.js:3543-3544` 注释),
   所以本报告以**探针次数**为主指标;CPU 只给夹具值(且本机审计期间有并发任务,抖动大)。
2. 真机冷 GET 的 1.08–1.73s 来自当前运行实例,而它加载的是旧构建;当前代码的等价成本是夹具里的 151.9ms。
3. `test/panel-render.mjs` 在审计结束时于工作区失败(`找不到可点的 .envd-morebtn`,系并发重构进行中),
   与本报告补丁无关(未改 `client.js`);`test/host-harness.mjs`、`parsers`、`i18n-check` 均通过。
