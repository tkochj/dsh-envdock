# EnvDock 面板第二轮独立审校（只读）

> 角色：独立面板审校员（第二轮，全新视角，只读；不改代码/测试）。
> 审校快照：`client.js` **md5 `ba891eb7 3784 40fa 8abb 74f1 e07b 757d`**，**1497 行**，mtime `2026-11-08 10:10`（工作树未提交）。
> 注意：审校期间该文件被并发修改过（10:06 读到 1491 行，10:10 已 1497 行，中途落进了「全 host + 全 confined → 沙箱」的补丁）。
> 本报告所有行号都对应上面这个 md5；若实现继续变动，请按报告里的代码片段定位，不要只信行号。
> 基线：`node test/panel-render.mjs` = 194 断言全绿，`node test/i18n-check.mjs` 全绿。即：**下面每一条都是 194 条断言没覆盖到的地方。**
> 证据来源：`api1.json`（现网实测 GET 载荷）、`node test/simulate.mjs` 生成的真实 `index.js` 载荷、以及 5 个临时探针（见 §12，全在 `.envdock-verify/work/`，未进仓库）。
> 参考规格：`docs/notes/panel-design.md`（下称「规格」）、`docs/notes/ops-integration.md`（下称「ops 报告」）。

---

## 0. 结论先行

1. **P0（会崩）：无。** 在 30 组正常/半脏载荷下渲染都不崩；唯一会抛错的是「`tools` / `issues` / `terminals` 不是数组」（§5-10），而当前宿主恒发数组，故降级为 P2 防御项。
2. **P1（会误导）：5 条**，其中 **P1-1 现网已中**（旧版 API 把稳态「让路」画成「工具并存」），**P1-3 上线即中**（逐会话 id 列全部显示 `session-`）。
3. **规格里最贵的三条（胶囊=1 / 状态词不是胶囊 / 状态词五态）没有完全落地**：卡内 `statuschip` 仍是与头部 badge 同文案的第二颗粒子（§5-1）；沙箱态用黄色而不是规格要求的 business 蓝（§5-8）。
4. 折叠/开关主体是对的：三态 `sessionsUser` 解决了「异常自动展开后收起是死按钮」（特别怀疑点 a **不是 bug**，已实测）。
5. 设计规格 `panel-design.md` 与实现已经分叉（自动展开、终端常显、`.envd-sys`、`aria-controls`、`.envd-exec`），属于「规格滞后」还是「实现漏项」需 Lead 裁决，列在 §9。

### P1 速览

| # | 场景 | 实际（一句话） | 证据 | 严重度 |
|---|---|---|---|---|
| P1-1 | 旧版 API + `unrestrictable:['ops_bash']`（**现网就是**） | badge「工具并存」、工具名「envd_shell · ops_bash」、备注「与 envd_shell 并存」，而真实稳态是**让路、模型只有 ops_bash** | `api1.json` + probe1 A1 + probe3 1.1/1.3 + `index.js:4196` | P1 |
| P1-2 | 会话 `confined:null` / `policyKnown:false`，或部分围栏 | badge「未接管」，同一屏备注却说「沙箱策略未知，按有围栏保守处理」；逐会话行也写「未接管」 | probe3 4.1、probe2 1.1/2.1 + `client.js:846-873` | P1 |
| P1-3 | 真实会话 id（`session-<uuid>`） | 逐会话行 id 列 `slice(0,8)` 后全部是 `session-`，N 行看起来一模一样 | `api1.json` ids + probe4 1.1 + `client.js:1084` | P1 |
| P1-4 | 有数据后手动「重新探测」失败 | 完全静默：无错误框、无备注、badge/时间戳不动（用户以为刷新成功） | probe2 4.1 + `client.js:1310` | P1 |
| P1-5 | 混合部署（takeover + sandbox-host） | badge「{n} 个会话未接管」旁边就是「1 沙箱」——0 个会话真的是「未接管」 | probe3 2.1、probe5 4.1 + `client.js:60/193/877` | P1 |

---

## 1. 审校方法（可复现）

```bash
node test/panel-render.mjs            # 基线：194 全绿
node .envdock-verify/work/r2-probe.mjs    # 30 组载荷矩阵（旧/新 API、脏值、零会话、reuse…）
node .envdock-verify/work/r2-probe2.mjs   # 交互：会话三态、静默刷新失败、复制、窄屏 CSS
node .envdock-verify/work/r2-probe3.mjs   # 真实 index.js 载荷：同一事实的新旧 API 对比
node .envdock-verify/work/r2-probe4.mjs   # 真实 session-<uuid> id、胶囊、a11y、设置项
node .envdock-verify/work/r2-probe5.mjs   # 文案细节（空版本/路径、EN 复数、健康行）
# 真实载荷生成（供 probe3 复现）
node test/simulate.mjs --mode danger-full-access --host-tools bash,ops_bash --unrestrictable ops_bash --json
```

探针复用了 `test/panel-render.mjs` 的 React 替身 + `settle()` 模式，**跑的是真 `client.js`**，不是重写逻辑。

---

## 2. P1 详情（场景 / 期望 / 实际 / 修法）

### P1-1 旧版 API 把「稳态让路」画成「工具并存」（现网正在中）

**场景**：现网跑的构建没有 `commandTool.scopes`，`commandTool = {name:'envd_shell',takeover:true,visible:true,denies:['pwsh'],sandbox:true,sandboxPolicyKnown:true}`，`syncStats.unrestrictable = ['ops_bash']`（实测 `api1.json`）。

