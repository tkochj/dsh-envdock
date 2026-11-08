/**
 * EnvDock Host 半边的本地运行时夹具(开发用,不随包发布)。
 *
 * 目的:在没有 dsh 宿主的情况下,用一套最小的 Cordis 服务替身把 index.js 的
 * apply() 真正跑起来,从而:
 *   · 计时探测各阶段(哪一步慢)
 *   · 走一遍 /envdock-api 的所有 op(含畸形输入)
 *   · 走一遍 envd 工具的所有 action
 *   · 断言「增补命令工具」模型的 8 类契约(docs/notes/assist-model.md §3)
 *   · 断言快照/简报/健康检查的基本形状
 *
 * 本模型的硬不变量:**EnvDock 永不遮挡别人的工具** —— 全程 `tools.restrict`
 * 调用次数必须是 0、`tools.guard` 一次都不许注册。文件末尾按夹具逐个核对。
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
/** 把共享状态文件复位成默认(默认终端 auto / 简报开 / 局域网关)。 */
async function resetState(h) {
  await post(h, { op: 'setShell', key: 'auto' })
  await post(h, { op: 'setOption', injectBrief: true, allowLan: false })
}
/** 默认终端族 → 该族的宿主工具名(造「同族冲突」用)。 */
const FAMILY_TOOLS = { powershell: 'pwsh', cmd: 'cmd', bash: 'bash', wsl: 'wsl', custom: 'bash' }
/** envd_shell 的 argv 必须按**当前默认终端**的语法生成。 */
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
  '选项已落盘(只有两个开关)',
  afterOpts.json.state.options.injectBrief === true &&
    afterOpts.json.state.options.allowLan === false &&
    Object.keys(afterOpts.json.state.options).sort().join(',') === 'allowLan,injectBrief',
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
//  0.5「辅助展示」模型的 8 类契约(docs/notes/assist-model.md §3)
// ══════════════════════════════════════════════════════════════════════

// ── (1) 无执行器 → 注册 envd_shell;registered/visible/skipReason 三态 ──
// 顺带钉死本模型最重要的一条:注册了也不隐藏别人的工具(B 只增不减)。
phase('§3.1 无执行器 → 注册增补工具')
const hReg = start({ shippedTools: ['bash'], agentIds: ['agent-reg'] }, { syncIntervalMs: 25 })
const regSnap = await (async () => {
  await waitForBrief(hReg)
  return waitCommandTool(hReg, (c) => c.registered === true)
})()
check('无执行器 + 不同族宿主工具 → 注册 envd_shell', regSnap.commandTool.registered === true, JSON.stringify(regSnap.commandTool))
check('registered=true / visible=true / skipReason=null', regSnap.commandTool.registered === true && regSnap.commandTool.visible === true && regSnap.commandTool.skipReason === null, JSON.stringify(regSnap.commandTool))
check('注册表里真的有 envd_shell', hReg.state.toolDefs.has('envd_shell'))
check('commandTool.shell 报出默认终端(label/family/path/version)', Boolean(regSnap.commandTool.shell.path) && Boolean(regSnap.commandTool.shell.family) && Boolean(regSnap.commandTool.shell.label), JSON.stringify(regSnap.commandTool.shell))
check('refuseWhenConfined=true(围栏会话里会拒绝)', regSnap.commandTool.refuseWhenConfined === true)
// 只增不减:宿主的 bash 必须仍然在工具表里、并且在那个会话里可见
check('宿主的 bash 仍在工具表里(没被隐藏/删除)', hReg.state.toolDefs.has('bash'))
check('宿主的 bash 在 agent 作用域里仍然可见(B 只增不减)', Boolean(hReg.toolsFor('agent-reg').get('bash')))
check('全程没有调用 tools.restrict(硬不变量)', hReg.stats().restrictCalls === 0, String(hReg.stats().restrictCalls))
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

