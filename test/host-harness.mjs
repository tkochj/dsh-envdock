/**
 * EnvDock Host 半边的本地运行时夹具(开发用,不随包发布)。
 *
 * 目的:在没有 dsh 宿主的情况下,用一套最小的 Cordis 服务替身把 index.js 的
 * apply() 真正跑起来,从而:
 *   · 计时探测各阶段(哪一步慢)
 *   · 走一遍 /envdock-api 的所有 op(含畸形输入)
 *   · 走一遍 envd 工具的所有 action
 *   · 走一遍「终端接管」注册的命令工具
 *   · 断言快照/简报/健康检查的基本形状
 *
 * 状态文件写在临时 DSH_HOME 里,绝不碰用户真实的 ~/.dsh/envdock.json。
 * subprocess 用固定输出的替身(本机沙箱不允许 Node 用管道 stdio 起子进程),
 * 因此每次探测发起几次子进程是可数的 —— 版本缓存的收益也能被断言。
 *
 * 跑法: node test/host-harness.mjs [--timing]
 *
 * 夹具(假 Cordis 宿主 + 服务替身)已抽到 test/fixture/host.mjs:
 * 本文件只保留断言与主流程,新增用例请复用 buildHost(),不要再造第二份。
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
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
  decodeBashPayload,
  decodePowerShellPayload,
  isReg,
  isVersion,
  home,
} from './fixture/host.mjs'

const args = new Set(process.argv.slice(2))
const TIMING = args.has('--timing') || args.has('--verbose')

const failures = []
const skips = []
const t0 = Date.now()
let last = Date.now()
function phase(name) {
  const now = Date.now()
  if (TIMING) console.log(String(now - last).padStart(7) + ' ms  ' + name)
  last = now
}
function check(name, cond, detail) {
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

// ───────────────────────────────────────────── 主流程 ──
const mod = await import('../index.js')
const { apply, inject } = mod
check('export: apply 是函数', typeof apply === 'function')
check('export: inject 声明了 tools', Array.isArray(inject) && inject.includes('tools'))

const h = makeHarness()
apply(h.ctx, {})
phase('apply()')

check('systemPrompt.context 已注册', Boolean(h.state.brief) && typeof h.state.brief.text === 'function')
check('/envdock-api 路由已注册', h.webRoutes.length === 1 && h.webRoutes[0].path === '/envdock-api')

const briefText = await waitForBrief(h)
phase('首次探测(等待简报)')
check('简报包含系统行', /系统: .*Windows/.test(briefText), briefText.slice(0, 120))
check('简报包含默认终端', briefText.includes('默认终端'))
check('简报包含 envd 提示', briefText.includes('envd'))
check('简报包含 Node 版本', /Node\.js v24\.18\.0/.test(briefText), briefText.split('\n').find((l) => l.includes('Node')) || '')

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
check('GET 没接管时 commandTool 为宿主自带名字', got.json.commandTool.name === 'pwsh' ? true : got.json.commandTool.name === null, JSON.stringify(got.json.commandTool))
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
// 非 force 的 GET 仍然吃缓存(见上面「缓存命中」那条)。
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
const h4 = makeHarness()
apply(h4.ctx, {})
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

// setOption:白名单 + 枚举校验(以前原样落盘,一个 "yes" 会让面板和接管逻辑各理解一次)
const badTakeover = await post(h, { op: 'setOption', shellTakeover: 'hack' })
check('setOption 非法 shellTakeover → 400', badTakeover.status === 400 && badTakeover.json.ok === false, badTakeover.raw.slice(0, 140))
const strBool = await post(h, { op: 'setOption', injectBrief: 'yes' })
check('setOption 字符串布尔归一为 false(不是 Boolean("yes"))', strBool.status === 200 && strBool.json.state.options.injectBrief === false, strBool.raw.slice(0, 160))
const emptyOpt = await post(h, { op: 'setOption', nope: 1 })
check('setOption 未知键 → 400 且不落盘', emptyOpt.status === 400 && emptyOpt.json.ok === false, emptyOpt.raw.slice(0, 140))
await post(h, { op: 'setOption', injectBrief: true })

// setOption 三个开关
for (const patch of [{ injectBrief: false }, { shellTakeover: 'off' }, { allowLan: false }, { injectBrief: true }, { shellTakeover: 'auto' }]) {
  const r = await post(h, { op: 'setOption', ...patch })
  check('setOption ' + JSON.stringify(patch), r.status === 200 && r.json.ok === true, r.raw.slice(0, 160))
}
const afterOpts = await callApi(h)
check('选项已落盘', afterOpts.json.state.options.injectBrief === true && afterOpts.json.state.options.shellTakeover === 'auto')

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
const setDefaultOk = await envd.execute({ action: 'set_default', name: 'node', path: nodeCand.path })
check('envd set_default 合法路径', setDefaultOk.ok === true)

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
    options: { injectBrief: 'yes', shellTakeover: 'hack', allowLan: 'true' },
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
check('readState 非法 shellTakeover 回落 auto', normGet.json.state.options.shellTakeover === 'auto', String(normGet.json.state.options.shellTakeover))
check('customTools[].path 强制 String', normGet.json.state.customTools[0] && normGet.json.state.customTools[0].path === '1234', JSON.stringify(normGet.json.state.customTools))
await post(h, { op: 'removeCustomTool', key: 'num' })
await post(h, { op: 'setOption', injectBrief: true, allowLan: false })

// 无 subprocess 服务时仍可用(只做 PATH 扫描)
const h2 = makeHarness()
h2.services.subprocess = null
apply(h2.ctx, {})
await freshDetection(h2)
await waitForBrief(h2)
const noSp = await callApi(h2)
check('无 subprocess 时 GET 200', noSp.status === 200 && noSp.json.ok === true)
check('无 subprocess 时 hasSubprocess=false', noSp.json.hasSubprocess === false)
check('无 subprocess 时仍扫到工具', (noSp.json.tools || []).length > 0, String((noSp.json.tools || []).length))
check(
  '无 subprocess 时版本为空',
  (noSp.json.tools || []).every((t) => !t.defaultVersion),
  (noSp.json.tools || []).map((t) => t.key + '=' + String(t.defaultVersion)).join(','),
)

// ── 终端接管:宿主自带 bash,默认终端是 PowerShell → 应接管并注册自己的命令工具 ──
const h3 = makeHarness({ shippedTools: ['bash'] })
apply(h3.ctx, {})
await freshDetection(h3)
await waitForBrief(h3)
// sync 的 kick 是 1200ms,等它跑过一轮
await new Promise((r) => setTimeout(r, 1400))
const takeover = await callApi(h3)
check('接管后 commandTool.takeover = true', takeover.json.commandTool.takeover === true, JSON.stringify(takeover.json.commandTool))
check('接管后的工具名是本族的 pwsh/powershell', ['pwsh', 'powershell', 'envd_powershell', 'envd_shell'].includes(takeover.json.commandTool.name), String(takeover.json.commandTool.name))
check('宿主自带的 bash 仍在工具表里(未被误删)', Boolean(h3.state.toolDefs.get('bash')))
const cmdTool = h3.state.toolDefs.get(takeover.json.commandTool.name)
check('接管的命令工具已注册', Boolean(cmdTool))
if (cmdTool) {
  const execOk = await cmdTool.execute({ command: 'echo hi', cwd: process.cwd() }, { signal: null, agent: null })
  check('命令工具执行(替身输出)', execOk.ok === true && execOk.text.includes('[exit 0]'), execOk.text.slice(0, 200))
  check('命令工具带 exit 行', /\[exit \d+\]/.test(execOk.text))
  const empty = await cmdTool.execute({ command: '   ' }, { signal: null, agent: null })
  check('空命令 → ok:false', empty.ok === false, String(empty.ok))
  h3.subprocess.state.throwNext = true
  const thrown = await cmdTool.execute({ command: 'echo hi' }, { signal: null, agent: null })
  check('spawn 同步抛错被接住', thrown.ok === false && thrown.text.includes('启动命令失败'), thrown.text.slice(0, 120))
  h3.subprocess.state.rejectNext = true
  const rejected = await cmdTool.execute({ command: 'echo hi' }, { signal: null, agent: null })
  check('done 拒绝被接住', rejected.ok === false && rejected.text.includes('[error]'), rejected.text.slice(0, 120))
  const badCwd = await cmdTool.execute({ command: 'echo hi', cwd: 'C:\\nope\\nope' }, { signal: null, agent: null })
  check('不存在的 cwd → ok:false', badCwd.ok === false, badCwd.text.slice(0, 120))
}
// 切到「只给简报」后应撤掉接管
await post(h3, { op: 'setOption', shellTakeover: 'off' })
await new Promise((r) => setTimeout(r, 100))
const afterOff = await callApi(h3)
check('切到只给简报后不再接管', afterOff.json.commandTool.takeover === false, JSON.stringify(afterOff.json.commandTool))
check(
  '关闭接管时把 envd_shell 摘掉并记进 disposes(替换/拆建不是静默)',
  afterOff.json.syncStats.disposes >= 1 && afterOff.json.syncStats.registers >= 1,
  JSON.stringify({ registers: afterOff.json.syncStats.registers, disposes: afterOff.json.syncStats.disposes }),
)

// ── 沙箱:能力位 ≠ 本会话有效策略 ──
// dsh 的 shell.sandboxMode 是**部署默认档**(dsh-pwsh-sandbox 里就是 sandboxPolicy.defaultMode),
// 不是本会话的有效策略。修前只看它 → danger-full-access 的会话也被判成 workspace-write,
// 接管被永久锁死,简报还把部署默认档谎报成本会话策略。
// 修后:能力位只决定「能不能直连」,有效策略逐会话问 sandboxPolicy.resolve。
const hSandbox = makeHarness({
  shippedTools: ['bash'],
  agentIds: [{ id: 'agent-s', session: { key: 'work' } }],
  shell: { sandboxMode: 'workspace-write' },
  sandboxPolicy: fakeSandboxPolicy('workspace-write'),
})
apply(hSandbox.ctx, { syncIntervalMs: 25 })
await post(hSandbox, { op: 'setOption', shellTakeover: 'takeover' })
await post(hSandbox, { op: 'setShell', key: 'auto' })
await waitForBrief(hSandbox)
const sandboxSnap = await pollSnapshot(hSandbox, (s) => Boolean(s.syncStats) && s.syncStats.sandboxBlocked === true)
phase('沙箱:按会话判策略')
check('有围栏的会话:不注册 envd_shell(不制造绕沙箱的旁路)', !hSandbox.state.toolDefs.has('envd_shell'))
check(
  '有围栏的会话:显式 takeover 也不接管',
  sandboxSnap.commandTool.takeover === false && sandboxSnap.commandTool.sandbox === true,
  JSON.stringify(sandboxSnap.commandTool),
)
check('有围栏的会话:宿主命令工具仍然可见(模型还有命令工具)', Boolean(hSandbox.toolsFor('agent-s').get('bash')))
check(
  '面板拿到三层事实:能力位 / 部署默认档 / 逐会话有效策略',
  sandboxSnap.sandbox &&
    sandboxSnap.sandbox.capable === true &&
    sandboxSnap.sandbox.defaultMode === 'workspace-write' &&
    sandboxSnap.sandbox.scopes[0].confined === true &&
    sandboxSnap.sandbox.scopes[0].mode === 'workspace-write',
  JSON.stringify(sandboxSnap.sandbox),
)
check(
  'API 没有会话 → commandTool 不谎报会话结论(confined=null),但逐会话事实在 sandbox.scopes 里',
  sandboxSnap.commandTool.sandboxMode === 'workspace-write' && sandboxSnap.commandTool.sandboxConfined === null && sandboxSnap.commandTool.sandboxPolicyKnown === true,
  JSON.stringify(sandboxSnap.commandTool),
)
// 简报是按会话求值的:带 scope 调一次,这才是模型真看到的那份
const confinedBrief = hSandbox.state.brief.text({ scope: hSandbox.state.agents[0] })
check(
  '有围栏会话的简报:按宿主工具的语法教(不再用默认终端的语法误导)',
  confinedBrief.includes('宿主自带') && confinedBrief.includes('bash / sh 语法') && !confinedBrief.includes('不在工具表里'),
  confinedBrief.split('\n').find((l) => l.includes('命令工具')) || '',
)
const sandboxBrief = String((await callApi(hSandbox)).json.brief)
// P0-1:逐会话终局端出来 —— 只有围栏会话时 EnvDock 根本不注册(trustedUnconfined=false),
// 终局必须如实写 host,不能因为「全局没接管」就把这个会话说成「已接管」或留空。
const sandboxFact = ((sandboxSnap.commandTool || {}).scopes || []).find((s) => s.id === 'agent-s')
check(
  '只有围栏会话时不注册 envd_shell(registers 为 0)',
  sandboxSnap.syncStats.registers === 0,
  'registers=' + sandboxSnap.syncStats.registers + ' scopes=' + JSON.stringify((sandboxSnap.commandTool || {}).scopes),
)
check(
  '围栏会话的逐会话终局如实写 host(不是 takeover)',
  sandboxFact &&
    sandboxFact.kind === 'host' &&
    sandboxFact.tool === 'bash' &&
    sandboxFact.confined === true &&
    sandboxFact.hidesOwn === false &&
    (sandboxFact.hidden || []).length === 0,
  JSON.stringify(sandboxFact),
)
check(
  'API 简报不再写「本会话策略未知」,改指路 scopes',
  !sandboxBrief.includes('本会话策略未知') && sandboxBrief.includes('见 scopes'),
  sandboxBrief.split('\n').find((l) => l.includes('命令工具')) || '',
)
check('沙箱时简报说明为什么没接管', sandboxBrief.includes('沙箱'), sandboxBrief.split('\n').find((l) => l.includes('沙箱')) || '')

// 同一个部署默认档,但本会话 resolve 出 danger-full-access → 必须照常接管(假阳性修复)
const hFull = makeHarness({
  shippedTools: ['bash'],
  agentIds: [{ id: 'agent-f', session: { key: 'full' } }],
  shell: { sandboxMode: 'workspace-write' },
  sandboxPolicy: fakeSandboxPolicy('workspace-write', { full: 'danger-full-access' }),
})
apply(hFull.ctx, { syncIntervalMs: 25 })
await post(hFull, { op: 'setOption', shellTakeover: 'takeover' })
const fullSnap = await pollSnapshot(hFull, (s) => Boolean(s.commandTool) && s.commandTool.takeover === true)
check('本会话 danger-full-access → 照常接管(不再被部署默认档锁死)', hFull.state.toolDefs.has('envd_shell'), JSON.stringify(fullSnap.commandTool))
check('无围栏会话里宿主 bash 被遮挡(只留一个命令工具)', hFull.toolsFor('agent-f').get('bash') === null)
check(
  '无围栏会话的简报说明「本会话策略 … 无围栏」',
  hFull.state.brief.text({ scope: hFull.state.agents[0] }).includes('无围栏'),
  hFull.state.brief.text({ scope: hFull.state.agents[0] }).split('\n').find((l) => l.includes('命令工具')) || '',
)

// 策略不可知(执行器会围栏但没有 sandboxPolicy 服务)→ 不猜:宁可先不接管
const hPolicy = makeHarness({ shippedTools: ['bash'], agentIds: [{ id: 'agent-p', session: { key: 'p' } }], shell: { sandboxPolicy: { mode: 'workspace-write' } } })
apply(hPolicy.ctx, { syncIntervalMs: 25 })
await post(hPolicy, { op: 'setOption', shellTakeover: 'takeover' })
const policySnap = await pollSnapshot(hPolicy, (s) => Boolean(s.syncStats) && s.syncStats.sandboxBlocked === true)
check(
  '只有 shell.sandboxPolicy、没有策略服务 → 保守不接管',
  policySnap.commandTool.takeover === false && policySnap.commandTool.sandbox === true,
  JSON.stringify(policySnap.commandTool),
)
check('保守判定下宿主命令工具仍然可用', Boolean(hPolicy.toolsFor('agent-p').get('bash')))

// dsh-ops 在 cordis 模式用 ops_bash 顶替官方 shell 工具:EnvDock 必须认得出这个家族,
// 否则接管之后模型会同时看到 ops_bash + envd_shell 两个命令工具(想藏也藏不掉)。
const hOps = makeHarness({ shippedTools: ['ops_bash'], agentIds: ['agent-ops'] })
apply(hOps.ctx, { syncIntervalMs: 25 })
await post(hOps, { op: 'setOption', shellTakeover: 'takeover' })
const opsSnap = await pollSnapshot(hOps, (s) => Boolean(s.commandTool) && s.commandTool.takeover === true)
check('认领 ops_bash 为宿主 bash 工具(shippedShell 报得出)', opsSnap.shippedShell === 'ops_bash', String(opsSnap.shippedShell))
check('接管后 ops_bash 被遮挡(不同时暴露两个命令工具)', hOps.toolsFor('agent-ops').get('ops_bash') === null)
check('挡住 ops_bash 之后 envd_shell 仍然可见', Boolean(hOps.toolsFor('agent-ops').get('envd_shell')))

// dsh-ops 的 session-shells 把 ops_bash 挂在**会话自己的层**里:restrict 过滤不到它。
// EnvDock 必须让路(藏自己、留宿主),而不是让模型同时看到两个命令工具。
const hLocal = makeHarness({
  shippedTools: ['ops_bash'],
  agentIds: ['agent-local'],
  unrestrictableFor: (scopeId, name) => name === 'ops_bash',
})
apply(hLocal.ctx, { syncIntervalMs: 25 })
await post(hLocal, { op: 'setOption', shellTakeover: 'takeover' })
const localSnap = await pollSnapshot(hLocal, (s) => (s.syncStats.hostOnlyScopes || []).includes('agent-local'), 6000)
check(
  '作用域私有的宿主 shell 挡不掉 → 记进 hostOnlyScopes(不是静默)',
  (localSnap.syncStats.hostOnlyScopes || []).includes('agent-local'),
  JSON.stringify(localSnap.syncStats.hostOnlyScopes),
)
check('让路:该会话还剩宿主的 ops_bash', Boolean(hLocal.toolsFor('agent-local').get('ops_bash')))
check('让路:该会话的 envd_shell 已藏(不同时暴露两个)', hLocal.toolsFor('agent-local').get('envd_shell') === null)
check('挡不掉的 ops_bash 也记进 unrestrictable', (localSnap.syncStats.unrestrictable || []).includes('ops_bash'), JSON.stringify(localSnap.syncStats.unrestrictable))
// P0-1:让路会话的逐会话终局。tool 是宿主 shell 名(不是 envd_shell),hidden 空(藏的是我们自己),
// visible 走的是该作用域的口径(宿主工具真的可执行)。
const localFact = ((localSnap.commandTool || {}).scopes || []).find((s) => s.id === 'agent-local')
check(
  '让路会话的逐会话终局:kind=yield、tool=宿主 shell、visible、hidesOwn、hidden 为空',
  localFact &&
    localFact.kind === 'yield' &&
    localFact.tool === 'ops_bash' &&
    localFact.visible === true &&
    localFact.hidesOwn === true &&
    Array.isArray(localFact.hidden) &&
    localFact.hidden.length === 0,
  JSON.stringify(localFact),
)
// P3-9:让路是稳态 —— yieldTicks 跟着 tick 涨,而注册表三个相位一动不动。
// 这两个数一起涨就说明让路分支在 5 秒一次地拆建工具(模型会撞上 unknown tool 空窗)。
const yieldBefore = (await callApi(hLocal)).json.syncStats
await new Promise((r) => setTimeout(r, 250))
const yieldAfter = (await callApi(hLocal)).json.syncStats
check(
  '让路是稳态:yieldTicks 随 tick 涨,registers/disposes/denyApplies 不变',
  yieldAfter.ticks > yieldBefore.ticks &&
    yieldAfter.yieldTicks > yieldBefore.yieldTicks &&
    yieldAfter.registers === yieldBefore.registers &&
    yieldAfter.disposes === yieldBefore.disposes &&
    yieldAfter.denyApplies === yieldBefore.denyApplies,
  JSON.stringify({
    ticks: [yieldBefore.ticks, yieldAfter.ticks],
    yieldTicks: [yieldBefore.yieldTicks, yieldAfter.yieldTicks],
    registers: [yieldBefore.registers, yieldAfter.registers],
    disposes: [yieldBefore.disposes, yieldAfter.disposes],
    denyApplies: [yieldBefore.denyApplies, yieldAfter.denyApplies],
  }),
)
const localBrief = hLocal.state.brief.text({ scope: hLocal.state.agents[0] })
check('让路会话的简报说清「用宿主工具、EnvDock 已让路」', localBrief.includes('让路'), localBrief.split('\n').find((l) => l.includes('命令工具')) || '')

// 混合部署:有围栏的会话用宿主工具,无围栏的会话用 envd_shell —— 一个会话的策略不该锁死另一个
const hMix = makeHarness({
  shippedTools: ['bash'],
  agentIds: [
    { id: 'agent-free', session: { key: 'free' } },
    { id: 'agent-locked', session: { key: 'locked' } },
  ],
  shell: { sandboxMode: 'workspace-write' },
  sandboxPolicy: fakeSandboxPolicy('workspace-write', { free: 'danger-full-access' }),
})
apply(hMix.ctx, { syncIntervalMs: 25 })
await post(hMix, { op: 'setOption', shellTakeover: 'takeover' })
await pollSnapshot(hMix, (s) => Boolean(s.commandTool) && s.commandTool.takeover === true)
phase('混合部署:按会话遮不同工具')
check(
  '无围栏会话:用 envd_shell,宿主 bash 被藏',
  Boolean(hMix.toolsFor('agent-free').get('envd_shell')) && hMix.toolsFor('agent-free').get('bash') === null,
  'free=' + ['envd_shell', 'bash'].filter((n) => hMix.toolsFor('agent-free').get(n)).join(','),
)
check(
  '有围栏会话:用宿主 bash,envd_shell 被藏(不制造零工具)',
  Boolean(hMix.toolsFor('agent-locked').get('bash')) && hMix.toolsFor('agent-locked').get('envd_shell') === null,
  'locked=' + ['envd_shell', 'bash'].filter((n) => hMix.toolsFor('agent-locked').get(n)).join(','),
)
// P0-1:同一进程里两种终局并存 —— 面板不能只看全局 commandTool.visible 就报「已接管」,
// 逐会话 scopes 必须各报各的:free=takeover,locked=sandbox-host(用宿主带围栏的 bash)。
const mixSnap = (await callApi(hMix)).json
const mixFreeFact = ((mixSnap.commandTool || {}).scopes || []).find((s) => s.id === 'agent-free')
const mixLockedFact = ((mixSnap.commandTool || {}).scopes || []).find((s) => s.id === 'agent-locked')
check(
  '混合部署:无围栏会话 kind=takeover、tool=envd_shell、hidden 含宿主 bash',
  mixFreeFact &&
    mixFreeFact.kind === 'takeover' &&
    mixFreeFact.tool === 'envd_shell' &&
    (mixFreeFact.hidden || []).includes('bash') &&
    mixFreeFact.hidesOwn === false,
  JSON.stringify(mixFreeFact),
)
check(
  '混合部署:围栏会话 kind=sandbox-host、tool=宿主 bash、hidesOwn、confined',
  mixLockedFact &&
    mixLockedFact.kind === 'sandbox-host' &&
    mixLockedFact.tool === 'bash' &&
    mixLockedFact.hidesOwn === true &&
    mixLockedFact.confined === true &&
    mixLockedFact.visible === true,
  JSON.stringify(mixLockedFact),
)

// 围栏下调用 envd_shell:没有可委托的宿主执行器 → 拒绝,绝不 spawn 一条无 policy 的命令。
// 新语义(rev:delegateRefusals):进入委托路径先记 delegateTries,拒绝单独记 delegateRefusals ——
// 「拒绝(没执行)」不再混进 delegateFailures(执行阶段出错)。
const mixTool = hMix.state.toolDefs.get('envd_shell')
const mixRefuseBefore = (await callApi(hMix)).json.syncStats
const refusedHere = await mixTool.execute({ command: 'echo portable-bypass', cwd: process.cwd() }, { signal: null, agent: { session: { key: 'locked' } } })
const mixRefuseAfter = (await callApi(hMix)).json.syncStats
check(
  '围栏会话调用 envd_shell:拒绝而不是 spawn(宿主没有可委托执行器)',
  refusedHere.ok === false &&
    refusedHere.text.includes('[sandbox]') &&
    refusedHere.text.includes('没有可委托的执行器') &&
    refusedHere.text.includes('请改用宿主自带的命令工具'),
  String(refusedHere.text).slice(0, 160),
)
check(
  '拒绝单独记账:delegateTries+1 / delegateRefusals+1 / delegateFailures 不变 / delegateCalls 不变',
  mixRefuseAfter.delegateTries === mixRefuseBefore.delegateTries + 1 &&
    mixRefuseAfter.delegateRefusals === mixRefuseBefore.delegateRefusals + 1 &&
    mixRefuseAfter.delegateFailures === mixRefuseBefore.delegateFailures &&
    mixRefuseAfter.delegateCalls === mixRefuseBefore.delegateCalls,
  JSON.stringify({
    tries: [mixRefuseBefore.delegateTries, mixRefuseAfter.delegateTries],
    refusals: [mixRefuseBefore.delegateRefusals, mixRefuseAfter.delegateRefusals],
    failures: [mixRefuseBefore.delegateFailures, mixRefuseAfter.delegateFailures],
    calls: [mixRefuseBefore.delegateCalls, mixRefuseAfter.delegateCalls],
  }),
)
check(
  '拒绝时没有产生子进程(核对 spawn 记录)',
  !hMix.subprocess.calls.some((c) => (c.argv || []).some((a) => String(a).includes('portable-bypass'))),
  String(hMix.subprocess.calls.length),
)

// 围栏下委托执行:命令经**带围栏的宿主执行器**跑,并带上本会话 policy(围栏不被绕过)
const hostShell = fakeSandboxedShell({ stdout: 'delegated-ok\n' })
const hDelegate = makeHarness({
  shippedTools: ['bash'],
  agentIds: [
    { id: 'agent-free2', session: { key: 'free2' } },
    { id: 'agent-locked2', session: { key: 'locked2' } },
  ],
  shell: hostShell,
  sandboxPolicy: fakeSandboxPolicy('workspace-write', { free2: 'danger-full-access' }),
})
apply(hDelegate.ctx, { syncIntervalMs: 25 })
await post(hDelegate, { op: 'setOption', shellTakeover: 'takeover' })
await pollSnapshot(hDelegate, (s) => Boolean(s.commandTool) && s.commandTool.takeover === true)
const delTool = hDelegate.state.toolDefs.get('envd_shell')
const delegated = await delTool.execute({ command: 'echo delegated', cwd: process.cwd() }, { signal: null, agent: { session: { key: 'locked2' } } })
phase('围栏下委托执行')
check(
  '委托执行走宿主执行器(resolve + execute 都被调用)',
  hostShell.calls.resolved.length === 1 && hostShell.calls.executed.length === 1,
  JSON.stringify({ r: hostShell.calls.resolved.length, e: hostShell.calls.executed.length }),
)
check(
  '委托时带上本会话 policy(围栏不会被绕过)',
  Boolean(hostShell.calls.executed[0].sandboxPolicy) && hostShell.calls.executed[0].sandboxPolicy.mode === 'workspace-write',
  JSON.stringify(hostShell.calls.executed[0].sandboxPolicy),
)
// 委托包装器按**目标终端族**安全编码(审校后的新约定):
//   命令数据一律走 env ENVD_CMD 的 base64(UTF-8)载荷 —— 命令行里永远没有用户原文;
//   目标 bash → 目标端 `printf %s $ENVD_CMD | base64 -d | bash -s`(外层 -lc 已经是登录 shell,
//                 内层再带 -l 会让 profile 跑第二次 —— 安全审计 P4);
//   目标 PowerShell → -Command 脚本自己从 $env:ENVD_CMD 解码再 Invoke-Expression
//     (不再用 -EncodedCommand;脚本前缀固定 [Console]::OutputEncoding = UTF-8,避免非 65001 代码页中文乱码);
//   目标 cmd/wsl/custom → 拒绝委托。以下按目标族各自核对。
const delegateTargetFamily = (await callApi(hDelegate)).json.shell.family
const dSpec = hostShell.calls.executed[0]
check('委托包装器:命令行里不含用户原文(不会被引号吞噬)', !String(dSpec.command).includes('echo delegated'), String(dSpec.command).slice(0, 200))
if (delegateTargetFamily === 'bash') {
  const dBash = String(dSpec.command)
  check(
    'bash 目标:ENVD_CMD 是 base64 载荷,目标端 base64 -d | bash -s 解码(外层 -lc 已登录,内层不重复 profile)',
    dBash.includes('base64 -d | bash -s') && decodeBashPayload(dSpec) === 'echo delegated' && !dBash.includes('echo delegated'),
    JSON.stringify({ command: dBash.slice(0, 240), payload: decodeBashPayload(dSpec) }),
  )
} else if (delegateTargetFamily === 'powershell') {
  const dScript = String(dSpec.command)
  const dPayload = decodePowerShellPayload(dSpec)
  check(
    'PowerShell 目标:-Command + $env:ENVD_CMD(UTF-8 base64)载荷;不用 -EncodedCommand / -lc',
    dScript.includes('-Command') &&
      dScript.includes('$env:ENVD_CMD') &&
      !dScript.includes('-EncodedCommand') &&
      !dScript.includes('-lc') &&
      dPayload === 'echo delegated',
    JSON.stringify({ command: dScript.slice(0, 260), payload: dPayload }),
  )
} else {
  skip('bash/PowerShell 目标委托包装器断言', '默认终端族=' + delegateTargetFamily + '(cmd/wsl/custom 会拒绝委托)')
}
check(
  '委托执行的输出回来了(带沙箱事实)',
  delegated.ok === true && delegated.text.includes('delegated-ok') && delegated.text.includes('[sandbox]'),
  String(delegated.text).slice(0, 160),
)
// P3-9:委托路径真的被走过一次 —— 诊断条靠这个数区分「围栏会话没走过委托」和「走了、但宿主拒绝」。
const delegateStats = (await callApi(hDelegate)).json.syncStats
check('成功委托被记账:syncStats.delegateCalls === 1', delegateStats.delegateCalls === 1, String(delegateStats.delegateCalls))
await post(hDelegate, { op: 'setOption', sandboxTakeover: 'refuse' })
const refusedByOpt = await delTool.execute({ command: 'echo delegated' }, { signal: null, agent: { session: { key: 'locked2' } } })
check('sandboxTakeover=refuse:围栏会话直接拒绝', refusedByOpt.ok === false && refusedByOpt.text.includes('沙箱围栏'), String(refusedByOpt.text).slice(0, 140))
await post(hDelegate, { op: 'setOption', sandboxTakeover: 'delegate' })

// ── 学 dsh-ops:被藏掉的宿主 shell 直呼时给可操作拒绝(guard),而不是 UNKNOWN_TOOL ──
const hGuard = makeHarness({ shippedTools: ['bash'], agentIds: ['agent-guard'] })
apply(hGuard.ctx, { syncIntervalMs: 60000 })
await post(hGuard, { op: 'setOption', shellTakeover: 'takeover' })
await pollSnapshot(hGuard, (s) => Boolean(s.commandTool) && s.commandTool.takeover === true)
const guardReason = hGuard.guardReason('bash', hGuard.state.agents[0])
phase('拒绝守卫(学 dsh-ops 的 refusal)')
check(
  'guard 注册了,直呼被藏的宿主 shell 会得到可操作拒绝',
  typeof guardReason === 'string' && guardReason.includes('envd_shell'),
  String(guardReason),
)
// P3-9:守卫真的命中过一次就记一次 —— 诊断条要能证明拒绝路径被走过,不是只看静态配置猜。
const guardStats = (await callApi(hGuard)).json.syncStats
check('守卫命中被记账:syncStats.guardDenials === 1', guardStats.guardDenials === 1, String(guardStats.guardDenials))
check('guard 不拦我们自己的工具', hGuard.guardReason('envd_shell', hGuard.state.agents[0]) === undefined)
// 我们的工具在这个作用域不可见时,guard 必须放行宿主 shell —— 绝不制造「两个都调不到」
hGuard.setScopeDeny('agent-guard', ['envd_shell'])
const guardPassBefore = (await callApi(hGuard)).json.syncStats.guardDenials
const guardPassReason = hGuard.guardReason('bash', hGuard.state.agents[0])
const guardPassAfter = (await callApi(hGuard)).json.syncStats.guardDenials
check('envd_shell 不可见时 guard 放行宿主 shell(零工具保险)', guardPassReason === undefined, String(guardPassReason))
// 方向二放行是「放行」不是「拒绝」:计数不能涨,否则诊断条会把零工具保险误报成拒绝。
check('方向二放行不涨计数(放行不是拒绝)', guardPassAfter === guardPassBefore, guardPassBefore + ' → ' + guardPassAfter)
hGuard.setScopeDeny('agent-guard', [])
// fact 还没生成(新 agent 首步 / 会话还没登记):仍给可操作拒绝,但不编造替代工具名。
hGuard.setScopeDeny('agent-ghost', ['envd_shell'])
const ghostAgent = hGuard.makeAgent('agent-ghost')
const ghostRefusal = hGuard.guardReason('envd_shell', ghostAgent)
check(
  'fact 缺失时给「暂时无法判定」的可操作拒绝(不静默放行、不编造工具名)',
  typeof ghostRefusal === 'string' && ghostRefusal.includes('不可用') && ghostRefusal.includes('暂时无法判定') && !ghostRefusal.includes('`bash`'),
  String(ghostRefusal),
)
hGuard.setScopeDeny('agent-ghost', [])
check('guardReady 记录守卫注册成功(失败原因在 guardError)', (await callApi(hGuard)).json.syncStats.guardReady === true, JSON.stringify((await callApi(hGuard)).json.syncStats.guardError))

// ── 学 dsh-ops:tools/change 驱动对账(别的插件晚一步注册 shell 时立刻收敛,不等 5 秒) ──
const hEvt = makeHarness({ agentIds: ['agent-evt'] })
apply(hEvt.ctx, { syncIntervalMs: 60000 })
await post(hEvt, { op: 'setOption', shellTakeover: 'auto' })
await waitForBrief(hEvt)
check('前置:宿主还没注册命令工具时先不接管', !hEvt.state.toolDefs.has('envd_shell'))
// 模拟别的插件在 apply 之后才注册 bash,并按真机语义派发 tools/change
hEvt.state.toolDefs.set('bash', {
  name: 'bash',
  description: 'late bash',
  parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] },
  execute: async () => ({}),
})
hEvt.emit('tools/change')
const evtSnap = await pollSnapshot(hEvt, (s) => Boolean(s.commandTool) && s.commandTool.takeover === true, 1500)
phase('事件驱动对账')
check('tools/change 之后立刻接管(不等 60 秒 tick)', Boolean(evtSnap.commandTool && evtSnap.commandTool.takeover), JSON.stringify(evtSnap.commandTool))
check('遮挡也立刻生效(宿主的 bash 已藏)', hEvt.toolsFor('agent-evt').get('bash') === null)

// ── 不变量:已遮挡作用域里 envd_shell 消失 → 立刻把宿主 shell 还回去(不制造零工具) ──
const hDeny = makeHarness({ shippedTools: ['bash'], agentIds: ['agent-r'] })
apply(hDeny.ctx, { syncIntervalMs: 25 })
await post(hDeny, { op: 'setOption', shellTakeover: 'takeover' })
await pollSnapshot(hDeny, (s) => Boolean(s.commandTool) && s.commandTool.takeover === true)
for (let i = 0; i < 200 && hDeny.toolsFor('agent-r').get('bash') !== null; i++) await new Promise((r) => setTimeout(r, 10))
check('前置:接管后宿主 bash 已被遮挡', hDeny.toolsFor('agent-r').get('bash') === null)
// 别的插件在这个**已遮挡**作用域里把 envd_shell 也遮住:宿主的被我们挡、我们的看不见 = 零命令工具。
hDeny.setScopeDeny('agent-r', ['bash', 'envd_shell'])
const healed = await pollSnapshot(hDeny, (s) => (s.syncStats.blockedScopes || []).includes('agent-r'))
phase('已遮挡作用域复检')
check('已遮挡作用域里我们的工具不可见 → 立刻放开宿主 shell', Boolean(hDeny.toolsFor('agent-r').get('bash')))
check('并记进 blockedScopes(不是静默)', (healed.syncStats.blockedScopes || []).includes('agent-r'), JSON.stringify(healed.syncStats.blockedScopes))
hDeny.setScopeDeny('agent-r', [])
await pollSnapshot(hDeny, (s) => hDeny.toolsFor('agent-r').get('bash') === null && (s.syncStats.blockedScopes || []).length === 0)
check('恢复可见后自动补上遮挡', hDeny.toolsFor('agent-r').get('bash') === null)

// ── 不变量:挡不掉是「作用域私有」的,不能株连别的挡得掉的作用域 ──
const hSplit = makeHarness({
  shippedTools: ['bash'],
  agentIds: ['agent-x', 'agent-y'],
  unrestrictableFor: (scopeId, name) => scopeId === 'agent-x' && name === 'bash',
})
apply(hSplit.ctx, { syncIntervalMs: 25 })
await post(hSplit, { op: 'setOption', shellTakeover: 'takeover' })
const splitSnap = await pollSnapshot(hSplit, (s) => Boolean(s.syncStats) && (s.syncStats.unrestrictable || []).includes('bash'))
phase('失败名单按作用域记')
check('A 域挡不掉 → 宿主的 bash 保留(宁可两个,不要零个)', Boolean(hSplit.toolsFor('agent-x').get('bash')))
check('B 域挡得掉 → 遮挡照常生效(没被全局黑名单株连)', hSplit.toolsFor('agent-y').get('bash') === null)
check('挡不掉的名单只按作用域并集记账', (splitSnap.syncStats.unrestrictable || []).includes('bash'))
check(
  '面板 denies 取交集:部分作用域漏挡时不谎报全挡',
  !(splitSnap.commandTool.denies || []).includes('bash'),
  JSON.stringify(splitSnap.commandTool.denies),
)

// ── 沙箱在接管之后才出现 / 之后消失:窗口必须收敛,不留无围栏后门 ──
const shellSvc = {}
const hLife = makeHarness({ shippedTools: ['bash'], agentIds: ['agent-l'], shell: shellSvc })
apply(hLife.ctx, { syncIntervalMs: 60000 }) // 长周期:靠 kick / 状态变更对账,窗口可控
await pollSnapshot(hLife, (s) => Boolean(s.commandTool) && s.commandTool.takeover === true, 8000)
const lifeTool = hLife.state.toolDefs.get('envd_shell')
check('前置:接管已建立(命令工具可执行)', Boolean(lifeTool))
shellSvc.sandboxMode = 'workspace-write'
// 还没到下一轮对账:执行侧必须自己挡住,不能靠「5 秒内会拆」兜底。
// 新语义:围栏下这一步走委托路径 → 宿主没有可委托执行器(这个夹具的 shell 只有一个 sandboxMode 字段)
// /没有会话信息时一律**拒绝**,而不是退回无围栏 spawn。
const refused = await lifeTool.execute({ command: 'echo hi' }, { signal: null, agent: null })
check(
  '沙箱出现后、对账之前,执行侧拒绝 spawn(无围栏窗口为 0)',
  refused.ok === false &&
    refused.text.includes('[sandbox]') &&
    (refused.text.includes('没有可委托的执行器') || refused.text.includes('本会话信息缺失')) &&
    !hLife.subprocess.calls.some((c) => (c.argv || []).some((a) => String(a).includes('echo hi'))),
  JSON.stringify({ text: String(refused.text).slice(0, 160), spawns: hLife.subprocess.calls.length }),
)
await post(hLife, { op: 'setOption', injectBrief: true }) // 触发一次对账
const lifeOff = await pollSnapshot(hLife, (s) => Boolean(s.commandTool) && s.commandTool.takeover === false && s.commandTool.sandbox === true)
check('沙箱出现后自动放开接管(摘掉 envd_shell)', lifeOff.commandTool.takeover === false && !hLife.state.toolDefs.has('envd_shell'))
check('放开后宿主命令工具可见', Boolean(hLife.toolsFor('agent-l').get('bash')))
delete shellSvc.sandboxMode
await post(hLife, { op: 'setOption', injectBrief: true })
const lifeBack = await pollSnapshot(hLife, (s) => Boolean(s.commandTool) && s.commandTool.takeover === true)
check('沙箱消失后自动恢复接管', lifeBack.commandTool.takeover === true && hLife.state.toolDefs.has('envd_shell'))

// ── py -0p 失败不缓存:一次失败不能把「Python 多版本」钉死 10 分钟 ──
// 用独立的 py.exe 桩目录(不同路径 = 不同的版本缓存 key),避免前面成功探测留下的缓存干扰。
const failDir = mkdtempSync(join(tmpdir(), 'envdock-pyfail-'))
writeFileSync(join(failDir, 'py.exe'), '', 'utf8')
const pathBeforePyFail = process.env.PATH
process.env.PATH = failDir
try {
  const hPyFail = makeHarness({ subprocess: { exitWhen: (argv) => (argv || [])[1] === '-0p' } })
  apply(hPyFail.ctx, {})
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
} finally {
  process.env.PATH = pathBeforePyFail
  rmSync(failDir, { recursive: true, force: true })
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
  const h5 = makeHarness({ subprocess: { registryPath: () => ({ machine: realPath, user: '' }) } })
  apply(h5.ctx, {})
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
  const h6 = makeHarness({ subprocess: { registryPath: () => ({ machine: realPath, user: newDir }) } })
  apply(h6.ctx, {})
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

  for (const { dis } of [...h5.state.effects, ...h6.state.effects]) {
    try {
      if (typeof dis === 'function') dis()
    } catch {}
  }
} finally {
  process.env.PATH = realPath
  rmSync(newDir, { recursive: true, force: true })
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
  const h7 = makeHarness({ subprocess: { registryPath: () => ({ machine: launcherDir, user: '' }) } })
  apply(h7.ctx, {})
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
  for (const { dis } of h7.state.effects) {
    try {
      if (typeof dis === 'function') dis()
    } catch {}
  }
} finally {
  process.env.PATH = realPath
  rmSync(launcherDir, { recursive: true, force: true })
}

// 收尾
for (const { dis } of [...h.state.effects, ...h3.state.effects, ...h4.state.effects, ...h2.state.effects]) {
  try {
    if (typeof dis === 'function') dis()
  } catch {}
}

// ────────────────────────── 回归:切终端 / 跑 tick 绝不能把命令工具摘掉 ──
//
// 真实故障:22:14-22:30 之间连续多次 unknown tool "bash" / "powershell",
// 而同一时刻 GET /envdock-api 与 Tool.listTools 都显示命令工具一切正常。
// 根因三条:
//   ① appliedSig 存的是 `sigBase|name|own`,比较的却是裸 sigBase → 永远不相等 → 每 5 秒全量重建;
//   ② 重建是「先 teardown 再 register」→ 中间有一瞬间零个命令工具;
//   ③ 工具名跟着终端走 → 切终端必然经历一次「旧名没了、新名还没进工具表」。
// 这个用例把它们钉死:8 次终端切换 + 20 个稳态 tick,任何一步都不允许出现「零命令工具」,
// 且稳态 tick 的 register / dispose / deny 次数必须是 0。
const COMMAND_TOOL_NAMES = ['envd_shell', 'bash', 'powershell', 'pwsh', 'cmd', 'wsl', 'sh', 'zsh', 'fish']
const h8 = makeHarness({ shippedTools: ['bash'], agentIds: ['agent-a', 'agent-b'] })
apply(h8.ctx, { syncIntervalMs: 25 })
// 前面的用例把 shellTakeover 留成了 off(它测的就是「切到只给简报」),这里显式复位
await post(h8, { op: 'setOption', injectBrief: true, shellTakeover: 'auto' })
await freshDetection(h8)

const apiSnapshot = async () => (await callApi(h8)).json
/** 某个 agent 作用域此刻真正能看到哪些命令工具(restrict 掉的读作不存在) */
const visibleCommands = (agentId) => {
  const view = h8.toolsFor(agentId)
  return COMMAND_TOOL_NAMES.filter((name) => Boolean(view.get(name)))
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/**
 * 等对账 tick 真的推进 N 次。
 * tick 计数在 sync() 开头自增,而自增和对账在同一个同步块里 —— 所以「观察到推进」时那一轮已经跑完,
 * 中间的注册表状态不会被我们的采样插进去。
 */
async function waitTicks(count, timeoutMs = 15000) {
  const started = (await apiSnapshot()).syncStats.ticks
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const now = (await apiSnapshot()).syncStats.ticks
    if (now >= started + count) return now
    if (Date.now() > deadline) throw new Error('对账 tick 没有推进: ' + started + ' → ' + now)
    await sleep(10)
  }
}