**期望**：ops 报告 §4.2 已经写死结论——稳态下模型手里**恰好 1 个**命令工具 `ops_bash`，`envd_shell` 被逐作用域 restrict 藏掉；§4.4 明说现网 8 个 `danger-full-access` 会话「本应全部是 `yield`」。面板该说「让路 / 宿主工具在会话层」，至少不能断言两者并存。

**实际**（probe1 A1、probe3 1.1）：

```
badge  = warn / 工具并存
tool   = envd_shell · ops_bash
notes  = ⚠ 接口是旧版构建……
         ⚠ 宿主工具 ops_bash 挡不掉，与 envd_shell 并存
```

原因链：
- `client.js:865-873` 的旧版分支：`unrestrictable.length && ct.takeover === true ? (ct.visible === true ? 'conflict' : 'yield') : …`。
- `ct.visible` 来自 `index.js:4196`：`commandToolState(rt, (name) => hasTool(ctx, name), apiGate)`——**API 侧没有会话，问的是全局工具表**（`index.js:4193-4194` 的注释原话：「注意 API 没有会话:可见性用全局视图」）。逐作用域 restrict 藏掉 `envd_shell` 后，全局视图仍然看得见它，所以 `visible:true` 是**必然**的。
- 因此 `conflict`「并存」在现网是恒定结论，而它要证明的事实（两个工具在同一个会话里同时可见）恰恰是全局探针证明不了的。

**同一份事实的对照**（probe3 1.2 vs 1.3，用 simulate 生成的真载荷，只删掉 `scopes`）：

| 载荷 | badge | 工具名 | 备注 |
|---|---|---|---|
| 新 API（真实稳态） | warn / **让路** | `ops_bash` | 挡不掉，**已让路** |
| 同一份删掉 `scopes` | warn / **工具并存** | `envd_shell · ops_bash` | 挡不掉，**与 envd_shell 并存** |

**最小修法**：旧版分支里 `unrestrictable.length > 0` 时改判 `'yield'`（本来就是代码意图，注释也这么写），`toolNames` 走 `unrestrictable.slice()`（`client.js:894-895` 已有该分支），备注用「已让路」文案；若坚持保留 `conflict`，则文案必须降级为「无法逐会话确认：宿主工具可能仍可见」，不能写「并存」。

---

### P1-2 `confined` 三态只修了一半：`null` / 部分围栏仍被画成「未接管」

**场景 B**（策略不可知）：全会话 `kind:'host'` + `confined:null` + `policyKnown:false`，`data.sandbox.policyKnown:false`（probe3 4.1）：

```
badge = muted / 未接管
note  = · 沙箱策略未知，按有围栏保守处理
row   = agent-1 | 未接管 | ops_bash | 策略未知
```

**期望**：规格 §4.1 判据 1 原话——「`null = 策略不可知`，执行层按『有围栏』保守处理 → 视觉上归入 `sandbox`，原因写 `策略未知`。**绝不能把 `null` 当 `false`**（那会把围栏会话画成『未接管』）」；§4.3 案例 F 要求状态词「沙箱」。同一屏「未接管」+「按有围栏保守处理」是自相矛盾。

**场景 A**（全围栏）：all-host + `confined:true` 已在 10:10 的补丁里修好（`client.js:850-855`，probe2 1.1 聚合 = 沙箱 ✅）。**但逐会话行没跟着改**（probe2 1.1）：

```
aggregate badge = muted / 沙箱
row            = aaaaaaaa 未接管 ops_bash 围栏    (dot = envd-sdot idle)
```

**场景 C**（部分围栏）：`[{kind:'host',confined:true},{kind:'host',confined:false}]` → `nonTakeover.every(host) && scopes.every(confined===true)` 为假 → 落 `'host'` → 「未接管」，其中被围栏的那个会话照样被说成未接管（规格 §4.2 聚合优先级要求「否则 有沙箱 → 沙箱」）。

**最小修法**：把规格 §4.1 已经写好的 `sessionState(sc)` 原样落地为纯函数，聚合与逐会话行**共用同一个词**：

```js
if (sc.anomaly === true || !sc.tool || sc.visible === false || leaked.length) return 'conflict'
if (sc.kind === 'sandbox-host' || sc.confined !== false) return 'sandbox'   // true 与 null 都算沙箱
if (sc.kind === 'yield') return 'yield'
if (sc.kind === 'takeover') return 'takeover'
return 'host'
```

聚合按 conflict > mixed > sandbox > yield > takeover > host 投影；行状态词同样取 `sessionState`。

---

### P1-3 逐会话 id 列全是 `session-`（上线即中）

**场景**：真实会话 id 形如 `session-9496271c-2738-4ffa-9066-4074ff95a8ac`（`api1.json` 的 `sandbox.scopes[].id`，`index.js` 的 `commandTool.scopes[].id` 同源 = `String(cur.agent.id)`）。

**实际**（probe4 1.1）：三行 `envd-sid` 全部渲染成 `session-`，三行可见文本完全相同：

```
session-直连envd_shell
session-直连envd_shell
session-直连envd_shell
```

`client.js:1084`：`String(sc.id || '?').slice(0, 8)`。测试用的是 `'aaaa1111bbbbcccc'` 这类假 id（`test/panel-render.mjs:411-419`），所以 194 条断言全绿。

