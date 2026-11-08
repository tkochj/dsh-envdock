/**
 * EnvDock Host 半边的本地运行时夹具(开发用,不随包发布)。
 *
 * 目的:在没有 dsh 宿主的情况下,用一套最小的 Cordis 服务替身把 index.js 的
 * apply() 真正跑起来,从而:
 *   · 计时探测各阶段(哪一步慢)
 *   · 走一遍 /envdock-api 的所有 op(含畸形输入)
 *   · 走一遍 envd 工具的所有 action
 *   · 断言 0.6「两族」模型:按会话选语法族 + bash 族会话遮挡 PowerShell 族内置命令工具
 *     + 增补 envd_shell(docs/notes/assist-model.md)
 *   · 断言快照/简报/健康检查的基本形状
 *
 * 0.6 推翻了 0.5 的「restrict 恒为 0 / guard 一次都不注册」,换成这五条硬不变量
 * (文件末尾按夹具逐个核对):
 *   ① bash 族名字永不进任何 deny / refuse 集合(遮挡只针对 PowerShell 族内置名);
 *   ② `tools.restrict` 只在 agent 作用域调用,根层调用必须抛错;
 *   ③ 稳态 10 次对账的 restrict 调用不超过 1 次(不反复拆建遮挡);
 *   ④ 关掉遮挡开关后一个对账周期内 deny 全清;
 *   ⑤ 插件卸载 / agent 销毁后 deny 全清。
 *
 * 两族用例在 §5(编号与规划 §5 一一对应,test name 里带编号方便核对)。
 *
 * 状态文件写在临时 DSH_HOME 里,绝不碰用户真实的 ~/.dsh/envdock.json。
 * subprocess 用固定输出的替身(本机沙箱不允许 Node 用管道 stdio 起子进程),
 * 因此每次探测发起几次子进程是可数的 —— 版本缓存的收益也能被断言。
 *
 * 跑法: node test/host-harness.mjs [--timing]
 *
 * 夹具(假 Cordis 宿主 + 服务替身)全部来自 test/fixture/host.mjs:
 * 本文件只保留断言与主流程,新增用例请复用 buildHost()/makeHarness(),不要再造第二份。
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// 假 Cordis 宿主 / 服务替身 / 断言解码器:全部来自共享夹具(见文首)。
import {
  makeHarness,
  fakeSandboxPolicy,
  fakeSandboxedShell,
  callApi,
  post,
  pollSnapshot,
  freshDetection,
  waitForBrief,
  isReg,
  isVersion,
  decodeBashPayload,
  withPath,
  makeStubBin,
  home,
} from './fixture/host.mjs'

const args = new Set(process.argv.slice(2))
const TIMING = args.has('--timing') || args.has('--verbose')

const failures = []
const skips = []
/** 断言总数(--summary / 汇报用) */
let checks = 0
const t0 = Date.now()
let last = Date.now()
function phase(name) {
  const now = Date.now()
  if (TIMING) console.log(String(now - last).padStart(7) + ' ms  ' + name)
  last = now
}
function check(name, cond, detail) {
  checks++
  if (cond) {
    console.log('ok   ' + name)
  } else {
    failures.push(name + (detail ? ' → ' + detail : ''))
    console.log('FAIL ' + name + (detail ? ' → ' + detail : ''))
  }
}
/** 本机环境不满足(没有该终端等)时明确 SKIP,不伪造 ok。 */
function skip(name, reason) {
  skips.push(name + (reason ? ' → ' + reason : ''))
  console.log('SKIP ' + name + (reason ? ' → ' + reason : ''))
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** 全部夹具登记在这里:收尾时逐个卸载并核对硬不变量。 */
const fixtures = []
/** 起一个夹具并 apply(自动登记,收尾统一卸载)。 */
function start(options = {}, config = {}) {
  const h = makeHarness(options)
  fixtures.push(h)
  mod.apply(h.ctx, config)
  return h
}
const snapshot = async (h) => (await callApi(h)).json
/** 等 commandTool 满足条件:注册/拆除都是 tick 驱动的,断言必须等事实落地。 */
const waitCommandTool = (h, pred, timeoutMs = 9000) =>
  pollSnapshot(h, (snap) => Boolean(snap && snap.commandTool) && pred(snap.commandTool, snap), timeoutMs)
/** 把共享状态文件复位成默认(auto 终端 / 简报开 / 局域网关 / 两族遮挡开)。 */
async function resetState(h) {
  await post(h, { op: 'setShell', key: 'auto' })
  await post(h, { op: 'setOption', injectBrief: true, allowLan: false, blockOtherFamily: true })
}
/** envd_shell 的 argv 必须按**当前语法族**的语法生成。 */
function invocationLooksRight(family, argv, line) {
  const args0 = Array.isArray(argv) ? argv.map(String) : []
  if (!args0.length) return false
  if (family === 'bash') return args0.includes('-lc') && args0[args0.length - 1] === line
  if (family === 'cmd') return args0.includes('/c') && args0[args0.length - 1] === line
  if (family === 'wsl') return args0.includes('bash') && args0.includes('-lc') && args0[args0.length - 1] === line
  if (family === 'custom') return args0[args0.length - 1] === line && args0.some((a) => a.includes('-c') || a.includes('{command}'))
  // powershell / pwsh
  return args0.includes('-NoLogo') && args0.includes('-Command') && args0[args0.length - 1] === line
}

// ── 两族(0.6)断言小工具 ──
/**
 * 名字属于哪一族:直接用 index.js 的纯函数,口径与实现完全一致
 * (测试没导出时退回内置名单 + 名字 token 兜底,免得纯函数还没落地就整片红)。
 */
const groupOf = (name) => {
  if (typeof mod.shellToolGroup === 'function') return mod.shellToolGroup(name)
  const lower = String(name || '').toLowerCase()
  const builtin = { pwsh: 'powershell', powershell: 'powershell', cmd: 'cmd', bash: 'bash', sh: 'bash', zsh: 'bash', fish: 'bash', ops_bash: 'bash', wsl: 'wsl' }
  return builtin[lower] || ''
}
/** 一个名字列表里所有 bash 族名字(硬不变量 ①:这个列表必须永远为空)。 */
const bashNamesIn = (list) => (Array.isArray(list) ? list : []).filter((name) => groupOf(name) === 'bash' || /bash/i.test(String(name)))
/** 某个夹具此刻还生效的遮挡(展开成名字列表)。 */
const deniedIn = (h) => Object.values(h.stats().activeDenies || {}).flat()
/** 某个夹具发生过的 restrict 尝试里出现过的名字。 */
const restrictedIn = (h) => h.stats().restrictAttempts.flatMap((attempt) => attempt.deny)
/** 夹具里某个 agent 的 id(按位置取,测两族够用)。 */
const agentById = (h, id) => h.state.agents.find((agent) => agent.id === id) || h.state.agents[0]
/** 快照里有没有某族终端(用例会按本机环境 SKIP,不伪造 ok)。 */
const hasTerminalFamily = (snap, family) => ((snap && snap.terminals) || []).some((t) => t.family === family)
/** 两族快照登记处:收尾时统一核对「任何场景 hide/refuse 都不含 bash 族名字」。 */
const familySnapshots = []
const recordFamilySnap = (label, snap) => {
  if (snap && snap.commandTool) familySnapshots.push({ label, commandTool: snap.commandTool })
  return snap
}

// ───────────────────────────────────────────── 主流程 ──
const mod = await import('../index.js')
const { apply, inject } = mod
check('export: apply 是函数', typeof apply === 'function')
check('export: inject 声明了 tools', Array.isArray(inject) && inject.includes('tools'))

const h = start()
await waitForBrief(h)
phase('首次探测(等待简报)')

check('systemPrompt.context 已注册', Boolean(h.state.brief) && typeof h.state.brief.text === 'function')
check('/envdock-api 路由已注册', h.webRoutes.length === 1 && h.webRoutes[0].path === '/envdock-api')

const briefText = await waitForBrief(h)
check('简报包含系统行', /系统: .*Windows/.test(briefText), briefText.slice(0, 120))
check('简报包含默认终端', briefText.includes('默认终端'))
check('简报包含 envd 提示', briefText.includes('envd'))
check('简报包含 Node 版本', /Node\.js v24\.18\.0/.test(briefText), briefText.split('\n').find((l) => l.includes('Node')) || '')
check(
  '简报最后一行:envd 只能解析上面已探测到的工具',
  briefText.split('\n').slice(-1)[0].includes('只能解析上面已探测到的工具'),
  briefText.split('\n').slice(-1)[0],
)

// GET 快照
const coldSpawns = h.subprocess.calls.length
const got = await callApi(h)
phase('GET /envdock-api')
check('GET 200', got.status === 200)
check('GET ok', got.json && got.json.ok === true)
check('GET 无额外子进程(缓存命中)', h.subprocess.calls.length === coldSpawns, String(h.subprocess.calls.length - coldSpawns))
check('GET 有 tools 数组', Array.isArray(got.json.tools))
check('GET 有 terminals 数组', Array.isArray(got.json.terminals))
check('GET hasSubprocess', got.json.hasSubprocess === true)
check('GET brief 非空', typeof got.json.brief === 'string' && got.json.brief.length > 50)
check('GET commandTool.name 固定为 envd_shell', got.json.commandTool && got.json.commandTool.name === 'envd_shell', String(got.json.commandTool && got.json.commandTool.name))
check(
  'GET commandTool 有 registered / visible / skipReason',
  got.json.commandTool &&
    typeof got.json.commandTool.registered === 'boolean' &&
    typeof got.json.commandTool.visible === 'boolean' &&
    ['string', 'object'].includes(typeof got.json.commandTool.skipReason),
  JSON.stringify(got.json.commandTool),
)
const toolKeys = got.json.tools.map((x) => x.key)
check('GET 扫到 node', toolKeys.includes('node'), toolKeys.join(','))
const node = got.json.tools.find((x) => x.key === 'node')
check('GET node 有版本', node && node.defaultVersion === '24.18.0', node && node.defaultVersion)
const py = got.json.tools.find((x) => x.key === 'python')
check('GET python 版本', py && py.defaultVersion === '3.12.10', py && py.defaultVersion)
const gitTool = got.json.tools.find((x) => x.key === 'git')
check('GET git 版本', gitTool && gitTool.defaultVersion === '2.55.0', gitTool && gitTool.defaultVersion)
const ps = got.json.terminals.find((t) => t.key === 'powershell')
check('GET PowerShell 终端版本', ps && ps.version === '5.1.26100', ps && ps.version)
check('GET pathInfo.missingCount 存在', typeof got.json.pathInfo.missingCount === 'number', JSON.stringify(got.json.pathInfo))
check('GET pathInfo 说明 PATH 来源', got.json.pathInfo.source === 'system' || got.json.pathInfo.source === 'process', JSON.stringify(got.json.pathInfo))

// 刷新:force = 用户点了「重新探测」→ 必须重跑版本探测(versionCache 被清空,不再信 mtime 判断的旧版本号),
// 并且 PATH 一定重新问系统要(reg.exe ×2:机器级 + 用户级),否则「重新探测」等于没探测。
let before = h.subprocess.calls.length
const refreshed = await post(h, { op: 'refresh' })
const refreshAll = h.subprocess.calls.slice(before)
const refreshCalls = refreshAll.filter((c) => !isReg(c))
const refreshReg = refreshAll.filter(isReg)
phase('POST refresh(新增子进程 ' + refreshAll.length + ')')
check('refresh 200', refreshed.status === 200 && refreshed.json.ok === true)
check('refresh 重新读了系统 PATH(机器级 + 用户级)', refreshReg.length === 2, refreshReg.map((c) => c.argv.join(' ')).join(' | '))
check('refresh 重跑了版本探测(force 清 versionCache)', refreshCalls.length >= 5, String(refreshCalls.length))
check(
  'refresh 的调用都是版本探测(或 py -0p 启动器清单)',
  refreshCalls.every((c) => isVersion(c) || (c.argv || [])[1] === '-0p'),
  refreshCalls.filter((c) => !isVersion(c) && (c.argv || [])[1] !== '-0p').map((c) => c.argv.join(' ')).join(' | '),
)
const againBefore = h.subprocess.calls.length
await post(h, { op: 'refresh' })
const againCalls = h.subprocess.calls.slice(againBefore).filter((c) => !isReg(c))
check('再次 refresh 仍然重跑版本探测(缓存没有被偷偷复用)', againCalls.length >= 5, String(againCalls.length))

// 并发冷启动只探测一次
const h4 = start()
await freshDetection(h4)
await Promise.all([callApi(h4), callApi(h4), callApi(h4)])
const unique = new Set(h4.subprocess.calls.map((c) => c.argv.join(' ')))
check('并发 GET 只探测一份', h4.subprocess.calls.length === unique.size, h4.subprocess.calls.length + ' 次调用 / ' + unique.size + ' 个唯一命令')

// 畸形 JSON
const badJson = await callApi(h, { method: 'POST', body: '{oops' })
check('畸形 JSON → 400', badJson.status === 400 && badJson.json.ok === false, JSON.stringify(badJson.json))

// 未知 op
const unknownOp = await post(h, { op: 'nope' })
check('未知 op → 400', unknownOp.status === 400)

// 非 loopback 拒绝 / 放行
const lanDenied = await callApi(h, { remoteAddress: '192.168.1.9' })
check('非 loopback GET → 403', lanDenied.status === 403, String(lanDenied.status))
const lanDeniedOp = await post(h, { op: 'refresh' }, { remoteAddress: '192.168.1.9' })
check('非 loopback 的操作 → 403', lanDeniedOp.status === 403, String(lanDeniedOp.status))
// 安全口径:局域网**不能**打开 allowLan(打开只许本机),打开后也只能读;
// 唯一允许的局域网写是「把 allowLan 关掉」,且必须同源。
const lanEnableByLan = await post(h, { op: 'setOption', allowLan: true }, { remoteAddress: '192.168.1.9' })
check('局域网不能打开「允许局域网访问」(只许本机)', lanEnableByLan.status === 403, String(lanEnableByLan.status))
const lanEnableLocal = await post(h, { op: 'setOption', allowLan: true })
check('本机可以打开 allowLan', lanEnableLocal.status === 200 && lanEnableLocal.json.ok === true, String(lanEnableLocal.status))
const lanRead = await callApi(h, { remoteAddress: '192.168.1.9' })
check('打开后局域网 GET 放行(只读)', lanRead.status === 200, String(lanRead.status))
const lanWrite = await post(h, { op: 'setShell', key: 'cmd' }, { remoteAddress: '192.168.1.9' })
check('局域网写操作一律 403(即使 allowLan 打开)', lanWrite.status === 403, String(lanWrite.status))
const lanToggleOffCrossSite = await post(h, { op: 'setOption', allowLan: false }, {
  remoteAddress: '192.168.1.9',
  headers: { origin: 'http://evil.example', host: '192.168.1.9:3080' },
})
check('局域网关 allowLan 必须同源(跨站 Origin 被拒)', lanToggleOffCrossSite.status === 403, String(lanToggleOffCrossSite.status))
const lanToggleOff = await post(h, { op: 'setOption', allowLan: false }, {
  remoteAddress: '192.168.1.9',
  headers: { origin: 'http://192.168.1.9:3080', host: '192.168.1.9:3080' },
})
check('局域网可以关掉 allowLan(同源)', lanToggleOff.status === 200 && lanToggleOff.json.ok === true, String(lanToggleOff.status))
const lanDeniedAgain = await callApi(h, { remoteAddress: '192.168.1.9' })
check('关掉 allowLan 后又拒绝', lanDeniedAgain.status === 403, String(lanDeniedAgain.status))

// setShell 校验
const badShell = await post(h, { op: 'setShell', key: '__nope__' })
check('非法终端名被拒绝', badShell.status === 400 && badShell.json.ok === false, 'status=' + badShell.status)
const badShellState = await callApi(h)
check('非法终端名未写进状态', badShellState.json.state.defaultShell === 'auto', badShellState.json.state.defaultShell)
const customNoShell = await post(h, { op: 'setShell', key: 'custom' })
check('没有自定义终端时选 custom → 400', customNoShell.status === 400, String(customNoShell.status))
const cmdShell = await post(h, { op: 'setShell', key: 'cmd' })
check('setShell cmd → 200', cmdShell.status === 200 && cmdShell.json.ok === true)
await post(h, { op: 'setShell', key: 'auto' })

// setTool:选一个真实候选
const nodeCand = (node.versions || [])[0]
if (nodeCand) {
  const setTool = await post(h, { op: 'setTool', key: 'node', path: nodeCand.path })
  check('setTool 合法路径 200', setTool.status === 200 && setTool.json.ok === true)
  const setToolBad = await post(h, { op: 'setTool', key: 'node', path: 'C:\\nope\\nope.exe' })
  check('setTool 非法路径 400', setToolBad.status === 400)
  const setToolUnknown = await post(h, { op: 'setTool', key: 'nope', path: nodeCand.path })
  check('setTool 未知工具 400', setToolUnknown.status === 400)
  await post(h, { op: 'setTool', key: 'node', path: '' })
}

// 并发 setTool 不能丢更新:两个请求都在 await 探测,写回时若拿旧 state 覆盖就丢一个
const pyCand = (py.versions || [])[0]
if (nodeCand && pyCand) {
  const [rNode, rPy] = await Promise.all([
    post(h, { op: 'setTool', key: 'node', path: nodeCand.path }),
    post(h, { op: 'setTool', key: 'python', path: pyCand.path }),
  ])
  const selAfterConcurrent = (await callApi(h)).json.state.selections || {}
  check(
    '并发 setTool 不丢更新(两个选择都在)',
    rNode.status === 200 && rPy.status === 200 && selAfterConcurrent.node === nodeCand.path && selAfterConcurrent.python === pyCand.path,
    JSON.stringify({ statuses: [rNode.status, rPy.status], selections: selAfterConcurrent }),
  )
  await post(h, { op: 'setTool', key: 'node', path: '' })
  await post(h, { op: 'setTool', key: 'python', path: '' })
} else {
  skip('并发 setTool 不丢更新', '没有可用的 node / python 候选')
}

// API 安全(审校新增):超大 body 必须是 413(不是 ECONNRESET/bad json);Origin 严格回环
const hugeBody = await callApi(h, { method: 'POST', body: 'x'.repeat(1_100_000) })
check('>1MB 请求体 → 413(不是 ECONNRESET / bad json)', hugeBody.status === 413, 'status=' + hugeBody.status + ' raw=' + String(hugeBody.raw).slice(0, 120))
const evilOrigin = await post(h, { op: 'setOption', injectBrief: true }, { headers: { origin: 'http://127.0.0.1.evil.example:3080' } })
check('loopback 但 Origin 是 127.0.0.1.evil.example → 403(严格回环,不做前缀匹配)', evilOrigin.status === 403, String(evilOrigin.status))
const goodOrigin = await post(h, { op: 'setOption', injectBrief: true }, { headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080', 'content-type': 'application/json' } })
check('Origin http://127.0.0.1:3080 → 放行(同源)', goodOrigin.status === 200 && goodOrigin.json.ok === true, String(goodOrigin.status))

// ── 同源校验(Origin / Host / Content-Type / Sec-Fetch-Site)──
// 只判「Origin 是回环字面量」不够:任意 127.0.0.1 端口上的网页都能发免预检的简单 POST,
// 而改默认终端 argv 就等于命令注入。真机语义:Origin 的 host:port 必须与 Host 完全一致,
// 且必须申明 application/json;浏览器一定带 Origin,没 Origin 却带 Sec-Fetch-Site 的不是我们的面板。
const sameHost = { host: '127.0.0.1:3080' }
const otherPort = await post(h, { op: 'setOption', injectBrief: true }, { headers: { ...sameHost, origin: 'http://127.0.0.1:3081', 'content-type': 'application/json' } })
check('回环但端口不同 → 403(同源要求 host:port 完全一致)', otherPort.status === 403, String(otherPort.status))
const plainText = await post(h, { op: 'setOption', injectBrief: true }, { headers: { ...sameHost, origin: 'http://127.0.0.1:3080', 'content-type': 'text/plain' } })
check('同源但 Content-Type 不是 application/json → 403(跨源简单请求免预检)', plainText.status === 403, String(plainText.status))
const noOriginSecFetch = await post(h, { op: 'setOption', injectBrief: true }, { headers: { 'sec-fetch-site': 'same-origin' } })
check('没有 Origin 却带 Sec-Fetch-Site → 403(不是我们的面板)', noOriginSecFetch.status === 403, String(noOriginSecFetch.status))
const crossSite = await post(h, { op: 'setOption', injectBrief: true }, { headers: { 'sec-fetch-site': 'cross-site' } })
check('Sec-Fetch-Site: cross-site → 403', crossSite.status === 403, String(crossSite.status))

// ── DNS rebinding(安全审计 P1)──
// 攻击者的页面把自己的域名重新解析到 127.0.0.1 后,浏览器请求的**来源地址**是回环,
// 而 Host/Origin 都还是攻击者域名 —— 只比较「Origin 与 Host 一致」会把这种请求放行
// (改自定义终端 argv ≈ 本机代码执行)。规则:回环来源必须配回环 Host。
const rebindPost = await post(h, { op: 'setOption', injectBrief: true }, { headers: { host: 'evil.example:3080', origin: 'http://evil.example:3080', 'content-type': 'application/json' } })
check('DNS rebinding 写请求(Host=Origin=evil.example)→ 403', rebindPost.status === 403, String(rebindPost.status))
const rebindGet = await callApi(h, { method: 'GET', headers: { host: 'evil.example:3080' } })
check('DNS rebinding 读请求(只读也含绝对路径)→ 403', rebindGet.status === 403, String(rebindGet.status))
const emptyHost = await callApi(h, { method: 'GET', headers: { host: '' } })
check('回环来源但 Host 为空 → 403(拿不到 Host 不猜)', emptyHost.status === 403, String(emptyHost.status))
const localhostHost = await callApi(h, { method: 'GET', headers: { host: 'localhost:3080' } })
check('Host=localhost:3080 → 放行', localhostHost.status === 200, String(localhostHost.status))
const v6Host = await callApi(h, { method: 'GET', headers: { host: '[::1]:3080' } })
check('Host=[::1]:3080 → 放行(IPv6 回环字面量)', v6Host.status === 200, String(v6Host.status))
const secFetchNone = await post(h, { op: 'setOption', injectBrief: true }, { headers: { 'sec-fetch-site': 'none' } })
check('没有 Origin + Sec-Fetch-Site: none → 放行(本机脚本/CLI)', secFetchNone.status === 200 && secFetchNone.json.ok === true, String(secFetchNone.status))

// ── 413 在读 body 之前拒绝 ──
// 声明的 Content-Length 已超限时直接回 413:配置在 readBody 之前,不替任何人读完大上传。
// callApi 额外返回 bodyRead(handler 挂过 data/end 监听器就为 true)—— 用它证明「body 真的没被读」。
const hugeDeclared = await callApi(h, {
  method: 'POST',
  body: '{"op":"setShell","key":"cmd"}',
  headers: { 'content-length': '2000000', host: '127.0.0.1:3080' },
})
check(
  '声明 Content-Length > 1MB → 413 且没有读 body(早拒)',
  hugeDeclared.status === 413 && hugeDeclared.bodyRead === false,
  JSON.stringify({ status: hugeDeclared.status, bodyRead: hugeDeclared.bodyRead, raw: String(hugeDeclared.raw).slice(0, 100) }),
)
const shellAfterEarly413 = (await callApi(h)).json.state.defaultShell
check('早拒的 413 没有执行 body 里的操作(默认终端没被改成 cmd)', shellAfterEarly413 !== 'cmd', String(shellAfterEarly413))

// 自定义工具:写入后必须立刻能看见(缓存失效)
before = h.subprocess.calls.length
const addCustom = await post(h, { op: 'addCustomTool', path: process.execPath, label: 'harness-node' })
check('addCustomTool 200', addCustom.status === 200 && addCustom.json.ok === true, addCustom.raw.slice(0, 200))
const afterCustom = await callApi(h)
check('新自定义工具立刻可见(缓存已失效)', afterCustom.json.tools.some((x) => x.custom && x.label === 'harness-node'), afterCustom.json.tools.map((x) => x.key).join(','))
check('新工具复用已探测过的同名版本(0 次版本子进程)', h.subprocess.calls.slice(before).filter(isVersion).length === 0, String(h.subprocess.calls.slice(before).filter(isVersion).length))
const addCustomBad = await post(h, { op: 'addCustomTool', path: 'C:\\nope\\nope.exe' })
check('addCustomTool 不存在路径 400', addCustomBad.status === 400)
const removeCustom = await post(h, { op: 'removeCustomTool', key: 'harness-node' })
check('removeCustomTool 200', removeCustom.status === 200)
const afterRemove = await callApi(h)
check('自定义工具已移除', !afterRemove.json.tools.some((x) => x.label === 'harness-node'))

// setCustomShell
const shellBad = await post(h, { op: 'setCustomShell', path: 'C:\\nope\\nope.exe' })
check('setCustomShell 不存在路径 400', shellBad.status === 400)
const shellNoPlaceholder = await post(h, { op: 'setCustomShell', path: process.env.ComSpec || 'cmd.exe', args: ['/c'] })
check('setCustomShell 缺 {command} 占位 400', shellNoPlaceholder.status === 400, String(shellNoPlaceholder.status))
const shellOk = await post(h, { op: 'setCustomShell', path: process.env.ComSpec || 'cmd.exe', args: ['/c', '{command}'] })
check('setCustomShell 合法路径 200', shellOk.status === 200 && shellOk.json.ok === true, shellOk.raw.slice(0, 200))
const customShellState = await callApi(h)
check('自定义终端成为默认', customShellState.json.shell.family === 'custom', JSON.stringify(customShellState.json.shell))
await post(h, { op: 'setShell', key: 'auto' })

// setOption:白名单 + 归一化(0.5.0 起只剩 injectBrief / allowLan)
const strBool = await post(h, { op: 'setOption', injectBrief: 'yes' })
check('setOption 字符串布尔归一为 false(不是 Boolean("yes"))', strBool.status === 200 && strBool.json.state.options.injectBrief === false, strBool.raw.slice(0, 160))
const emptyOpt = await post(h, { op: 'setOption', nope: 1 })
check('setOption 未知键 → 400 且不落盘', emptyOpt.status === 400 && emptyOpt.json.ok === false, emptyOpt.raw.slice(0, 140))
await post(h, { op: 'setOption', injectBrief: true })
for (const patch of [{ injectBrief: false }, { allowLan: false }, { injectBrief: true }, { allowLan: false }]) {
  const r = await post(h, { op: 'setOption', ...patch })
  check('setOption ' + JSON.stringify(patch), r.status === 200 && r.json.ok === true, r.raw.slice(0, 160))
}
const afterOpts = await callApi(h)
check(
  '选项已落盘(三个开关)',
  afterOpts.json.state.options.injectBrief === true &&
    afterOpts.json.state.options.allowLan === false &&
    afterOpts.json.state.options.blockOtherFamily === true &&
    Object.keys(afterOpts.json.state.options).sort().join(',') === 'allowLan,blockOtherFamily,injectBrief',
  JSON.stringify(afterOpts.json.state.options),
)
// 删掉的接管开关**不再**是合法选项:发上来就是 400(旧字段忽略,不迁移)
const legacyTaken = await post(h, { op: 'setOption', shellTakeover: 'off' })
check('setOption shellTakeover(已删除)→ 400', legacyTaken.status === 400, String(legacyTaken.status))
const legacySandbox = await post(h, { op: 'setOption', sandboxTakeover: 'refuse' })
check('setOption sandboxTakeover(已删除)→ 400', legacySandbox.status === 400, String(legacySandbox.status))

// injectBrief=false 时简报应为空
await post(h, { op: 'setOption', injectBrief: false })
const blankBrief = h.state.brief.text()
check('关闭注入后简报为空', blankBrief === '', JSON.stringify(blankBrief).slice(0, 120))
await post(h, { op: 'setOption', injectBrief: true })

// envd 工具
const envd = h.state.toolDefs.get('envd')
check('envd 工具已注册', Boolean(envd))
const summary = await envd.execute({ action: 'summary' })
check('envd summary', summary.ok === true && summary.text.includes('本机环境'))
const checkRes = await envd.execute({ action: 'check' })
check('envd check', checkRes.ok === true && typeof checkRes.text === 'string')
const summaryToolLine = String(summary.text).split('\n').find((l) => l.includes('命令工具')) || ''
check(
  'envd summary(无会话)只说「命令工具」事实,不说「本会话」结论',
  summaryToolLine.includes('命令工具') && !summaryToolLine.includes('本会话'),
  summaryToolLine,
)
const resolveNode = await envd.execute({ action: 'resolve', name: 'node' })
check('envd resolve node', resolveNode.ok === true && resolveNode.text.includes('node'))
// py 启动器:Python 工具条目要标出它,`resolve py` 也必须命中(0.2.2 修的就是这个坑)
const pyTool = got.json.tools.find((x) => x.key === 'python')
if (pyTool && pyTool.pyLauncher) {
  check('GET 快照标出 py 启动器', /py\.exe$/i.test(String(pyTool.pyLauncher)), pyTool.pyLauncher)
  check('简报提到 py 启动器', briefText.includes('py 启动器'), briefText.split('\n').find((l) => l.includes('Python')) || '')
  const resolvePy = await envd.execute({ action: 'resolve', name: 'py' })
  check('envd resolve py(py 是 python 的别名)', resolvePy.ok === true && resolvePy.text.includes('py 启动器'), resolvePy.text.slice(0, 180))
} else {
  skip('py 启动器断言', '本机 PATH 上没有 py.exe')
}
const hasBashTerminal = (got.json.terminals || []).some((t) => t.key === 'bash')
if (hasBashTerminal) {
  const resolveBash = await envd.execute({ action: 'resolve', name: 'bash' })
  check('envd resolve bash(终端)', resolveBash.ok === true, resolveBash.text.slice(0, 120))
} else {
  skip('envd resolve bash(终端)', '本机没有检测到 bash 终端')
}
const resolveNope = await envd.execute({ action: 'resolve', name: 'zzz' })
check('envd resolve 未知名字 ok:false', resolveNope.ok === false)
const resolveEmpty = await envd.execute({ action: 'resolve' })
check('envd resolve 缺 name ok:false', resolveEmpty.ok === false)
const setDefaultBad = await envd.execute({ action: 'set_default', name: 'node', path: 'C:\\nope.exe' })
check('envd set_default 非法路径 ok:false', setDefaultBad.ok === false)
if (nodeCand) {
  const setDefaultOk = await envd.execute({ action: 'set_default', name: 'node', path: nodeCand.path })
  check('envd set_default 合法路径', setDefaultOk.ok === true)
  await post(h, { op: 'setTool', key: 'node', path: '' })
}

// 状态文件损坏时回落默认
mkdirSync(home, { recursive: true })
writeFileSync(join(home, 'envdock.json'), '{ this is not json', 'utf8')
const corruptGet = await callApi(h)
check('损坏的状态文件不炸', corruptGet.status === 200 && corruptGet.json.ok === true)
check('损坏状态 → 回落默认', corruptGet.json.state.defaultShell === 'auto' && corruptGet.json.state.options.injectBrief === true)
check('损坏状态留了 .corrupt 备份', existsSync(join(home, 'envdock.json.corrupt')))
check(
  '损坏状态给面板一条 issue',
  (corruptGet.json.issues || []).some((i) => String(i.title || '').includes('状态文件损坏')),
  JSON.stringify((corruptGet.json.issues || []).map((i) => i.title)),
)

// 手改过的状态文件:options 白名单归一化 + customTools[].path 强制 String
writeFileSync(
  join(home, 'envdock.json'),
  JSON.stringify({
    options: { injectBrief: 'yes', allowLan: 'true' },
    customTools: [{ key: 'num', label: 'num', path: 1234 }],
  }),
  'utf8',
)
const normGet = await callApi(h)
check(
  'readState 布尔归一化(injectBrief 非布尔回落默认开,allowLan 只认 true)',
  normGet.json.state.options.injectBrief === true && normGet.json.state.options.allowLan === false,
  JSON.stringify(normGet.json.state.options),
)
check('customTools[].path 强制 String', normGet.json.state.customTools[0] && normGet.json.state.customTools[0].path === '1234', JSON.stringify(normGet.json.state.customTools))
await post(h, { op: 'removeCustomTool', key: 'num' })
await post(h, { op: 'setOption', injectBrief: true, allowLan: false })

// 无 subprocess 服务时仍可用(只做 PATH 扫描)
const h2 = makeHarness()
fixtures.push(h2)
h2.services.subprocess = null
apply(h2.ctx, {})
await freshDetection(h2)
await waitForBrief(h2)
// 等第一个对账 tick:注册决定是 tick 驱动的,GET 早于第一个 tick 时 registered=false/skipReason=null
await pollSnapshot(h2, (s) => Boolean(s.syncStats) && s.syncStats.ticks >= 1, 6000)
const noSp = await callApi(h2)
check('无 subprocess 时 GET 200', noSp.status === 200 && noSp.json.ok === true)
check('无 subprocess 时 hasSubprocess=false', noSp.json.hasSubprocess === false)
check('无 subprocess 时仍扫到工具', (noSp.json.tools || []).length > 0, String((noSp.json.tools || []).length))
check(
  '无 subprocess 时版本为空',
  (noSp.json.tools || []).every((t) => !t.defaultVersion),
  (noSp.json.tools || []).map((t) => t.key + '=' + String(t.defaultVersion)).join(','),
)
// 没有 subprocess 就执行不了命令:envd_shell 仍然注册(注册条件只看终端/家族/沙箱/名字),
// 但执行必须如实报「没有可用的 subprocess 服务」,不能假装成功。
const noSubTool = noSp.json.commandTool && noSp.json.commandTool.registered === true ? h2.state.toolDefs.get('envd_shell') : null
if (noSubTool) {
  const noSubRun = await noSubTool.execute({ command: 'echo hi', cwd: process.cwd() }, { signal: null })
  check('无 subprocess 时执行 ok:false 且说明原因', noSubRun.ok === false && noSubRun.text.includes('subprocess'), String(noSubRun.text).slice(0, 120))
} else {
  skip('无 subprocess 时执行报错', 'envd_shell 未注册(skipReason=' + String(noSp.json.commandTool && noSp.json.commandTool.skipReason) + ')')
}

// ── 「重新探测」必须看到系统**当前**的 PATH,而不是 dsh 启动那一刻的快照 ──
//
// 真实故障:用户在系统里删掉一个失效目录(比如 D:\python\Scripts\)或新装工具把目录加进 PATH,
// 进程里的 PATH 不会变;只重扫它 → 面板永远显示旧结果,非要重启 dsh。
// 下面两个 fixture 直接模拟这两种漂移,并且都走「重新探测」这条路径。
const realPath = process.env.PATH
const ghostDir = join(tmpdir(), 'envdock-ghost-' + process.pid + '-' + Date.now()) // 故意不创建
const newDir = mkdtempSync(join(tmpdir(), 'envdock-newdir-'))
const baseKeys = new Set((got.json.tools || []).map((t) => t.key))
const newToolKey = ['deno', 'bun', 'yarn', 'uv'].find((k) => !baseKeys.has(k))
try {
  // (1) 进程 PATH 里挂着、系统 PATH 里已经删掉、目录也不在 → 重新探测后不该再报
  process.env.PATH = realPath + ';' + ghostDir
  const h5 = start({ subprocess: { registryPath: () => ({ machine: realPath, user: '' }) } })
  await post(h5, { op: 'refresh' })
  const snap5 = await callApi(h5)
  phase('僵尸 PATH 项')
  check('系统 PATH 里已删掉的失效目录,重新探测后不再报', !(snap5.json.pathInfo.missing || []).includes(ghostDir), (snap5.json.pathInfo.missing || []).join('; '))
  check('探测按系统 PATH 走(source=system)', snap5.json.pathInfo.source === 'system', String(snap5.json.pathInfo.source))
  check('漂移被标记(dsh 进程里的 PATH 是旧的)', snap5.json.pathInfo.staleProcess === true, JSON.stringify(snap5.json.pathInfo.staleProcess))
  check(
    '漂移在健康检查里有一条 info 说明(不用重启)',
    (snap5.json.issues || []).some((i) => i.level === 'info' && /PATH/.test(i.title)),
    JSON.stringify((snap5.json.issues || []).map((i) => i.level + ':' + i.title)),
  )

  // (2) 系统 PATH 里新加的目录(进程 PATH 里没有)→ 重新探测就能看见,不必重启 dsh
  if (newToolKey) writeFileSync(join(newDir, newToolKey + '.cmd'), '@echo off\r\n', 'utf8')
  process.env.PATH = realPath
  const h6 = start({ subprocess: { registryPath: () => ({ machine: realPath, user: newDir }) } })
  await post(h6, { op: 'refresh' })
  const snap6 = await callApi(h6)
  phase('系统 PATH 新目录')
  if (newToolKey) {
    check(
      '系统 PATH 新加目录里的工具立刻能扫到(' + newToolKey + ')',
      (snap6.json.tools || []).some((t) => t.key === newToolKey),
      (snap6.json.tools || []).map((t) => t.key).join(','),
    )
  } else {
    skip('系统 PATH 新加目录里的工具立刻能扫到', '机器上 CATALOG 里的工具都装了,没有空槽可注入')
  }
  check('上一个 fixture 的僵尸目录不会漏过来', (snap6.json.pathInfo.missing || []).every((d) => d !== ghostDir), (snap6.json.pathInfo.missing || []).join('; '))

  for (const cur of [h5, h6]) {
    try {
      cur.dispose()
    } catch {}
  }
} finally {
  process.env.PATH = realPath
  rmSync(newDir, { recursive: true, force: true })
}

// ── py -0p 失败不缓存:一次失败不能把「Python 多版本」钉死 10 分钟 ──
// 用独立的 py.exe 桩目录(不同路径 = 不同的版本缓存 key),避免前面成功探测留下的缓存干扰。
const failDir = mkdtempSync(join(tmpdir(), 'envdock-pyfail-'))
writeFileSync(join(failDir, 'py.exe'), '', 'utf8')
const pathBeforePyFail = process.env.PATH
process.env.PATH = failDir
try {
  const hPyFail = start({ subprocess: { exitWhen: (argv) => (argv || [])[1] === '-0p' } })
  await waitForBrief(hPyFail)
  // force:重读系统 PATH(夹具返回 process.env.PATH = 桩目录),并强制跑一次 py -0p(失败)
  await post(hPyFail, { op: 'refresh' })
  const launcherCalls = () => hPyFail.subprocess.calls.filter((c) => (c.argv || [])[1] === '-0p').length
  const launcherFirst = launcherCalls()
  check('py -0p 探测执行且失败(夹具断言)', launcherFirst >= 1, String(launcherFirst))
  await post(hPyFail, { op: 'refresh' }) // 强制重扫(选项写入不再作废探测缓存)
  await callApi(hPyFail) // 非 force 探测:失败结果不许被缓存,必须重试
  const launcherSecond = launcherCalls()
  check('py -0p 失败不缓存(下一次探测仍会重试)', launcherSecond > launcherFirst, launcherFirst + ' → ' + launcherSecond)
  hPyFail.dispose()
} finally {
  process.env.PATH = pathBeforePyFail
  rmSync(failDir, { recursive: true, force: true })
}

// ── py 启动器:python.exe 不在 PATH、只有 py.exe 时 ──
//
// 真实场景:python.org 安装器没勾「Add python.exe to PATH」,PATH 上只有 py 启动器。
// 以前这种机器 EnvDock 直接报「没有 Python」,`envd resolve py` 也说「没探测到 py」——
// 可它内部探测多版本时恰恰在用 `py -0p`。这里用临时目录里一个 py.exe 桩把这种机器固定住。
const launcherDir = mkdtempSync(join(tmpdir(), 'envdock-pyonly-'))
try {
  writeFileSync(join(launcherDir, 'py.exe'), '', 'utf8')
  process.env.PATH = launcherDir
  const h7 = start({ subprocess: { registryPath: () => ({ machine: launcherDir, user: '' }) } })
  await post(h7, { op: 'refresh' })
  const snap7 = await callApi(h7)
  const pyEntry = (snap7.json.tools || []).find((t) => t.key === 'python')
  phase('只有 py 启动器')
  check('只有 py.exe 时仍报 Python', Boolean(pyEntry), (snap7.json.tools || []).map((t) => t.key).join(','))
  check('默认路径落在 py.exe 上', pyEntry && /py\.exe$/i.test(String(pyEntry.defaultPath)), pyEntry && pyEntry.defaultPath)
  check(
    '标记为「经 py 启动器」',
    pyEntry && pyEntry.viaLauncher === true && /py 启动器/.test(String(pyEntry.label)),
    pyEntry && pyEntry.label,
  )
  const envd7 = h7.state.toolDefs.get('envd')
  const resolve7 = await envd7.execute({ action: 'resolve', name: 'py' })
  check('resolve py 命中(python.exe 不在 PATH 时)', resolve7.ok === true && resolve7.text.includes('py 启动器'), resolve7.text.slice(0, 200))
  const resolvePython7 = await envd7.execute({ action: 'resolve', name: 'python' })
  check('resolve python 也带启动器说明', resolvePython7.ok === true && resolvePython7.text.includes('py 启动器'), resolvePython7.text.slice(0, 200))
  const resolveNope7 = await envd7.execute({ action: 'resolve', name: 'zzz' })
  check('无启动器时未知名字仍然 ok:false', resolveNope7.ok === false, resolveNope7.text.slice(0, 120))
  h7.dispose()
} finally {
  process.env.PATH = realPath
  rmSync(launcherDir, { recursive: true, force: true })
}

// ── 探测缓存语义:多次 GET 不重复探测;非探测写入不作废;setShell 作废 ──
const hCache = start({})
// 上一个用例把 PATH 换成过桩目录:探测缓存是**进程共享**的,先强制一份真实快照,
// 否则这里拿到的是桩环境的结果(没有终端可切,用例就白跳过了)。
await freshDetection(hCache)
const cacheSnap1 = await pollSnapshot(hCache, (s) => Boolean(s.syncStats) && s.syncStats.detections >= 1, 6000)
const det1 = cacheSnap1.syncStats.detections
const at1 = cacheSnap1.detectedAt
const cacheSnap2 = (await callApi(hCache)).json
check(
  '同一探测缓存的多次 GET 不增加 detections / detectedAt 不变',
  cacheSnap2.syncStats.detections === det1 && cacheSnap2.detectedAt === at1,
  JSON.stringify({ detections: [det1, cacheSnap2.syncStats.detections], detectedAt: [at1, cacheSnap2.detectedAt] }),
)
await post(hCache, { op: 'setOption', injectBrief: true })
const cacheSnap3 = (await callApi(hCache)).json
check(
  '非探测相关的 setOption 不作废探测(detectedAt 不变)',
  cacheSnap3.detectedAt === at1 && cacheSnap3.syncStats.detections === det1,
  JSON.stringify({ detectedAt: [at1, cacheSnap3.detectedAt], detections: [det1, cacheSnap3.syncStats.detections] }),
)
const cacheShellKey = (cacheSnap3.terminals || []).map((t) => t.key).find((k) => k && k !== 'auto') || ''
if (cacheShellKey) {
  await sleep(5)
  await post(hCache, { op: 'setShell', key: cacheShellKey })
  const cacheSnap4 = (await callApi(hCache)).json
  check(
    'setShell(影响探测)会作废缓存,下一次 GET 重新探测(detectedAt 变化)',
    cacheSnap4.detectedAt !== at1 && cacheSnap4.syncStats.detections > det1,
    JSON.stringify({ detectedAt: [at1, cacheSnap4.detectedAt], detections: [det1, cacheSnap4.syncStats.detections] }),
  )
} else {
  skip('setShell 作废探测缓存', '没有可切换的终端')
}
hCache.dispose()
await resetState(h)

// ══════════════════════════════════════════════════════════════════════
//  0.6「两族」模型的基础契约(docs/notes/assist-model.md)
//  逐会话选族 + bash 族会话遮挡 PowerShell 族内置命令工具 + 增补 envd_shell。
//  本节夹具都不含「可遮挡的 PowerShell 内置名」,所以仍按 0 次 restrict 断言;
//  真正的遮挡/守卫用例在 §5(编号与规划 §5 一一对应)。
// ══════════════════════════════════════════════════════════════════════

// ── (1) 有 bash 族宿主工具 → 注册 envd_shell;registered/visible/skipReason 三态 ──
// 0.5 的「同族 → 不重复提供」已删除:bash 族会话要同时看到宿主 ops_bash 与 envd_shell。
phase('§3.1 bash 族宿主工具 → 注册增补工具')
const hReg = start({ shippedTools: ['bash'], agentIds: ['agent-reg'] }, { syncIntervalMs: 25 })
const regSnap = await (async () => {
  await waitForBrief(hReg)
  return waitCommandTool(hReg, (c) => c.registered === true)
})()
check('有 bash 族宿主工具 → 注册 envd_shell(不再按同族跳过)', regSnap.commandTool.registered === true, JSON.stringify(regSnap.commandTool))
check('registered=true / visible=true / skipReason=null', regSnap.commandTool.registered === true && regSnap.commandTool.visible === true && regSnap.commandTool.skipReason === null, JSON.stringify(regSnap.commandTool))
check('注册表里真的有 envd_shell', hReg.state.toolDefs.has('envd_shell'))
check('commandTool.shell 报出默认终端(label/family/path/version)', Boolean(regSnap.commandTool.shell.path) && Boolean(regSnap.commandTool.shell.family) && Boolean(regSnap.commandTool.shell.label), JSON.stringify(regSnap.commandTool.shell))
check('refuseWhenConfined=true(围栏会话里会拒绝)', regSnap.commandTool.refuseWhenConfined === true)
check('会话族判定成 bash(commandTool.family 与 shell.family 一致)', regSnap.commandTool.family === 'bash' && regSnap.commandTool.shell.family === 'bash', JSON.stringify({ family: regSnap.commandTool.family, source: regSnap.commandTool.familySource, shell: regSnap.commandTool.shell }))
// 只增不减:宿主的 bash 必须仍然在工具表里、并且在那个会话里可见
check('宿主的 bash 仍在工具表里(没被隐藏/删除)', hReg.state.toolDefs.has('bash'))
check('宿主的 bash 在 agent 作用域里仍然可见(遮挡只针对 PowerShell 族)', Boolean(hReg.toolsFor('agent-reg').get('bash')))
check('没有可遮挡的 PowerShell 内置名 → 0 次 restrict', hReg.stats().restrictCalls === 0, JSON.stringify(hReg.stats().restrictAttempts))
check('简报同时点名 envd_shell 与宿主 bash', /envd_shell/.test(regSnap.brief) && /bash/.test(regSnap.brief), String(regSnap.brief).split('\n').find((l) => l.includes('命令工具')) || '')

// 稳态:ticks 在涨,registerTries 不涨(不反复拆建工具)
const steadyA = (await callApi(hReg)).json.syncStats
await sleep(150)
const steadyB = (await callApi(hReg)).json.syncStats
check(
  '稳态:ticks 涨而 registerTries 不涨(注册表没有反复拆建)',
  steadyB.ticks > steadyA.ticks && steadyB.registerTries === steadyA.registerTries,
  JSON.stringify({ ticks: [steadyA.ticks, steadyB.ticks], registerTries: [steadyA.registerTries, steadyB.registerTries] }),
)
check('稳态:hostToolScans 跟着 tick 涨(每个 tick 重新识别宿主工具)', steadyB.hostToolScans > steadyA.hostToolScans, JSON.stringify([steadyA.hostToolScans, steadyB.hostToolScans]))

// 执行语义(无围栏 → 直跑假 subprocess):argv 必须按**会话族**的语法
const regTool = hReg.state.toolDefs.get('envd_shell')
const regFamily = regSnap.commandTool.family
const spawnBefore = hReg.subprocess.calls.length
const regRun = await regTool.execute({ command: 'echo hi', cwd: process.cwd() }, { signal: null })
const regSpawned = hReg.subprocess.calls.slice(spawnBefore)
check('无围栏会话照常执行(假 subprocess)', regRun.ok === true && regRun.text.includes('[exit 0]'), String(regRun.text).slice(0, 160))
check('执行带 exit 行', /\[exit \d+\]/.test(regRun.text))
check('argv 按会话族(' + regFamily + ')语法生成', regSpawned.length === 1 && invocationLooksRight(regFamily, regSpawned[0].argv, 'echo hi'), JSON.stringify(regSpawned.map((c) => c.argv)))
const regEmpty = await regTool.execute({ command: '   ' }, { signal: null })
check('空命令 → ok:false', regEmpty.ok === false, String(regEmpty.ok))
hReg.subprocess.state.throwNext = true
const regThrown = await regTool.execute({ command: 'echo hi' }, { signal: null })
check('spawn 同步抛错被接住', regThrown.ok === false && regThrown.text.includes('启动命令失败'), regThrown.text.slice(0, 120))
hReg.subprocess.state.rejectNext = true
const regRejected = await regTool.execute({ command: 'echo hi' }, { signal: null })
check('done 拒绝被接住', regRejected.ok === false && regRejected.text.includes('[error]'), regRejected.text.slice(0, 120))
const regBadCwd = await regTool.execute({ command: 'echo hi', cwd: 'C:\\nope\\nope' }, { signal: null })
check('不存在的 cwd → ok:false', regBadCwd.ok === false, regBadCwd.text.slice(0, 120))
hReg.dispose()

// ── (2) 名字被别的插件占着:不认领别人的工具 ──
// 0.5 的 same-family 分支已删除(「同族不重复提供」不再存在);两族遮挡行为见 §5。
phase('§3.2 名字被占用')
const hTaken = start({ shippedTools: ['envd_shell'], agentIds: ['agent-taken'] })
await waitForBrief(hTaken)
const takenSnap = await waitCommandTool(hTaken, (c) => c.skipReason === 'taken')
check(
  '同名工具已存在 → skipReason=taken(不认领、不注册)',
  takenSnap.commandTool.skipReason === 'taken' && takenSnap.commandTool.registered === false,
  JSON.stringify(takenSnap.commandTool),
)
check('不认领时别人的那份仍然在工具表里(没被拆)', hTaken.state.toolDefs.has('envd_shell'))
check('被占用时也不调用 restrict', hTaken.stats().restrictCalls === 0, String(hTaken.stats().restrictCalls))
hTaken.dispose()

// ── (3) 沙箱条件:全部会话受限但有可委托执行器 → 仍注册;不能委托 → no-unconfined-session ──
phase('§3.3 沙箱条件(委托可用性)')
const hConf = start({
  agentIds: [{ id: 'agent-w', session: { key: 'w1' } }],
  shell: fakeSandboxedShell({ mode: 'workspace-write' }),
  sandboxPolicy: fakeSandboxPolicy('workspace-write'),
})
await waitForBrief(hConf)
const confSnap = await waitCommandTool(hConf, (c) => c.registered === true)
check('全部会话受限但执行器可委托 → 仍注册 envd_shell', confSnap.commandTool.registered === true && confSnap.commandTool.skipReason === null, JSON.stringify(confSnap.commandTool))
check(
  'sandbox.delegatable=true(执行器有 resolve/execute + 合法 sandboxPolicy)',
  confSnap.commandTool.sandbox.delegatable === true && confSnap.sandbox.delegatable === true,
  JSON.stringify({ ct: confSnap.commandTool.sandbox, top: confSnap.sandbox }),
)
check(
  'sandbox 聚合:capable / confinedCount / sessionCount / anyUnconfined / delegatable',
  confSnap.commandTool.sandbox.capable === true &&
    confSnap.commandTool.sandbox.present === true &&
    confSnap.commandTool.sandbox.sessionCount === 1 &&
    confSnap.commandTool.sandbox.confinedCount === 1 &&
    confSnap.commandTool.sandbox.anyUnconfined === false &&
    confSnap.commandTool.sandbox.delegatable === true,
  JSON.stringify(confSnap.commandTool.sandbox),
)
check('沙箱聚合与顶层 sandbox 一致', JSON.stringify(confSnap.sandbox) === JSON.stringify(confSnap.commandTool.sandbox), JSON.stringify(confSnap.sandbox))
const confBrief = hConf.state.brief.text({ scope: hConf.state.agents[0] })
check(
  '受限会话简报:说会在沙箱内执行,不说「会拒绝」',
  confBrief.includes('会通过宿主执行器在沙箱内执行') && !confBrief.includes('会拒绝'),
  confBrief.split('\n').find((l) => l.includes('命令工具')) || '',
)
hConf.dispose()

// 执行器只有 sandboxMode(没有 resolve/execute)+ 全部会话受限 → 不可委托 → 不注册
const hNoDelegate = start({
  agentIds: [{ id: 'agent-nd', session: { key: 'nd1' } }],
  shell: { sandboxMode: 'workspace-write' },
  sandboxPolicy: fakeSandboxPolicy('workspace-write'),
})
await waitForBrief(hNoDelegate)
const ndConfSnap = await waitCommandTool(hNoDelegate, (c) => c.skipReason === 'no-unconfined-session')
check(
  '没有可委托执行器 + 全部会话受限 → skipReason=no-unconfined-session',
  ndConfSnap.commandTool.skipReason === 'no-unconfined-session' && ndConfSnap.commandTool.registered === false,
  JSON.stringify(ndConfSnap.commandTool),
)
check('没有可委托执行器时不注册 envd_shell', !hNoDelegate.state.toolDefs.has('envd_shell'))
check('sandbox.delegatable=false(执行器没有 resolve/execute)', ndConfSnap.commandTool.sandbox.delegatable === false && ndConfSnap.sandbox.delegatable === false, JSON.stringify(ndConfSnap.sandbox))
const ndBrief = hNoDelegate.state.brief.text({ scope: hNoDelegate.state.agents[0] })
check(
  '受限且无法委托的简报:无法在沙箱内执行 + 改用宿主',
  ndBrief.includes('无法在沙箱内执行') && ndBrief.includes('改用宿主'),
  ndBrief.split('\n').find((l) => l.includes('命令工具')) || '',
)
hNoDelegate.dispose()

// 有围栏能力但没有 sandboxPolicy 服务 → 判不出策略 → 保守按受限,且不可委托 → 不注册
const hNoPolicy = start({
  agentIds: [{ id: 'agent-np', session: { key: 'np1' } }],
  shell: fakeSandboxedShell({ mode: 'workspace-write' }),
})
await waitForBrief(hNoPolicy)
const npSnap = await waitCommandTool(hNoPolicy, (c) => c.skipReason === 'no-unconfined-session')
check(
  '没有 sandboxPolicy 服务 + 全部会话受限 → skipReason=no-unconfined-session',
  npSnap.commandTool.skipReason === 'no-unconfined-session' && npSnap.commandTool.registered === false,
  JSON.stringify(npSnap.commandTool),
)
check('没有 sandboxPolicy 服务时 delegatable=false', npSnap.commandTool.sandbox.delegatable === false, JSON.stringify(npSnap.commandTool.sandbox))
hNoPolicy.dispose()

const hFull = start({
  agentIds: [
    { id: 'agent-free', session: { key: 'f1' } },
    { id: 'agent-locked', session: { key: 'l1' } },
  ],
  // 显式 bash 执行器族:委托包装串按**执行器**族写(Windows 默认布局会落到 powershell)
  shell: fakeSandboxedShell({ mode: 'workspace-write', className: 'BashSandboxExecutor' }),
  sandboxPolicy: fakeSandboxPolicy('workspace-write', { f1: 'danger-full-access' }),
})
const fullSnap = await (async () => {
  await waitForBrief(hFull)
  return waitCommandTool(hFull, (c) => c.registered === true)
})()
check('有会话 resolve 出 danger-full-access → 注册 envd_shell', fullSnap.commandTool.registered === true, JSON.stringify(fullSnap.commandTool))
check(
  'sandbox 聚合:anyUnconfined=true / confinedCount=1 / sessionCount=2 / delegatable=true',
  fullSnap.commandTool.sandbox.anyUnconfined === true &&
    fullSnap.commandTool.sandbox.confinedCount === 1 &&
    fullSnap.commandTool.sandbox.sessionCount === 2 &&
    fullSnap.commandTool.sandbox.delegatable === true,
  JSON.stringify(fullSnap.commandTool.sandbox),
)

// ── (4) 受限会话:能委托 → 在宿主沙箱内执行;不能委托 → 拒绝(绝不自己 spawn) ──
phase('§3.4 沙箱委托执行 / 无法委托时拒绝')
const fullTool = hFull.state.toolDefs.get('envd_shell')
const lockedAgent = hFull.state.agents.find((a) => a.id === 'agent-locked')
const freeAgent = hFull.state.agents.find((a) => a.id === 'agent-free')
const hostShell = hFull.services.shell

// (a) 委托执行:宿主执行器 resolve + execute 各一次,EnvDock 自己不 spawn
const delegatedBeforeSub = hFull.subprocess.calls.length
const delegatedBeforeExec = hostShell.calls.executed.length
const delegated = await fullTool.execute({ command: 'echo owned', cwd: process.cwd() }, { signal: null, agent: lockedAgent })
const delegatedSpec = hostShell.calls.executed[delegatedBeforeExec]
check('(a) 受限会话调用 envd_shell → 委托宿主执行器执行(ok:true)', delegated.ok === true && delegated.text.startsWith('[sandbox] 委托宿主执行器执行('), String(delegated.text).slice(0, 200))
check('(a) 委托结果带宿主 stdout 与 exit 行', delegated.text.includes('host-ran') && /\[exit 0\]/.test(delegated.text), String(delegated.text).slice(0, 200))
check('(a) EnvDock 自己不 spawn(subprocess 增量为 0)', hFull.subprocess.calls.length === delegatedBeforeSub, String(hFull.subprocess.calls.length - delegatedBeforeSub))
check('(a) 宿主执行器被执行一次(execute 一次)', hostShell.calls.executed.length === delegatedBeforeExec + 1, String(hostShell.calls.executed.length))
check('(a) 宿主执行器先 resolve 再 execute(request 有 sandboxPolicy + env.ENVD_CMD)', Boolean(hostShell.calls.resolved.length) && Boolean(hostShell.calls.resolved[0].sandboxPolicy) && Boolean(hostShell.calls.resolved[0].env && hostShell.calls.resolved[0].env.ENVD_CMD), JSON.stringify(hostShell.calls.resolved[0]).slice(0, 240))
check('(a) ENVD_CMD 载荷解码 == 用户命令(命令不拼进命令行)', Boolean(delegatedSpec) && decodeBashPayload(delegatedSpec) === 'echo owned', JSON.stringify(delegatedSpec && delegatedSpec.env))
check('(a) spec.sandboxPolicy 透传本会话策略(workspace-write)', Boolean(delegatedSpec && delegatedSpec.sandboxPolicy) && delegatedSpec.sandboxPolicy.mode === 'workspace-write', JSON.stringify(delegatedSpec && delegatedSpec.sandboxPolicy))
check('(a) spec 带 workdir / timeoutMs', Boolean(delegatedSpec) && delegatedSpec.workdir === process.cwd() && typeof delegatedSpec.timeoutMs === 'number', JSON.stringify(delegatedSpec && { workdir: delegatedSpec.workdir, timeoutMs: delegatedSpec.timeoutMs }))
check(
  '(a) spec.command 把目标终端包起来(按执行器族 bash:引号包装 + exit $?)',
  Boolean(delegatedSpec) && typeof delegatedSpec.command === 'string' && delegatedSpec.command.includes('; exit $?') && delegatedSpec.command.includes(fullSnap.shell.path),
  String(delegatedSpec && delegatedSpec.command).slice(0, 220),
)

// (b) 围栏 runner 失败(命令根本没跑)→ ok:false
hostShell.state.runnerFailed = true
const runRunnerFailed = await fullTool.execute({ command: 'echo runner-failed', cwd: process.cwd() }, { signal: null, agent: lockedAgent })
check(
  '(b) runnerFailed → ok:false 且说清命令没执行',
  runRunnerFailed.ok === false && runRunnerFailed.text.includes('围栏 runner 失败') && runRunnerFailed.text.includes('这条命令没有执行'),
  String(runRunnerFailed.text).slice(0, 240),
)
hostShell.state.runnerFailed = false

// (c) 策略拒绝文件操作 → 文本解释「文件操作被沙箱拒绝」(命令本身执行了)
hostShell.state.denied = true
const runDenied = await fullTool.execute({ command: 'echo touched', cwd: process.cwd() }, { signal: null, agent: lockedAgent })
check('(c) denied → 文本含「文件操作被沙箱拒绝」', runDenied.text.includes('文件操作被沙箱拒绝'), String(runDenied.text).slice(0, 240))
hostShell.state.denied = false

// (d) 无围栏会话照常直跑(不走委托、自己 spawn)
const freeBefore = hFull.subprocess.calls.length
const freeRun = await fullTool.execute({ command: 'echo allowed', cwd: process.cwd() }, { signal: null, agent: freeAgent })
const freeSpawns = hFull.subprocess.calls.slice(freeBefore).filter((c) => (c.argv || []).join(' ').includes('allowed'))
check('(d) 无围栏会话照常执行(假 subprocess)', freeRun.ok === true && freeRun.text.includes('[exit 0]'), String(freeRun.text).slice(0, 160))
check('(d) 无围栏会话的 argv 按会话族语法生成', freeSpawns.length === 1 && invocationLooksRight(fullSnap.commandTool.family, freeSpawns[0].argv, 'echo allowed'), JSON.stringify(freeSpawns.map((c) => c.argv)))

// (e) 没有会话信息 → 无法把本会话策略交给执行器 → 拒绝(不拿部署默认档冒充)
const noAgentSpawns = hFull.subprocess.calls.length
const noAgentRun = await fullTool.execute({ command: 'echo noagent', cwd: process.cwd() }, { signal: null })
check('(e) 没有会话信息 → 拒绝([sandbox] + 本会话信息缺失)', noAgentRun.ok === false && noAgentRun.text.startsWith('[sandbox]') && noAgentRun.text.includes('本会话信息缺失'), String(noAgentRun.text).slice(0, 240))
check('(e) 没有会话信息时也不 spawn', !hFull.subprocess.calls.slice(noAgentSpawns).some((c) => (c.argv || []).join(' ').includes('noagent')))

// (f) 简报:受限会话说「沙箱内执行」,无围栏会话不提沙箱限制
const lockedBrief = hFull.state.brief.text({ scope: lockedAgent })
const freeBrief = hFull.state.brief.text({ scope: freeAgent })
check('(f) 受限会话的简报:在沙箱内执行(不再说「会拒绝」)', lockedBrief.includes('会通过宿主执行器在沙箱内执行') && !lockedBrief.includes('会拒绝'), lockedBrief.split('\n').find((l) => l.includes('命令工具')) || '')
check('(f) 无围栏会话的简报没有沙箱限制提示', !freeBrief.includes('受沙箱限制'), freeBrief.split('\n').find((l) => l.includes('命令工具')) || '')
// 新会话的第一步可能早于下一轮 tick:scope 不在映射里也要按它自己的会话判沙箱
const brandNew = hFull.makeAgent('agent-new', { key: 'l1' })
const brandNewBrief = hFull.state.brief.text({ scope: brandNew })
check('(f) 新会话首步(还没等到下一轮 tick)也按它自己的会话判沙箱', brandNewBrief.includes('会通过宿主执行器在沙箱内执行'), brandNewBrief.split('\n').find((l) => l.includes('命令工具')) || '')
hFull.dispose()

// (g) 执行器不可委托(只有 sandboxMode):受限会话 → 拒绝,不 spawn
const hNoDele = start({
  agentIds: [
    { id: 'agent-nl', session: { key: 'nl1' } },
    { id: 'agent-nf', session: { key: 'nf1' } },
  ],
  shell: { sandboxMode: 'workspace-write' },
  sandboxPolicy: fakeSandboxPolicy('workspace-write', { nl1: 'workspace-write', nf1: 'danger-full-access' }),
})
const ndTool = await (async () => {
  await waitForBrief(hNoDele)
  return waitCommandTool(hNoDele, (c) => c.registered === true)
})()
const ndToolDef = hNoDele.state.toolDefs.get('envd_shell')
const ndLocked = hNoDele.state.agents.find((a) => a.id === 'agent-nl')
const ndSubBefore = hNoDele.subprocess.calls.length
const ndRun = ndToolDef ? await ndToolDef.execute({ command: 'echo nod', cwd: process.cwd() }, { signal: null, agent: ndLocked }) : null
check(
  '(g) 执行器只有 sandboxMode → 拒绝([sandbox] + 无法在沙箱内执行 + 宿主命令工具)',
  Boolean(ndRun) &&
    ndRun.ok === false &&
    ndRun.text.startsWith('[sandbox]') &&
    ndRun.text.includes('无法在沙箱内执行') &&
    ndRun.text.includes('宿主命令工具') &&
    ndRun.text.includes('没有可委托的沙箱执行器'),
  String(ndRun && ndRun.text).slice(0, 260),
)
check('(g) 拒绝时不 spawn', hNoDele.subprocess.calls.length === ndSubBefore, String(hNoDele.subprocess.calls.length - ndSubBefore))
hNoDele.dispose()

// (h) 手动 cmd 目标终端 → 委托不支持该族 → 拒绝
await post(h, { op: 'setShell', key: 'cmd' })
const hCmdTarget = start({
  agentIds: [
    { id: 'agent-cl', session: { key: 'cl1' } },
    { id: 'agent-cf', session: { key: 'cf1' } },
  ],
  shell: fakeSandboxedShell({ mode: 'workspace-write' }),
  sandboxPolicy: fakeSandboxPolicy('workspace-write', { cl1: 'workspace-write', cf1: 'danger-full-access' }),
})
await (async () => {
  await waitForBrief(hCmdTarget)
  return waitCommandTool(hCmdTarget, (c) => c.registered === true)
})()
const cmdTool = hCmdTarget.state.toolDefs.get('envd_shell')
const cmdLocked = hCmdTarget.state.agents.find((a) => a.id === 'agent-cl')
const cmdSubBefore = hCmdTarget.subprocess.calls.length
const cmdRun = cmdTool ? await cmdTool.execute({ command: 'echo cmd', cwd: process.cwd() }, { signal: null, agent: cmdLocked }) : null
check(
  '(h) 目标终端是 cmd → 拒绝委托(cmd/WSL/自定义终端不支持安全委托)',
  Boolean(cmdRun) && cmdRun.ok === false && cmdRun.text.includes('无法在沙箱内执行') && cmdRun.text.includes('不支持安全委托执行'),
  String(cmdRun && cmdRun.text).slice(0, 260),
)
check('(h) 目标终端族不支持时不 spawn', hCmdTarget.subprocess.calls.length === cmdSubBefore, String(hCmdTarget.subprocess.calls.length - cmdSubBefore))
hCmdTarget.dispose()
await resetState(h)

// (i) 本会话策略不可得/非法 → 拒绝(不拿部署默认档冒充)
const hBadPolicy = start({
  agentIds: [{ id: 'agent-bp', session: { key: 'bp1' } }],
  shell: fakeSandboxedShell({ mode: 'workspace-write' }),
  sandboxPolicy: fakeSandboxPolicy('not-a-mode'),
})
await (async () => {
  await waitForBrief(hBadPolicy)
  return waitCommandTool(hBadPolicy, (c) => c.registered === true)
})()
const bpTool = hBadPolicy.state.toolDefs.get('envd_shell')
const bpAgent = hBadPolicy.state.agents[0]
const bpSubBefore = hBadPolicy.subprocess.calls.length
const bpRun = bpTool ? await bpTool.execute({ command: 'echo bp', cwd: process.cwd() }, { signal: null, agent: bpAgent }) : null
check(
  '(i) 策略不可得/非法 → 拒绝(不拿部署默认档冒充)',
  Boolean(bpRun) && bpRun.ok === false && bpRun.text.includes('无法在沙箱内执行') && bpRun.text.includes('策略不可得'),
  String(bpRun && bpRun.text).slice(0, 260),
)
check('(i) 策略不可得时不 spawn', hBadPolicy.subprocess.calls.length === bpSubBefore, String(hBadPolicy.subprocess.calls.length - bpSubBefore))
hBadPolicy.dispose()

// ── (5) hostTools 识别:内置 + 启发式;文件/RPC 工具不误认 ──
phase('§3.5 宿主工具识别(只用于展示)')
const tenantBashDef = {
  name: 'tenant_bash',
  description: 'Run a Bash command in the tenant workspace',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
}
const readFilesDef = {
  name: 'ops_read_files',
  description: 'Read files from the workspace',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}
const runCmdDef = { name: 'run_cmd', description: 'Run a task', parameters: { type: 'object', properties: { task: { type: 'string' } } } }
const paletteDef = {
  name: 'wc_cmd_palette',
  description: 'Command palette UI',
  parameters: { type: 'object', properties: { palette: { type: 'string' } } },
}
const hHost = start(
  {
    shippedTools: ['ops_bash', 'pwsh'],
    agentIds: ['agent-host'],
    shellDefinitions: [tenantBashDef, readFilesDef, runCmdDef, paletteDef],
  },
  { syncIntervalMs: 25 },
)
await waitForBrief(hHost)
// 这一节只验「识别」:关掉遮挡开关,让两族工具都留在可见面里(遮挡行为见 §5)
await post(hHost, { op: 'setOption', blockOtherFamily: false })
const hostSnap = await pollSnapshot(
  hHost,
  (s) => Boolean(s.commandTool) && ['tenant_bash', 'ops_bash', 'pwsh'].every((name) => (s.commandTool.hostTools || []).some((t) => t.name === name)),
  9000,
)
const hostTools = hostSnap.commandTool.hostTools || []
const hostNames = hostTools.map((t) => t.name)
const hostOf = (name) => hostTools.find((t) => t.name === name) || null
check('内置 ops_bash 被认出(bash 家族、learned=false)', Boolean(hostOf('ops_bash')) && hostOf('ops_bash').family === 'bash' && hostOf('ops_bash').learned === false, JSON.stringify(hostTools))

check('内置 pwsh 被认出(powershell 家族、learned=false)', Boolean(hostOf('pwsh')) && hostOf('pwsh').family === 'powershell' && hostOf('pwsh').learned === false, JSON.stringify(hostTools))
check('hostTools[].group:ops_bash=bash / pwsh=powershell', hostOf('ops_bash').group === 'bash' && hostOf('pwsh').group === 'powershell', JSON.stringify(hostTools.map((t) => t.name + ':' + t.group)))
check('启发式 tenant_bash(有 command 参数)→ bash 家族、learned=true', Boolean(hostOf('tenant_bash')) && hostOf('tenant_bash').family === 'bash' && hostOf('tenant_bash').learned === true, JSON.stringify(hostTools))
check(
  'run_cmd / wc_cmd_palette(名字有 cmd 但没有命令参数)不误认',
  !hostNames.includes('run_cmd') && !hostNames.includes('wc_cmd_palette'),
  JSON.stringify(hostNames),
)
check('ops_read_files(文件工具)不误认', !hostNames.includes('ops_read_files'), JSON.stringify(hostNames))
check(
  'hostTools 排序稳定:内置顺序优先,其余按名字',
  hostNames.join(',') === ['pwsh', 'ops_bash', 'tenant_bash'].filter((n) => hostNames.includes(n)).join(','),
  JSON.stringify(hostNames),
)
// 展示用的识别结果绝不改变「谁可见」:所有宿主工具都还在
check(
  '识别结果只是展示:run_cmd / ops_read_files / tenant_bash 全都仍然可见',
  Boolean(hHost.toolsFor('agent-host').get('run_cmd')) &&
    Boolean(hHost.toolsFor('agent-host').get('ops_read_files')) &&
    Boolean(hHost.toolsFor('agent-host').get('tenant_bash')),
  JSON.stringify(hostSnap.commandTool.hostTools),
)
check('关掉遮挡开关后识别过程不调用 restrict(没有遮挡目标)', hHost.stats().restrictCalls === 0, JSON.stringify(hHost.stats().restrictAttempts))
hHost.dispose()

// 名字集合有界(≤64)
phase('§3.5b hostTools 名字集合有界')
const manyDefs = Array.from({ length: 70 }, (_, i) => ({
  name: 'tenant_bash_' + i,
  description: 'tenant bash ' + i,
  parameters: { type: 'object', properties: { command: { type: 'string' } } },
}))
const hMany = start({ agentIds: ['agent-many'], shellDefinitions: manyDefs })
await waitForBrief(hMany)
const manySnap = await pollSnapshot(hMany, (s) => Boolean(s.commandTool) && (s.commandTool.hostTools || []).length > 0, 6000)
check('hostTools 名字集合有界(≤64)', (manySnap.commandTool.hostTools || []).length <= 64, String((manySnap.commandTool.hostTools || []).length))
hMany.dispose()

// 老宿主没有 tools.definitions:退回按内置名字探可见性
phase('§3.5c 老宿主(没有 definitions)')
const hNoDefs = start({ shippedTools: ['ops_bash'], agentIds: ['agent-nd'], definitions: false })
await waitForBrief(hNoDefs)
const ndSnap = await pollSnapshot(hNoDefs, (s) => Boolean(s.commandTool) && (s.commandTool.hostTools || []).length > 0, 6000)
check(
  '老宿主:按名字探可见性也能认出 ops_bash',
  (ndSnap.commandTool.hostTools || []).some((t) => t.name === 'ops_bash'),
  JSON.stringify(ndSnap.commandTool.hostTools),
)
check(
  '老宿主路径不谎报 learned(只能按内置名单认)',
  (ndSnap.commandTool.hostTools || []).every((t) => t.name !== 'ops_bash' || t.learned === false),
  JSON.stringify(ndSnap.commandTool.hostTools),
)
hNoDefs.dispose()

// ── (6) /envdock-api 新形状:没有接管时代的字段,syncStats 只剩白名单 ──
phase('§3.6 API 形状')
const hShape = start()
await waitForBrief(hShape)
const shapeSnap = (await callApi(hShape)).json
const commandToolKeys = Object.keys(shapeSnap.commandTool).sort()
check(
  'commandTool 有 0.6 的 17 个键(旧 8 + 两族 9)',
  JSON.stringify(commandToolKeys) ===
    JSON.stringify(['blockOtherFamily', 'displayOnly', 'family', 'familyFallback', 'familySource', 'hidden', 'hostTools', 'mixed', 'name', 'refuseOnly', 'refuseWhenConfined', 'registered', 'sandbox', 'sessions', 'shell', 'skipReason', 'visible']),
  JSON.stringify(commandToolKeys),
)
const legacyCommandFields = [
  'scopes',
  'kind',
  'hostName',
  'denies',
  'hostOnlyScopes',
  'sandboxHiddenScopes',
  'scopeAnomalies',
  'yieldTicks',
  'takeover',
  'reuse',
  'sandboxMode',
  'sandboxConfined',
  'sandboxDelegate',
  'sandboxPolicyKnown',
  'sameFamilyTool',
]
const presentLegacy = legacyCommandFields.filter((key) => Object.prototype.hasOwnProperty.call(shapeSnap.commandTool, key))
check('commandTool 没有接管时代的字段(scopes/kind/denies/takeover …)', presentLegacy.length === 0, JSON.stringify(presentLegacy))
check(
  'commandTool.family 是 bash/powershell/空,familySource 是 auto/manual',
  ['bash', 'powershell', ''].includes(shapeSnap.commandTool.family) && ['auto', 'manual'].includes(shapeSnap.commandTool.familySource),
  JSON.stringify({ family: shapeSnap.commandTool.family, source: shapeSnap.commandTool.familySource }),
)
check(
  'commandTool.sessions 是四元组数字(total/bash/powershell/other)',
  Boolean(shapeSnap.commandTool.sessions) && ['total', 'bash', 'powershell', 'other'].every((key) => typeof shapeSnap.commandTool.sessions[key] === 'number'),
  JSON.stringify(shapeSnap.commandTool.sessions),
)
check(
  'commandTool.hidden / refuseOnly / displayOnly 是字符串数组,且不含 bash 族名字',
  ['hidden', 'refuseOnly', 'displayOnly'].every((key) => Array.isArray(shapeSnap.commandTool[key]) && shapeSnap.commandTool[key].every((name) => typeof name === 'string')) &&
    bashNamesIn(shapeSnap.commandTool.hidden).length === 0 &&
    bashNamesIn(shapeSnap.commandTool.refuseOnly).length === 0,
  JSON.stringify({ hidden: shapeSnap.commandTool.hidden, refuseOnly: shapeSnap.commandTool.refuseOnly, displayOnly: shapeSnap.commandTool.displayOnly }),
)
check(
  '顶层 family / familySource 报出全局默认族(API 没有会话)',
  ['bash', 'powershell', ''].includes(shapeSnap.family) && ['auto', 'manual'].includes(shapeSnap.familySource),
  JSON.stringify({ family: shapeSnap.family, source: shapeSnap.familySource }),
)
check('hostTools[].group 每项都存在(空串 = cmd/wsl 等不参与两族)', (shapeSnap.commandTool.hostTools || []).every((tool) => tool && typeof tool.group === 'string'), JSON.stringify(shapeSnap.commandTool.hostTools))
check(
  'sandbox 是 §1.4 的聚合形状(没有 scopes)',
  JSON.stringify(Object.keys(shapeSnap.sandbox).sort()) ===
    JSON.stringify(['anyUnconfined', 'capable', 'confinedCount', 'defaultMode', 'delegatable', 'policyKnown', 'present', 'sessionCount']),
  JSON.stringify(Object.keys(shapeSnap.sandbox).sort()),
)
check(
  'sandbox.delegatable 是布尔(没有 ctx.shell 时为 false)',
  typeof shapeSnap.sandbox.delegatable === 'boolean' &&
    typeof shapeSnap.commandTool.sandbox.delegatable === 'boolean' &&
    shapeSnap.sandbox.delegatable === false,
  JSON.stringify({ top: shapeSnap.sandbox.delegatable, ct: shapeSnap.commandTool.sandbox.delegatable }),
)

const statsKeys = Object.keys(shapeSnap.syncStats).sort()
check(
  'syncStats 只剩 0.6 白名单的 11 个字段(旧 9 + restrictApplied/guardRefusals)',
  JSON.stringify(statsKeys) ===
    JSON.stringify(['detections', 'guardRefusals', 'hostToolScans', 'intervalMs', 'lastAt', 'lastDetectMs', 'lastError', 'lastErrorAt', 'registerTries', 'restrictApplied', 'ticks']),
  JSON.stringify(statsKeys),
)
const legacyStats = ['registers', 'disposes', 'denyApplies', 'denyDrops', 'guardDenials', 'guardReady', 'yieldTicks', 'unrestrictable', 'blockedScopes', 'lostDenies', 'delegateCalls', 'delegateTries', 'delegateRefusals', 'delegateFailures', 'delegateRunnerFailures', 'delegateAborts', 'ownHides', 'hostDenyApplies', 'denyNoops', 'transientMisses', 'sandboxScopes', 'sandboxBlocked', 'scopeAnomalies', 'runtimeShellTools', 'executorFamily', 'hasExecutableApi', 'steadyNow', 'steadyTicks']
const presentLegacyStats = legacyStats.filter((key) => Object.prototype.hasOwnProperty.call(shapeSnap.syncStats, key))
check('syncStats 没有 deny/delegate/guard/steady 之类的旧计数', presentLegacyStats.length === 0, JSON.stringify(presentLegacyStats))
check('顶层不再有 shippedShell(认领哪个宿主 shell 已无意义)', !Object.prototype.hasOwnProperty.call(shapeSnap, 'shippedShell'))
check(
  '顶层其余字段保持不变',
  ['state', 'shell', 'platform', 'pathInfo', 'tools', 'terminals', 'versionManagers', 'issues', 'brief', 'detectedAt', 'hasSubprocess', 'family', 'familySource'].every(
    (key) => Object.prototype.hasOwnProperty.call(shapeSnap, key),
  ),
  JSON.stringify(Object.keys(shapeSnap).sort()),
)
hShape.dispose()

// ── (7) 状态文件里旧 shellTakeover / sandboxTakeover 被忽略(读取不报错、写回不保留)──
phase('§3.7 旧状态字段')
writeFileSync(
  join(home, 'envdock.json'),
  JSON.stringify({ options: { injectBrief: true, allowLan: false, shellTakeover: 'off', sandboxTakeover: 'refuse' } }),
  'utf8',
)
const hLegacy = start()
await waitForBrief(hLegacy)
const legacySnap = (await callApi(hLegacy)).json
check('旧状态文件读取不报错', legacySnap.ok === true && legacySnap.state.options.injectBrief === true)
check(
  '旧 shellTakeover / sandboxTakeover 被忽略(不在归一化后的 options 里)',
  !Object.prototype.hasOwnProperty.call(legacySnap.state.options, 'shellTakeover') &&
    !Object.prototype.hasOwnProperty.call(legacySnap.state.options, 'sandboxTakeover'),
  JSON.stringify(legacySnap.state.options),
)
check('归一化后只剩 injectBrief / allowLan / blockOtherFamily', Object.keys(legacySnap.state.options).sort().join(',') === 'allowLan,blockOtherFamily,injectBrief', JSON.stringify(Object.keys(legacySnap.state.options)))
const legacyWrite = await post(hLegacy, { op: 'setOption', injectBrief: true })
check('旧状态文件可以正常写回(不迁移、不报错)', legacyWrite.status === 200 && legacyWrite.json.ok === true, String(legacyWrite.status))
const diskOptions = JSON.parse(readFileSync(join(home, 'envdock.json'), 'utf8')).options || {}
check(
  '写回不保留旧字段',
  !Object.prototype.hasOwnProperty.call(diskOptions, 'shellTakeover') &&
    !Object.prototype.hasOwnProperty.call(diskOptions, 'sandboxTakeover') &&
    Object.keys(diskOptions).sort().join(',') === 'allowLan,blockOtherFamily,injectBrief',
  JSON.stringify(diskOptions),
)
hLegacy.dispose()

// ── (8) 视口/回归:切终端后立刻按新终端执行(简报与执行不许各说一套)──
phase('§3.8 切终端后立即生效')
const hSwitch = start({ shippedTools: [], agentIds: ['agent-switch'] })
await waitForBrief(hSwitch)
await waitCommandTool(hSwitch, (c) => c.registered === true)
const switchBeforeFamily = (await callApi(hSwitch)).json.shell.family
const switchTarget = switchBeforeFamily === 'cmd' ? 'auto' : 'cmd'
await post(hSwitch, { op: 'setShell', key: switchTarget })
const switchedSnap = (await callApi(hSwitch)).json
const switched = switchedSnap.shell
check('手动 cmd 不参与两族(顶层 family 为空、source=manual)', switchedSnap.family === '' && switchedSnap.familySource === 'manual', JSON.stringify({ family: switchedSnap.family, source: switchedSnap.familySource }))
const switchTool = hSwitch.state.toolDefs.get('envd_shell')
const switchSpawns = hSwitch.subprocess.calls.length
await switchTool.execute({ command: 'echo switched', cwd: process.cwd() }, { signal: null })
const switchSpawn = hSwitch.subprocess.calls.slice(switchSpawns).find((c) => (c.argv || []).join(' ').includes('switched'))
check(
  'setShell 之后下一单立刻用新终端(不等下一轮对账)',
  Boolean(switchSpawn) && invocationLooksRight(switched.family, switchSpawn.argv, 'echo switched'),
  JSON.stringify({ family: switched.family, argv: switchSpawn && switchSpawn.argv }),
)
check('切终端不动注册表(envd_shell 还在,名字不变)', hSwitch.state.toolDefs.has('envd_shell'))
await resetState(hSwitch)
hSwitch.dispose()

// ── 卸载:不许留下幽灵工具(占着固定名会让下一次启用永远判成「已被占用」)──
phase('§3.9 卸载清理')
const hDrop = start({ shippedTools: [], agentIds: ['agent-drop'] })
await waitForBrief(hDrop)
await waitCommandTool(hDrop, (c) => c.registered === true)
check('卸载前 envd_shell 在注册表里', hDrop.state.toolDefs.has('envd_shell'))
hDrop.dispose()
await sleep(150)
check('卸载后 envd_shell 从注册表消失(没有幽灵工具)', !hDrop.state.toolDefs.has('envd_shell'))
const afterDisposeTool = hDrop.state.toolDefs.has('envd_shell')
check('卸载后不再注册(定时器已清)', afterDisposeTool === false)

// ══════════════════════════════════════════════════════════════════════
//  §5 两族(0.6):按会话选族 + bash 族会话遮挡 PowerShell 族内置命令工具
//  编号与规划 §5 的 16 个用例一一对应(test name 以 5.N 开头,方便核对)。
//  夹具能力:全局层 / 祖先层(shellDefinitions)/ 作用域自有层(agentTools)。
// ══════════════════════════════════════════════════════════════════════
await resetState(h)
phase('§5 两族(0.6)')

// ── 5.1 无 bash 族:会话族 powershell、envd_shell 用 PowerShell 7、restrict 0 次、guard 不拒绝 pwsh ──
{
  const h51 = start({ shippedTools: ['pwsh'], agentIds: ['agent-51'] }, { syncIntervalMs: 25 })
  await waitForBrief(h51)
  const s51 = recordFamilySnap('5.1', await waitCommandTool(h51, (c) => c.registered === true && c.family === 'powershell', 9000))
  const agent51 = agentById(h51, 'agent-51')
  const reason51 = h51.guardReason('pwsh', agent51)
  if (!hasTerminalFamily(s51, 'powershell')) {
    skip('5.1 无 bash 族 → 会话族 powershell / envd_shell 用 PowerShell 7', '本机没有 PowerShell 族终端')
  } else {
    check('5.1 无 bash 族工具 → 会话族 powershell(自动判定)', s51.commandTool.family === 'powershell' && s51.commandTool.familySource === 'auto', JSON.stringify({ family: s51.commandTool.family, source: s51.commandTool.familySource }))
    check('5.1 会话统计:powershell=1 / bash=0', Boolean(s51.commandTool.sessions) && s51.commandTool.sessions.total === 1 && s51.commandTool.sessions.powershell === 1 && s51.commandTool.sessions.bash === 0, JSON.stringify(s51.commandTool.sessions))
    check('5.1 不遮挡(restrict 0 次 / deny 空)', h51.stats().restrictCalls === 0 && Object.keys(h51.stats().activeDenies).length === 0, JSON.stringify(h51.stats().restrictAttempts))
    check('5.1 guard 不拒绝 pwsh', reason51 === undefined, String(reason51))
    check('5.1 envd_shell 已注册(skipReason=null)', s51.commandTool.registered === true && s51.commandTool.skipReason === null, JSON.stringify(s51.commandTool))
    const tool51 = h51.state.toolDefs.get('envd_shell')
    const before51 = h51.subprocess.calls.length
    const run51 = tool51 ? await tool51.execute({ command: 'echo p51', cwd: process.cwd() }, { signal: null, agent: agent51 }) : null
    const spawn51 = h51.subprocess.calls.slice(before51)
    check('5.1 envd_shell 用 PowerShell 7 执行(-NoLogo -Command)', Boolean(run51) && run51.ok === true && spawn51.length === 1 && invocationLooksRight('powershell', spawn51[0].argv, 'echo p51'), JSON.stringify(spawn51.map((c) => c.argv)))
    check('5.1 commandTool.shell 报 PowerShell 7', /PowerShell 7/i.test(String(s51.commandTool.shell && s51.commandTool.shell.label)), JSON.stringify(s51.commandTool.shell))
  }
  h51.dispose()
}

// ── 5.2 有 ops_bash:会话族 bash、envd_shell 注册且用 Git Bash(argv 走 bash -lc)、不再 same-family 跳过 ──
{
  const h52 = start({ shippedTools: ['ops_bash'], agentIds: ['agent-52'] }, { syncIntervalMs: 25 })
  await waitForBrief(h52)
  const s52 = recordFamilySnap('5.2', await waitCommandTool(h52, (c) => c.registered === true && c.family === 'bash', 9000))
  if (!hasTerminalFamily(s52, 'bash')) {
    skip('5.2 有 ops_bash → 会话族 bash / envd_shell 用 Git Bash', '本机没有 bash 族终端')
  } else {
    check('5.2 有 ops_bash → 会话族 bash', s52.commandTool.family === 'bash' && s52.commandTool.familySource === 'auto', JSON.stringify({ family: s52.commandTool.family, source: s52.commandTool.familySource }))
    check('5.2 不再有 same-family 跳过(skipReason=null 且已注册)', s52.commandTool.skipReason === null && s52.commandTool.registered === true, JSON.stringify({ skipReason: s52.commandTool.skipReason, registered: s52.commandTool.registered }))
    check('5.2 commandTool.shell 用 Git Bash', s52.commandTool.shell.family === 'bash' && /bash/i.test(String(s52.commandTool.shell.label)), JSON.stringify(s52.commandTool.shell))
    const tool52 = h52.state.toolDefs.get('envd_shell')
    const before52 = h52.subprocess.calls.length
    const run52 = await tool52.execute({ command: 'echo p52', cwd: process.cwd() }, { signal: null, agent: agentById(h52, 'agent-52') })
    const spawn52 = h52.subprocess.calls.slice(before52)
    check('5.2 envd_shell 走 bash -lc(Git Bash 语法)', run52.ok === true && spawn52.length === 1 && invocationLooksRight('bash', spawn52[0].argv, 'echo p52'), JSON.stringify(spawn52.map((c) => c.argv)))
    check('5.2 宿主 ops_bash 与 envd_shell 同时可用(不是二选一)', Boolean(h52.toolsFor('agent-52').get('ops_bash')) && h52.state.toolDefs.has('envd_shell'))
  }
  h52.dispose()
}

// ── 5.3 有 ops_bash 且内置 pwsh 在全局层:deny {pwsh}、ops_bash 不在其中;guard 拒绝 pwsh 且不 spawn ──
{
  const h53 = start({ shippedTools: ['ops_bash', 'pwsh'], agentIds: ['agent-53'] }, { syncIntervalMs: 25 })
  await waitForBrief(h53)
  const s53 = recordFamilySnap('5.3', await waitCommandTool(h53, (c) => (c.hidden || []).includes('pwsh'), 9000))
  const agent53 = agentById(h53, 'agent-53')
  const stats53 = h53.stats()
  const deny53 = stats53.activeDenies['agent-53'] || []
  check('5.3 该 agent 的 deny 正好 {pwsh}', JSON.stringify(deny53) === '["pwsh"]', JSON.stringify(stats53.activeDenies))
  check('5.3 ops_bash 不在 deny 里(bash 族永不被遮)', !deny53.includes('ops_bash'), JSON.stringify(deny53))
  check('5.3 commandTool.hidden=[pwsh](继承层可 restrict)', JSON.stringify(s53.commandTool.hidden) === '["pwsh"]' && (s53.commandTool.refuseOnly || []).length === 0, JSON.stringify({ hidden: s53.commandTool.hidden, refuseOnly: s53.commandTool.refuseOnly }))
  check('5.3 restrict 只在 agent 作用域(没有根层调用)', stats53.restrictAttempts.length > 0 && stats53.restrictAttempts.every((attempt) => attempt.scope !== '(root)'), JSON.stringify(stats53.restrictAttempts))
  check('5.3 guard 在根层注册一次', stats53.guards === 1 && stats53.guardScopes.join(',') === '(root)', JSON.stringify({ guards: stats53.guards, scopes: stats53.guardScopes }))
  const before53 = h53.subprocess.calls.length
  const reason53 = h53.guardReason('pwsh', agent53)
  check(
    '5.3 guard 拒绝 pwsh(说清被隐藏 + 改用 ops_bash/envd_shell + bash 语法)',
    typeof reason53 === 'string' && reason53.includes('隐藏') && reason53.includes('ops_bash') && reason53.includes('bash 语法'),
    String(reason53),
  )
  check('5.3 guard 求理由不 spawn(命令没跑)', h53.subprocess.calls.length === before53, String(h53.subprocess.calls.length - before53))
  check('5.3 guard 不拒绝 ops_bash', h53.guardReason('ops_bash', agent53) === undefined, String(h53.guardReason('ops_bash', agent53)))
  const defs53 = h53.toolsFor('agent-53').definitions(agent53).map((d) => d.name)
  check('5.3 隐藏后该会话定义面里没有 pwsh(全局注册还在)', !defs53.includes('pwsh') && h53.state.toolDefs.has('pwsh'), JSON.stringify(defs53))
  const view53 = h53.toolsFor('agent-53').view(agent53)
  check('5.3 pwsh 仍登记在 knownNames/restrictableNames(只挡可见性,不注销)', view53.knownNames.has('pwsh') && view53.restrictableNames.has('pwsh'), JSON.stringify([...view53.knownNames]))
  h53.dispose()
}

// ── 5.4 pwsh 在 agent 层(不可 restrict):不 restrict,只 guard 拒绝 ──
{
  const h54 = start({ shippedTools: ['ops_bash'], agentIds: ['agent-54'], agentTools: { 'agent-54': ['pwsh'] } }, { syncIntervalMs: 25 })
  await waitForBrief(h54)
  const s54 = recordFamilySnap('5.4', await waitCommandTool(h54, (c) => c.family === 'bash' && (c.refuseOnly || []).includes('pwsh'), 9000))
  const agent54 = agentById(h54, 'agent-54')
  check('5.4 自有层 pwsh → 不 restrict(hide 空 / restrict 0 次)', (s54.commandTool.hidden || []).length === 0 && h54.stats().restrictCalls === 0, JSON.stringify(h54.stats().restrictAttempts))
  check('5.4 refuseOnly 含 pwsh(只能 guard 拒绝)', (s54.commandTool.refuseOnly || []).includes('pwsh'), JSON.stringify(s54.commandTool.refuseOnly))
  const defs54 = h54.toolsFor('agent-54').definitions(agent54).map((d) => d.name)
  check('5.4 自有层 pwsh 仍然可见(restrict 挡不掉)', defs54.includes('pwsh') && Boolean(h54.toolsFor('agent-54').get('pwsh')), JSON.stringify(defs54))
  let restrictErr54 = ''
  try {
    h54.toolsFor('agent-54').restrict({ deny: ['pwsh'] })
  } catch (error) {
    restrictErr54 = String((error && error.message) || error)
  }
  check('5.4 对自有层名字 restrict 抛真机错误(names unknown global tool "pwsh")', /tools\.restrict\(\) names unknown global tool/.test(restrictErr54) && restrictErr54.includes('"pwsh"'), restrictErr54)
  check('5.4 guard 拒绝 pwsh(执行侧兜底)', typeof h54.guardReason('pwsh', agent54) === 'string', String(h54.guardReason('pwsh', agent54)))
  check('5.4 自有层注册没被删除/没被拆', Boolean(h54.toolsFor('agent-54').get('pwsh')))
  h54.dispose()
}

// ── 5.5 ops_bash 出现后消失:锁定 + sticky 记忆(族仍 bash、pwsh 仍隐藏);重新探测后解锁 ──
{
  const h55 = start({ shippedTools: ['pwsh'], agentIds: ['agent-55'] }, { syncIntervalMs: 25 })
  await waitForBrief(h55)
  const s55a = recordFamilySnap('5.5-initial', await waitCommandTool(h55, (c) => c.family === 'powershell', 9000))
  check('5.5 初始只有 pwsh → 会话族 powershell、不遮挡', s55a.commandTool.family === 'powershell' && (s55a.commandTool.hidden || []).length === 0, JSON.stringify(s55a.commandTool))
  // dsh-ops 晚挂载 ops_bash:往全局层加工具 + 派发 tools/change(10s 宽限内允许升级一次)
  const disposeOps55 = h55.tools.register({ name: 'ops_bash', description: 'shipped ops_bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } })
  h55.emit('tools/change')
  const s55b = recordFamilySnap('5.5-appear', await waitCommandTool(h55, (c) => c.family === 'bash' && (c.hidden || []).includes('pwsh'), 6000))
  check('5.5 10s 内出现 ops_bash → 升级成 bash 并遮挡 pwsh', s55b.commandTool.family === 'bash' && JSON.stringify(s55b.commandTool.hidden) === '["pwsh"]', JSON.stringify(s55b.commandTool))
  // 消失:锁定的族 + sticky 记忆,不能来回闪
  disposeOps55()
  h55.emit('tools/change')
  await sleep(250)
  const s55c = recordFamilySnap('5.5-gone', (await callApi(h55)).json)
  const deny55 = h55.stats().activeDenies['agent-55'] || []
  check('5.5 ops_bash 消失 → 会话族仍 bash(锁定,不立刻回退)', s55c.commandTool.family === 'bash', JSON.stringify({ family: s55c.commandTool.family, sessions: s55c.commandTool.sessions }))
  check('5.5 ops_bash 消失 → pwsh 仍被隐藏(sticky 记忆,不来回闪)', (s55c.commandTool.hidden || []).includes('pwsh') && deny55.includes('pwsh'), JSON.stringify({ hidden: s55c.commandTool.hidden, denies: deny55 }))
  // 重新探测:族锁定与遮挡记忆一起作废,按当前工具表重判
  await freshDetection(h55)
  const s55d = recordFamilySnap('5.5-redetect', await waitCommandTool(h55, (c) => c.family === 'powershell', 6000))
  check(
    '5.5 重新探测后解锁:会话族回 powershell、hide 空、deny 空',
    s55d.commandTool.family === 'powershell' && (s55d.commandTool.hidden || []).length === 0 && (h55.stats().activeDenies['agent-55'] || []).length === 0,
    JSON.stringify({ family: s55d.commandTool.family, hidden: s55d.commandTool.hidden, denies: h55.stats().activeDenies }),
  )
  h55.dispose()
}

// ── 5.6 手动 PowerShell 且有 ops_bash:不遮挡、不拒绝,mixed=true,简报有混用警告 ──
{
  await resetState(h)
  const base56 = (await callApi(h)).json
  const ps56 = (base56.terminals || []).find((t) => t.family === 'powershell')
  if (!ps56) {
    skip('5.6 手动 PowerShell + ops_bash → 不遮挡 / mixed', '本机没有 PowerShell 族终端')
  } else {
    await post(h, { op: 'setShell', key: ps56.key })
    const h56 = start({ shippedTools: ['ops_bash', 'pwsh'], agentIds: ['agent-56'] }, { syncIntervalMs: 25 })
    await waitForBrief(h56)
    const s56 = recordFamilySnap('5.6', await waitCommandTool(h56, (c) => c.familySource === 'manual' && c.family === 'powershell', 9000))
    const agent56 = agentById(h56, 'agent-56')
    check('5.6 手动 PowerShell → family=powershell / familySource=manual', s56.commandTool.family === 'powershell' && s56.commandTool.familySource === 'manual', JSON.stringify({ family: s56.commandTool.family, source: s56.commandTool.familySource }))
    check(
      '5.6 不遮挡(hidden/refuseOnly 空、deny 空、restrict 0 次)',
      (s56.commandTool.hidden || []).length === 0 && (s56.commandTool.refuseOnly || []).length === 0 && h56.stats().restrictCalls === 0 && Object.keys(h56.stats().activeDenies).length === 0,
      JSON.stringify({ hidden: s56.commandTool.hidden, refuses: h56.stats().restrictAttempts }),
    )
    check('5.6 不拒绝(guard 对 pwsh 放行)', h56.guardReason('pwsh', agent56) === undefined, String(h56.guardReason('pwsh', agent56)))
    check('5.6 mixed=true(两族同时可见)', s56.commandTool.mixed === true, JSON.stringify(s56.commandTool.mixed))
    const line56 = String(s56.brief).split('\n').find((l) => l.includes('命令工具')) || ''
    check('5.6 简报有混用警告(两族同时可见 / 不要混写 / 手动选择)', line56.includes('两族同时可见') && line56.includes('不要混写') && line56.includes('手动选择'), line56)
    h56.dispose()
    await resetState(h)
  }
}

// ── 5.7 手动 bash 且有 pwsh(且会话有 bash 族工具):遮挡 pwsh ──
{
  await resetState(h)
  const base57 = (await callApi(h)).json
  const bash57 = (base57.terminals || []).find((t) => t.family === 'bash')
  if (!bash57) {
    skip('5.7 手动 bash + pwsh → 遮挡', '本机没有 bash 族终端')
  } else {
    await post(h, { op: 'setShell', key: bash57.key })
    const h57 = start({ shippedTools: ['ops_bash', 'pwsh'], agentIds: ['agent-57'] }, { syncIntervalMs: 25 })
    await waitForBrief(h57)
    const s57 = recordFamilySnap('5.7', await waitCommandTool(h57, (c) => c.family === 'bash' && c.familySource === 'manual' && (c.hidden || []).includes('pwsh'), 9000))
    const agent57 = agentById(h57, 'agent-57')
    check('5.7 手动 bash → family=bash / familySource=manual 且遮挡 pwsh', s57.commandTool.family === 'bash' && s57.commandTool.familySource === 'manual' && JSON.stringify(s57.commandTool.hidden) === '["pwsh"]', JSON.stringify({ family: s57.commandTool.family, source: s57.commandTool.familySource, hidden: s57.commandTool.hidden }))
    const deny57 = h57.stats().activeDenies['agent-57'] || []
    check('5.7 deny={pwsh},ops_bash 不在其中', JSON.stringify(deny57) === '["pwsh"]', JSON.stringify(deny57))
    check('5.7 guard 拒绝 pwsh', typeof h57.guardReason('pwsh', agent57) === 'string', String(h57.guardReason('pwsh', agent57)))
    h57.dispose()
    await resetState(h)
  }
}

// ── 5.8 blockOtherFamily=false:无 restrict、无 guard 拒绝,简报说明未隐藏 ──
{
  await resetState(h)
  await post(h, { op: 'setOption', blockOtherFamily: false })
  const h58 = start({ shippedTools: ['ops_bash', 'pwsh'], agentIds: ['agent-58'] }, { syncIntervalMs: 25 })
  await waitForBrief(h58)
  const s58 = recordFamilySnap('5.8', await waitCommandTool(h58, (c) => c.family === 'bash' && c.blockOtherFamily === false, 9000))
  const agent58 = agentById(h58, 'agent-58')
  check('5.8 commandTool.blockOtherFamily=false(状态已落盘)', s58.commandTool.blockOtherFamily === false, JSON.stringify(s58.commandTool.blockOtherFamily))
  check(
    '5.8 不发 restrict(hidden 空 / restrict 0 次 / deny 空)',
    (s58.commandTool.hidden || []).length === 0 && (s58.commandTool.refuseOnly || []).length === 0 && h58.stats().restrictCalls === 0 && Object.keys(h58.stats().activeDenies).length === 0,
    JSON.stringify({ hidden: s58.commandTool.hidden, attempts: h58.stats().restrictAttempts }),
  )
  check('5.8 guard 不拒绝 pwsh', h58.guardReason('pwsh', agent58) === undefined, String(h58.guardReason('pwsh', agent58)))
  check('5.8 pwsh 仍然可见(没被隐藏)', Boolean(h58.toolsFor('agent-58').get('pwsh')))
  const line58 = String(s58.brief).split('\n').find((l) => l.includes('命令工具')) || ''
  check('5.8 简报说明「未隐藏」', line58.includes('未隐藏'), line58)
  h58.dispose()
  await resetState(h)
}

// ── 5.9 启发式认出的 PowerShell 族名字(tenant_pwsh,描述含 command):只 displayOnly ──
{
  const h59 = start(
    {
      shippedTools: ['ops_bash'],
      agentIds: ['agent-59'],
      shellDefinitions: [
        {
          name: 'tenant_pwsh',
          description: 'Run a command with PowerShell 7',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      ],
    },
    { syncIntervalMs: 25 },
  )
  await waitForBrief(h59)
  const s59 = recordFamilySnap('5.9', await waitCommandTool(h59, (c) => (c.displayOnly || []).includes('tenant_pwsh'), 9000))
  check('5.9 启发式 PowerShell 名进 displayOnly', (s59.commandTool.displayOnly || []).includes('tenant_pwsh'), JSON.stringify(s59.commandTool.displayOnly))
  check('5.9 不进 hide / refuseOnly(不遮挡不拒绝)', !(s59.commandTool.hidden || []).includes('tenant_pwsh') && !(s59.commandTool.refuseOnly || []).includes('tenant_pwsh'), JSON.stringify({ hidden: s59.commandTool.hidden, refuseOnly: s59.commandTool.refuseOnly }))
  check('5.9 不发 restrict(只展示)', h59.stats().restrictCalls === 0, JSON.stringify(h59.stats().restrictAttempts))
  check('5.9 guard 不拒绝 tenant_pwsh', h59.guardReason('tenant_pwsh', agentById(h59, 'agent-59')) === undefined, String(h59.guardReason('tenant_pwsh', agentById(h59, 'agent-59'))))
  check('5.9 tenant_pwsh 仍然可见', Boolean(h59.toolsFor('agent-59').get('tenant_pwsh')))
  const line59 = String(s59.brief).split('\n').find((l) => l.includes('命令工具')) || ''
  check('5.9 简报标成「只展示、未遮挡」', line59.includes('只展示'), line59)
  h59.dispose()
}

// ── 5.10 不变量:任何场景 hide / refuse 都不含 bash 族名字 ──
{
  const snapshotOffenders = []
  for (const item of familySnapshots) {
    for (const field of ['hidden', 'refuseOnly', 'displayOnly']) {
      const bad = bashNamesIn(item.commandTool[field])
      if (bad.length) snapshotOffenders.push(item.label + '.' + field + ':' + bad.join(','))
    }
  }
  check('5.10 任何场景的 hide/refuse/displayOnly 都不含 bash 族名字', snapshotOffenders.length === 0, JSON.stringify(snapshotOffenders))
  const denyOffenders = fixtures.flatMap((cur) => {
    let statsCur = null
    try {
      statsCur = cur.stats()
    } catch {}
    if (!statsCur) return []
    return [...deniedIn(cur), ...restrictedIn(cur)].filter((name) => bashNamesIn([name]).length > 0)
  })
  check('5.10 所有夹具的 deny / restrict 目标都不含 bash 族名字', denyOffenders.length === 0, JSON.stringify(denyOffenders))
}

// ── 5.11 不变量:restrict 从不在根层调用(夹具根层 restrict 直接抛错) ──
{
  let rootErr = ''
  try {
    h.tools.restrict({ deny: ['pwsh'] })
  } catch (error) {
    rootErr = String((error && error.message) || error)
  }
  check('5.11 夹具根层 tools.restrict 直接抛错(真机口径)', /scoped context/.test(rootErr), rootErr)
  // 排除上面那条「故意打上去」的探针,其余所有 restrict 尝试都必须在 agent 作用域
  const rootAttempts = fixtures.flatMap((cur) =>
    cur.stats().restrictAttempts.filter((attempt) => attempt.scope === '(root)' && !/scoped context/.test(attempt.error)),
  )
  check('5.11 全程没有真实的根层 restrict 调用', rootAttempts.length === 0, JSON.stringify(rootAttempts.slice(0, 5)))
  const rootApplied = fixtures.flatMap((cur) => cur.stats().restrictAttempts.filter((attempt) => attempt.scope === '(root)' && attempt.ok))
  check('5.11 根层 restrict 一次都没有成功落地', rootApplied.length === 0, JSON.stringify(rootApplied))
}

// ── 5.12 agent/disposed 撤销遮挡;关闭开关后全部撤销 ──
{
  const h512 = start({ shippedTools: ['ops_bash', 'pwsh'], agentIds: ['agent-512'] }, { syncIntervalMs: 25 })
  await waitForBrief(h512)
  recordFamilySnap('5.12', await waitCommandTool(h512, (c) => (c.hidden || []).includes('pwsh'), 9000))
  const agent512 = agentById(h512, 'agent-512')
  check('5.12 遮挡已生效(deny 含 pwsh)', (h512.stats().activeDenies['agent-512'] || []).includes('pwsh'), JSON.stringify(h512.stats().activeDenies))
  h512.disposeAgent(agent512)
  await sleep(300)
  let stats512 = null
  try {
    stats512 = h512.stats()
  } catch {}
  check('5.12 agent/disposed 后该作用域 deny 全清', Boolean(stats512) && (stats512.activeDenies['agent-512'] || []).length === 0, JSON.stringify(stats512 && stats512.activeDenies))
  check('5.12 agent/disposed 后 agents.list() 里没有它', Boolean(stats512) && !stats512.agents.includes('agent-512'), JSON.stringify(stats512 && stats512.agents))
  check('5.12 restrict disposer 已撤销:pwsh 在作用域里重新可见', Boolean(h512.toolsFor('agent-512').get('pwsh')))
  check('5.12 注销后简报不再说「已隐藏」', !String(h512.state.brief.text({ scope: agent512 })).includes('已隐藏'), String(h512.state.brief.text({ scope: agent512 })).split('\n').find((l) => l.includes('命令工具')) || '')
  h512.dispose()

  // 关闭开关 → 一个对账周期内 deny 全清(不等 5s tick)
  const h512b = start({ shippedTools: ['ops_bash', 'pwsh'], agentIds: ['agent-512b'] }, { syncIntervalMs: 25 })
  await waitForBrief(h512b)
  await waitCommandTool(h512b, (c) => (c.hidden || []).includes('pwsh'), 9000)
  const started512 = Date.now()
  await post(h512b, { op: 'setOption', blockOtherFamily: false })
  const s512b = await waitCommandTool(h512b, (c) => (c.hidden || []).length === 0, 3000)
  check(
    '5.12 关闭开关后一个对账周期内 deny 全清',
    (s512b.commandTool.hidden || []).length === 0 && (h512b.stats().activeDenies['agent-512b'] || []).length === 0,
    JSON.stringify({ hidden: s512b.commandTool.hidden, denies: h512b.stats().activeDenies, ms: Date.now() - started512 }),
  )
  await post(h512b, { op: 'setOption', blockOtherFamily: true })
  h512b.dispose()
}

// ── 5.13 振荡:遮挡稳定后连续 10 次对账,restrict 调用次数不超过 1 ──
{
  const h513 = start({ shippedTools: ['ops_bash', 'pwsh'], agentIds: ['agent-513'] }, { syncIntervalMs: 25 })
  await waitForBrief(h513)
  await waitCommandTool(h513, (c) => (c.hidden || []).includes('pwsh'), 9000)
  const before513 = h513.stats().restrictCalls
  for (let i = 0; i < 10; i++) await post(h513, { op: 'setOption', injectBrief: true }) // 每次写入都触发一次立即对账
  const after513 = h513.stats().restrictCalls
  check('5.13 连续 10 次对账 restrict 调用不超过 1 次', after513 - before513 <= 1, String(after513 - before513))
  check('5.13 稳态后 deny 仍是 {pwsh}(没有来回拆建)', JSON.stringify(h513.stats().activeDenies['agent-513'] || []) === '["pwsh"]', JSON.stringify(h513.stats().activeDenies))
  const snap513 = recordFamilySnap('5.13', (await callApi(h513)).json)
  check('5.13 稳态隐藏集合没漂移', JSON.stringify(snap513.commandTool.hidden) === '["pwsh"]', JSON.stringify(snap513.commandTool.hidden))
  h513.dispose()
}

// ── 5.14 受限 bash 族会话:能委托 → 简报说「在沙箱内执行」;不能委托 → 简报/拒绝改口径 ──
{
  const h514 = start(
    {
      shippedTools: ['ops_bash', 'pwsh'],
      agentIds: [
        { id: 'agent-514', session: { key: 'f514' } },
        { id: 'agent-514-free', session: { key: 'f514-free' } },
      ],
      shell: fakeSandboxedShell({ mode: 'workspace-write' }),
      sandboxPolicy: fakeSandboxPolicy('workspace-write', { 'f514-free': 'danger-full-access' }),
    },
    { syncIntervalMs: 25 },
  )
  await waitForBrief(h514)
  recordFamilySnap('5.14', await waitCommandTool(h514, (c) => c.family === 'bash' && (c.hidden || []).includes('pwsh'), 9000))
  const locked514 = agentById(h514, 'agent-514')
  const brief514 = String(h514.state.brief.text({ scope: locked514 }))
  const line514 = brief514.split('\n').find((l) => l.includes('命令工具')) || ''
  check(
    '5.14 受限 bash 族简报含「沙箱内执行」与 ops_bash,不含「会拒绝」',
    line514.includes('会通过宿主执行器在沙箱内执行') && line514.includes('ops_bash') && !line514.includes('会拒绝'),
    line514,
  )
  check('5.14 不再出现旧文案「优先 envd_shell」/「不重复提供」', !brief514.includes('优先 `envd_shell`') && !brief514.includes('不重复提供'), line514)
  const tool514 = h514.state.toolDefs.get('envd_shell')
  const before514 = h514.subprocess.calls.length
  const delegated514 = tool514 ? await tool514.execute({ command: 'echo fenced', cwd: process.cwd() }, { signal: null, agent: locked514 }) : null
  check(
    '5.14 受限会话委托宿主执行器(bash 族会话也走沙箱,不自己 spawn)',
    Boolean(delegated514) &&
      delegated514.ok === true &&
      String(delegated514.text).startsWith('[sandbox] 委托宿主执行器执行(') &&
      h514.subprocess.calls.length === before514,
    String(delegated514 && delegated514.text).slice(0, 200),
  )
  const free514 = agentById(h514, 'agent-514-free')
  const run514 = tool514 ? await tool514.execute({ command: 'echo free', cwd: process.cwd() }, { signal: null, agent: free514 }) : null
  check('5.14 无围栏会话照常执行(同族终端)', Boolean(run514) && run514.ok === true, String(run514 && run514.text).slice(0, 120))
  h514.dispose()

  // 同构但执行器没有 resolve/execute:只能拒绝,简报改「无法在沙箱内执行」
  const h514b = start(
    {
      shippedTools: ['ops_bash', 'pwsh'],
      agentIds: [
        { id: 'agent-514b', session: { key: 'f514b' } },
        { id: 'agent-514b-free', session: { key: 'f514b-free' } },
      ],
      shell: { sandboxMode: 'workspace-write' },
      sandboxPolicy: fakeSandboxPolicy('workspace-write', { 'f514b-free': 'danger-full-access' }),
    },
    { syncIntervalMs: 25 },
  )
  await waitForBrief(h514b)
  await waitCommandTool(h514b, (c) => c.registered === true, 9000)
  const locked514b = agentById(h514b, 'agent-514b')
  const line514b = String(h514b.state.brief.text({ scope: locked514b })).split('\n').find((l) => l.includes('命令工具')) || ''
  check('5.14b 无法委托时简报含「无法在沙箱内执行」', line514b.includes('无法在沙箱内执行'), line514b)
  const tool514b = h514b.state.toolDefs.get('envd_shell')
  const run514b = tool514b ? await tool514b.execute({ command: 'echo no-delegate', cwd: process.cwd() }, { signal: null, agent: locked514b }) : null
  check(
    '5.14b 无法委托时拒绝([sandbox] + 无法在沙箱内执行 + 指向 ops_bash)',
    Boolean(run514b) &&
      run514b.ok === false &&
      String(run514b.text).includes('无法在沙箱内执行') &&
      String(run514b.text).includes('ops_bash'),
    String(run514b && run514b.text).slice(0, 240),
  )
  h514b.dispose()
}

// ── 5.15 无 Git Bash 且有 ops_bash:envd_shell 未注册(no-family-terminal),遮挡仍生效 ──
{
  const stubBin = makeStubBin(['git.exe'])
  const out515 = await withPath(
    () => false,
    async () => {
      // PATH 换成「只有 git.exe 桩」的目录:git 兜底(dirname(dirname(git)))找不到 bash
      process.env.PATH = stubBin
      const h515 = start({ shippedTools: ['ops_bash', 'pwsh'], agentIds: ['agent-515'] }, { syncIntervalMs: 25 })
      await freshDetection(h515)
      const s515 = await waitCommandTool(h515, (c) => c.skipReason === 'no-family-terminal' && c.registered === false, 9000)
      return { h515, s515 }
    },
  )
  const { h515, s515 } = out515
  const snap515 = recordFamilySnap('5.15', s515)
  if (hasTerminalFamily(s515, 'bash')) {
    skip('5.15 无 Git Bash 且有 ops_bash → skipReason=no-family-terminal', '本机仍能探测到 bash 终端(固定路径兜底),造不出「无 Git Bash」')
  } else {
    check(
      '5.15 无 Git Bash 且有 ops_bash → envd_shell 未注册(skipReason=no-family-terminal)',
      s515.commandTool.skipReason === 'no-family-terminal' && s515.commandTool.registered === false && !h515.state.toolDefs.has('envd_shell'),
      JSON.stringify(s515.commandTool),
    )
    check('5.15 会话族仍是 bash(有 ops_bash)', s515.commandTool.family === 'bash', JSON.stringify({ family: s515.commandTool.family, source: s515.commandTool.familySource }))
    check(
      '5.15 遮挡仍生效(deny 含 pwsh)',
      (h515.stats().activeDenies['agent-515'] || []).includes('pwsh') && (s515.commandTool.hidden || []).includes('pwsh'),
      JSON.stringify({ hidden: s515.commandTool.hidden, denies: h515.stats().activeDenies }),
    )
    const line515 = String(h515.state.brief.text({ scope: agentById(h515, 'agent-515') })).split('\n').find((l) => l.includes('命令工具')) || ''
    check('5.15 简报说「未找到」该族终端', line515.includes('未找到'), line515)
  }
  h515.dispose()
  // 探测缓存是进程共享的:恢复 PATH 后必须 refresh 一次,否则后面的夹具会吃到桩环境
  await freshDetection(h)
}

// ── 5.16 手动选 bash 且 envd_shell 在本会话能跑 → 即使没有 bash 宿主工具也遮挡 PowerShell 族 ──
// 0.6.3 修的就是用户报的那个矛盾:「我明明选了 Git Bash,你却不藏 PowerPoint」——
// 手动选择优先,只要 EnvDock 自己的 bash 入口确实可用(有 bash 终端 + 非受限或可委托)。
{
  await resetState(h)
  await freshDetection(h)
  const base516 = (await callApi(h)).json
  const bash516 = (base516.terminals || []).find((t) => t.family === 'bash')
  if (!bash516) {
    skip('5.16a 手动 bash + 只有 pwsh 宿主工具 → 仍遮挡', '本机没有 bash 族终端')
  } else {
    // 5.16a(主用例):手动 bash + 宿主只有 pwsh + 本机有 Git Bash → 手动选择优先,遮挡 pwsh
    await post(h, { op: 'setShell', key: bash516.key })
    const h516a = start({ shippedTools: ['pwsh'], agentIds: ['agent-516a'] }, { syncIntervalMs: 25 })
    await waitForBrief(h516a)
    const s516a = recordFamilySnap('5.16a', await waitCommandTool(h516a, (c) => (c.hidden || []).includes('pwsh'), 9000))
    const agent516a = agentById(h516a, 'agent-516a')
    check('5.16a 手动 bash + 没有 bash 宿主工具 → 会话族仍是 bash/manual', s516a.commandTool.family === 'bash' && s516a.commandTool.familySource === 'manual', JSON.stringify({ family: s516a.commandTool.family, source: s516a.commandTool.familySource }))
    check('5.16a 本会话确实没有 bash 族宿主工具(只有 pwsh)', (s516a.commandTool.hostTools || []).every((tool) => tool.family !== 'bash'), JSON.stringify(s516a.commandTool.hostTools))
    check('5.16a 手动选择优先 → hidden=[pwsh](envd_shell 在本会话能跑)', JSON.stringify(s516a.commandTool.hidden) === '["pwsh"]', JSON.stringify({ hidden: s516a.commandTool.hidden, hostTools: s516a.commandTool.hostTools }))
    check('5.16a 该 agent 的 deny 正好 {pwsh}', JSON.stringify(h516a.stats().activeDenies['agent-516a'] || []) === '["pwsh"]', JSON.stringify(h516a.stats().activeDenies))
    check('5.16a guard 拒绝 pwsh(执行侧也挡住)', typeof h516a.guardReason('pwsh', agent516a) === 'string', String(h516a.guardReason('pwsh', agent516a)))
    check('5.16a envd_shell 仍注册(遮挡后本会话仍有命令工具,不是死局)', s516a.commandTool.registered === true && s516a.commandTool.skipReason === null, JSON.stringify(s516a.commandTool))
    const line516a = String(h516a.state.brief.text({ scope: agent516a })).split('\n').find((l) => l.includes('命令工具')) || ''
    check('5.16a 简报含「已隐藏」,不含「未遮挡」/「没有可用的 bash 命令工具」', line516a.includes('已隐藏') && !line516a.includes('未遮挡') && !line516a.includes('没有可用的 bash 命令工具'), line516a)
    h516a.dispose()
    await resetState(h)

    // 5.16b:手动 bash 但机器上没有 bash 终端 → familyFallback 回 auto,不遮挡
    const h516b = start({ shippedTools: ['pwsh'], agentIds: ['agent-516b'] }, { syncIntervalMs: 25 })
    const stub516b = makeStubBin(['git.exe', 'pwsh.exe'])
    try {
      await waitForBrief(h516b)
      await post(h, { op: 'setShell', key: bash516.key })
      const s516b = await withPath(
        () => false,
        async () => {
          process.env.PATH = stub516b
          await freshDetection(h516b)
          return pollSnapshot(h516b, (snap) => Boolean(snap && snap.commandTool) && snap.commandTool.familyFallback === true, 9000)
        },
      )
      recordFamilySnap('5.16b', s516b)
      if (hasTerminalFamily(s516b, 'bash')) {
        skip('5.16b 手动 bash + 没有 bash 终端 → 回退 auto、不遮挡', '桩环境里仍探测到 bash 终端(固定路径兜底)')
      } else {
        check('5.16b 没有 bash 终端 → familyFallback=true 且不遮挡(hidden 空)', s516b.commandTool.familyFallback === true && (s516b.commandTool.hidden || []).length === 0, JSON.stringify({ fallback: s516b.commandTool.familyFallback, hidden: s516b.commandTool.hidden }))
        check('5.16b 回退后会话族按自动重判 → powershell/auto', s516b.commandTool.family === 'powershell' && s516b.commandTool.familySource === 'auto', JSON.stringify({ family: s516b.commandTool.family, source: s516b.commandTool.familySource }))
        const agent516b = agentById(h516b, 'agent-516b')
        const line516b = String(h516b.state.brief.text({ scope: agent516b })).split('\n').find((l) => l.includes('命令工具')) || ''
        check('5.16b 简报含「手动选择的族不可用…已回退自动选族」', line516b.includes('手动选择的族不可用') && line516b.includes('已回退自动选族'), line516b)
        check('5.16b 回退分支不再出现「未遮挡」矛盾文案', !line516b.includes('未遮挡'), line516b)
      }
    } finally {
      h516b.dispose()
      await resetState(h)
      await freshDetection(h)
    }

    // 5.16c:手动 bash + 会话受限 → 能委托才遮挡,不能委托就不遮挡
    await post(h, { op: 'setShell', key: bash516.key })
    const h516c = start(
      {
        shippedTools: ['pwsh'],
        agentIds: [{ id: 'agent-516c', session: { key: 'c516' } }],
        // 只有 sandboxMode、没有 resolve/execute:受限会话里 envd_shell 跑不了 → envdAvailable=false
        shell: { sandboxMode: 'workspace-write' },
        sandboxPolicy: fakeSandboxPolicy('workspace-write'),
      },
      { syncIntervalMs: 25 },
    )
    await waitForBrief(h516c)
    const s516c = recordFamilySnap('5.16c', await waitCommandTool(h516c, (c) => c.family === 'bash' && c.familySource === 'manual', 9000))
    await sleep(150) // 多跑两轮对账,排除「恰好还没算到」
    const agent516c = agentById(h516c, 'agent-516c')
    const line516c = String(h516c.state.brief.text({ scope: agent516c })).split('\n').find((l) => l.includes('命令工具')) || ''
    check(
      '5.16c 受限且不能委托 → envdAvailable=false,不遮挡(hidden 空 / 无 deny / 0 次 restrict)',
      (s516c.commandTool.hidden || []).length === 0 && h516c.stats().restrictCalls === 0 && Object.keys(h516c.stats().activeDenies).length === 0,
      JSON.stringify({ hidden: s516c.commandTool.hidden, attempts: h516c.stats().restrictAttempts }),
    )
    check('5.16c guard 不拒绝 pwsh(没遮挡就没有执行侧拒绝)', h516c.guardReason('pwsh', agent516c) === undefined, String(h516c.guardReason('pwsh', agent516c)))
    check('5.16c 简报说明「没有可用的 bash 命令工具」', line516c.includes('没有可用的 bash 命令工具'), line516c)
    h516c.dispose()

    // 同构但可委托(0.6.2 的沙箱委托):受限会话里 envd_shell 能跑 → 恢复遮挡
    const h516c2 = start(
      {
        shippedTools: ['pwsh'],
        agentIds: [{ id: 'agent-516c2', session: { key: 'c5162' } }],
        shell: fakeSandboxedShell({ mode: 'workspace-write' }),
        sandboxPolicy: fakeSandboxPolicy('workspace-write'),
      },
      { syncIntervalMs: 25 },
    )
    await waitForBrief(h516c2)
    const s516c2 = recordFamilySnap('5.16c2', await waitCommandTool(h516c2, (c) => (c.hidden || []).includes('pwsh'), 9000))
    check('5.16c2 受限但可委托(envdAvailable=true)→ 手动 bash 仍遮挡 pwsh', JSON.stringify(s516c2.commandTool.hidden) === '["pwsh"]' && s516c2.commandTool.registered === true, JSON.stringify({ hidden: s516c2.commandTool.hidden, registered: s516c2.commandTool.registered }))
    check('5.16c2 该 agent 的 deny 正好 {pwsh}', JSON.stringify(h516c2.stats().activeDenies['agent-516c2'] || []) === '["pwsh"]', JSON.stringify(h516c2.stats().activeDenies))
    h516c2.dispose()
    await resetState(h)
  }
}


// ── 5.17 手动族不可用 → 回退 auto + 警告(familyFallback);重新可用后自动恢复 ──
{
  await resetState(h)
  await freshDetection(h)
  const base517 = (await callApi(h)).json
  const bash517 = (base517.terminals || []).find((t) => t.family === 'bash')
  if (!bash517) {
    skip('5.17 手动族不可用 → 回退 auto + 警告', '本机没有 bash 族终端,造不出「手动选了 bash 族」')
  } else {
    const h517 = start({ agentIds: ['agent-517'] }, { syncIntervalMs: 25 })
    const stub517 = makeStubBin(['git.exe', 'pwsh.exe'])
    try {
      await waitForBrief(h517)
      const set517 = await post(h, { op: 'setShell', key: bash517.key })
      check('5.17 前置:手动 bash 已写进共享状态', set517.status === 200 && (await callApi(h)).json.state.defaultShell === bash517.key, JSON.stringify({ status: set517.status, defaultShell: (await callApi(h)).json.state.defaultShell }))
      // 桩环境:PATH 只有 git.exe + pwsh.exe,于是「bash 族」既没有终端、也没有按该族发布的宿主工具。
      const s517 = await withPath(
        () => false,
        async () => {
          process.env.PATH = stub517
          await freshDetection(h517) // 让共享探测缓存落到桩环境
          return pollSnapshot(
            h517,
            (snap) => Boolean(snap && snap.commandTool) && snap.commandTool.familyFallback === true && snap.familyFallback === true,
            9000,
          )
        },
      )
      recordFamilySnap('5.17', s517)
      if (hasTerminalFamily(s517, 'bash')) {
        skip('5.17 手动族不可用 → 回退 auto + 警告', '桩环境里仍探测到 bash 终端(固定路径兜底),造不出「该族没有终端」')
      } else {
        check('5.17 手动 bash 但该族无终端无宿主工具 → familySource 回 auto', s517.commandTool.familySource === 'auto' && s517.familySource === 'auto', JSON.stringify({ top: s517.familySource, ct: s517.commandTool.familySource }))
        check('5.17 API 顶层与 commandTool 都报 familyFallback=true', s517.familyFallback === true && s517.commandTool.familyFallback === true, JSON.stringify({ top: s517.familyFallback, ct: s517.commandTool.familyFallback }))
        check('5.17 生效族按自动规则重判(stub 里只有 pwsh → powershell)', s517.commandTool.family === 'powershell' && s517.family === 'powershell', JSON.stringify({ top: s517.family, ct: s517.commandTool.family }))
        const line517 = String(s517.brief).split('\n').find((l) => l.includes('命令工具')) || ''
        check('5.17 简报命令工具行含「手动选择的族不可用」与「已回退自动选族」', line517.includes('手动选择的族不可用') && line517.includes('已回退自动选族'), line517)
        // 恢复:该族重新可用(出现 bash 族宿主工具)→ 下一轮对账自动回到手动族,不用重新探测。
        const disposeOps517 = h517.tools.register({ name: 'ops_bash', description: 'shipped ops_bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } })
        h517.emit('tools/change')
        const s517b = recordFamilySnap(
          '5.17-recover',
          await waitCommandTool(h517, (c) => c.familySource === 'manual' && c.family === 'bash' && c.familyFallback === false, 6000),
        )
        check('5.17 该族重新可用 → 逐轮对账自动回到手动族(familySource=manual、fallback=false)', s517b.commandTool.familySource === 'manual' && s517b.commandTool.family === 'bash' && s517b.commandTool.familyFallback === false && s517b.familyFallback === false, JSON.stringify({ ct: { family: s517b.commandTool.family, source: s517b.commandTool.familySource, fallback: s517b.commandTool.familyFallback }, top: { family: s517b.family, source: s517b.familySource, fallback: s517b.familyFallback } }))
        disposeOps517()
        h517.emit('tools/change')
      }
    } finally {
      h517.dispose()
      // PATH 已由 withPath 恢复:必须再 refresh 一次,共享探测缓存不能停在桩环境。
      await resetState(h)
      await freshDetection(h)
    }
  }
}

// ── 第二轮安全审校:Host 字面量 / Content-Type 子串 / 保留 key ──
phase('安全回归(第二轮)')
const hHttp = start({ shippedTools: [], agentIds: ['agent-http'] })
await waitForBrief(hHttp)
for (const [label, host, want] of [
  ['localhost. 尾点', 'localhost.:3080', 200],
  ['[::ffff:127.0.0.1]', '[::ffff:127.0.0.1]:3080', 200],
  ['userinfo 拼接', 'evil.example@127.0.0.1:3080', 403],
]) {
  const r = await callApi(hHttp, { method: 'GET', headers: { host } })
  check('Host ' + label + ' → ' + want, r.status === want, String(r.status))
}
const ctSubstr = await post(hHttp, { op: 'setOption', injectBrief: true }, { headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'content-type': 'text/plain;application/json' } })
check('Content-Type 子串不算: text/plain;application/json → 403', ctSubstr.status === 403, String(ctSubstr.status))
const protoKey = await post(hHttp, { op: 'addCustomTool', path: process.execPath, key: '__proto__', label: 'x' })
check('addCustomTool key=__proto__ → 400(不写状态文件)', protoKey.status === 400, String(protoKey.status))
const ctorKey = await post(hHttp, { op: 'addCustomTool', path: process.execPath, key: 'constructor', label: 'x' })
check('addCustomTool key=constructor → 400', ctorKey.status === 400, String(ctorKey.status))
hHttp.dispose()

// ───────────────────────────────────────────────────────── 收尾 ──
await resetState(h)
const totalFixtures = fixtures.length

// 硬不变量①:bash 族名字永不进任何 deny / refuse 集合(遮挡只针对 PowerShell 族内置名)
const bashOffenders = fixtures.flatMap((cur) => {
  let statsCur = null
  try {
    statsCur = cur.stats()
  } catch {}
  if (!statsCur) return []
  return [...deniedIn(cur), ...restrictedIn(cur)].filter((name) => bashNamesIn([name]).length > 0)
})
check('硬不变量①:所有夹具(共 ' + totalFixtures + ' 个)的 deny / restrict 目标里没有 bash 族名字', bashOffenders.length === 0, JSON.stringify(bashOffenders))
const snapshotOffenders = []
for (const item of familySnapshots) {
  for (const field of ['hidden', 'refuseOnly', 'displayOnly']) {
    const bad = bashNamesIn(item.commandTool[field])
    if (bad.length) snapshotOffenders.push(item.label + '.' + field + ':' + bad.join(','))
  }
}
check('硬不变量①:所有两族快照的 hide / refuseOnly / displayOnly 里没有 bash 族名字', snapshotOffenders.length === 0, JSON.stringify(snapshotOffenders))

// 硬不变量②:restrict 只在 agent 作用域调用(夹具根层 restrict 直接抛错;§5.11 已单独断言)
const rootRealAttempts = fixtures.flatMap((cur) =>
  cur.stats().restrictAttempts.filter((attempt) => attempt.scope === '(root)' && !/scoped context/.test(attempt.error)),
)
check('硬不变量②:全程没有根层 restrict 调用(除 §5.11 的有意探针)', rootRealAttempts.length === 0, JSON.stringify(rootRealAttempts.slice(0, 5)))
const guardOffenders = fixtures.filter((cur) => {
  try {
    const statsCur = cur.stats()
    return statsCur.guards > 1 || (statsCur.guards === 1 && statsCur.guardScopes[0] !== '(root)')
  } catch {
    return false
  }
})
check('guard 只在根层注册一次(没有逐会话重复注册)', guardOffenders.length === 0, JSON.stringify(guardOffenders.map((cur) => cur.stats().guardScopes)))

// 硬不变量③:没有夹具在稳态反复施加 restrict(§5.13 已逐条断言 ≤1 次;这里给全局上限)
const overSteady = fixtures.filter((cur) => {
  try {
    return cur.stats().restrictCalls > 2
  } catch {
    return false
  }
})
check('硬不变量③:没有夹具在稳态反复施加 restrict(每个夹具 ≤2 次)', overSteady.length === 0, JSON.stringify(overSteady.map((cur) => cur.stats().restrictCalls)))

for (const cur of fixtures) {
  try {
    cur.dispose()
  } catch {}
}
// 硬不变量⑤:卸载后 deny / guard 全清(撤销走的是 restrict disposer / effect cleanup)
const residual = fixtures.flatMap((cur) => {
  try {
    return Object.entries(cur.stats().activeDenies)
  } catch {
    return []
  }
})
check('硬不变量⑤:卸载后所有夹具的 deny 全清(没有撤不掉的残留)', residual.length === 0, JSON.stringify(residual.slice(0, 5)))
const residualGuards = fixtures.filter((cur) => {
  try {
    return cur.stats().guards > 0
  } catch {
    return false
  }
})
check('硬不变量⑤:卸载后 guard 也全部撤销', residualGuards.length === 0, JSON.stringify(residualGuards.map((cur) => cur.stats().guards)))

phase('总计 ' + (Date.now() - t0) + ' ms,夹具 ' + totalFixtures + ' 个')
console.log('')
console.log('断言 ' + checks + ' 条:通过 ' + (checks - failures.length) + ' 条' + (skips.length ? ',跳过 ' + skips.length + ' 个用例' : ''))
if (failures.length) {
  console.log('')
  for (const failure of failures) console.log('FAIL ' + failure)
  process.exit(1)
}
process.exit(0)