// 等接管建立
let settled = null
for (let i = 0; i < 300; i++) {
  const snap = await apiSnapshot()
  if (snap.commandTool && snap.commandTool.name === 'envd_shell' && snap.commandTool.visible) {
    settled = snap
    break
  }
  await sleep(10)
}
phase('接管建立(固定名 envd_shell)')
check('接管建立:工具名是固定名 envd_shell 且真的可见', Boolean(settled), settled ? JSON.stringify(settled.commandTool) : '等不到可见的 envd_shell')
check(
  '接管时把宿主自带的 bash 在这两个 agent 作用域里都遮挡掉(不是并列两个)',
  visibleCommands('agent-a').join(',') === 'envd_shell' && visibleCommands('agent-b').join(',') === 'envd_shell',
  'a=' + visibleCommands('agent-a').join(',') + ' b=' + visibleCommands('agent-b').join(','),
)
// P0-1:直连接管的逐会话终局。面板头部据此显示 envd_shell + 「已接管」;
// hidden 必须是被 restrict 真正挡住的宿主 shell 名(账本口径,不是「本来想挡」)。
const settledScopes = (settled && settled.commandTool && settled.commandTool.scopes) || []
const takeoverFact = settledScopes.find((s) => s.id === 'agent-a')
check(
  '接管会话的逐会话终局:kind=takeover、tool=envd_shell、hidden 含被挡的宿主 bash、hidesOwn=false',
  takeoverFact &&
    takeoverFact.kind === 'takeover' &&
    takeoverFact.tool === 'envd_shell' &&
    (takeoverFact.hidden || []).includes('bash') &&
    takeoverFact.hidesOwn === false &&
    takeoverFact.visible === true,
  JSON.stringify(takeoverFact),
)
check(
  '逐会话终局按会话逐个记(两个 agent 各一条,不是只报一条全局)',
  settledScopes.length === 2 && settledScopes.every((s) => s.kind === 'takeover' && s.tool === 'envd_shell'),
  JSON.stringify(settledScopes),
)
check('syncStats 已端出去', Boolean(settled && settled.syncStats && typeof settled.syncStats.ticks === 'number'), JSON.stringify(settled && settled.syncStats))
check(
  '注册尝试数与成功数自洽(registerTries >= registers,没有建了又拆)',
  Boolean(settled && settled.syncStats && settled.syncStats.registerTries >= settled.syncStats.registers && settled.syncStats.registers >= 1),
  JSON.stringify(settled && { registerTries: settled.syncStats.registerTries, registers: settled.syncStats.registers }),
)
check('接管后简报只说「已接管」', String((await apiSnapshot()).brief).includes('EnvDock 已接管'), String((await apiSnapshot()).brief).split('\n').find((l) => l.includes('命令工具')) || '')