**最小修法**：`const short = String(sc.id||'?').replace(/^session-/, '').slice(0,8)`，并给 `.envd-sid` 加 `title={完整 id}`；顺手可以让点一下复制（和工具路径一致的心智）。

---

### P1-4 有数据后手动刷新失败 = 完全静默

**场景**：面板已有数据，用户点「重新探测」，POST 成功但随后 GET 失败（网络抖动 / 宿主重启中 / 403）。

**期望**：至少一行「刷新失败：…」的可见反馈（用户主动动作必须有回执）。

**实际**（probe2 4.1）：`fetch` 1 → 3（POST + GET 都发了），`.envd-err` 数量 0，badge 不变，`.envd-copy-note` 空。原因：`client.js:1310` 用 `if (error && !data)` 才渲染错误框，而 `fetchState` 在非静默路径里确实 `setError(...)`——**state 里躺着错误，屏幕上永远不显示**（只有 `data` 为 null 时才显示）。

**最小修法**：`error && data` 时补一条 muted/warn 备注（复用 `notes` 机制即可），或把「重新探测」失败走 `opError` 通道（它已经有可见 + 可关闭的错误框）。

---

### P1-5 混合部署 badge 词错：「{n} 个会话未接管」但 0 个会话是 host

**场景**：`scopes = [takeover, takeover, sandbox-host]`（规格 §4.3 案例 E 的典型混合部署，simulate 可复现）。

**实际**（probe3 2.1、probe5 4.1）：

```
zh: badge = warn / 1 个会话未接管     subs = 3 个会话 · 2 直连 · 1 沙箱
en: badge = "Host tool in 1"          subs = "3 sessions · 1 direct · 1 sandboxed"
```

`client.js:877` 用 `nonTakeover.length` 填 `t.statusMixed`，而 `statusMixed` 的词是「未接管 / Host tool」（`client.js:60/193`），把「让路 + 沙箱」也算成「未接管」。规格 §4.4 规则 4 的原文是「{n} 个会话用宿主工具」——那句在语义上对 yield/sandbox-host 都成立。

**最小修法**：改词（`{n} 个会话用宿主工具` / `{n} sessions on the host tool`），或按 kind 分列（`2 直连 · 1 沙箱`）不做汇总 badge。

---

## 3. 特别怀疑点 a–d 裁决

### a) `showSessions = sessionsOpen || badScopes.length > 0` —— **不是 bug（已被三态修掉）**

当前实现是 `client.js:1068`：

```js
const showSessions = hasScopes && (sessionsUser === undefined ? badScopes.length > 0 : sessionsUser)
```

`sessionsUser` 三态（`undefined` = 跟随异常自动展开，`true/false` = 用户显式选择），按钮 `onClick={() => setSessionsUser(!showSessions)}`（`client.js:1363`）。实测（probe2 5.1）：

- 异常载荷挂载：`rows=1`、按钮 = 「收起」、`aria-expanded=true`；
- 点「收起」：`rows=0`、按钮 = 「会话」、`aria-expanded=false`；
- 再渲染/轮询：「仍然收起」——用户选择被保留。

即：**「异常自动展开后收起按钮假死」已修好**。两条附带结论：

1. 用户收起后，**新异常也不会自动展开**（`sessionsUser` 不回 undefined）。这与规格 §1.2 硬验收 4「折叠态由用户点击决定，且 `useState` 保存、不随 15s 轮询重置」一致，但与「异常会话自动展开」只在**首次挂载**成立。属设计取舍，不算 bug，但值得在 CHANGELOG 里写清。
2. 唯一残留边缘：`hasScopes` 变 false（会话清零）再变回 true 时，`sessionsUser=false` 保留 → 有异常也保持收起。badge 仍报 N 个异常，可接受。

### b) 「状态=让路，却仍显示 envd_shell」 —— **不会**；但 `'yield'` 分支是死代码，且会产出「让路 + 并存」自相矛盾

- `toolNames` 的 yield 分支取 `unrestrictable`（`client.js:894-895`），**不会**显示 `ct.name`，所以「让路却列 envd_shell」不会发生。
- 但 `client.js:860` 的 `ct.visible === false` 分支已经**提前**截走了「不可见」的所有情况（→ `sandbox` / `broken`），于是 `client.js:868-870` 的 `ct.visible === true ? 'conflict' : 'yield'` 里那个 `'yield'` **在真实载荷下不可达**（宿主恒发 boolean `visible`，见 `index.js:898/906` 的 `Boolean(...)`）。
- 它只在**脏载荷**（`visible` 字段缺失）时命中，而一旦命中就是自相矛盾组合（probe1 A3）：

```
badge = warn / 让路            ← statusText 让路
tool  = ops_bash               ← 正确
notes = ⚠ 宿主工具 ops_bash 挡不掉，与 envd_shell 并存   ← yielded = ct.visible === false → false
```

结论：旧版 API 无法诚实表达「让路」，代码的分支设计意图（不可见→让路）被自己的前置分支吃掉了。**修法**：删掉 `'yield'` 这个不可达三元，`visible` 缺失时按「未知」处理（不并列工具名、备注不写「并存」）；真要支持旧版让路，按 P1-1 的修法整体改判。

### c) `reuse === true` 时「由其它插件提供」+「没探测到命令工具」 —— **是矛盾**（确认）

probe1 B1（`reuse:true, takeover:false, name:null`）：