// 执行语义(无围栏 → 直跑假 subprocess):argv 必须按默认终端语法
const regTool = hReg.state.toolDefs.get('envd_shell')
const regFamily = regSnap.shell.family
const spawnBefore = hReg.subprocess.calls.length
const regRun = await regTool.execute({ command: 'echo hi', cwd: process.cwd() }, { signal: null })
const regSpawned = hReg.subprocess.calls.slice(spawnBefore)
check('无围栏会话照常执行(假 subprocess)', regRun.ok === true && regRun.text.includes('[exit 0]'), String(regRun.text).slice(0, 160))
check('执行带 exit 行', /\[exit \d+\]/.test(regRun.text))
check('argv 按默认终端(' + regFamily + ')语法生成', regSpawned.length === 1 && invocationLooksRight(regFamily, regSpawned[0].argv, 'echo hi'), JSON.stringify(regSpawned.map((c) => c.argv)))
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

// ── (2) 宿主有同族工具 → skipReason='same-family',且 restrict 调用次数为 0 ──
// 先探一次默认终端族,再按「同族」造夹具(换台机器/换终端也成立)。
phase('§3.2 同族 → 只展示,不重复提供')
const probe = start({})
await waitForBrief(probe)
const defaultFamily = (await callApi(probe)).json.shell.family
probe.dispose()
const sameFamilyTool = FAMILY_TOOLS[defaultFamily] || 'pwsh'
const hSame = start({ shippedTools: [sameFamilyTool], agentIds: ['agent-same'] })
await waitForBrief(hSame)
const sameSnap = await waitCommandTool(hSame, (c) => c.skipReason === 'same-family')
check(
  '宿主有同族工具 → skipReason=same-family',
  sameSnap.commandTool.skipReason === 'same-family' && sameSnap.commandTool.registered === false,
  JSON.stringify(sameSnap.commandTool),
)
check('同族时不注册 envd_shell(注册表里没有)', !hSame.state.toolDefs.has('envd_shell'))
check('同族时不调用 restrict(硬不变量:0 次)', hSame.stats().restrictCalls === 0, String(hSame.stats().restrictCalls))
check('hostTools 报出那个同族工具', (sameSnap.commandTool.hostTools || []).some((t) => t.name === sameFamilyTool && t.family === defaultFamily), JSON.stringify(sameSnap.commandTool.hostTools))
const sameBrief = String((await callApi(hSame)).json.brief)
check('同族简报:「与默认终端同族,EnvDock 不重复提供」', sameBrief.includes('与默认终端同族') && sameBrief.includes('不重复提供'), sameBrief.split('\n').find((l) => l.includes('命令工具')) || '')
check('同族时宿主工具仍然可用(没被隐藏)', Boolean(hSame.toolsFor('agent-same').get(sameFamilyTool)))
// 状态驱动:宿主工具消失 → 立刻注册(不等下一个 5 秒 tick 也行,事件驱动 40ms)
hSame.state.toolDefs.delete(sameFamilyTool)
hSame.emit('tools/change')
const afterGone = await waitCommandTool(hSame, (c) => c.registered === true, 4000)
check('同族工具消失后立刻注册(tools/change 驱动,不是等下一个 tick)', afterGone.commandTool.registered === true, JSON.stringify(afterGone.commandTool))
hSame.dispose()

// 名字被别的插件占着:不认领别人的工具(认领了就等于把模型唯一的命令工具挂在别人的生命周期上)
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