// 8 次终端切换
const termKeys = ((settled && settled.terminals) || []).map((t) => t.key)
const usable = termKeys.filter((key) => ['bash', 'powershell', 'cmd'].includes(key))
const ring = usable.includes('bash') && usable.length > 1 ? usable : ['auto']
const sequence = Array.from({ length: 8 }, (_, i) => ring[i % ring.length])
let emptyAt = ''
let sampleCount = 0
for (const key of sequence) {
  const res = await post(h8, { op: 'setShell', key })
  check('切到 ' + key + ' → 200', res.status === 200 && res.json.ok === true, res.raw.slice(0, 120))
  // 切换后每一步都检查:这一 tick 结束后模型还能不能看到命令工具
  for (let i = 0; i < 3; i++) {
    await waitTicks(1)
    sampleCount++
    if (!visibleCommands('agent-a').length || !visibleCommands('agent-b').length) {
      emptyAt = key + ' 第 ' + (i + 1) + ' 个 tick'
      break
    }
  }
  if (emptyAt) break
}
phase('8 次终端切换 × 3 tick')
check('8 次终端切换全程(' + sampleCount + ' 个采样点)都至少有一个命令工具可见', !emptyAt, '第一次空窗出现在 ' + emptyAt)
check(
  '每次切换后最终恰好一个命令工具(可见性稳定,不是靠两个工具凑数)',
  visibleCommands('agent-a').length === 1 && visibleCommands('agent-b').length === 1,
  'a=' + visibleCommands('agent-a').join(',') + ' b=' + visibleCommands('agent-b').join(','),
)
check(
  '切换过程中没有把宿主的 bash 永久挡掉(放开遮挡后还能回来)',
  visibleCommands('agent-a').length + visibleCommands('agent-b').length >= 2,
  'a=' + visibleCommands('agent-a').join(',') + ' b=' + visibleCommands('agent-b').join(','),
)

// 20 个稳态 tick:寄存器必须零动作
await post(h8, { op: 'setShell', key: 'auto' })
await waitTicks(4)
const steadyBefore = (await apiSnapshot()).syncStats
const visibleBefore = visibleCommands('agent-a').join(',')
phase('20 个稳态 tick')
const ticksAfter = await waitTicks(20)
const steadyAfter = (await apiSnapshot()).syncStats
check('稳态 tick 真的在跑(采样到 ' + ticksAfter + ')', steadyAfter.ticks > steadyBefore.ticks, steadyBefore.ticks + ' → ' + steadyAfter.ticks)
check('稳态 20 个 tick 里 register 次数为 0', steadyAfter.registers === steadyBefore.registers, steadyBefore.registers + ' → ' + steadyAfter.registers)
check('稳态 20 个 tick 里 dispose 次数为 0', steadyAfter.disposes === steadyBefore.disposes, steadyBefore.disposes + ' → ' + steadyAfter.disposes)
check('稳态 20 个 tick 里 deny 重挂次数为 0', steadyAfter.denyApplies === steadyBefore.denyApplies, steadyBefore.denyApplies + ' → ' + steadyAfter.denyApplies)
check(
  '稳态 20 个 tick 里没有新的注册尝试(registerTries 不变)',
  steadyAfter.registerTries === steadyBefore.registerTries,
  steadyBefore.registerTries + ' → ' + steadyAfter.registerTries,
)
check(
  '稳态 20 个 tick 里没有新的藏自己/挡宿主动作(ownHides / hostDenyApplies 不变)',
  steadyAfter.ownHides === steadyBefore.ownHides && steadyAfter.hostDenyApplies === steadyBefore.hostDenyApplies,
  JSON.stringify({ ownHides: [steadyBefore.ownHides, steadyAfter.ownHides], hostDenyApplies: [steadyBefore.hostDenyApplies, steadyAfter.hostDenyApplies] }),
)
check(
  '连续稳态里 steadySinceAt 保持不变(面板才算得出「已经稳态多久」)',
  steadyAfter.steadySinceAt === steadyBefore.steadySinceAt && steadyBefore.steadySinceAt > 0,
  JSON.stringify({ before: steadyBefore.steadySinceAt, after: steadyAfter.steadySinceAt }),
)
check(
  '计数恒等式:denyApplies === ownHides + hostDenyApplies(藏自己 / 挡宿主分开记账)',
  steadyAfter.denyApplies === steadyAfter.ownHides + steadyAfter.hostDenyApplies,
  JSON.stringify({ denyApplies: steadyAfter.denyApplies, ownHides: steadyAfter.ownHides, hostDenyApplies: steadyAfter.hostDenyApplies }),
)
check('稳态 20 个 tick 里可见性完全不变', visibleCommands('agent-a').join(',') === visibleBefore, visibleBefore + ' → ' + visibleCommands('agent-a').join(','))
check('稳态 tick 被记账(steadyTicks 在涨)', steadyAfter.steadyTicks > steadyBefore.steadyTicks, steadyBefore.steadyTicks + ' → ' + steadyAfter.steadyTicks)
check('稳态没有留下错误', !steadyAfter.lastError, String(steadyAfter.lastError))

// ── S1:「接管建立之后」才出现的 agent(新会话 / 子 agent)也必须被遮挡 ──
// 稳态快路径如果只看全局签名,addScope 里补的那次 sync 会直接落进 steady 返回,
// 新作用域永远拿不到掩码 → 那个作用域里模型同时看到 envd_shell 和宿主的 bash。
const lateAgent = h8.makeAgent('agent-late')
const regBeforeLate = (await apiSnapshot()).syncStats
h8.state.agents.push(lateAgent)
h8.emit('agent/created', { agent: lateAgent })
await waitTicks(3)
check(
  '接管后新建的 agent 也拿到了遮挡(只看到一个命令工具)',
  visibleCommands('agent-late').join(',') === 'envd_shell',
  visibleCommands('agent-late').join(','),
)
const regAfterLate = (await apiSnapshot()).syncStats
check('补遮挡没有动注册表(register 次数不变)', regAfterLate.registers === regBeforeLate.registers, regBeforeLate.registers + ' → ' + regAfterLate.registers)
check(
  '补遮挡确实调了 restrict(deny 次数 +1,不是靠别的原因看着像挡了)',
  regAfterLate.denyApplies === regBeforeLate.denyApplies + 1,
  regBeforeLate.denyApplies + ' → ' + regAfterLate.denyApplies,
)

// ── 先建后拆的反面:自己注册不上时,绝不能遮挡宿主的那个 ──
// (以前 teardown 在最前面:拆完注册失败 → 空窗一直持续到下一个 5s tick)
const h9 = makeHarness({ shippedTools: ['bash'], agentIds: ['agent-x'] })
// 别的插件已经占了固定名 → ctx.tools.register 会抛 duplicate
h9.state.toolDefs.set('envd_shell', {
  name: 'envd_shell',
  description: 'occupied by another plugin',
  parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] },
  execute: async () => ({}),
})
apply(h9.ctx, { syncIntervalMs: 25 })
await post(h9, { op: 'setOption', shellTakeover: 'auto' })
await post(h9, { op: 'setShell', key: 'auto' })
for (let i = 0; i < 300; i++) {
  const snap = (await callApi(h9)).json
  if (snap && snap.syncStats && snap.syncStats.ticks > 2) break
  await sleep(10)
}
const h9snap = (await callApi(h9)).json
const h9view = h9.toolsFor('agent-x')
const h9visible = COMMAND_TOOL_NAMES.filter((name) => Boolean(h9view.get(name)))
phase('固定名被占用')
check('固定名被占用时没有谎报接管', h9snap.commandTool.takeover === false, JSON.stringify(h9snap.commandTool))
check('固定名被占用时宿主自带的 bash 仍然可见(没有零工具窗口)', h9visible.includes('bash'), h9visible.join(','))
check('固定名被占用时留下可读的错误', Boolean(h9snap.syncStats.lastError), String(h9snap.syncStats.lastError))
// lastError 生命周期:持续故障要持续可见(不是一闪而过),恢复成功后才清空(见 hMiss)。
const h9a = (await callApi(h9)).json
await sleep(200)
const h9b = (await callApi(h9)).json
check(
  '名字被占用时 lastError 持续非空且带写入时刻(面板能显示「多久前」)',
  Boolean(h9a.syncStats.lastError) && Boolean(h9b.syncStats.lastError) && h9b.syncStats.lastErrorAt > 0,
  JSON.stringify({ lastError: h9b.syncStats.lastError, lastErrorAt: h9b.syncStats.lastErrorAt }),
)
// 注册失败退避(30s)必须被 tools/change 提前解除:占名方一释放就重试,不能干等退避结束。
const h9FreeAt = Date.now()
h9.state.toolDefs.delete('envd_shell')
h9.emit('tools/change')
const h9revived = await pollSnapshot(h9, (s) => Boolean(s.commandTool) && s.commandTool.takeover === true, 6000)
check(
  '占名释放 + tools/change → 立刻接管(不等 30s 退避)',
  Boolean(h9revived.commandTool && h9revived.commandTool.takeover === true) && h9.state.toolDefs.has('envd_shell'),
  JSON.stringify(h9revived.commandTool),
)
check('事件解除退避用了多久(<5s,远小于 30s)', Date.now() - h9FreeAt < 5000, String(Date.now() - h9FreeAt))
check('恢复接管后 lastError 被清空', !h9revived.syncStats.lastError, String(h9revived.syncStats.lastError))
check('固定名被占用时不注册自己的工具', h9snap.syncStats.registers === 0, String(h9snap.syncStats.registers))