```
badge = muted / 由其它插件提供
tool  = 没探测到命令工具          ← 同一行
notes = ⚠ 宿主工具 ops_bash 挡不掉，与 envd_shell 并存   ← 连 envd_shell 都不是我们的
```

原因：`client.js:890-899` 在 `hasScopes=false` 且 `kind==='reuse'` 时不走任何特例，落到 `ct && ct.name ? … : []` → 空 → `toolText = t.noCommandTool`。「由其它插件提供」和「没探测到」是两句互斥的话。

**修法**：`kind==='reuse'` 时 `toolText` 用 `ct.hostName || unrestrictable[0] || t.reuseByOther`，或干脆把命令行第二段改成「工具名未知（由其它插件提供）」；备注里不要提 `envd_shell`。

### d) `confined` 三态为 `null` 且 `kind='host'` 会不会被误画成「未接管」 —— **会；10:10 的补丁只修了 `confined===true` 的全量场景**

- 已修：全 host 且 **全部** `confined===true` → `'sandbox'`（`client.js:850-855`，probe2 1.1 聚合 ✅）。
- 未修 1：`confined===null`（策略未知）→ `'host'` → **「未接管」**，与同屏备注「沙箱策略未知，按有围栏保守处理」打架（probe3 4.1）。规格 §4.1 判据 1 / §4.3 F 明确要求「沙箱 + 策略未知」。
- 未修 2：逐会话行状态词仍是 `scopeKindText(kind)`（`client.js:1084`），host+confined:true 的行写「未接管」（probe2 1.1）——**聚合说沙箱、行说未接管**。
- 未修 3：部分围栏（混合 true/false）→ `'host'` → 未接管。

裁决：**d 仍成立（部分）**，按 P1-2 的整体修法解决，别再打单个 case 的补丁。

---

## 4. 状态推导矩阵（实测）

| 载荷 | 期望（规格） | 实际 badge | 实际工具名 | 结论 |
|---|---|---|---|---|
| 旧版 + unrestrictable（现网） | 让路 | warn 工具并存 | envd_shell · ops_bash | ❌ P1-1 |
| 旧版 + 无 unrestrictable | 接管中 | ok 接管中 | envd_shell | ✅ |
| 旧版 + `visible:false` + `sandbox:false` + `denies:['pwsh']` | 无命令工具（真故障） | bad 无命令工具 | envd_shell | ⚠ 工具名列与状态矛盾（P2-4） |
| 旧版 + `visible:false` + `sandbox:true` | 沙箱 | muted 沙箱 | envd_shell | ⚠ 同上 |
| 旧版 + `takeover:false` + 无 unrestrictable | 未接管 | muted 未接管 | envd_shell | ✅（按规格 §3.3.2 用 ct.name） |
| 新 API 全 takeover | 接管中 | ok 接管中 | envd_shell | ✅ |
| 新 API 全 yield | 让路 | warn 让路 | ops_bash | ✅ |
| 新 API 全 sandbox-host | 沙箱 | muted 沙箱 | 宿主名 | ✅（但点色 warn，见 P2-8） |
| 新 API 全 host + `confined:false` | 未接管 | muted 未接管 | 宿主名 | ✅ |
| 新 API 全 host + `confined:true` | 沙箱 | muted 沙箱 | 宿主名 | ✅ 聚合 / ❌ 行（P1-2） |
| 新 API 全 host + `confined:null` | 沙箱 + 策略未知 | muted 未接管 | 宿主名 | ❌ P1-2 |
| 新 API takeover + sandbox-host | 混合 | warn「N 个会话未接管」 | 两个都列 | ⚠ 词错（P1-5） |
| 新 API host + sandbox-host | 沙箱/混合 | warn **让路** | 两个都列 | ❌ 见 P2-9 |
| 新 API 全 takeover + 全局 unrestrictable | 接管中 + warn 备注 | ok 接管中 | envd_shell | ✅（备注见 P1-1 同源风险） |
| 新 API 零会话 + unrestrictable | 接管中/无会话 | warn 工具并存 | envd_shell · ops_bash | ❌ 零会话说「并存」（P2-6） |
| 新 API 零会话 + 无 unrestrictable | 接管中 | ok 接管中 | envd_shell | ✅ |

补充：**host + sandbox-host 混合**（probe1 C3）落 `'yield'`——`nonTakeover` 既不是全 host 也不是全 sandbox-host → 走 `'yield'` 兜底，badge 写「让路」，而同一行写「1 未接管 · 1 沙箱」，**没有任何会话在让路**。规格 §4.2 的聚合优先级要求「有沙箱 → 沙箱」（这里应落沙箱），且 `'yield'` 只应在真的存在 `kind==='yield'` 时出现。

---

## 5. P2 清单（体验 / 健壮性 / 规范偏差）

> 每条都给了复现探针；行号对应 md5 `ba891eb7`。

### 5-1 两颗粒子，同文案（规格 §1.2#3 / §3.3.2 / 反模式 #2）

- 实测 probe4 5.1：`.envd-badge` = 1、`.envd-statuschip` = 1、**文本完全相同**（如都写「工具并存」）。
- `.envd-badge,.envd-statuschip` 共享同一条胶囊样式（`client.js:317-322`）→ 视觉上就是两颗一样的丸子；规格要求「胶囊总数 = 1，卡内状态词用『点 + 文字』」。
- 建议：卡内 `.envd-statuschip` 改为 `.envd-state`（点 + 12px 文字，无背景/圆角），或去掉头部 badge 只留卡内。二选一，**待 Lead 裁决**（测试 542 现在冻结的是「两处同文」）。