// ── (3) 有执行器:全部会话围栏 → no-unconfined-session;有会话无围栏 → 注册 ──
phase('§3.3 沙箱条件')
const hConf = start({
  agentIds: [{ id: 'agent-w', session: { key: 'w1' } }],
  shell: fakeSandboxedShell({ mode: 'workspace-write' }),
  sandboxPolicy: fakeSandboxPolicy('workspace-write'),
})
await waitForBrief(hConf)
const confSnap = await waitCommandTool(hConf, (c) => c.skipReason === 'no-unconfined-session')
check(
  '有执行器 + 全部会话围栏 → skipReason=no-unconfined-session',
  confSnap.commandTool.skipReason === 'no-unconfined-session' && confSnap.commandTool.registered === false,
  JSON.stringify(confSnap.commandTool),
)
check('围栏时不注册 envd_shell(注册了也只会被拒绝)', !hConf.state.toolDefs.has('envd_shell'))
check(
  'sandbox 聚合:capable / confinedCount / sessionCount / anyUnconfined',
  confSnap.commandTool.sandbox.capable === true &&
    confSnap.commandTool.sandbox.present === true &&
    confSnap.commandTool.sandbox.sessionCount === 1 &&
    confSnap.commandTool.sandbox.confinedCount === 1 &&
    confSnap.commandTool.sandbox.anyUnconfined === false,
  JSON.stringify(confSnap.commandTool.sandbox),
)
check('沙箱聚合与顶层 sandbox 一致', JSON.stringify(confSnap.sandbox) === JSON.stringify(confSnap.commandTool.sandbox), JSON.stringify(confSnap.sandbox))
check('围栏会话里的简报追加「被围栏,会被拒绝」', hConf.state.brief.text({ scope: hConf.state.agents[0] }).includes('Envd_shell 在本会话被围栏,会被拒绝,请用宿主工具'), hConf.state.brief.text({ scope: hConf.state.agents[0] }).split('\n').find((l) => l.includes('命令工具')) || '')
hConf.dispose()

const hFull = start({
  agentIds: [
    { id: 'agent-free', session: { key: 'f1' } },
    { id: 'agent-locked', session: { key: 'l1' } },
  ],
  shell: fakeSandboxedShell({ mode: 'workspace-write' }),
  sandboxPolicy: fakeSandboxPolicy('workspace-write', { f1: 'danger-full-access' }),
})
const fullSnap = await (async () => {
  await waitForBrief(hFull)
  return waitCommandTool(hFull, (c) => c.registered === true)
})()
check('有会话 resolve 出 danger-full-access → 注册 envd_shell', fullSnap.commandTool.registered === true, JSON.stringify(fullSnap.commandTool))
check(
  'sandbox 聚合:anyUnconfined=true / confinedCount=1 / sessionCount=2',
  fullSnap.commandTool.sandbox.anyUnconfined === true &&
    fullSnap.commandTool.sandbox.confinedCount === 1 &&
    fullSnap.commandTool.sandbox.sessionCount === 2,
  JSON.stringify(fullSnap.commandTool.sandbox),
)