// ── S2:卸载之后不许再往注册表里塞东西 ──
// 以前 cleanup 只清 interval 与 kick:addScope 的 250ms 定时器、探测回调的 then 都没有哨兵。
// 卸载之后它们仍会跑一次 reconcile → 把 envd_shell 重新注册回来,留下一个「幽灵工具」:
// 1) 它占着固定名;2) 下一次启用会被判成「已被其它插件占用」,接管再也起不来(直到重启 dsh)。
const h10 = makeHarness({ shippedTools: ['bash'], agentIds: ['agent-g'] })
apply(h10.ctx, { syncIntervalMs: 25 })
await post(h10, { op: 'setOption', shellTakeover: 'auto' })
await post(h10, { op: 'setShell', key: 'auto' })
let h10ready = false
for (let i = 0; i < 300; i++) {
  if (h10.state.toolDefs.has('envd_shell')) {
    h10ready = true
    break
  }
  await sleep(10)
}
phase('卸载 / 再启用')
check('卸载用例前置:接管已建立', h10ready, String(h10ready))
// 制造一个「还没到点」的 agent 补账定时器,然后立刻卸载
h10.emit('agent/created', { agent: h10.makeAgent('agent-g2') })
const firstGen = h10.state.effects.length
for (const { dis } of h10.state.effects) {
  try {
    if (typeof dis === 'function') dis()
  } catch {}
}
await sleep(900)
check('卸载后没有幽灵 envd_shell 被重新注册', !h10.state.toolDefs.has('envd_shell'), [...h10.state.toolDefs.keys()].join(','))
const afterUnload = h10.state.agents[0] && COMMAND_TOOL_NAMES.filter((name) => Boolean(h10.toolsFor(h10.state.agents[0].id).get(name)))
check('卸载后遮挡也没残留(模型能看到宿主的命令工具)', Boolean(afterUnload && afterUnload.includes('bash')), String(afterUnload))
// 同进程再启用:必须还能接管(不能被「名字被占用」永久挡住)
apply(h10.ctx, { syncIntervalMs: 25 })
await post(h10, { op: 'setOption', shellTakeover: 'auto' })
let revived = false
for (let i = 0; i < 400; i++) {
  const snap = (await callApi(h10)).json
  if (snap && snap.syncStats && snap.syncStats.registers > 0 && h10.state.toolDefs.has('envd_shell')) {
    revived = true
    break
  }
  await sleep(10)
}
const revivedSnap = (await callApi(h10)).json
check('卸载后同进程再启用,接管仍能起来', revived, JSON.stringify(revivedSnap && revivedSnap.syncStats))
check('再启用没有被误判成「已被其它插件占用」', !/占用/.test(String(revivedSnap && revivedSnap.syncStats && revivedSnap.syncStats.lastError)), String(revivedSnap && revivedSnap.syncStats && revivedSnap.syncStats.lastError))
for (const { dis } of h10.state.effects.slice(firstGen)) {
  try {
    if (typeof dis === 'function') dis()
  } catch {}
}

// ── S3:挡不掉的名字要收敛(不是每 tick 重试),而且不能谎报「全挡住了」 ──
// 真机上 restrict 对「作用域私有」的名字会失败,而宿主 shell 名只会越记越多;
// 不把挡不掉的名字剔掉,就是每 tick 一次无效 restrict + 面板显示全挡其实漏挡。
const h12 = makeHarness({ shippedTools: ['bash', 'zsh'], agentIds: ['agent-z'], unrestrictable: ['zsh'] })
apply(h12.ctx, { syncIntervalMs: 25 })
await post(h12, { op: 'setOption', shellTakeover: 'auto' })
await post(h12, { op: 'setShell', key: 'auto' })
for (let i = 0; i < 400; i++) {
  if (h12.state.toolDefs.has('envd_shell')) break
  await sleep(10)
}
const h12view = h12.toolsFor('agent-z')
const visibleZ = () => COMMAND_TOOL_NAMES.filter((name) => Boolean(h12view.get(name))).join(',')
for (let i = 0; i < 200; i++) {
  if (visibleZ().includes('bash') === false) break
  await sleep(10)
}
const z1 = (await callApi(h12)).json.syncStats
await sleep(600)
const z2 = (await callApi(h12)).json.syncStats
phase('挡不掉的名字')
check('挡不掉的名字收敛后不再重试', z2.denyApplies === z1.denyApplies && z2.denyDrops === z1.denyDrops, JSON.stringify([z1.denyApplies, z2.denyApplies, z1.denyDrops, z2.denyDrops]))
check('能挡的那个仍然被挡住(不只是不报错)', !visibleZ().includes('bash'), visibleZ())
check('挡不掉的名字在 syncStats 里说得清', (z2.unrestrictable || []).includes('zsh'), JSON.stringify(z2.unrestrictable) + ' vis=' + visibleZ())
check('面板用的 denies 不包含挡不掉的名字(不谎报)', !(z2 && (await callApi(h12)).json.commandTool.denies).includes('zsh'), JSON.stringify((await callApi(h12)).json.commandTool.denies))

// ── denyBlocked 自愈:某个作用域一度看不到 envd_shell,之后恢复可见必须补挡 ──
// 直接按结论永久跳过的话,这个作用域会永久漏挡(症状与「新 agent 不被遮挡」一致)。
const h13 = makeHarness({ shippedTools: ['bash'] })
apply(h13.ctx, { syncIntervalMs: 25 })
await post(h13, { op: 'setOption', shellTakeover: 'auto' })
await post(h13, { op: 'setShell', key: 'auto' })
for (let i = 0; i < 400; i++) {
  if (h13.state.toolDefs.has('envd_shell')) break
  await sleep(10)
}
// 新作用域:一开始就被别的插件遮住了 envd_shell
h13.setScopeDeny('agent-d', ['envd_shell'])
const blockedAgent = h13.makeAgent('agent-d')
h13.state.agents.push(blockedAgent)
h13.emit('agent/created', { agent: blockedAgent })
await sleep(600)
const h13view = h13.toolsFor('agent-d')
const visibleD = () => COMMAND_TOOL_NAMES.filter((name) => Boolean(h13view.get(name))).join(',')
phase('denyBlocked 自愈')
check('看不到我们的工具时,不遮挡宿主(宁可两个,也不要零个)', visibleD().includes('bash'), visibleD())
check(
  '被挡期间把「哪个作用域没遮挡」记在 blockedScopes 里(不是静默)',
  ((await callApi(h13)).json.syncStats.blockedScopes || []).includes('agent-d'),
  JSON.stringify((await callApi(h13)).json.syncStats.blockedScopes),
)
// 放开:envd_shell 重新可见
h13.setScopeDeny('agent-d', [])
for (let i = 0; i < 300; i++) {
  if (!visibleD().includes('bash')) break
  await sleep(10)
}
check('恢复可见后自动补上遮挡(不会永久漏挡)', !visibleD().includes('bash') && visibleD().includes('envd_shell'), visibleD())
const d2 = (await callApi(h13)).json
check('自愈后不再留着「该作用域没遮挡」的告警', (d2.syncStats.blockedScopes || []).length === 0, JSON.stringify(d2.syncStats.blockedScopes))

// ── P2-8:dsh-ops 的 ptc 折叠让 get 与 executable 分歧 ──
//
// 真机语义:`tools.get` 说「注册了」,`tools.executable` 说「这一单真的能调」。
// dsh-ops 在 ptc 模式下把替代工具折叠起来时,名字仍在工具表里,但模型直呼不可执行。
// EnvDock 以前只问 get → 把一下调不到的 envd_shell 当成就绪 → 挡住宿主的 bash →
// 那个会话里模型一个命令工具都调不到。夹具用 executableFor 把这条分歧固定下来:
// 只有 a-ptc 作用域里的 envd_shell「注册了但不可执行」,其余名字一律回落 get。
const hPtc = makeHarness({
  shippedTools: ['bash'],
  agentIds: ['a-ptc'],
  executableFor: (scopeId, name) => !(scopeId === 'a-ptc' && name === 'envd_shell'),
})
apply(hPtc.ctx, { syncIntervalMs: 25 })
await post(hPtc, { op: 'setOption', shellTakeover: 'takeover' })
const ptcSnap = await pollSnapshot(hPtc, (s) => Boolean(s.syncStats) && (s.syncStats.blockedScopes || []).includes('a-ptc'), 6000)
phase('PTC 折叠:get/executable 分歧')
const ptcView = hPtc.toolsFor('a-ptc')
const execOf = (name) => (typeof ptcView.executable === 'function' ? ptcView.executable(name) : 'missing')
check(
  '夹具前置:envd_shell 在 a-ptc 里 get 有、executable 无',
  Boolean(ptcView.get('envd_shell')) && execOf('envd_shell') === null,
  'get=' + Boolean(ptcView.get('envd_shell')) + ' executable=' + String(execOf('envd_shell')),
)
check(
  '夹具前置:其它名字的 executable 回落 get(宿主的 bash 仍然可执行)',
  Boolean(execOf('bash')),
  String(execOf('bash')),
)
check(
  'PTC 折叠下故意不挡宿主 bash(自己的工具调不到,再挡就是零命令工具)',
  Boolean(ptcView.get('bash')),
  'vis=' + ['envd_shell', 'bash'].filter((n) => ptcView.get(n)).join(','),
)
check(
  'PTC 折叠下记进 blockedScopes(不是静默)',
  (ptcSnap.syncStats.blockedScopes || []).includes('a-ptc'),
  JSON.stringify(ptcSnap.syncStats.blockedScopes),
)
check('PTC 折叠下没有真的 restrict 宿主 bash(denyApplies 为 0)', ptcSnap.syncStats.denyApplies === 0, String(ptcSnap.syncStats.denyApplies))
const ptcFact = (ptcSnap.commandTool.scopes || []).find((s) => s.id === 'a-ptc')
check(
  'PTC 折叠下逐会话终局是 host(用宿主工具),不是 takeover',
  ptcFact && ptcFact.kind === 'host' && ptcFact.tool === 'bash' && ptcFact.visible === true,
  JSON.stringify(ptcFact),
)
const ptcBrief = hPtc.state.brief.text({ scope: hPtc.state.agents[0] })
check(
  'PTC 折叠下的简报不自称「已接管」:点名宿主工具 bash,并说明 envd_shell 在本会话不可用',
  !ptcBrief.includes('已接管') && ptcBrief.includes('bash') && ptcBrief.includes('envd_shell'),
  ptcBrief.split('\n').find((l) => l.includes('命令工具')) || '',
)

// ── 多宿主 shell 回归:官方 pwsh(全局注册、被 dsh-ops 按会话藏掉)+ ops_bash(按会话发布)──
//
// 真机踩到的坑:旧实现用**全局** seenShells 算掩码,一旦官方 pwsh 被记进来,
// mask=['pwsh'] 就是非空 → 让路分支被跳过 → 挡不掉的 ops_bash 和 envd_shell 同时可见
// (模型手里两个命令工具,brief 还只提 envd_shell)。现在按作用域记忆判定:
// 本作用域只挡它自己见过的宿主 shell;挡不掉的只要此刻还在,就藏自己、让路。
const hMulti = makeHarness({
  shippedTools: ['bash', 'pwsh'],
  agentIds: ['agent-m'],
  // dsh-ops 的 ops_bash(这里用 bash 代表)是作用域私有、restrict 挡不掉;pwsh 挡得掉
  unrestrictableFor: (scopeId, name) => name === 'bash',
})
apply(hMulti.ctx, { syncIntervalMs: 25 })
await post(hMulti, { op: 'setOption', shellTakeover: 'takeover' })
const multiSnap = await pollSnapshot(
  hMulti,
  (s) => {
    const fact = ((s.commandTool || {}).scopes || []).find((x) => x.id === 'agent-m')
    return Boolean(fact && fact.kind === 'yield' && fact.hostTool === 'bash')
  },
  6000,
)
phase('多宿主 shell:让路(不许并列)')
const multiView = hMulti.toolsFor('agent-m')
const multiVisible = () => COMMAND_TOOL_NAMES.filter((name) => Boolean(multiView.get(name)))
check(
  '多宿主 shell:模型手里只有一个命令工具,而且是挡不掉的 bash',
  multiVisible().length === 1 && multiVisible()[0] === 'bash',
  multiVisible().join(','),
)
const multiFact = (multiSnap.commandTool.scopes || []).find((s) => s.id === 'agent-m')
check(
  '多宿主 shell:终局 kind=yield、tool/hostTool=bash、hidden 只含真正挡掉的 pwsh',
  Boolean(
    multiFact &&
      multiFact.kind === 'yield' &&
      multiFact.tool === 'bash' &&
      multiFact.hostTool === 'bash' &&
      multiFact.hidden.join(',') === 'pwsh' &&
      multiFact.hidesOwn === true,
  ),
  JSON.stringify(multiFact),
)
const multiBefore = (await callApi(hMulti)).json.syncStats
await sleep(300)
const multiAfter = (await callApi(hMulti)).json.syncStats
check(
  '多宿主 shell:让路是稳态(registers / disposes / denyApplies 不涨)',
  multiAfter.registers === multiBefore.registers &&
    multiAfter.disposes === multiBefore.disposes &&
    multiAfter.denyApplies === multiBefore.denyApplies,
  JSON.stringify([multiBefore.registers, multiAfter.registers, multiBefore.disposes, multiAfter.disposes, multiBefore.denyApplies, multiAfter.denyApplies]),
)
const multiBrief = hMulti.state.brief.text({ scope: hMulti.state.agents[0] })
check(
  '多宿主 shell:简报点名实际可用的宿主工具(bash),不再谎称只有 envd_shell',
  multiBrief.includes('已让路') && multiBrief.includes('`bash`'),
  multiBrief.split('\n').find((l) => l.includes('命令工具')) || '',
)
// 守卫方向一:替代品必须取**本会话事实里的 hostTool**(bash),不能取全局主 shell(pwsh,
// 而 pwsh 已被我们挡住)。旧实现拿全局 shippedName 做 hasTool 判定 → 不通过就静默放行,
// 模型只收到裸 UNKNOWN_TOOL —— 多宿主让路场景下最隐蔽的一条。
const multiGuardBefore = (await callApi(hMulti)).json.syncStats
const multiRefusal = hMulti.guardReason('envd_shell', hMulti.state.agents[0])
const multiGuardAfter = (await callApi(hMulti)).json.syncStats
check(
  '多宿主让路:直呼 envd_shell 指路本会话真正可用的 bash(不静默放行)',
  typeof multiRefusal === 'string' && multiRefusal.includes('bash') && !multiRefusal.includes('暂时无法判定'),
  String(multiRefusal),
)
check(
  '多宿主让路:守卫方向一命中记账 guardDenials +1',
  multiGuardAfter.guardDenials === multiGuardBefore.guardDenials + 1,
  multiGuardBefore.guardDenials + ' → ' + multiGuardAfter.guardDenials,
)
check(
  '多宿主让路:守卫命中后该会话仍只有一个命令工具(bash)',
  multiVisible().length === 1 && multiVisible()[0] === 'bash',
  multiVisible().join(','),
)

// ══════════════════ 本轮大改新增回归(7 类真问题) ══════════════════
//
// 下面每个用例都对应一条「修复前会静默出错」的真实故障。夹具先按真机语义补齐:
//   · tools.definitions(scope):枚举本作用域可见定义(动态识别第三方发布名);
//   · restrictNoop:restrict 返回成功却挡不住(agent 层同名工具);
//   · shellDefinitions:preset / 第三方发布在 agent 祖先层的命令工具定义。
/** 某个作用域此刻真正可用的命令工具名(restrict 掉的读作不存在) */
const scopeCommands = (h, agentId, names = COMMAND_TOOL_NAMES) => {
  const view = h.toolsFor(agentId)
  return names.filter((name) => Boolean(view.get(name)))
}
/** 切默认终端并等对账 tick 落地(60s 周期的夹具靠状态变更触发,别干等 interval)。 */
async function settleShell(h, key, timeoutMs = 8000) {
  const before = (await callApi(h)).json.syncStats.ticks
  const res = await post(h, { op: 'setShell', key })
  if (!res.json || res.json.ok !== true) return { error: 'setShell 失败: ' + res.raw.slice(0, 120) }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const s = (await callApi(h)).json
    if (s.syncStats.ticks >= before + 2) return s
    if (Date.now() > deadline) return s
    await sleep(10)
  }
}
/** 从检测到的终端里挑一个指定家族的 key(找不到返回 '')。 */
const terminalKeyOfFamily = (snap, family) => {
  const term = (snap.terminals || []).find((t) => t.key && t.family === family)
  return term ? term.key : ''
}