### 5-2 `<560px` 网格：版本号与动作按钮抢同一个 grid 单元

```
client.js:470  .envd-trow{...grid-template-areas:"g n a" "v v v"}
client.js:471  .envd-tgroup{grid-area:g}.envd-tname{grid-area:n}.envd-tver{grid-area:a}
client.js:473  .envd-tact{grid-area:a}
```

`.envd-tver` 与 `.envd-tact` 都 `grid-area:a` → 窄屏（<560px，笔记本分栏/小窗）第 1 行第 3 格会**叠字**：版本号（如 `v24.18.0`）和「2 个版本 ▾ / 移除」按钮重叠。
建议：`grid-template-areas:"g n v" "p p a"`（版本第三列、路径第二行跨列、动作第二行右对齐），或直接把 `.envd-tver` 挪到第二行左侧。
测试没有窄屏断言（17 条溢出断言只查宽屏 CSS 声明），所以 194 条全绿也发现不了。

### 5-3 旧版备注常显橙色 ⚠（规格 §11#9 明确禁止）

`client.js:914` 给「接口是旧版构建…」`tone:'warn'` → 常显橙色 ⚠ + 备注区第一行。规格原话：「不要把『旧版构建』做成橙色警告占位：兼容分支只给一行 muted 文本」。现网每次打开都中，叠上 P1-1 的 warn 就是**两条橙字**。

### 5-4 `broken` 终局在 `denies` 为空时也说「已遮挡（无）」，且红报「无命令工具」

probe2 3.1（`visible:false, sandbox:false, denies:[]`）：

```
badge = bad / 无命令工具
tool  = envd_shell
note  = ⛔ envd_shell 不可见，已遮挡 （无）
```

`client.js:913`：`denies.length ? denies.join(', ') : t.noneLabel`。`denies` 为空 = EnvDock 一个宿主工具都没挡 → 模型手里（几乎必然）还有宿主 shell，却被红报「无命令工具」；备注还渲染出「已遮挡（无）」这种崩坏句。
可达条件：旧构建 + 无沙箱能力执行器（`sandbox:false`）+ EnvDock 不注册自己的工具（如「只给简报」）。建议：`denies.length === 0` 时不要判 `broken`（用 `host`/未知），或文案改成「envd_shell 不可见；未遮挡任何宿主工具」。

### 5-5 `reuse` 无工具名 → 「由其它插件提供」+「没探测到命令工具」

见 §3-c。行号 `client.js:890-899`。

### 5-6 `commandTool = {}`（旧状态文件/半截载荷）→ 「未接管」+「没探测到命令工具」

probe1 B3：`ct` 是真值 → 跳过 `'none'` 分支 → 一路落到 `'host'`。`client.js:840-873` + `896-899`。建议：`!ct.name && !ct.takeover` 时归 `'none'`。

### 5-7 零会话 + `unrestrictable` → 「工具并存」+「当前无会话」

probe1 C8（`scopes: []`、`unrestrictable:['ops_bash']`）。两个工具「并存」的前提是有会话，零会话时这句没有主语。建议：`hasScopeField && !hasScopes` 时不走 conflict 分支，或备注改成「全局有挡不掉的宿主工具（当前无会话）」。

### 5-8 沙箱会话点色是黄色 warn（规格要求 business 蓝）

`scopeTone`（`client.js:604-607`）：host → `idle`，其余非 takeover → `warn`；CSS 只有 `.envd-sdot.ok/.warn/.idle/.bad`（`client.js:364-368`），**没有 `.info` / `business-primary`**（`grep business-primary client.js` = 0 处）。probe3 2.1 的第 3 行：`"dot":"envd-sdot warn"`。
规格 §4.2「沙箱蓝的理由」：沙箱是设计行为，不能与「让路」同黄。建议：加 `.envd-sdot.info{background:var(--dsw-alias-state-business-primary)}`，`scopeTone` 对 sandbox 返回 `'info'`。

### 5-9 未知/缺失 `kind` → 「让路」+ 会话计数尾随 ` · `

probe1 C6（`kind:'conflict'` 与 `kind:''`）/ C7（无 kind）：

```
badge = warn / 让路
subs  = "2 个会话 ·"        ← 尾随分隔符，没有任何分项
```

`client.js:821-822` 只统计 4 个已知 kind；`client.js:909` 无条件拼 `' · ' + sessionBits.join(' · ')`。
建议：`kindCount` 加 `unknown` 桶（或让未知 kind 计入 `'host'`），并把 §909 改成 `[总句, ...bits].filter(Boolean).join(' · ')`。

### 5-10 非数组脏值会**抛错**（P0 级但当前宿主恒发数组）

probe1 D1-D3：

```
D1 tools 非数组      → CRASH: tools is not iterable        (client.js:1134)
D2 issues 非数组     → CRASH: issues.some is not a function (client.js:1257)
D3 terminals 非数组  → CRASH: terminals.filter is not a function (client.js:982)
```