// ── (4) 围栏会话调用 → 拒绝、不 spawn;无围栏会话照常执行 ──
phase('§3.4 围栏拒绝 / 无围栏执行')
const fullTool = hFull.state.toolDefs.get('envd_shell')
const lockedAgent = hFull.state.agents.find((a) => a.id === 'agent-locked')
const freeAgent = hFull.state.agents.find((a) => a.id === 'agent-free')
const refuseBefore = hFull.subprocess.calls.length
const refused = await fullTool.execute({ command: 'echo portable-bypass', cwd: process.cwd() }, { signal: null, agent: lockedAgent })
const refuseSpawns = hFull.subprocess.calls.slice(refuseBefore)
check('围栏会话调用 envd_shell → 拒绝', refused.ok === false && refused.text.startsWith('[sandbox]'), String(refused.text).slice(0, 160))
check('拒绝文案含「围栏」与「宿主工具」', refused.text.includes('围栏') && refused.text.includes('宿主工具'), String(refused.text).slice(0, 200))
check('拒绝时一个子进程都没起(不 spawn)', !refuseSpawns.some((c) => (c.argv || []).join(' ').includes('portable-bypass')), JSON.stringify(refuseSpawns.map((c) => c.argv)))
check('拒绝的文案里说清本会话策略', refused.text.includes('workspace-write'), String(refused.text).slice(0, 160))
const freeRun = await fullTool.execute({ command: 'echo allowed', cwd: process.cwd() }, { signal: null, agent: freeAgent })
const freeSpawns = hFull.subprocess.calls.slice(refuseBefore).filter((c) => (c.argv || []).join(' ').includes('allowed'))
check('无围栏会话照常执行(假 subprocess)', freeRun.ok === true && freeRun.text.includes('[exit 0]'), String(freeRun.text).slice(0, 160))
check('无围栏会话的 argv 按默认终端语法生成', freeSpawns.length === 1 && invocationLooksRight(fullSnap.shell.family, freeSpawns[0].argv, 'echo allowed'), JSON.stringify(freeSpawns.map((c) => c.argv)))
// 没有会话信息 = 取不到「本会话」策略 → 同样保守拒绝(§1.2)
const noAgentSpawns = hFull.subprocess.calls.length
const noAgentRun = await fullTool.execute({ command: 'echo noagent', cwd: process.cwd() }, { signal: null })
check('没有会话信息 → 保守拒绝(策略不可得)', noAgentRun.ok === false && noAgentRun.text.includes('围栏'), String(noAgentRun.text).slice(0, 160))
check('没有会话信息时也不 spawn', !hFull.subprocess.calls.slice(noAgentSpawns).some((c) => (c.argv || []).join(' ').includes('noagent')))
// 围栏会话的简报追加提示(按会话求值)
const lockedBrief = hFull.state.brief.text({ scope: lockedAgent })
const freeBrief = hFull.state.brief.text({ scope: freeAgent })
check('围栏会话的简报追加「被围栏,会被拒绝」', lockedBrief.includes('Envd_shell 在本会话被围栏,会被拒绝,请用宿主工具'), lockedBrief.split('\n').find((l) => l.includes('命令工具')) || '')
check('无围栏会话的简报没有那句围栏提示', !freeBrief.includes('Envd_shell 在本会话被围栏'), freeBrief.split('\n').find((l) => l.includes('命令工具')) || '')
// 新会话的第一步可能早于下一轮 tick:scope 不在映射里也要按它自己的会话判围栏(不能答「不知道」)
const brandNew = hFull.makeAgent('agent-new', { key: 'l1' })
const brandNewBrief = hFull.state.brief.text({ scope: brandNew })
check('新会话首步(还没等到下一轮 tick)也按它自己的会话判围栏', brandNewBrief.includes('Envd_shell 在本会话被围栏'), brandNewBrief.split('\n').find((l) => l.includes('命令工具')) || '')
hFull.dispose()

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
const hHost = start({
  shippedTools: ['ops_bash', 'pwsh'],
  agentIds: ['agent-host'],
  shellDefinitions: [tenantBashDef, readFilesDef, runCmdDef, paletteDef],
})
await waitForBrief(hHost)
const hostSnap = await pollSnapshot(hHost, (s) => Boolean(s.commandTool && (s.commandTool.hostTools || []).some((t) => t.name === 'tenant_bash')), 6000)
const hostTools = hostSnap.commandTool.hostTools || []
const hostNames = hostTools.map((t) => t.name)
const hostOf = (name) => hostTools.find((t) => t.name === name) || null
check('内置 ops_bash 被认出(bash 家族、learned=false)', Boolean(hostOf('ops_bash')) && hostOf('ops_bash').family === 'bash' && hostOf('ops_bash').learned === false, JSON.stringify(hostTools))
check('内置 pwsh 被认出(powershell 家族、learned=false)', Boolean(hostOf('pwsh')) && hostOf('pwsh').family === 'powershell' && hostOf('pwsh').learned === false, JSON.stringify(hostTools))
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
check('识别过程不调用 restrict', hHost.stats().restrictCalls === 0, String(hHost.stats().restrictCalls))
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
  'commandTool 只有 §1.4 的 8 个键',
  JSON.stringify(commandToolKeys) === JSON.stringify(['hostTools', 'name', 'refuseWhenConfined', 'registered', 'sandbox', 'shell', 'skipReason', 'visible']),
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
]
const presentLegacy = legacyCommandFields.filter((key) => Object.prototype.hasOwnProperty.call(shapeSnap.commandTool, key))
check('commandTool 没有接管时代的字段(scopes/kind/denies/takeover …)', presentLegacy.length === 0, JSON.stringify(presentLegacy))
check(
  'sandbox 是 §1.4 的聚合形状(没有 scopes)',
  JSON.stringify(Object.keys(shapeSnap.sandbox).sort()) ===
    JSON.stringify(['anyUnconfined', 'capable', 'confinedCount', 'defaultMode', 'policyKnown', 'present', 'sessionCount']),
  JSON.stringify(Object.keys(shapeSnap.sandbox).sort()),
)
const statsKeys = Object.keys(shapeSnap.syncStats).sort()
check(
  'syncStats 只剩 §1.4 白名单的 9 个字段',
  JSON.stringify(statsKeys) ===
    JSON.stringify(['detections', 'hostToolScans', 'intervalMs', 'lastAt', 'lastDetectMs', 'lastError', 'lastErrorAt', 'registerTries', 'ticks']),
  JSON.stringify(statsKeys),
)
const legacyStats = ['registers', 'disposes', 'denyApplies', 'denyDrops', 'guardDenials', 'guardReady', 'yieldTicks', 'unrestrictable', 'blockedScopes', 'lostDenies', 'delegateCalls', 'delegateTries', 'delegateRefusals', 'delegateFailures', 'delegateRunnerFailures', 'delegateAborts', 'ownHides', 'hostDenyApplies', 'denyNoops', 'transientMisses', 'sandboxScopes', 'sandboxBlocked', 'scopeAnomalies', 'runtimeShellTools', 'executorFamily', 'hasExecutableApi', 'steadyNow', 'steadyTicks']
const presentLegacyStats = legacyStats.filter((key) => Object.prototype.hasOwnProperty.call(shapeSnap.syncStats, key))
check('syncStats 没有 deny/delegate/guard/steady 之类的旧计数', presentLegacyStats.length === 0, JSON.stringify(presentLegacyStats))
check('顶层不再有 shippedShell(认领哪个宿主 shell 已无意义)', !Object.prototype.hasOwnProperty.call(shapeSnap, 'shippedShell'))
check(
  '顶层其余字段保持不变',
  ['state', 'shell', 'platform', 'pathInfo', 'tools', 'terminals', 'versionManagers', 'issues', 'brief', 'detectedAt', 'hasSubprocess'].every(
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
check('归一化后只剩 injectBrief / allowLan', Object.keys(legacySnap.state.options).sort().join(',') === 'allowLan,injectBrief', JSON.stringify(Object.keys(legacySnap.state.options)))
const legacyWrite = await post(hLegacy, { op: 'setOption', injectBrief: true })
check('旧状态文件可以正常写回(不迁移、不报错)', legacyWrite.status === 200 && legacyWrite.json.ok === true, String(legacyWrite.status))
const diskOptions = JSON.parse(readFileSync(join(home, 'envdock.json'), 'utf8')).options || {}
check(
  '写回不保留旧字段',
  !Object.prototype.hasOwnProperty.call(diskOptions, 'shellTakeover') &&
    !Object.prototype.hasOwnProperty.call(diskOptions, 'sandboxTakeover') &&
    Object.keys(diskOptions).sort().join(',') === 'allowLan,injectBrief',
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
const switched = (await callApi(hSwitch)).json.shell
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
// 硬不变量:全程 restrict / guard 一次都不许调用(「不遮挡任何工具」)
const withRestrict = fixtures.filter((cur) => {
  try {
    return cur.stats().restrictCalls > 0
  } catch {
    return false
  }
})
const withGuard = fixtures.filter((cur) => {
  try {
    return cur.stats().guards > 0
  } catch {
    return false
  }
})
check('硬不变量:所有夹具(共 ' + totalFixtures + ' 个)的 restrict 调用次数都是 0', withRestrict.length === 0, JSON.stringify(withRestrict.map((cur) => cur.stats().restrictCalls)))
check('硬不变量:全程没有注册 tools.guard(拒绝守卫已删除)', withGuard.length === 0, JSON.stringify(withGuard.map((cur) => cur.stats().guards)))
check('硬不变量:restrict 总调用次数为 0', fixtures.reduce((sum, cur) => sum + (cur.stats().restrictCalls || 0), 0) === 0)

for (const cur of fixtures) {
  try {
    cur.dispose()
  } catch {}
}
phase('总计 ' + (Date.now() - t0) + ' ms,夹具 ' + totalFixtures + ' 个')
console.log('')
console.log('断言 ' + checks + ' 条:通过 ' + (checks - failures.length) + ' 条' + (skips.length ? ',跳过 ' + skips.length + ' 个用例' : ''))
if (failures.length) {
  console.log('')
  for (const failure of failures) console.log('FAIL ' + failure)
  process.exit(1)
}
process.exit(0)