// ── c) hideOwn 自愈:别人短暂藏住 envd_shell 再放开,必须重新藏住(不能复活绕过沙箱) ──
//
// 真机故障:围栏会话里藏自己的工具时,如果那一刻它**本来就不可见**(别的插件先遮了),
// 旧实现直接记成「已藏」;别人一放开,envd_shell 就在围栏会话里复活 = 无围栏旁路。
// 而且 scopesSettled 跳过 hideOwn 复检,于是永远不自愈。
const hHeal = makeHarness({
  shippedTools: ['bash'],
  agentIds: [
    { id: 'agent-heal-free', session: { key: 'heal-free' } },
    { id: 'agent-heal-locked', session: { key: 'heal-locked' } },
  ],
  shell: { sandboxMode: 'workspace-write' },
  sandboxPolicy: fakeSandboxPolicy('workspace-write', { 'heal-free': 'danger-full-access' }),
})
apply(hHeal.ctx, { syncIntervalMs: 25 })
await post(hHeal, { op: 'setOption', shellTakeover: 'takeover' })
const healSnap = await pollSnapshot(
  hHeal,
  (s) => {
    const fact = ((s.commandTool || {}).scopes || []).find((x) => x.id === 'agent-heal-locked')
    return Boolean(fact && fact.kind === 'sandbox-host' && hHeal.toolsFor('agent-heal-locked').get('envd_shell') === null)
  },
  6000,
)
phase('hideOwn 自愈')
check(
  '前置:围栏会话的 envd_shell 已被藏住(kind=sandbox-host)',
  ((healSnap.commandTool || {}).scopes || []).some((x) => x.id === 'agent-heal-locked' && x.kind === 'sandbox-host'),
  JSON.stringify((healSnap.commandTool || {}).scopes),
)
// 别的插件在这个作用域里先遮住 envd_shell:此刻 EnvDock 一推 restrict 也是「本来就看不见」
hHeal.setScopeDeny('agent-heal-locked', ['envd_shell'])
await sleep(150)
const healAway = (await callApi(hHeal)).json
check(
  '看不见期间账本仍然如实:该会话仍有宿主 bash(不是零工具),envd_shell 不可见',
  Boolean(hHeal.toolsFor('agent-heal-locked').get('bash')) && hHeal.toolsFor('agent-heal-locked').get('envd_shell') === null,
  'vis=' + scopeCommands(hHeal, 'agent-heal-locked').join(',') + ' kind=' + JSON.stringify((((healAway.commandTool || {}).scopes || []).find((x) => x.id === 'agent-heal-locked') || {}).kind),
)
// 放开:envd_shell 重新可见 → 必须立刻重新藏住,否则围栏会话里我们的工具复活
hHeal.setScopeDeny('agent-heal-locked', [])
const healedSnap = await pollSnapshot(hHeal, () => hHeal.toolsFor('agent-heal-locked').get('envd_shell') === null, 6000)
const healedFact = ((healedSnap.commandTool || {}).scopes || []).find((x) => x.id === 'agent-heal-locked')
check(
  '别人放开后立刻重新藏住 envd_shell(围栏会话不能被我们的工具复活)',
  hHeal.toolsFor('agent-heal-locked').get('envd_shell') === null,
  'vis=' + scopeCommands(hHeal, 'agent-heal-locked').join(',') + ' fact=' + JSON.stringify(healedFact),
)
check(
  '自愈后终局仍是 sandbox-host,且该会话只有一个命令工具(bash)',
  Boolean(
    healedFact &&
      healedFact.kind === 'sandbox-host' &&
      healedFact.hidesOwn === true &&
      healedFact.tool === 'bash' &&
      scopeCommands(hHeal, 'agent-heal-locked').length === 1 &&
      scopeCommands(hHeal, 'agent-heal-locked')[0] === 'bash',
  ),
  JSON.stringify(healedFact) + ' vis=' + scopeCommands(hHeal, 'agent-heal-locked').join(','),
)

// ── d) 过渡性缺名不永久判死:restrict 说 unknown 不能锁进 badNames ──
//
// 真机故障:热重载空窗里宿主 shell 名字短暂消失,restrict 报 unknown;旧实现记进 badNames →
// 这个作用域永久让路、永久谎报「挡不掉」,名字回来也不会恢复接管。
const hMiss = makeHarness({ shippedTools: ['bash'], agentIds: ['agent-miss'] })
apply(hMiss.ctx, { syncIntervalMs: 25 })
await post(hMiss, { op: 'setOption', shellTakeover: 'takeover' })
await pollSnapshot(hMiss, (s) => Boolean(s.commandTool) && s.commandTool.takeover === true && hMiss.toolsFor('agent-miss').get('bash') === null, 6000)
phase('过渡性缺名')
const bashDef = hMiss.state.toolDefs.get('bash')
// 宿主 shell 短暂消失:先 off 再 takeover,让下一次 restrict 真的会跑(稳态不会重挂同一掩码)
hMiss.state.toolDefs.delete('bash')
await post(hMiss, { op: 'setOption', shellTakeover: 'off' })
await post(hMiss, { op: 'setOption', shellTakeover: 'takeover' })
const missSnap = await pollSnapshot(hMiss, (s) => Boolean(s.syncStats) && s.syncStats.transientMisses >= 1, 6000)
check('名字暂时缺失时记 transientMisses(不是当成「挡不掉」)', missSnap.syncStats.transientMisses >= 1, String(missSnap.syncStats.transientMisses))
check('过渡缺名不进永久 unrestrictable(不能永久判死)', !(missSnap.syncStats.unrestrictable || []).includes('bash'), JSON.stringify(missSnap.syncStats.unrestrictable))
check(
  '过渡缺名留下可读错误(不是静默)',
  Boolean(missSnap.syncStats.lastError) && missSnap.syncStats.lastErrorAt > 0,
  JSON.stringify({ lastError: missSnap.syncStats.lastError, lastErrorAt: missSnap.syncStats.lastErrorAt }),
)
// 名字回来:必须回到 takeover(真挡住 bash),不是永久让路/永久 unrestrictable
hMiss.state.toolDefs.set('bash', bashDef)
hMiss.emit('tools/change')
const missHealed = await pollSnapshot(
  hMiss,
  (s) => {
    const fact = ((s.commandTool || {}).scopes || []).find((x) => x.id === 'agent-miss')
    return Boolean(fact && fact.kind === 'takeover' && (fact.hidden || []).includes('bash'))
  },
  6000,
)
const missFact = ((missHealed.commandTool || {}).scopes || []).find((x) => x.id === 'agent-miss')
check(
  '名字回来后回到 takeover 并重新挡住 bash(不是永久让路)',
  Boolean(missFact && missFact.kind === 'takeover' && (missFact.hidden || []).includes('bash')),
  JSON.stringify(missFact),
)
check(
  '恢复后 unrestrictable 为空、lastError 被清掉(lastError 生命周期)',
  (missHealed.syncStats.unrestrictable || []).length === 0 && !missHealed.syncStats.lastError && missHealed.syncStats.lastErrorAt === 0,
  JSON.stringify({
    unrestrictable: missHealed.syncStats.unrestrictable,
    lastError: missHealed.syncStats.lastError,
    lastErrorAt: missHealed.syncStats.lastErrorAt,
  }),
)

// ── e) restrict 成功但没生效(agent 层同名工具挡不住):承认事实,不谎报已挡 ──
//
// 真机坑:restrict 只过滤继承面;agent 自己层注册的同名工具挡不掉,restrict 也不报错。
// 不复查就记成「已挡」→ hidden 谎报、面板 denies 谎报、brief 说「已接管」,模型却同时看得到两个。
const hNoop = makeHarness({
  shippedTools: ['bash'],
  agentIds: ['agent-noop'],
  restrictNoop: (scopeId, deny) => scopeId === 'agent-noop' && deny.includes('bash'),
})
apply(hNoop.ctx, { syncIntervalMs: 60000 })
await post(hNoop, { op: 'setOption', shellTakeover: 'takeover' })
const noopSnap = await pollSnapshot(hNoop, (s) => Boolean(s.syncStats) && s.syncStats.denyNoops >= 1, 8000)
const noopFact = ((noopSnap.commandTool || {}).scopes || []).find((x) => x.id === 'agent-noop')
phase('restrict 成功但没生效')
check('restrict 返回成功却仍可见 → 记 denyNoops(不静默)', noopSnap.syncStats.denyNoops >= 1, String(noopSnap.syncStats.denyNoops))
check('事实带 anomaly(挡了却仍可见),不谎报已挡', Boolean(noopFact && noopFact.anomaly === true), JSON.stringify(noopFact))
check('hidden 不含没真挡住的名字(bash)', Boolean(noopFact) && !(noopFact.hidden || []).includes('bash'), JSON.stringify(noopFact && noopFact.hidden))
check('面板用的 denies 也不含 bash(取交集,不谎报全挡)', !(noopSnap.commandTool.denies || []).includes('bash'), JSON.stringify(noopSnap.commandTool.denies))
const noopBrief = hNoop.state.brief.text({ scope: hNoop.state.agents[0] })
check(
  '简报不声称 bash 已被挡住(说它仍然可用或已让路)',
  !noopBrief.includes('已被 EnvDock 接管(`bash`') && noopBrief.includes('bash') && (noopBrief.includes('仍然可用') || noopBrief.includes('已让路')),
  noopBrief.split('\n').find((l) => l.includes('命令工具')) || '',
)

// ── f) 事实按「此刻实际能不能用」推导:宿主 shell 全局有、本会话不可执行 → takeover ──
//
// 真机坑:宿主 shell 全局注册(定义面/全局 get 都有),但本会话 executable 为 false;
// 拿「注册了」当成「能用」会算出 host,而模型手里真正能用的只有 envd_shell。
const hFactExec = makeHarness({
  shippedTools: ['bash'],
  agentIds: ['agent-fact'],
  executableFor: (scopeId, name) => name !== 'bash',
})
apply(hFactExec.ctx, { syncIntervalMs: 25 })
await post(hFactExec, { op: 'setOption', shellTakeover: 'takeover' })
const factExecSnap = await pollSnapshot(
  hFactExec,
  (s) => {
    const fact = ((s.commandTool || {}).scopes || []).find((x) => x.id === 'agent-fact')
    return Boolean(fact && fact.kind === 'takeover' && (fact.hidden || []).includes('bash'))
  },
  6000,
)
const factExecFact = ((factExecSnap.commandTool || {}).scopes || []).find((x) => x.id === 'agent-fact')
phase('事实按实际可用推导')
check(
  '夹具前置:宿主 bash 全局注册、本会话 executable 无',
  hFactExec.state.toolDefs.has('bash') && hFactExec.toolsFor('agent-fact').executable('bash') === null,
  'global=' + Boolean(hFactExec.toolsFor(null).get('bash')) + ' exec=' + String(hFactExec.toolsFor('agent-fact').executable('bash')),
)
check(
  '宿主 bash 本会话不可执行 → 终局 takeover(不是 host),tool=envd_shell',
  Boolean(factExecFact && factExecFact.kind === 'takeover' && factExecFact.tool === 'envd_shell' && factExecFact.ownVisible === true),
  JSON.stringify(factExecFact),
)
check(
  '不可执行的宿主 bash 记进 hidden(不是 hostTools):不能把调不到的工具算成可用',
  Boolean(factExecFact && (factExecFact.hidden || []).includes('bash') && !(factExecFact.hostTools || []).includes('bash')),
  JSON.stringify(factExecFact),
)

// ── g/h) 委托失败分阶段记账 + 执行器族决定包装器(不是宿主工具名) ──
//
// 真机坑:Windows 官方 base 挂的是 pwsh-sandbox(PowerShell),模型手里的工具却可能是
// dsh-ops 的 ops_bash(bash)。按工具名选 bash 包装器交给 PowerShell 执行必然 ParserError,
// 命令根本没跑。包装器必须跟**执行器族**走;失败要分 resolve/启动/结果/策略/runner 记账。
const failShell = fakeSandboxedShell({ className: 'PwshSandboxExecutor' })
const hDelegErr = makeHarness({
  shippedTools: ['bash'],
  agentIds: [
    { id: 'agent-err-free', session: { key: 'err-free' } },
    { id: 'agent-err-locked', session: { key: 'err-locked' } },
  ],
  shell: failShell,
  shellEnv: { collect: () => ({ DSH_SESSION: 'err-session' }) },
  sandboxPolicy: {
    resolve(request) {
      const key = request && request.session ? request.session.key : ''
      if (key === 'err-locked') {
        if (failShell.state.fail === 'policy') throw new Error('policy service down (injected)')
        return { mode: 'workspace-write', workspaceRoot: process.cwd() }
      }
      return { mode: 'danger-full-access', workspaceRoot: process.cwd() }
    },
  },
})
apply(hDelegErr.ctx, { syncIntervalMs: 60000 })
await post(hDelegErr, { op: 'setOption', shellTakeover: 'takeover' })
await pollSnapshot(hDelegErr, (s) => Boolean(s.commandTool) && s.commandTool.takeover === true, 8000)
const errTool = hDelegErr.state.toolDefs.get('envd_shell')
const errExec = { signal: null, agent: { session: { key: 'err-locked' } } }
const errStats = async () => (await callApi(hDelegErr)).json.syncStats
phase('委托失败分阶段 + 执行器族')
const errFamSnap = (await callApi(hDelegErr)).json
check(
  '执行器族按实现类名识别:PwshSandboxExecutor → powershell(不是按宿主工具名 bash)',
  errFamSnap.syncStats.executorFamily === 'powershell' && errFamSnap.syncStats.executorFamilySource === 'executor',
  JSON.stringify({ family: errFamSnap.syncStats.executorFamily, source: errFamSnap.syncStats.executorFamilySource }),
)
// 目标终端固定成 PowerShell 家族,包装器里不该出现 '-lc'
const pwshKey = terminalKeyOfFamily(errFamSnap, 'powershell')
if (pwshKey) await settleShell(hDelegErr, pwshKey)
const e0 = await errStats()
failShell.state.fail = 'resolve'
const errResolve = await errTool.execute({ command: 'echo err-resolve', cwd: process.cwd() }, errExec)
const e1 = await errStats()
check(
  '委托 resolve 阶段抛错:ok:false + 「解析」+ delegateFailures/delegateTries 各 +1',
  errResolve.ok === false &&
    errResolve.text.includes('解析') &&
    e1.delegateFailures === e0.delegateFailures + 1 &&
    e1.delegateTries === e0.delegateTries + 1 &&
    e1.delegateCalls === e0.delegateCalls,
  JSON.stringify({ text: String(errResolve.text).slice(0, 160), tries: [e0.delegateTries, e1.delegateTries], failures: [e0.delegateFailures, e1.delegateFailures] }),
)
failShell.state.fail = 'execute'
const errExecute = await errTool.execute({ command: 'echo err-execute', cwd: process.cwd() }, errExec)
const e2 = await errStats()
check(
  '委托启动阶段抛错:ok:false + 「启动」+ delegateFailures+1',
  errExecute.ok === false && errExecute.text.includes('启动') && e2.delegateFailures === e1.delegateFailures + 1 && e2.delegateTries === e1.delegateTries + 1,
  JSON.stringify({ text: String(errExecute.text).slice(0, 160), failures: [e1.delegateFailures, e2.delegateFailures] }),
)
failShell.state.fail = 'result'
const errResult = await errTool.execute({ command: 'echo err-result', cwd: process.cwd() }, errExec)
const e3 = await errStats()
check(
  '委托结果阶段抛错:ok:false + 「执行」+ delegateFailures+1',
  errResult.ok === false && errResult.text.includes('执行') && e3.delegateFailures === e2.delegateFailures + 1 && e3.delegateCalls === e2.delegateCalls,
  JSON.stringify({ text: String(errResult.text).slice(0, 160), failures: [e2.delegateFailures, e3.delegateFailures], calls: [e2.delegateCalls, e3.delegateCalls] }),
)
failShell.state.fail = 'policy'
const errPolicy = await errTool.execute({ command: 'echo err-policy', cwd: process.cwd() }, errExec)
const e4 = await errStats()
check(
  '本会话 sandboxPolicy 不可得 → 拒绝委托(refusals+1;不是「失败」,也不拿部署默认档冒充)',
  errPolicy.ok === false &&
    errPolicy.text.includes('策略不可得') &&
    e4.delegateRefusals === e3.delegateRefusals + 1 &&
    e4.delegateFailures === e3.delegateFailures &&
    e4.delegateTries === e3.delegateTries + 1,
  JSON.stringify({
    text: String(errPolicy.text).slice(0, 160),
    refusals: [e3.delegateRefusals, e4.delegateRefusals],
    failures: [e3.delegateFailures, e4.delegateFailures],
  }),
)
failShell.state.fail = ''
failShell.state.runnerFailed = true
const errRunner = await errTool.execute({ command: 'echo err-runner', cwd: process.cwd() }, errExec)
const e5 = await errStats()
check(
  'runner 失败:命令没跑 → ok:false;不进 delegateCalls/failures,但进 delegateRunnerFailures(面板要能区分「没走过委托」与「runner 坏了」)',
  errRunner.ok === false &&
    errRunner.text.includes('围栏 runner 失败') &&
    e5.delegateCalls === e4.delegateCalls &&
    e5.delegateFailures === e4.delegateFailures &&
    e5.delegateTries === e4.delegateTries + 1 &&
    (Number(e5.delegateRunnerFailures) || 0) === (Number(e4.delegateRunnerFailures) || 0) + 1,
  JSON.stringify({
    text: String(errRunner.text).slice(0, 160),
    calls: [e4.delegateCalls, e5.delegateCalls],
    failures: [e4.delegateFailures, e5.delegateFailures],
    runnerFailures: [e4.delegateRunnerFailures, e5.delegateRunnerFailures],
  }),
)
failShell.state.runnerFailed = false
const errOk = await errTool.execute({ command: 'echo err-ok', cwd: process.cwd() }, errExec)
const e6 = await errStats()
const errSpec = failShell.calls.executed[failShell.calls.executed.length - 1]
const errTargetFamily = (await callApi(hDelegErr)).json.shell.family
const errPayload = decodeBashPayload(errSpec)
check(
  '成功委托:命令行里不含用户原文(安全包装,不是拼字符串)',
  errOk.ok === true && !String(errSpec.command).includes('echo err-ok'),
  JSON.stringify({ text: String(errOk.text).slice(0, 120), command: String(errSpec && errSpec.command).slice(0, 220) }),
)
if (errTargetFamily === 'powershell') {
  const errScript = String(errSpec.command)
  check(
    'PowerShell 目标:-Command + $env:ENVD_CMD(UTF-8 base64)载荷;不用 -EncodedCommand / -lc',
    errScript.includes('-Command') &&
      errScript.includes('$env:ENVD_CMD') &&
      !errScript.includes('-EncodedCommand') &&
      !errScript.includes('-lc') &&
      decodePowerShellPayload(errSpec) === 'echo err-ok',
    JSON.stringify({ command: errScript.slice(0, 260), payload: decodePowerShellPayload(errSpec) }),
  )
} else if (errTargetFamily === 'bash') {
  const errScript = String(errSpec.command)
  check(
    'bash 目标:ENVD_CMD 是 base64 载荷,目标端 base64 -d | bash -s 解码(外层 -lc 已登录,内层不重复 profile)',
    errScript.includes('base64 -d | bash -s') && errPayload === 'echo err-ok' && !errScript.includes('echo err-ok'),
    JSON.stringify({ command: errScript.slice(0, 240), payload: errPayload }),
  )
} else {
  skip('委托成功包装器断言', '默认终端族=' + errTargetFamily)
}
check(
  '委托请求带 dshEnv(官方 shell 工具同款,subprocess 不会剥掉 DSH_* 快照)',
  Boolean(errSpec.dshEnv) && errSpec.dshEnv.DSH_SESSION === 'err-session',
  JSON.stringify(errSpec.dshEnv),
)
// 6 次进入委托(按上面的执行顺序):
//   · 3 次失败(resolve / 启动 / 结果阶段抛错)= delegateFailures
//   · 1 次拒绝(policy 不可得,没执行)= delegateRefusals
//   · 1 次 runnerFailed(拿到了结果,但命令根本没跑)= 三个计数都不进(只在 tries 里)
//   · 1 次成功 = delegateCalls
// 这条断言把「tries = 失败 + 拒绝 + 成功 + runnerFailed/aborted」的新口径钉死。
check(
  '最终计数自洽:delegateTries 6 / delegateFailures 3 / delegateRefusals 1 / delegateCalls 1',
  e6.delegateTries === 6 && e6.delegateFailures === 3 && e6.delegateRefusals === 1 && e6.delegateCalls === 1,
  JSON.stringify({ tries: e6.delegateTries, failures: e6.delegateFailures, refusals: e6.delegateRefusals, calls: e6.delegateCalls }),
)
// result 空(执行器坏了)不能算成功执行:delegateFailures+1、delegateCalls 不增
const e7 = await errStats()
failShell.state.emptyResult = true
const errEmpty = await errTool.execute({ command: 'echo err-empty', cwd: process.cwd() }, errExec)
const e8 = await errStats()
failShell.state.emptyResult = false
check(
  '执行器返回空结果 → ok:false + delegateFailures+1,不算 delegateCalls',
  errEmpty.ok === false && errEmpty.text.includes('空结果') && e8.delegateFailures === e7.delegateFailures + 1 && e8.delegateCalls === e7.delegateCalls,
  JSON.stringify({ text: String(errEmpty.text).slice(0, 140), failures: [e7.delegateFailures, e8.delegateFailures], calls: [e7.delegateCalls, e8.delegateCalls] }),
)
// aborted(取消)也不能回 ok:true(否则模型以为命令跑完了)
failShell.state.aborted = true
const errAborted = await errTool.execute({ command: 'echo err-aborted', cwd: process.cwd() }, errExec)
const e9 = await errStats()
failShell.state.aborted = false
check(
  '取消(aborted)→ ok:false + 文案带 [aborted];不进 calls/failures,但进 delegateAborts(取消要留痕)',
  errAborted.ok === false &&
    errAborted.text.includes('[aborted]') &&
    e9.delegateCalls === e8.delegateCalls &&
    e9.delegateFailures === e8.delegateFailures &&
    e9.delegateTries === e8.delegateTries + 1 &&
    (Number(e9.delegateAborts) || 0) === (Number(e8.delegateAborts) || 0) + 1,
  JSON.stringify({
    text: String(errAborted.text).slice(0, 160),
    calls: [e8.delegateCalls, e9.delegateCalls],
    failures: [e8.delegateFailures, e9.delegateFailures],
  }),
)
// ── 委托计数的新语义逐条钉死(delegateTries / Refusals / Failures / Calls)──
//   delegateTries    = 进入委托路径(含拒绝/失败/取消/runner 失败)
//   delegateRefusals = 没执行就拒绝(缺执行器 / 缺会话 / 策略不可得 / 执行器族或目标族不支持 / 太长)
//   delegateFailures = 进入执行阶段后抛错(resolve / 启动 / 结果)
//   delegateCalls    = 只数**真的执行了**的:runnerFailed(命令没跑)与 aborted(取消)都不算
const e9b = await errStats()
failShell.state.runnerFailed = true
const runnerAgain = await errTool.execute({ command: 'echo err-runner-2', cwd: process.cwd() }, errExec)
const e9c = await errStats()
failShell.state.runnerFailed = false
check(
  'runnerFailed 不计 delegateCalls、不计 delegateFailures(只进 tries)',
  runnerAgain.ok === false &&
    e9c.delegateCalls === e9b.delegateCalls &&
    e9c.delegateFailures === e9b.delegateFailures &&
    e9c.delegateRefusals === e9b.delegateRefusals &&
    e9c.delegateTries === e9b.delegateTries + 1,
  JSON.stringify({ calls: [e9b.delegateCalls, e9c.delegateCalls], failures: [e9b.delegateFailures, e9c.delegateFailures], tries: [e9b.delegateTries, e9c.delegateTries] }),
)
// 缺会话信息:没有 agent 就没有「本会话策略」可交给执行器 → 拒绝(绝不按部署默认档跑)
const noAgent = await errTool.execute({ command: 'echo err-no-agent', cwd: process.cwd() }, { signal: null, agent: null })
const e9d = await errStats()
check(
  '缺会话信息 → 拒绝委托(refusals+1;不执行、不计失败)',
  noAgent.ok === false &&
    noAgent.text.includes('本会话信息缺失') &&
    e9d.delegateRefusals === e9c.delegateRefusals + 1 &&
    e9d.delegateCalls === e9c.delegateCalls &&
    e9d.delegateFailures === e9c.delegateFailures,
  JSON.stringify({ text: String(noAgent.text).slice(0, 180), refusals: [e9c.delegateRefusals, e9d.delegateRefusals] }),
)
// 命令太长:base64 载荷会超过 env 上限(约 30KB)→ 拒绝,绝不悄悄截断成一条「半条命令」
const executedBeforeLong = failShell.calls.executed.length
const e9e = await errStats()
const tooLong = await errTool.execute({ command: 'echo ' + 'x'.repeat(23000), cwd: process.cwd() }, errExec)
const e9f = await errStats()
check(
  '命令太长 → 拒绝委托(不塞进 env,也不截断执行)',
  tooLong.ok === false &&
    tooLong.text.includes('命令太长') &&
    e9f.delegateRefusals === e9e.delegateRefusals + 1 &&
    e9f.delegateCalls === e9e.delegateCalls &&
    failShell.calls.executed.length === executedBeforeLong,
  JSON.stringify({ text: String(tooLong.text).slice(0, 180), refusals: [e9e.delegateRefusals, e9f.delegateRefusals], executed: [executedBeforeLong, failShell.calls.executed.length] }),
)