（`data.versionManagers` 非数组会在 `client.js:1198` 同类抛错。）
当前 `index.js` 恒发数组，所以只在「浏览器缓存了旧 client + 宿主换了版本」或状态文件损坏时可达——但面板白屏就是白屏。建议：入口统一 `const arr = Array.isArray(x) ? x : []`。
其余脏值都是**安全**的（`ct.scopes` 非数组 → 走旧版、`denies/unrestrictable/runtimeShellTools` 都有 `Array.isArray` 守卫、`state/platform/shell` 缺失都不崩）。

### 5-11 工具既无版本也无路径 → 行内「未知版本未知版本」

probe5 1.1：`["运行时Weird未知版本未知版本"]`。
`client.js:1153`（版本列）与 `client.js:1156`（路径列）都用 `t.versionUnknown`。建议：路径列缺失时显示 `—` 或 `t.pathMissing`，别重复同一个词。

### 5-12 `versions` 项缺 `path` → 空白路径 + `setTool` 传 null

probe2 6.1：`["v24设为默认","v20设为默认"]`（第二行路径空白），`post({op:'setTool', key, path: null})` 会被宿主 `index.js` 的 `String(body.path||'')` 吃成「清空选择」；同时 `key: v.path` 为 undefined 会触发 React 重复 key 警告。建议：`versions.filter(v => v && v.path)`。

### 5-13 复制失败提示无关闭、常驻；连续复制互相打断

- 失败：`client.js:792` `setCopyNote(t.copyFailed)`，渲染在 `client.js:1464`，**没有任何消失路径**（成功才清）。probe2 8.1：两次重渲染后仍在，`hasDismiss:0`。
- 成功：`copied` 是单槽 + 1400ms 定时器（`client.js:764/767`），1.4s 内复制第二项会被第一项的定时器提前清掉 ✓ 反馈。
建议：失败提示同样挂 1.4s 或加「知道了」；`copied` 改成 `Map<tag, timer>` 或直接复用同一超时。

### 5-14 没有沙箱能力时仍显示「沙箱下接管」设置（死开关）

probe4 6.1：`sandbox.capable:false` 时设置里仍有 `[委托执行, 直接拒绝]`。规格 §3.3.1 要求 `capable === true` 才渲染。测试 3 反而冻结了「不按 capable 隐藏」。**待 Lead 裁决**；若保留，至少加一句 title 说明「本机执行器不支持沙箱」。

### 5-15 语言切换会触发一次额外 GET

probe3 5.1：`fetchBefore=1 → fetchAfter=2`。原因：`fetchState` 的依赖里有 `t`（`client.js:712`），切语言 → 回调换身份 → `useEffect(load)` 重跑 → 非静默 GET（会把按钮切到「探测中…」，失败还会弹错）。
建议：把 `t` 从 `fetchState` 依赖里拿掉（错误文案在渲染层翻译，或用 ref 存字典）。

### 5-16 `hasSubprocess === false` 用红框（规格 §3.4 要求单行 note）

probe4 4.1：`redBox:true`、文案「宿主没有 subprocess 服务，版本探测会缺失」。`client.js:1345`。规格原话：「一行 `.envd-note`（warn 色，单行）……**不再用红框**」。红框是「读取失败/操作失败」专用的整块错误语言，用在这里会降低真错误的辨识度。

### 5-17 可访问性：`aria-controls` / `type="button"` 全缺，详情摘要 hover-only

- `grep aria-controls client.js` = **0 处**；规格 §8#2 要求 6 个折叠点都有 `id` + `aria-controls`（`envd-problems` / `envd-settings` / `envd-scope-rows` / `envd-termchips` / `envd-brief` / `envd-diag`）。当前只有 `aria-expanded`（`client.js:1359/1360/1361` 等）——读屏知道「展开了」，不知道「展开了什么」。
- `type: 'button'` = **0 处**（规格 §8#1）。现在没有 `<form>` 所以不会误提交，但语义上仍建议补。
- 「详情」按钮的摘要只放在 `title`（`client.js:1361` `title: diagSummary`），probe4 7.1：可见文本只有「详情」，`title="对账正常"`。规格 §8#7 / 反模式 #5 明令「状态、原因、计数结论必须有可见文本；hover-only 是反模式」。建议：按钮后缀可见小字（`详情 · 对账正常` / `详情 · 2 个会话异常`）。
- 做得对的：`role=status` + `aria-live=polite` 的复制反馈（`client.js:1464`）；两个 `role=alert` 错误框（`client.js:1310/1336`）；chips/switch 的 `aria-pressed`；状态色都伴随文字（点色不单独表意）。

### 5-18 i18n 细节

- `statusMixed`: zh「{n} 个会话未接管」/ en「Host tool in {n}」——英文不成句（"Host tool in 1"），且与 P1-5 同一个语义错。
- 英文无单复数：`nSessions: '{n} sessions'`、`noteSandbox: '{n} sessions confined; host tools kept'` → **"1 sessions"**（probe3/5 实测）。
- `scopeAnomalyLeak: 'host {tools} still visible'`（`client.js:217`）句首小写，拼进 `.envd-sreason` 后不是独立句，但作为行尾原因读起来别扭。
- 其余中英成对、无中文泄漏（`i18n-check` 全绿）；`{n}`/`{names}` 占位符成对；无 `undefined`/`NaN`/`null` 文本（30 组载荷 `badWords: []`）。

### 5-19 环境检查：`info` 级 issue 也染成 warn「⚠ N 项」

probe4 2.1：`issues:[{level:'info'}]` → `envd-flag warn` + `⚠ 1 项`。`client.js:1257` 只区分 `error`，其余一律 warn。建议 info 用中性色（或干脆不算「警告」）。