// 目标终端 cmd:不再拼包装串,直接拒绝(delegateRefusals 单独记账)
const cmdTermKey = ((await callApi(hDelegErr)).json.terminals || []).find((t) => t.key === 'cmd') ? 'cmd' : ''
if (cmdTermKey) {
  await settleShell(hDelegErr, cmdTermKey)
  const e10 = await errStats()
  const errCmdTarget = await errTool.execute({ command: 'echo err-cmd', cwd: process.cwd() }, errExec)
  const e11 = await errStats()
  check(
    '目标终端 cmd → 拒绝委托(文案含「不支持安全委托执行」,delegateRefusals+1)',
    errCmdTarget.ok === false &&
      errCmdTarget.text.includes('不支持安全委托执行') &&
      e11.delegateRefusals === e10.delegateRefusals + 1 &&
      e11.delegateTries === e10.delegateTries + 1 &&
      e11.delegateFailures === e10.delegateFailures,
    JSON.stringify({ text: String(errCmdTarget.text).slice(0, 200), refusals: [e10.delegateRefusals, e11.delegateRefusals] }),
  )
} else {
  skip('目标终端 cmd 拒绝委托', '本机没有检测到 cmd 终端')
}

// 执行器族为 cmd(CmdSandboxExecutor):拒绝委托,绝不按别的族猜语法
const cfShell = fakeSandboxedShell({ className: 'CmdSandboxExecutor' })
const hCmdFam = makeHarness({
  shippedTools: ['bash'],
  agentIds: [
    { id: 'agent-cf-free', session: { key: 'cf-free' } },
    { id: 'agent-cf-locked', session: { key: 'cf-locked' } },
  ],
  shell: cfShell,
  sandboxPolicy: fakeSandboxPolicy('workspace-write', { 'cf-free': 'danger-full-access' }),
})
apply(hCmdFam.ctx, { syncIntervalMs: 60000 })
await post(hCmdFam, { op: 'setOption', shellTakeover: 'takeover' })
const cfSnap = await pollSnapshot(hCmdFam, (s) => Boolean(s.commandTool) && s.commandTool.takeover === true, 8000)
check(
  'CamelCase 类名 CmdSandboxExecutor → executorFamily=cmd(source=executor)',
  cfSnap.syncStats.executorFamily === 'cmd' && cfSnap.syncStats.executorFamilySource === 'executor',
  JSON.stringify({ family: cfSnap.syncStats.executorFamily, source: cfSnap.syncStats.executorFamilySource }),
)
const cfTool = hCmdFam.state.toolDefs.get('envd_shell')
const cfBefore = (await callApi(hCmdFam)).json.syncStats
const cfRefused = await cfTool.execute({ command: 'echo cf', cwd: process.cwd() }, { signal: null, agent: { session: { key: 'cf-locked' } } })
const cfAfter = (await callApi(hCmdFam)).json.syncStats
check(
  '执行器族 cmd → 拒绝委托(不猜语法,delegateRefusals+1,没有真的执行)',
  cfRefused.ok === false && cfRefused.text.includes('无法安全包装') && cfAfter.delegateRefusals === cfBefore.delegateRefusals + 1 && cfShell.calls.executed.length === 0,
  JSON.stringify({ text: String(cfRefused.text).slice(0, 200), refusals: [cfBefore.delegateRefusals, cfAfter.delegateRefusals], executed: cfShell.calls.executed.length }),
)

// 执行器自称不围栏(capable=false)但策略服务说本会话受围栏 → 仍按有围栏处理,拒绝 spawn/委托。
// 夹具给**真实执行器形状**:resolve/execute 都在,只是不公布 sandboxMode(能力位 false)——
// 这样才会走到 runDelegated 里「自称不围栏」那条拒绝分支(空对象 {} 会先撞上「没有可委托执行器」)。
const noCapShell = fakeSandboxedShell({ className: '' })
delete noCapShell.sandboxMode
const hNoCap = makeHarness({
  shippedTools: ['bash'],
  agentIds: [
    { id: 'agent-nc-free', session: { key: 'nc-free' } },
    { id: 'agent-nc-locked', session: { key: 'nc-locked' } },
  ],
  shell: noCapShell,
  sandboxPolicy: fakeSandboxPolicy('workspace-write', { 'nc-free': 'danger-full-access' }),
})
apply(hNoCap.ctx, { syncIntervalMs: 60000 })
await post(hNoCap, { op: 'setOption', shellTakeover: 'takeover' })
await pollSnapshot(hNoCap, (s) => Boolean(s.commandTool) && s.commandTool.takeover === true, 8000)
const ncTool = hNoCap.state.toolDefs.get('envd_shell')
const ncBefore = (await callApi(hNoCap)).json.syncStats
const ncRefused = await ncTool.execute({ command: 'echo nc-marker', cwd: process.cwd() }, { signal: null, agent: { session: { key: 'nc-locked' } } })
const ncAfter = (await callApi(hNoCap)).json.syncStats
check(
  '执行器自称不围栏、策略说围栏 → 仍拒绝委托(refusals+1;不调宿主执行器、不 spawn)',
  ncRefused.ok === false &&
    ncRefused.text.includes('自称不围栏') &&
    ncAfter.delegateTries === ncBefore.delegateTries + 1 &&
    ncAfter.delegateRefusals === ncBefore.delegateRefusals + 1 &&
    ncAfter.delegateFailures === ncBefore.delegateFailures &&
    noCapShell.calls.executed.length === 0 &&
    !hNoCap.subprocess.calls.some((c) => (c.argv || []).some((a) => String(a).includes('nc-marker'))),
  JSON.stringify({
    text: String(ncRefused.text).slice(0, 160),
    tries: [ncBefore.delegateTries, ncAfter.delegateTries],
    refusals: [ncBefore.delegateRefusals, ncAfter.delegateRefusals],
    executed: noCapShell.calls.executed.length,
  }),
)

// h-2) BashSandboxExecutor → bash 包装器(含 -lc,不是 $env:ENVD_CMD)
const bashShell = fakeSandboxedShell({ className: 'BashSandboxExecutor' })
const hFamBash = makeHarness({
  shippedTools: ['bash'],
  agentIds: [
    { id: 'agent-bf-free', session: { key: 'bf-free' } },
    { id: 'agent-bf-locked', session: { key: 'bf-locked' } },
  ],
  shell: bashShell,
  sandboxPolicy: fakeSandboxPolicy('workspace-write', { 'bf-free': 'danger-full-access' }),
})
apply(hFamBash.ctx, { syncIntervalMs: 60000 })
await post(hFamBash, { op: 'setOption', shellTakeover: 'takeover' })
await pollSnapshot(hFamBash, (s) => Boolean(s.commandTool) && s.commandTool.takeover === true, 8000)
const bfSnap0 = (await callApi(hFamBash)).json
const bashKey = terminalKeyOfFamily(bfSnap0, 'bash')
check(
  '执行器族按实现类名识别:BashSandboxExecutor → bash',
  bfSnap0.syncStats.executorFamily === 'bash' && bfSnap0.syncStats.executorFamilySource === 'executor',
  JSON.stringify({ family: bfSnap0.syncStats.executorFamily, source: bfSnap0.syncStats.executorFamilySource }),
)
if (!bashKey) {
  skip('bash 执行器 + bash 目标终端包装器断言', '本机没有检测到 bash 终端')
} else {
  await settleShell(hFamBash, bashKey)
  const bfTool = hFamBash.state.toolDefs.get('envd_shell')
  const bfOk = await bfTool.execute({ command: 'echo bf-ok', cwd: process.cwd() }, { signal: null, agent: { session: { key: 'bf-locked' } } })
  const bfSpec = bashShell.calls.executed[bashShell.calls.executed.length - 1]
  const bfPayload = decodeBashPayload(bfSpec)
  check(
    'bash 执行器 + bash 目标终端:ENVD_CMD 是 base64 载荷,目标端 base64 -d | bash -s 解码',
    bfOk.ok === true &&
      String(bfSpec.command).includes('base64 -d | bash -s') &&
      !String(bfSpec.command).includes('echo bf-ok') &&
      bfPayload === 'echo bf-ok',
    JSON.stringify({ text: String(bfOk.text).slice(0, 120), command: String(bfSpec && bfSpec.command).slice(0, 220), payload: bfPayload }),
  )
}

// ── i) 动态识别第三方发布名(tools.definitions),并排除文件工具 ──
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
// i-1:认不出的发布名 + 作用域私有挡不掉 → 让路,brief 点名 tenant_bash
const hDyn = makeHarness({
  shippedTools: [],
  agentIds: ['agent-dyn'],
  shellDefinitions: [tenantBashDef, readFilesDef],
  unrestrictableFor: (scopeId, name) => name === 'tenant_bash',
})
apply(hDyn.ctx, { syncIntervalMs: 25 })
await post(hDyn, { op: 'setOption', shellTakeover: 'takeover' })
const dynSnap = await pollSnapshot(
  hDyn,
  (s) => {
    const fact = ((s.commandTool || {}).scopes || []).find((x) => x.id === 'agent-dyn')
    return Boolean(fact && fact.kind === 'yield' && fact.hostTool === 'tenant_bash')
  },
  6000,
)
const dynFact = ((dynSnap.commandTool || {}).scopes || []).find((x) => x.id === 'agent-dyn')
const dynTool = (dynSnap.syncStats.runtimeShellTools || []).find((t) => t.name === 'tenant_bash')
phase('动态 shell 识别')
check(
  'tenant_bash 被识别为宿主命令工具(bash 家族、learned,来自 definitions)',
  Boolean(dynTool && dynTool.family === 'bash' && dynTool.learned === true),
  JSON.stringify(dynSnap.syncStats.runtimeShellTools),
)
check(
  'ops_read_files(有 path 无 command)不被当成 shell 工具',
  !(dynSnap.syncStats.runtimeShellTools || []).some((t) => t.name === 'ops_read_files'),
  JSON.stringify(dynSnap.syncStats.runtimeShellTools),
)
check(
  'tenant_bash 挡不掉 → 让路:模型手里只剩它,envd_shell 被藏',
  Boolean(dynFact && dynFact.kind === 'yield' && dynFact.tool === 'tenant_bash' && dynFact.hidesOwn === true),
  JSON.stringify(dynFact),
)
check(
  'ops_read_files 不被遮挡(还在工具表里)',
  Boolean(hDyn.toolsFor('agent-dyn').get('ops_read_files')),
  'vis=' + scopeCommands(hDyn, 'agent-dyn', ['envd_shell', 'tenant_bash', 'ops_read_files']).join(','),
)
const dynBrief = hDyn.state.brief.text({ scope: hDyn.state.agents[0] })
check(
  '让路简报点名 tenant_bash(按它自己的 bash 语法教,不是默认终端语法)',
  dynBrief.includes('tenant_bash') && dynBrief.includes('已让路') && dynBrief.includes('bash / sh 语法'),
  dynBrief.split('\n').find((l) => l.includes('命令工具')) || '',
)
// i-2:同一个发布名挡得掉 → 接管并遮挡它(证明「识别」不是只认不挡)
const hDynTaken = makeHarness({
  shippedTools: [],
  agentIds: ['agent-dyn2'],
  shellDefinitions: [tenantBashDef, readFilesDef],
})
apply(hDynTaken.ctx, { syncIntervalMs: 25 })
await post(hDynTaken, { op: 'setOption', shellTakeover: 'takeover' })
const dynTakenSnap = await pollSnapshot(
  hDynTaken,
  (s) => {
    const fact = ((s.commandTool || {}).scopes || []).find((x) => x.id === 'agent-dyn2')
    return Boolean(fact && fact.kind === 'takeover' && (fact.hidden || []).includes('tenant_bash'))
  },
  6000,
)
const dynTakenFact = ((dynTakenSnap.commandTool || {}).scopes || []).find((x) => x.id === 'agent-dyn2')
check(
  'tenant_bash 挡得掉 → 接管并把它记进 hidden(动态识别的名字真的被遮挡)',
  Boolean(dynTakenFact && dynTakenFact.kind === 'takeover' && dynTakenFact.tool === 'envd_shell' && (dynTakenFact.hidden || []).includes('tenant_bash')),
  JSON.stringify(dynTakenFact),
)
check(
  '动态识别不误伤文件工具:ops_read_files 仍然可见',
  Boolean(hDynTaken.toolsFor('agent-dyn2').get('ops_read_files')) && hDynTaken.toolsFor('agent-dyn2').get('tenant_bash') === null,
  'vis=' + scopeCommands(hDynTaken, 'agent-dyn2', ['envd_shell', 'tenant_bash', 'ops_read_files']).join(','),
)
// i-3:老宿主没有 tools.definitions → 回退到按名字探可见性,现有行为不能坏
const hNoDefs = makeHarness({ shippedTools: ['bash'], agentIds: ['agent-nd'], definitions: false })
apply(hNoDefs.ctx, { syncIntervalMs: 25 })
await post(hNoDefs, { op: 'setOption', shellTakeover: 'takeover' })
const ndSnap = await pollSnapshot(hNoDefs, (s) => Boolean(s.commandTool) && s.commandTool.takeover === true && hNoDefs.toolsFor('agent-nd').get('bash') === null, 6000)
check(
  '老宿主没有 tools.definitions:回退按名字探可见性,接管照常(没坏)',
  Boolean(ndSnap.commandTool && ndSnap.commandTool.takeover === true) && hNoDefs.toolsFor('agent-nd').get('bash') === null,
  JSON.stringify(ndSnap.commandTool),
)
check(
  '老宿主路径不谎报 learned(只能按内置名单认)',
  ndSnap.syncStats.hasExecutableApi === true && !(ndSnap.syncStats.runtimeShellTools || []).some((t) => t.name === 'bash' && t.learned === true),
  JSON.stringify({ hasExecutableApi: ndSnap.syncStats.hasExecutableApi, runtimeShellTools: ndSnap.syncStats.runtimeShellTools }),
)

// ── b) 守卫卸载 + 方向二放行不涨计数 + fact 缺失文案(在上面 hGuard 已补) ──
// 守卫 disposer 必须进 cleanup:卸载后 h.state.guards 里不能留着它(否则热重载后两个守卫叠加)。
const hGuardDrop = makeHarness({ shippedTools: ['bash'], agentIds: ['agent-gd'] })
apply(hGuardDrop.ctx, { syncIntervalMs: 60000 })
await post(hGuardDrop, { op: 'setOption', shellTakeover: 'takeover' })
const guardDropSnap = await pollSnapshot(hGuardDrop, (s) => Boolean(s.commandTool) && s.commandTool.takeover === true, 8000)
phase('守卫生命周期')
check('守卫注册成功:guardReady=true 且 guards 里有 1 个', Boolean(guardDropSnap.syncStats.guardReady) && hGuardDrop.state.guards.length === 1, JSON.stringify({ ready: guardDropSnap.syncStats.guardReady, error: guardDropSnap.syncStats.guardError, n: hGuardDrop.state.guards.length }))
for (const { dis } of hGuardDrop.state.effects) {
  try {
    if (typeof dis === 'function') dis()
  } catch {}
}
check('卸载后守卫被摘掉(state.guards.length===0,不残留)', hGuardDrop.state.guards.length === 0, String(hGuardDrop.state.guards.length))

// ── j) steadyNow / steadySinceAt:稳态是**状态**,不是累计量 ──
//
// 真机坑:面板拿 steadyTicks > 0 当「此刻稳态」,于是一次瞬态故障之后永远显示「稳态」。
const hSteady = makeHarness({ shippedTools: ['bash'], agentIds: ['agent-st'] })
apply(hSteady.ctx, { syncIntervalMs: 60000 })
await post(hSteady, { op: 'setOption', shellTakeover: 'takeover' })
await pollSnapshot(hSteady, (s) => Boolean(s.commandTool) && s.commandTool.takeover === true, 8000)
// 触发一次状态写入,让对账落到「稳态 tick」(60s 周期不能干等)
const steadyTicksBefore = (await callApi(hSteady)).json.syncStats.ticks
await post(hSteady, { op: 'setOption', injectBrief: true })
for (let i = 0; i < 800; i++) {
  const s = (await callApi(hSteady)).json
  if (s.syncStats.ticks >= steadyTicksBefore + 2) break
  await sleep(10)
}
const steadyOn = (await callApi(hSteady)).json
phase('steadyNow 生命周期')
check(
  '稳态时 steadyNow===true 且 steadySinceAt>0(状态与累计量分开)',
  steadyOn.syncStats.steadyNow === true && steadyOn.syncStats.steadySinceAt > 0,
  JSON.stringify({ steadyNow: steadyOn.syncStats.steadyNow, steadySinceAt: steadyOn.syncStats.steadySinceAt, steadyTicks: steadyOn.syncStats.steadyTicks }),
)
// 强制一次完整对账:切到另一个家族的目标终端(签名变化 → 走完整对账,本 tick 不是稳态)
const steadySnap0 = (await callApi(hSteady)).json
const otherFamily = steadySnap0.shell.family === 'powershell' ? 'bash' : 'powershell'
const otherKey = terminalKeyOfFamily(steadySnap0, otherFamily) || terminalKeyOfFamily(steadySnap0, 'cmd')
const steadyTicksBefore2 = steadySnap0.syncStats.ticks
if (otherKey) await settleShell(hSteady, otherKey)
for (let i = 0; i < 800; i++) {
  const s = (await callApi(hSteady)).json
  if (s.syncStats.ticks >= steadyTicksBefore2 + 2) break
  await sleep(10)
}
const steadyFull = (await callApi(hSteady)).json
check(
  '强制一次完整对账后 steadyNow===false(不能拿累计量冒充状态)',
  steadyFull.syncStats.steadyNow === false && steadyFull.syncStats.ticks > steadyTicksBefore2,
  JSON.stringify({ steadyNow: steadyFull.syncStats.steadyNow, steadySinceAt: steadyFull.syncStats.steadySinceAt, lastSig: steadyFull.syncStats.lastSig, ticks: steadyFull.syncStats.ticks }),
)

// ══════════════ 服务端新行为 12 类断言(策略三态/活证回退/逐个 restrict/API 安全/探测缓存…) ══════════════

// ── B1) 策略不可知三态:resolve 返回 {}/空 mode/非法 mode → confined=null,不拿部署默认档冒充 ──
const hUnknown = makeHarness({
  shippedTools: ['bash'],
  agentIds: [{ id: 'agent-uk', session: { key: 'uk' } }],
  shell: { sandboxMode: 'workspace-write' },
  sandboxPolicy: { resolve: () => ({}) },
})
apply(hUnknown.ctx, { syncIntervalMs: 25 })
await post(hUnknown, { op: 'setOption', shellTakeover: 'takeover' })
const ukSnap = await pollSnapshot(hUnknown, (s) => Boolean(s.syncStats) && s.syncStats.sandboxBlocked === true, 6000)
const ukFact = ((ukSnap.commandTool || {}).scopes || []).find((x) => x.id === 'agent-uk')
const ukScope = ((ukSnap.sandbox || {}).scopes || []).find((x) => x.id === 'agent-uk')
phase('策略不可知三态')
check(
  '策略 resolve 返回空 mode → 不谎报「确定无围栏」(confined 不为 true),不把部署默认档当本会话结论',
  Boolean(ukFact && ukFact.confined !== true && ukFact.mode === ''),
  JSON.stringify(ukFact),
)
check(
  'sandbox.scopes 也是三态:confined===null、mode 为空(部署默认档只在 defaultMode)',
  Boolean(ukScope && ukScope.confined === null && ukScope.policyKnown === false && ukScope.mode === '') && ukSnap.sandbox.defaultMode === 'workspace-write',
  JSON.stringify({ scope: ukScope, defaultMode: ukSnap.sandbox && ukSnap.sandbox.defaultMode }),
)
check(
  '没有任何会话被证明无围栏 → sandboxBlocked=true 且根本不注册 envd_shell',
  ukSnap.syncStats.sandboxBlocked === true && ukSnap.syncStats.registers === 0 && !hUnknown.state.toolDefs.has('envd_shell'),
  JSON.stringify({ blocked: ukSnap.syncStats.sandboxBlocked, registers: ukSnap.syncStats.registers }),
)
check(
  '不可知会话仍拿得到宿主工具(不是零工具),终局 kind=host',
  Boolean(ukFact && ukFact.kind === 'host' && ukFact.tool === 'bash' && ukFact.visible === true && ukFact.anomaly === false),
  JSON.stringify(ukFact),
)

// 混合:一个确定无围栏(注册 envd_shell)+ 一个策略非法(不可知)→ 后者藏自己、留宿主工具;
// 同时验证 runDelegated 遇到非法 policy 拒绝委托(不拿部署默认档执行)。
const muShell = fakeSandboxedShell({ mode: 'workspace-write' })
const hMixedUnknown = makeHarness({
  shippedTools: ['bash'],
  agentIds: [
    { id: 'agent-mu-free', session: { key: 'mu-free' } },
    { id: 'agent-mu-unknown', session: { key: 'mu-unknown' } },
  ],
  shell: muShell,
  sandboxPolicy: {
    resolve(request) {
      const key = request && request.session ? request.session.key : ''
      if (key === 'mu-free') return { mode: 'danger-full-access', workspaceRoot: process.cwd() }
      return { mode: 'not-a-mode' } // 非法 mode → 按策略不可知
    },
  },
})
apply(hMixedUnknown.ctx, { syncIntervalMs: 25 })
await post(hMixedUnknown, { op: 'setOption', shellTakeover: 'takeover' })
const muSnap = await pollSnapshot(
  hMixedUnknown,
  (s) => {
    const fact = ((s.commandTool || {}).scopes || []).find((x) => x.id === 'agent-mu-unknown')
    return Boolean(fact && fact.kind === 'sandbox-host' && fact.confined === null && hMixedUnknown.toolsFor('agent-mu-unknown').get('envd_shell') === null)
  },
  8000,
)
const muFree = ((muSnap.commandTool || {}).scopes || []).find((x) => x.id === 'agent-mu-free')
const muUnknown = ((muSnap.commandTool || {}).scopes || []).find((x) => x.id === 'agent-mu-unknown')
const muScope = ((muSnap.sandbox || {}).scopes || []).find((x) => x.id === 'agent-mu-unknown')
check(
  '混合部署:确定无围栏会话照常 takeover(策略不可知不株连别的会话)',
  Boolean(muFree && muFree.kind === 'takeover' && muFree.confined === false),
  JSON.stringify(muFree),
)
check(
  '非法策略会话:confined=null、藏自己(hidesOwn)、宿主 bash 仍可见(不制造零工具)',
  Boolean(
    muUnknown &&
      muUnknown.kind === 'sandbox-host' &&
      muUnknown.hidesOwn === true &&
      (muUnknown.hostTools || []).includes('bash') &&
      muUnknown.visible === true,
  ) &&
    Boolean(hMixedUnknown.toolsFor('agent-mu-unknown').get('bash')) &&
    hMixedUnknown.toolsFor('agent-mu-unknown').get('envd_shell') === null,
  JSON.stringify(muUnknown) + ' vis=' + scopeCommands(hMixedUnknown, 'agent-mu-unknown').join(','),
)
check(
  'sandbox.scopes 对非法策略报 confined=null / mode 空(三态在这里保真)',
  Boolean(muScope && muScope.confined === null && muScope.mode === ''),
  JSON.stringify(muScope),
)
check('混合部署里有一个确定无围栏会话 → sandboxBlocked=false(不把不可知当挡掉)', muSnap.syncStats.sandboxBlocked === false, String(muSnap.syncStats.sandboxBlocked))
// 目标终端必须是可安全包装的族,才能走到「policy 非法拒绝」这一步
const muPsKey = terminalKeyOfFamily(muSnap, 'powershell') || terminalKeyOfFamily(muSnap, 'bash')
if (muPsKey) {
  await settleShell(hMixedUnknown, muPsKey)
  const muBefore = (await callApi(hMixedUnknown)).json.syncStats
  const muToolDef = hMixedUnknown.state.toolDefs.get('envd_shell')
  const muDeleg = await muToolDef.execute({ command: 'echo mu-invalid-policy', cwd: process.cwd() }, { signal: null, agent: { session: { key: 'mu-unknown' } } })
  const muAfter = (await callApi(hMixedUnknown)).json.syncStats
  check(
    'runDelegated 遇到非法/缺失 policy → 拒绝委托(refusals+1;不拿部署默认档执行,不计失败)',
    muDeleg.ok === false &&
      muDeleg.text.includes('策略不可得或非法') &&
      muAfter.delegateRefusals === muBefore.delegateRefusals + 1 &&
      muAfter.delegateFailures === muBefore.delegateFailures &&
      muAfter.delegateTries === muBefore.delegateTries + 1 &&
      muShell.calls.executed.length === 0,
    JSON.stringify({
      text: String(muDeleg.text).slice(0, 200),
      refusals: [muBefore.delegateRefusals, muAfter.delegateRefusals],
      failures: [muBefore.delegateFailures, muAfter.delegateFailures],
      executed: muShell.calls.executed.length,
    }),
  )
} else {
  skip('非法 policy 委托拒绝', '没有能安全包装的目标终端')
}

// ── B2) 宿主 shell 消失后的活证回退 + 起步 60s 宽限 ──
const hGrace = makeHarness({ agentIds: ['agent-gr'] })
apply(hGrace.ctx, { syncIntervalMs: 25 })
await post(hGrace, { op: 'setOption', shellTakeover: 'auto' })
await sleep(500)
const graceSnap = (await callApi(hGrace)).json
check(
  '从未见过宿主 shell → 60s 宽限内不注册 envd_shell(不和晚注册的宿主插件抢)',
  graceSnap.syncStats.registers === 0 && !hGrace.state.toolDefs.has('envd_shell') && graceSnap.syncStats.ticks >= 3,
  JSON.stringify({ registers: graceSnap.syncStats.registers, ticks: graceSnap.syncStats.ticks }),
)
const fallbackFamily = String((got.json && got.json.shell && got.json.shell.family) || '')
let hFallbackShared = null
const hostNameByFamily = { bash: 'bash', powershell: 'pwsh', cmd: 'cmd', wsl: 'wsl', custom: 'bash' }
const fbHostName = hostNameByFamily[fallbackFamily] || ''
if (fbHostName) {
  const hFallback = makeHarness({ shippedTools: [fbHostName], agentIds: [{ id: 'agent-fb', session: { key: 'fb' } }] })
  hFallbackShared = hFallback
  apply(hFallback.ctx, { syncIntervalMs: 25 })
  await post(hFallback, { op: 'setOption', shellTakeover: 'auto' })
  const fbFirst = await pollSnapshot(hFallback, (s) => Boolean(s.syncStats) && s.syncStats.ticks >= 4, 6000)
  check(
    '前置:宿主 shell 与默认终端同族 → auto 不接管(宿主工具继续干活)',
    fbFirst.commandTool.takeover === false && Boolean(hFallback.toolsFor('agent-fb').get(fbHostName)),
    JSON.stringify({ ct: fbFirst.commandTool, family: fallbackFamily }),
  )
  // 宿主 shell 从注册表消失(插件卸载 / 热重载),按真机语义派发 tools/change
  hFallback.state.toolDefs.delete(fbHostName)
  hFallback.emit('tools/change')
  const fbAfter = await pollSnapshot(
    hFallback,
    (s) => Boolean(s.commandTool) && s.commandTool.takeover === true && Boolean(hFallback.toolsFor('agent-fb').get('envd_shell')),
    8000,
  )
  check(
    '宿主 shell 消失后(已见过 → 不受宽限)立刻兜底注册 envd_shell,不留零命令工具',
    Boolean(fbAfter.commandTool && fbAfter.commandTool.takeover === true) &&
      Boolean(hFallback.toolsFor('agent-fb').get('envd_shell')) &&
      hFallback.state.toolDefs.has('envd_shell'),
    JSON.stringify(fbAfter.commandTool),
  )
} else {
  skip('宿主 shell 消失后的活证回退', '无法判定默认终端族: ' + fallbackFamily)
}

// ── B3/B4) 逐个 restrict(不批量)/ 无主 deny / badNames 30s 过期重试 ──
const hBatch = makeHarness({
  shippedTools: ['bash', 'pwsh'],
  agentIds: ['agent-batch'],
  // bash 挡得掉;pwsh 是作用域私有(restrict 抛错),让路后仍有 30s 重试窗口
  unrestrictableFor: (scopeId, name) => name === 'pwsh',
})
apply(hBatch.ctx, { syncIntervalMs: 25 })
await post(hBatch, { op: 'setOption', shellTakeover: 'takeover' })
const batchSnap = await pollSnapshot(
  hBatch,
  (s) => {
    const fact = ((s.commandTool || {}).scopes || []).find((x) => x.id === 'agent-batch')
    return Boolean(fact && fact.kind === 'yield' && fact.hostTool === 'pwsh' && (fact.hidden || []).includes('bash'))
  },
  8000,
)
const batchFact = ((batchSnap.commandTool || {}).scopes || []).find((x) => x.id === 'agent-batch')
phase('逐个 restrict / 30s 重试窗口')
check(
  '逐个 restrict:挡得掉的 bash 真挡住、挡不掉的 pwsh 让路(批量调用会一锅端)',
  Boolean(batchFact && batchFact.kind === 'yield' && (batchFact.hidden || []).includes('bash') && (batchFact.hostTools || []).includes('pwsh')),
  JSON.stringify(batchFact),
)
check(
  'badNames 30s 内只报未过期名字:unrestrictable 恰好是 pwsh(挡不掉的)',
  (batchSnap.syncStats.unrestrictable || []).length === 1 && (batchSnap.syncStats.unrestrictable || [])[0] === 'pwsh',
  JSON.stringify(batchSnap.syncStats.unrestrictable),
)
const pwshAttempts = () => hBatch.state.restrictCalls.filter((deny) => deny.includes('pwsh')).length
const pwshAttemptsBefore = pwshAttempts()
const batchSteady1 = (await callApi(hBatch)).json.syncStats
await sleep(300)
const batchSteady2 = (await callApi(hBatch)).json.syncStats
check(
  '30s 重试窗口内不反复 restrict(没有新的 pwsh restrict 尝试)',
  pwshAttempts() === pwshAttemptsBefore && batchSteady2.denyApplies === batchSteady1.denyApplies && batchSteady2.hostDenyApplies === batchSteady1.hostDenyApplies,
  JSON.stringify({ pwshAttempts: [pwshAttemptsBefore, pwshAttempts()], denyApplies: [batchSteady1.denyApplies, batchSteady2.denyApplies] }),
)
// 注入时间前进 31s:badNames 过期 → 必须重试一次(否则就是永久判死)
const realDateNow = Date.now
const batchBeforeTtl = (await callApi(hBatch)).json.syncStats
Date.now = () => realDateNow() + 31_000
try {
  hBatch.emit('tools/change')
  for (let i = 0; i < 800; i++) {
    if (pwshAttempts() > pwshAttemptsBefore) break
    await callApi(hBatch)
    await sleep(10)
  }
} finally {
  Date.now = realDateNow
}
const batchAfterTtl = (await callApi(hBatch)).json.syncStats
check(
  'badNames 30s 过期后会重新 restrict pwsh(不是永久判死)',
  pwshAttempts() > pwshAttemptsBefore,
  JSON.stringify({ pwshAttempts: [pwshAttemptsBefore, pwshAttempts()], hostDenyApplies: [batchBeforeTtl.hostDenyApplies, batchAfterTtl.hostDenyApplies] }),
)
// 无主 deny:关掉接管后宿主工具必须全部恢复(批量 restrict 中途抛错会留下无主 deny)
await post(hBatch, { op: 'setOption', shellTakeover: 'off' })
await pollSnapshot(
  hBatch,
  () => Boolean(hBatch.toolsFor('agent-batch').get('bash')) && Boolean(hBatch.toolsFor('agent-batch').get('pwsh')),
  6000,
)
check(
  '关掉接管后宿主工具全部恢复(逐个 restrict 不留无主 deny)',
  Boolean(hBatch.toolsFor('agent-batch').get('bash')) && Boolean(hBatch.toolsFor('agent-batch').get('pwsh')),
  'vis=' + scopeCommands(hBatch, 'agent-batch').join(','),
)