### 5-20 零工具 + 健康「✓ 通过」同屏

probe4 3.1：`.envd-empty`「PATH 上没扫到 node / python / git」+ 健康行「✓ 通过」。两句话不冲突（一个说没扫到、一个说环境检查没问题），但读者观感是「全坏却通过」。建议 `tools.length === 0` 时健康行给「未探测到工具链」而不是「通过」。

### 5-21 规格偏差（规格滞后还是实现漏项，**待 Lead 裁决**）

| 规格条款 | 要求 | 实现 |
|---|---|---|
| §1.2#3 / §3.3.2 | 胶囊 = 1；状态词「点 + 文字」 | 卡内 `.envd-statuschip` 仍是胶囊 → §5-1 |
| §4.2 | 沙箱用 business 蓝 | 无 `.info`/business-primary → §5-8 |
| §3.1 | 头部 `.envd-sys` = `{os} {release} · {arch}` | 无 `.envd-sys`；`platform.os/release` 从未显示，footer 用的是 `version/arch/host`（`client.js:1432`） |
| §3.3.2 | 状态行含 `.envd-exec` 执行器 | 只在「详情」title 里（`client.js:958` 附近） |
| §1.2#4 | 「有问题也不自动展开」 | 实现（和测试 4）明确要求异常自动展开 → 规格与测试互相矛盾 |
| §2.3 | 终端 chips 折叠 | 常显（`client.js:1349`，chips 由 `client.js:982` 过滤 wsl 后渲染）；文件头注释也自认「终端选择是面板的主操作，常显」→ 有意为之 |
| §3.4 | `hasSubprocess===false` 一行 note | 红框 → §5-16 |
| §8#2 / #1 | `aria-controls` / `type="button"` | 0 处 → §5-17 |
| §9.4 N3 | 头部 `.envd-sys` 存在且含 `os` | 不存在 |

---

## 6. 布局 / 溢出

| 检查 | 结论 |
|---|---|
| `.envd-trow` 五列（`client.js:400`）宽屏 | ✅ 列宽 `62 / minmax(64,84) / 96 / minmax(0,1fr) / auto`，路径列可收缩 + `.envd-tpath` ellipsis（`client.js:405`）+ `title` 全路径；长工具名由 `.envd-tname` ellipsis。 |
| `<560px` | ❌ `.envd-tver` 与 `.envd-tact` 同 `grid-area:a` 叠字（§5-2）。 |
| `.envd-sreason` / `.envd-tool` / `.envd-sub` | ✅ 三者都 `min-width:0` + `overflow:hidden` + `text-overflow:ellipsis` + `white-space:nowrap`；`.envd-srow`/`.envd-row` 都 `flex-wrap:wrap`，长原因会折到第二行右对齐（`margin-left:auto`）。 |
| ghost 按钮挤压 | ✅ 命令行 `.envd-row` 可换行；`.envd-grow` 兜住空白。3 个 ghost（会话/设置/详情）在 560px 会折行，不溢出。 |
| 空态 | ✅：`tools/managers` 都空 → `.envd-empty`；`scopes: []` → 「当前无会话」；无终端 → 终端行只剩 `自动` + `＋`（没有「未探测到终端」提示，规格 §3.3.4 要求 `.envd-muted 未探测到终端`，属小缺口）。 |
| 一屏高度 | ⚠ **无法在本环境测量**（测试替身没有 layout）。按代码估算：现网 7 个工具 + 2 个管理器 + 2 条 warn 备注 + 健康 folded，卡片 2 行 + 备注 2 行，工具链 11 行 + 标题 + 简报 1 行 + 底栏，1280×720 大概率仍在 600px 内，但需要真机截图复核。 |

---

## 7. 交互

| 交互 | 结论 |
|---|---|
| 设置/会话/详情 开关组合 | ✅ 三个独立 state，互不影响；卡内 `.envd-row` 顺序保证 `cmdRow` 恒为第 2 行（测试依赖）。 |
| 异常自动展开 + 收起 | ✅ 三态，见 §3-a。 |
| 轮询回来 scopes 变化 | ✅ 不重置用户选择（设计如此）。payload 去重会剔除 `ticks/steadyTicks/...`（`client.js:488`），实测 15s 轮询不抖动。 |
| 复制反馈 | ✅ 成功 `✓ 已复制` + `role=status` 播报；`navigator.clipboard` → `execCommand` 两级兜底；失败有可见提示。⚠ 失败提示不消失、单槽互相打断（§5-13）。 |
| 切语言 | ⚠ 触发一次额外 GET（§5-15）；词条随 `t` 即时切换，无中文泄漏。 |
| 手动刷新失败 | ❌ 静默（P1-4）。 |
| 操作失败（POST） | ✅ 独立 `opError` 通道 + `role=alert` + 可关闭，且 `!data` 时也可见（403 场景）。 |
| 重新探测按钮 | `disabled={busy}` ✅；`busy` 是计数不是布尔 ✅。 |

---

## 8. 可访问性小结