// ── B6) runtimeShellTools 只报真的见过(不再把 8 个内置名当「已识别」) ──
const hPwshOnly = makeHarness({ shippedTools: ['pwsh'], agentIds: ['agent-pw'] })
apply(hPwshOnly.ctx, { syncIntervalMs: 25 })
await post(hPwshOnly, { op: 'setOption', shellTakeover: 'takeover' })
const pwSnap = await pollSnapshot(hPwshOnly, (s) => Boolean(s.commandTool) && s.commandTool.takeover === true, 6000)
const pwNames = (pwSnap.syncStats.runtimeShellTools || []).map((t) => t.name)
phase('runtimeShellTools / 动态识别收紧')
check('runtimeShellTools 只报 really-seen:宿主只有 pwsh 时列表就是 [pwsh]', pwNames.length === 1 && pwNames[0] === 'pwsh', JSON.stringify(pwSnap.syncStats.runtimeShellTools))
check(
  'bash/cmd/fish/ops_bash 等伪候选不出现在「已识别」列表里',
  !pwNames.some((n) => ['bash', 'cmd', 'fish', 'ops_bash', 'powershell', 'sh', 'zsh', 'wsl'].includes(n)),
  pwNames.join(','),
)

// ── B7) 动态识别收紧:run_cmd / wc_cmd_palette 不误认;tenant_bash 正常识别 ──
const hDynTighten = makeHarness({
  shippedTools: [],
  agentIds: ['agent-dt'],
  shellDefinitions: [
    { name: 'run_cmd', description: 'Run a task', parameters: { type: 'object', properties: { task: { type: 'string' } } } },
    { name: 'wc_cmd_palette', description: 'Command palette UI', parameters: { type: 'object', properties: { palette: { type: 'string' } } } },
    readFilesDef,
    tenantBashDef,
  ],
})
apply(hDynTighten.ctx, { syncIntervalMs: 25 })
await post(hDynTighten, { op: 'setOption', shellTakeover: 'takeover' })
const dtSnap = await pollSnapshot(
  hDynTighten,
  (s) => {
    const fact = ((s.commandTool || {}).scopes || []).find((x) => x.id === 'agent-dt')
    return Boolean(fact && fact.kind === 'takeover' && (fact.hidden || []).includes('tenant_bash'))
  },
  8000,
)
const dtNames = (dtSnap.syncStats.runtimeShellTools || []).map((t) => t.name)
const dtFact = ((dtSnap.commandTool || {}).scopes || []).find((x) => x.id === 'agent-dt')
check(
  '名字带 cmd 但没有 command 参数(run_cmd / wc_cmd_palette)→ 不当宿主 shell',
  !dtNames.includes('run_cmd') && !dtNames.includes('wc_cmd_palette'),
  JSON.stringify(dtSnap.syncStats.runtimeShellTools),
)
check(
  'tenant_bash(有 command 参数)→ 正常识别并遮挡',
  dtNames.includes('tenant_bash') && Boolean(dtFact && (dtFact.hidden || []).includes('tenant_bash')),
  JSON.stringify({ names: dtNames, fact: dtFact }),
)
check(
  '不误伤:run_cmd / wc_cmd_palette / ops_read_files 仍然可见(RPC/文件工具不能挡)',
  Boolean(hDynTighten.toolsFor('agent-dt').get('run_cmd')) &&
    Boolean(hDynTighten.toolsFor('agent-dt').get('wc_cmd_palette')) &&
    Boolean(hDynTighten.toolsFor('agent-dt').get('ops_read_files')),
  'vis=' + scopeCommands(hDynTighten, 'agent-dt', ['envd_shell', 'tenant_bash', 'run_cmd', 'wc_cmd_palette', 'ops_read_files']).join(','),
)

// ── B10) 探测缓存语义:多次 GET 不重复探测;非探测写入不作废;setShell 作废 ──
const hCache = makeHarness()
apply(hCache.ctx, {})
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

// ── B11) brief 口径:sessionless 不说「本会话策略未知」;围栏会话给换回宿主工具的提示 ──
const envdSummary = await hSandbox.state.toolDefs.get('envd').execute({ action: 'summary' }, { signal: null })
check(
  'envd summary(无会话)不再说「本会话策略未知」,改指路 scopes',
  envdSummary.ok === true && !envdSummary.text.includes('本会话策略未知') && envdSummary.text.includes('各会话有效策略见 scopes'),
  String(envdSummary.text).split('\n').find((l) => l.includes('命令工具')) || '',
)
check(
  'brief 最后一行:envd 只能解析上面已探测到的工具',
  envdSummary.text.includes('只能解析上面已探测到的工具'),
  String(envdSummary.text).split('\n').slice(-1)[0] || '',
)
const mixLockedAgent = hMix.state.agents.find((a) => a.id === 'agent-locked')
if (mixLockedAgent) {
  hMix.setScopeDeny('agent-locked', ['bash'])
  const mixConfBrief = hMix.state.brief.text({ scope: mixLockedAgent })
  hMix.setScopeDeny('agent-locked', [])
  check(
    '围栏会话宿主工具暂时不可见时,简报给出「下一轮对账把宿主工具换回来」的提示',
    mixConfBrief.includes('下一轮对账会把宿主工具换回来') && !mixConfBrief.includes('本会话策略未知'),
    mixConfBrief.split('\n').find((l) => l.includes('命令工具')) || '',
  )
} else {
  skip('围栏会话简报换回宿主工具提示', 'hMix 里没有 agent-locked')
}

// ── B12) 让路计数语义/恒等式(ownHides + hostDenyApplies === denyApplies) ──
const multiStats = (await callApi(hMulti)).json.syncStats
check(
  '让路计数语义:ownHides>=1、hostDenyApplies>=1,且 denyApplies===两者之和',
  multiStats.ownHides >= 1 && multiStats.hostDenyApplies >= 1 && multiStats.denyApplies === multiStats.ownHides + multiStats.hostDenyApplies,
  JSON.stringify({ denyApplies: multiStats.denyApplies, ownHides: multiStats.ownHides, hostDenyApplies: multiStats.hostDenyApplies }),
)

// 收掉回归用例的 fixture
for (const { dis } of [
  ...h8.state.effects,
  ...h9.state.effects,
  ...hSandbox.state.effects,
  ...hFull.state.effects,
  ...hPolicy.state.effects,
  ...hDeny.state.effects,
  ...hSplit.state.effects,
  ...hLife.state.effects,
  ...h12.state.effects,
  ...h13.state.effects,
  ...hPtc.state.effects,
  ...hMulti.state.effects,
  // 本轮新增的夹具(守卫卸载用例 hGuardDrop 已就地 dispose,不重复列)
  ...hHeal.state.effects,
  ...hMiss.state.effects,
  ...hNoop.state.effects,
  ...hFactExec.state.effects,
  ...hDelegErr.state.effects,
  ...hFamBash.state.effects,
  ...hDyn.state.effects,
  ...hDynTaken.state.effects,
  ...hNoDefs.state.effects,
  ...hSteady.state.effects,
  // 服务端新行为批次
  ...hUnknown.state.effects,
  ...hMixedUnknown.state.effects,
  ...hGrace.state.effects,
  ...(hFallbackShared ? hFallbackShared.state.effects : []),
  ...hBatch.state.effects,
  ...hPwshOnly.state.effects,
  ...hDynTighten.state.effects,
  ...hCache.state.effects,
  ...hCmdFam.state.effects,
  ...hNoCap.state.effects,
]) {
  try {
    if (typeof dis === 'function') dis()
  } catch {}
}


// ── 第二轮安全审校(P1/P2)回归 ──
// 这些断言对应 docs/notes/review-security.md 的发现,别再让它们悄悄回退。
{
  // 1) 委托 bash 脚本:载荷缺失要 127、stdin 要接 /dev/null(否则 read/cat 会吃掉脚本)
  const guardShell = fakeSandboxedShell({ className: 'BashSandboxExecutor' })
  const hGuard = makeHarness({
    shippedTools: ['bash'],
    agentIds: [
      { id: 'agent-free', session: { key: 'free' } },
      { id: 'agent-locked', session: { key: 'g1' } },
    ],
    shell: guardShell,
    sandboxPolicy: {
      resolve: (request) =>
        request && request.session && request.session.key === 'g1'
          ? { mode: 'workspace-write', workspaceRoot: process.cwd() }
          : { mode: 'danger-full-access', workspaceRoot: process.cwd() },
    },
  })
  apply(hGuard.ctx, { syncIntervalMs: 60000 })
  await post(hGuard, { op: 'setOption', shellTakeover: 'takeover' })
  // 目标终端固定成 bash:断言的是 bash 目标端的委托包装(否则探测器会选到 pwsh7)
  await post(hGuard, { op: 'setShell', key: 'bash' })
  await pollSnapshot(hGuard, (s) => Boolean(s.commandTool) && s.commandTool.takeover === true, 8000)
  const guardTool = hGuard.state.toolDefs.get('envd_shell')
  await guardTool.execute({ command: 'echo guard', cwd: process.cwd() }, { signal: null, agent: { session: { key: 'g1' } } })
  const guardSpec = guardShell.calls.executed[guardShell.calls.executed.length - 1]
  const guardScript = String(guardSpec && guardSpec.command)
  check('委托 bash 脚本:载荷为空时 exit 127(不再静默成功)', guardScript.includes('exit 127'), guardScript.slice(0, 200))
  check('委托 bash 脚本:stdin 接 /dev/null(read/cat 不会吃掉脚本)', guardScript.includes('/dev/null'), guardScript.slice(0, 200))
  check('委托 bash 脚本:载荷单引号包裹(空值/空格都不会被拆词)', guardScript.includes('"$ENVD_CMD"'), guardScript.slice(0, 200))

  // 2) 切终端后立刻按新终端执行(简报与执行不许各说一套)
  const hSwitch = makeHarness({
    shippedTools: ['pwsh'],
    agentIds: ['agent-switch'],
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: process.cwd() }) },
  })
  apply(hSwitch.ctx, { syncIntervalMs: 60000 })
  await post(hSwitch, { op: 'setOption', shellTakeover: 'takeover' })
  await post(hSwitch, { op: 'setShell', key: 'bash' })
  await pollSnapshot(hSwitch, (s) => Boolean(s.commandTool) && s.commandTool.takeover === true, 8000)
  const switchTool = hSwitch.state.toolDefs.get('envd_shell')
  const switchBefore = hSwitch.subprocess.calls.length
  await switchTool.execute({ command: 'echo switched', cwd: process.cwd() }, { signal: null, agent: { session: { key: 's1' } } })
  const switchCall = hSwitch.subprocess.calls.slice(switchBefore).find((c) => String((c.argv || [])[1] || '').includes('switched') || String((c.argv || []).join(' ')).includes('-lc'))
  check(
    'setShell 之后下一单立刻用新终端(bash -lc,不等下一轮对账)',
    Boolean(switchCall) && /bash(\.exe)?$/i.test(String(switchCall.argv[0] || '')) && switchCall.argv.includes('-lc'),
    JSON.stringify(switchCall && switchCall.argv),
  )

  // 3) Host 字面量:尾点 / IPv4-mapped IPv6 要放行;非回环 Host 一律 403
  const hHttp = makeHarness({ shippedTools: ['pwsh'], agentIds: ['agent-http'] })
  apply(hHttp.ctx, { syncIntervalMs: 60000 })
  for (const [label, host, want] of [
    ['localhost. 尾点', 'localhost.:3080', 200],
    ['[::ffff:127.0.0.1]', '[::ffff:127.0.0.1]:3080', 200],
    ['userinfo 拼接', 'evil.example@127.0.0.1:3080', 403],
  ]) {
    const r = await callApi(hHttp, { method: 'GET', headers: { host } })
    check('Host ' + label + ' → ' + want, r.status === want, String(r.status))
  }

  // 4) Content-Type 必须就是 application/json(子串不算)
  const ctSubstr = await post(hHttp, { op: 'setOption', injectBrief: true }, { headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'content-type': 'text/plain;application/json' } })
  check('Content-Type 子串不算: text/plain;application/json → 403', ctSubstr.status === 403, String(ctSubstr.status))

  // 4b) restrict 先落地再抛错 → 必须如实记成「无主 deny」,不能当成临时缺名
  const hLost = makeHarness({
    shippedTools: ['pwsh'],
    agentIds: ['agent-lost'],
    restrictApplyThenThrow: (scopeId, deny) => deny.includes('pwsh'),
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: process.cwd() }) },
  })
  apply(hLost.ctx, { syncIntervalMs: 1000 })
  await post(hLost, { op: 'setOption', shellTakeover: 'takeover' })
  const lostSnap = await pollSnapshot(hLost, (s) => Array.isArray(s.syncStats.lostDenies) && s.syncStats.lostDenies.includes('pwsh'), 6000)
  check(
    'restrict 先落地再抛错 → syncStats.lostDenies 记名(不再是静默的临时缺名)',
    Array.isArray(lostSnap.syncStats.lostDenies) && lostSnap.syncStats.lostDenies.includes('pwsh'),
    JSON.stringify(lostSnap.syncStats.lostDenies),
  )
  check(
    '无主 deny 会写 lastError(面板/诊断能看到)',
    typeof lostSnap.syncStats.lastError === 'string' && lostSnap.syncStats.lastError.includes('无主'),
    String(lostSnap.syncStats.lastError).slice(0, 120),
  )
  check('无主 deny 的宿主工具此刻确实被挡住了(事实如此)', hLost.toolsFor('agent-lost').get('pwsh') === null)

  // 5) addCustomTool 的 key 不能是原型链保留名
  const protoKey = await post(hHttp, { op: 'addCustomTool', path: process.execPath, key: '__proto__', label: 'x' })
  check('addCustomTool key=__proto__ → 400(不写状态文件)', protoKey.status === 400, String(protoKey.status))
  const ctorKey = await post(hHttp, { op: 'addCustomTool', path: process.execPath, key: 'constructor', label: 'x' })
  check('addCustomTool key=constructor → 400', ctorKey.status === 400, String(ctorKey.status))
}


// ── 现网回归:dsh-ops 的 ops_bash(restrict 抛真机文案)必须让路,不能「接管 + 泄漏」──
// 真机 restrict 对会话私有注册抛 `names unknown global tool`,那条走 hardNames(10 分钟 TTL);
// 如果让路判据只看 badNames,就会既不遮挡也不让路 → 模型两个命令工具并列 + anomaly。
{
  const hReal = makeHarness({
    shippedTools: ['ops_bash', 'pwsh'],
    agentIds: [{ id: 'session-real-1', session: { key: 'real-1' } }],
    unrestrictable: ['ops_bash'],
    unrestrictableRealMessage: true,
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: process.cwd() }) },
  })
  apply(hReal.ctx, { syncIntervalMs: 40 })
  await post(hReal, { op: 'setOption', shellTakeover: 'takeover' })
  const real = await pollSnapshot(hReal, (s) => Array.isArray(s.commandTool.scopes) && s.commandTool.scopes.some((x) => x.kind === 'yield'), 8000)
  const fact = (real.commandTool.scopes || []).find((x) => String(x.id) === 'session-real-1') || {}
  check('真机文案(unknown global tool)也判让路:kind=yield', fact.kind === 'yield', JSON.stringify(fact))
  check('让路后模型只有一个命令工具:ops_bash 仍可见、envd_shell 被藏', hReal.toolsFor('session-real-1').get('ops_bash') !== null && hReal.toolsFor('session-real-1').get('envd_shell') === null, JSON.stringify({ ops_bash: Boolean(hReal.toolsFor('session-real-1').get('ops_bash')), envd: Boolean(hReal.toolsFor('session-real-1').get('envd_shell')) }))
  check('让路后不再报「接管下宿主仍可见」的 anomaly', fact.anomaly === false && (real.syncStats.scopeAnomalies || []).length === 0, JSON.stringify({ anomaly: fact.anomaly, scopeAnomalies: real.syncStats.scopeAnomalies }))
  check('unrestrictable 仍如实报 ops_bash', (real.syncStats.unrestrictable || []).includes('ops_bash'), JSON.stringify(real.syncStats.unrestrictable))
  check('结构性挡不掉不写 lastError(不刷红)', !real.syncStats.lastError, String(real.syncStats.lastError))
}


// ── 终审 P2:宿主静默撤掉挡不掉的名字后,unrestrictable 不许留残影 ──
// 记忆(badNames/hardNames)带 30s/10min TTL 是有意的(别每 tick 重试),
// 但诊断字段必须按「此刻还在不在」过滤,否则面板会一直说「ops_bash 挡不掉、与 envd_shell 并存」。
{
  const hGhost = makeHarness({
    shippedTools: ['ops_bash'],
    agentIds: [{ id: 'agent-ghost', session: { key: 'ghost' } }],
    unrestrictable: ['ops_bash'],
    unrestrictableRealMessage: true,
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: process.cwd() }) },
  })
  apply(hGhost.ctx, { syncIntervalMs: 40 })
  await post(hGhost, { op: 'setOption', shellTakeover: 'takeover' })
  const ghost1 = await pollSnapshot(hGhost, (s) => (s.syncStats.unrestrictable || []).includes('ops_bash'), 8000)
  check('前置:ops_bash 挡不掉时 unrestrictable 如实报(工具还在)', (ghost1.syncStats.unrestrictable || []).includes('ops_bash'), JSON.stringify(ghost1.syncStats.unrestrictable))
  // 宿主静默撤掉工具(不 emit tools/change):让路应解除,unrestrictable 也不许留残影
  hGhost.state.toolDefs.delete('ops_bash')
  const ghost2 = await pollSnapshot(hGhost, (s) => (s.syncStats.unrestrictable || []).length === 0, 8000)
  check('宿主撤掉工具后 unrestrictable 立刻清空(诊断不留残影)', (ghost2.syncStats.unrestrictable || []).length === 0, JSON.stringify(ghost2.syncStats.unrestrictable))
  check('宿主撤掉工具后让路解除:envd_shell 可再用', Boolean(hGhost.toolsFor('agent-ghost').get('envd_shell')), JSON.stringify({ envd: Boolean(hGhost.toolsFor('agent-ghost').get('envd_shell')) }))
  check('不产生零命令工具 / 不报异常', (ghost2.syncStats.scopeAnomalies || []).length === 0, JSON.stringify(ghost2.syncStats.scopeAnomalies))
}

rmSync(home, { recursive: true, force: true })

console.log(
  '\n' +
    (failures.length ? failures.length + ' 项失败:' : '全部通过') +
    '  (' + (Date.now() - t0) + ' ms)' +
    (skips.length ? '  SKIP ' + skips.length + ' 项(本机环境不满足)' : ''),
)
for (const s of skips) console.log('  SKIP · ' + s)
for (const f of failures) console.log('  · ' + f)
process.exit(failures.length ? 1 : 0)