- ✅ 状态不单靠颜色：badge/状态词/会话行都有文字；点色只是辅助。
- ✅ `role=status`/`aria-live=polite` 只在复制反馈；`role=alert` 只在两个错误框；面板整体无 `aria-live`（符合「别让 15s 轮询刷爆读屏」）。
- ✅ chips/switch 有 `aria-pressed`；`.envd-btn:focus-visible` 统一 2px 品牌色外环；所有可点元素是 `<button>`。
- ❌ `aria-controls` 全缺；`type="button"` 全缺；「详情」结论 hover-only（§5-17）。
- ⚠ `.envd-sreason` 只有 `title` 与可见文本同值（可接受）；`.envd-sid` 无 `title` 也是 P1-3 的一部分。

---

## 9. 为什么 194 条断言没抓到这些

1. **假 session id**：测试用 `'aaaa1111bbbbcccc'`，掩盖了 `slice(0,8)` 对真实 `session-<uuid>` 的截断（P1-3）。
2. **旧版用例只测了 `unrestrictable: []`**（测试 7），恰好避开现网唯一的真实形态 `unrestrictable: ['ops_bash']`（P1-1）。
3. **没有「有数据后刷新失败」用例**（测试 22 只测首屏 403）（P1-4）。
4. **scopeFact 默认 `confined:false`**，没有 `host + confined:null` 的聚合用例，也没有「部分围栏」用例（P1-2）。
5. **混合用例只覆盖 `takeover + sandbox-host`**，没覆盖 `host + sandbox-host`（§4 矩阵末尾）。
6. **没有窄屏断言**（17 组只查宽屏 CSS 声明）（§5-2）。
7. **没有「真实 `session-` 前缀」与「多会话同名显示」的可读性断言**。
8. 测试 542 把「badge 与 statuschip 同文」冻结成了契约，等于把规格 §1.2#3 的违反写进了回归（§5-1）。

---

## 10. 未验证 / 待 Lead 裁决

1. **一屏高度**：本环境无法量 layout（替身无 CSS），需要真机 1280×720 截图（浅/深色各一张）复核 §6 的估算。
2. **胶囊只留一颗** vs 现在「两处同文」：改哪边（去掉头部 badge / 把卡内 chip 降级成点+文字）需要产品裁决，因为测试已冻结现状。
3. **规格与实现的 5 处分叉**（自动展开、终端常显、`.envd-sys`、`.envd-exec`、`aria-controls`）：是「规格该更新」还是「实现漏了」，见 §5-21。
4. **旧版 API 的「让路 vs 并存」**：P1-1 的修法会改变 badge 语义（warn 让路 → 仍是 warn，但文案/工具名变），需要确认与 `docs/DESIGN.md` 的旧版兼容口径一致后再改。
5. 审校期间 `client.js` 被并发修改（1491 → 1497 行）。若还有未落地的补丁，请对本报告逐条做一次「是否已修」复核。

---

## 11. 给实现者的最小改动清单（按性价比排序）

1. `client.js:1084` 会话 id：去 `session-` 前缀再截 8 位 + `title` 全 id。（5 行内，P1-3）
2. `client.js:865-873` 旧版分支：`unrestrictable.length` 时判 `'yield'`，工具名只报宿主名，备注用「已让路」。（P1-1，现网）
3. 抽 `sessionState(sc)`（规格 §4.1 伪码原样），聚合与行状态词共用；`confined !== false` 一律沙箱。（P1-2）
4. `client.js:1310` 附近补 `error && data` 的可见反馈（一条 note 即可）。（P1-4）
5. `client.js:60/193` 改 `statusMixed` 文案为「{n} 个会话用宿主工具」。（P1-5）
6. `client.js:470-473` 窄屏网格拆开 `tver` / `tact`。（§5-2）
7. `client.js:909` 会话计数 `[...].filter(Boolean).join(' · ')`；`kindCount` 加 unknown。（§5-9）
8. `scopeTone` + CSS 增加 `.info` / `business-primary`（§5-8）。
9. 入口 `Array.isArray` 归一化 `tools/issues/terminals/versionManagers`（§5-10）。
10. 六个折叠点补 `id` + `aria-controls`，详情摘要出 title 上屏（§5-17）。

---

## 12. 附录：临时探针与用例

| 文件（`.envdock-verify/work/`，未进仓库） | 覆盖 |
|---|---|
| `r2-probe.mjs` | 30 组载荷矩阵：旧版 7 组、reuse/空 ct 5 组、新 API 9 组、脏值/403 9 组；输出存在 `r2-probe.json` |
| `r2-probe2.mjs` | 逐会话行（host+confined true/null）、`visible:false+denies:[]`、静默刷新失败、会话三态、versions 缺 path、窄屏 CSS、复制失败常驻 |
| `r2-probe3.mjs` | 真实 `api1.json` / simulate 载荷：新旧 API 同事实对比、混合形态、只给简报、策略未知、切语言额外 GET |
| `r2-probe4.mjs` | 真实 `session-<uuid>` id、info 级 issue、零工具+健康、`hasSubprocess` 红框、胶囊计数、capable:false 设置项、详情 hover-only |
| `r2-probe5.mjs` | 无版本无路径的工具行、健康行、`shell:null` headline、EN 混合状态词 |
| `r2-snapshot-client.js` | 审校快照（md5 `ba891eb7…`，1497 行），后续复核以此为基线 |

---

> **一句话结论**：折叠与开关骨架已经站住了，但「状态词」这一层还有五处会把用户往反方向带——最要紧的是**旧版 API 把稳态让路说成并存**（现网即中）和**会话 id 全成了 `session-`**（上线即中）；`confined` 三态请按规格的 `sessionState()` 一次做对，不要再按 case 打补丁。
