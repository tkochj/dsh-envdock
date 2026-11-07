/**
 * EnvDock 面板渲染回归测试(变异敏感)。
 *
 * client.js 是浏览器脚本(`window.__ModuleLoader__.load`),不能在 Node 里 import;
 * 但它渲染出来的东西完全由 /envdock-api 的 JSON 决定 —— 所以这里用一套极简 React
 * 运行时替身(useState/useEffect/useMemo/useCallback/useRef)+ 桩 slots/locale/fetch,
 * 把 client.js 真跑起来,捕获 EnvDockPanel 的真实渲染树,再遍历头部 .envd-badge 断言。
 *
 * 为什么要锁住这件事:commandTool.visible 只说明「EnvDock 的 envd_shell 此刻在工具表里」,
 * 不说明每个会话里模型拿到的是谁。有会话没走 EnvDock 时还单挂「模型可见」就是在说谎。
 *
 * 为什么每条载荷都把 scopes 与 syncStats 故意写成**不一致**:
 * 之前的版本曾被一个变异骗过 —— 把「宿主会话数」换成 syncStats.sandboxHiddenScopes,
 * 16 条断言照样全绿。这里所有数字/行数都从载荷(scopes / syncStats)推导,
 * 并且刻意让两个来源给出不同答案:只要实现改成「读 stats 不读 scopes」就必然失败。
 *
 * 零依赖,Windows 上直接 `node test/panel-render.mjs` 可跑。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', 'client.js'), 'utf8')

// ───────────────────────────────── 极简 React 运行时替身 ──
// 只实现 client.js 用到的那 5 个 hook。故意不支持并发/调度:测试里同步跑一遍再补一轮即可。
let states, refs, memoVals, memoDeps, effectDeps, cursor, dirty, effectQueue

function resetHooks() {
  states = []
  refs = []
  memoVals = []
  memoDeps = []
  effectDeps = []
  cursor = 0
  dirty = false
  effectQueue = []
}

// deps 相等 = 所有元素 ===;undefined 视为「每次都变」(和 React 规则一致)
const depsChanged = (prev, deps) => !prev || !deps || prev.length !== deps.length || deps.some((d, i) => d !== prev[i])

const React = {
  createElement: (type, props, ...kids) => ({ type, props: props || {}, children: kids.flat(Infinity) }),
  useState(init) {
    const i = cursor++
    if (!(i in states)) states[i] = typeof init === 'function' ? init() : init
    const set = (value) => {
      const next = typeof value === 'function' ? value(states[i]) : value
      if (next !== states[i]) {
        states[i] = next
        dirty = true
      }
    }
    return [states[i], set]
  },
  useRef(init) {
    const i = cursor++
    if (!(i in refs)) refs[i] = { current: init }
    return refs[i]
  },
  useEffect(fn, deps) {
    const i = cursor++
    if (depsChanged(effectDeps[i], deps)) {
      effectDeps[i] = deps ? deps.slice() : null
      effectQueue.push(fn)
    }
  },
  useMemo(fn, deps) {
    const i = cursor++
    if (depsChanged(memoDeps[i], deps)) {
      memoDeps[i] = deps ? deps.slice() : null
      memoVals[i] = fn()
    }
    return memoVals[i]
  },
  useCallback(fn, deps) {
    return React.useMemo(() => fn, deps)
  },
}

// ───────────────────────────────── 加载 client.js ──
// client.js 顶层只碰 window.__ModuleLoader__,用 new Function 传一个 window 进去即可,
// 不需要 jsdom,也不会污染全局。
let manifest = null
function loadClient() {
  const win = {
    __ModuleLoader__: {
      load(m) {
        manifest = m
      },
    },
  }
  new Function('window', SOURCE)(win)
  if (!manifest || typeof manifest.factory !== 'function') throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
  if (manifest.id !== 'dsh-envdock') throw new Error('ModuleLoader id 不是 dsh-envdock: ' + manifest.id)
  return manifest
}

// ───────────────────────────────── 渲染树工具 ──
// 用 props.children? client.js 用 h(type, props, ...kids),children 在第三个参数上,
// 所以这里统一读 element.children;函数组件(EnvDockIcon)就地展开。
function flattenText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenText).join('')
  if (node.type && typeof node.type === 'function') return flattenText(node.type(node.props))
  return (node.children || []).map(flattenText).join('')
}

function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, visit))
    return
  }
  if (typeof node.type === 'function') {
    walk(node.type(node.props), visit)
    return
  }
  visit(node)
  ;(node.children || []).forEach((c) => walk(c, visit))
}

function findByClass(tree, className) {
  let found = null
  walk(tree, (el) => {
    if (!found && typeof el.props.className === 'string' && el.props.className.split(/\s+/).includes(className)) found = el
  })
  return found
}

// 头部 badge:只收 .envd-head 子树里的,避免将来别处也放 badge 时误读。
function collectHeaderBadges(tree) {
  const header = findByClass(tree, 'envd-head')
  if (!header) throw new Error('渲染树里找不到 .envd-head(头部结构变了?)')
  const badges = []
  walk(header, (el) => {
    const cls = el.props && el.props.className
    if (typeof cls === 'string' && /\benvd-badge\b/.test(cls)) badges.push({ cls, text: flattenText(el.children).trim(), title: el.props.title })
  })
  return badges
}

// ───────────────────────────────── 桩:slots / locale / fetch ──
async function renderPanel(payload) {
  loadClient()
  resetHooks()
  const registered = []
  const slots = {
    inject(name, fn) {
      fn()
    },
    register(def, comp) {
      registered.push({ def, comp })
    },
  }
  const ctx = {
    get(name) {
      if (name === 'slots') return slots
      // 语言固定 zh:下面断言的就是中文文案,英文那侧由 test/i18n-check.mjs 保键一致
      if (name === 'locale') return { getLocale: () => ({ active: 'zh' }), subscribe: () => () => {} }
      return null
    },
  }
  globalThis.fetch = async () => ({ status: 200, json: async () => payload })
  const mod = manifest.factory((name) => (name === 'react' ? React : {}))
  mod.apply(ctx)
  const panel = registered.find((r) => r.def && r.def.key === 'envdock')
  if (!panel) throw new Error('client.js 没有注册 main 面板(key=envdock)')
  // 渲染 → 跑 effect(fetch)→ 等数据落地 → 再渲染,直到没有 setState
  let tree = null
  for (let i = 0; i < 60; i += 1) {
    cursor = 0
    dirty = false
    effectQueue = []
    tree = panel.comp()
    for (const fn of effectQueue) fn()
    await new Promise((r) => setTimeout(r, 4))
    if (!dirty) return tree
  }
  throw new Error('渲染循环没收敛(60 轮后仍在 setState)')
}

// ───────────────────────────────── 载荷 ──
const syncStats = (over) => ({
  registers: 4,
  registerTries: 7,
  disposes: 1,
  denyApplies: 2,
  ticks: 12,
  steadyTicks: 9,
  steadyNow: false,
  unrestrictable: [],
  blockedScopes: [],
  hostOnlyScopes: [],
  lastError: '',
  delegateCalls: 0,
  delegateTries: 0,
  delegateFailures: 0,
  guardDenials: 0,
  yieldTicks: 0,
  denyDrops: 0,
  sandboxHiddenScopes: 0,
  scopeAnomalies: [],
  ...over,
})

const commandTool = (over) => ({
  name: 'envd_shell',
  takeover: true,
  reuse: false,
  visible: true,
  denies: ['bash'],
  sandbox: true,
  sandboxMode: 'workspace-write',
  hostName: 'ops_bash',
  sandboxConfined: null,
  sandboxDelegate: false,
  sandboxPolicyKnown: true,
  ...over,
})

const payload = (over) => ({
  ok: true,
  state: { options: { injectBrief: false, shellTakeover: 'auto', sandboxTakeover: 'delegate' }, customTools: [] },
  shell: { key: 'pwsh', label: 'PowerShell', family: 'pwsh', path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', version: '7.4.0' },
  platform: { os: 'Windows', release: '10.0.26200', arch: 'x64' },
  tools: [],
  terminals: [{ key: 'pwsh', label: 'PowerShell', family: 'pwsh', path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', version: '7.4.0' }],
  versionManagers: [],
  issues: [],
  detectedAt: Date.now(),
  hasSubprocess: true,
  brief: 'demo brief',
  sandbox: { capable: true, defaultMode: 'workspace-write', policyKnown: true, delegate: false, scopes: [] },
  shippedShell: 'bash',
  syncStats: syncStats({}),
  ...over,
})

// 逐会话 fact:字段照 /envdock-api 的 commandTool.scopes 契约。
const scopeFact = (over) => ({
  id: '',
  kind: 'host',
  tool: null,
  hostTool: null,
  hostTools: [],
  ownVisible: false,
  hideOwnPlanned: false,
  visible: true,
  hidden: [],
  leaked: [],
  hidesOwn: false,
  anomaly: false,
  confined: false,
  mode: '',
  ...over,
})

// 固定 id:断言按前 8 位定位行,失败时一眼能看出是哪个会话
const YIELD_ID = 'aaaa1111bbbbcccc'
const SANDBOX_ID = 'cccc2222dddd0000'
const TAKEOVER_ID = 'eeee3333ffff9999'
const TAKEOVER2_ID = 'ffff4444aaaa5555'
const NULL_TOOL_ID = 'dddd4444eeee5555'
const INVISIBLE_ID = '1111aaaa2222bbbb'
const LEAKY_ID = '2222bbbb3333cccc'
const ANOMALY_ID = '3333cccc4444dddd'
const NORMAL_HOST_ID = '4444dddd5555eeee'
const LEAKED_YIELD_ID = '5555eeee6666ffff'

const YIELD = scopeFact({ id: YIELD_ID, kind: 'yield', tool: 'ops_bash', hostTool: 'ops_bash', hostTools: ['ops_bash'], hidesOwn: true })
const SANDBOX = scopeFact({ id: SANDBOX_ID, kind: 'sandbox-host', tool: 'ops_bash', hostTool: 'ops_bash', hostTools: ['ops_bash'], hidesOwn: true, confined: true, mode: 'workspace-write' })
const TAKEOVER = scopeFact({ id: TAKEOVER_ID, kind: 'takeover', tool: 'envd_shell', ownVisible: true, hidden: ['bash'] })
const TAKEOVER2 = scopeFact({ id: TAKEOVER2_ID, kind: 'takeover', tool: 'envd_shell', ownVisible: true, hidden: ['bash'] })

// ───────────────────────────────── 断言 ──
let failed = 0
function check(name, ok, detail) {
  if (ok) {
    console.log('ok   ' + name)
    return
  }
  failed += 1
  console.log('FAIL ' + name + (detail ? ' → ' + detail : ''))
}

const id8 = (id) => String(id).slice(0, 8)
const badgeWith = (badges, kind) => badges.find((b) => new RegExp('\\b' + kind + '\\b').test(b.cls))
const textsOf = (badges) => badges.map((b) => b.text)
const titleOf = (badges) => (badges.length && badges[0].title) || ''
// badge 文案里的数字:从载荷推导的期望值去比,不写死「2 个会话…」
const badgeNumber = (badge) => {
  const m = /(\d+)/.exec(badge ? badge.text : '')
  return m ? Number(m[1]) : NaN
}
// title 里的会话行:用载荷里的 id 前 8 位认领,而不是靠中文标签/行号
const sessionLines = (title, scopes) => title.split('\n').filter((line) => scopes.some((sc) => line.includes(id8(sc.id))))
const lineOf = (title, id) => title.split('\n').find((line) => line.includes(id8(id))) || ''
const describe = (badges, extra) => 'badges=' + JSON.stringify(badges.map((b) => b.cls + ' | ' + b.text)) + (extra ? ' ' + extra : '')

// 渲染失败就是结构性的(加载不到 / 没注册 / 循环不收敛),后面所有用例都没意义 ——
// 直接报错退出,不把「渲染崩了」伪装成一堆 badge 断言失败。
async function headerBadges(body, label) {
  try {
    return collectHeaderBadges(await renderPanel(body))
  } catch (error) {
    check(label + ':面板能渲染', false, error && error.message)
    process.exit(1)
  }
}

try {
  loadClient()
  console.log('ok   client.js 可加载(window.__ModuleLoader__)')
} catch (error) {
  console.log('FAIL client.js 可加载 → ' + (error && error.message))
  process.exit(1)
}

// ───────────────────────────────── 1) 混合:数字来自 scopes,不是 stats ──
// 载荷:scopes 里 2 个宿主会话 + 1 个 takeover;syncStats 故意给 sandboxHiddenScopes=2。
// 「宿主会话数」在载荷里是 2(由 HOST_SCOPES 构造),但任何「读 stats 不读 scopes」的实现
// 只有在 stats 恰好等于真值时才会碰巧通过 —— 所以下面还有 2) 专门把两者拆开。
const MIXED_SCOPES = [YIELD, SANDBOX, TAKEOVER]
const MIXED_HOST_SCOPES = [YIELD, SANDBOX] // 载荷里非 takeover 的会话
const MIXED_STATS = { hostOnlyScopes: [YIELD_ID], sandboxHiddenScopes: 2, delegateCalls: 3, guardDenials: 2, yieldTicks: 7 }
const mixed = await headerBadges(payload({ syncStats: syncStats(MIXED_STATS), commandTool: commandTool({ scopes: MIXED_SCOPES }) }), '1 混合会话')
const mixedTitle = titleOf(mixed)
const mixedWarn = badgeWith(mixed, 'warn')
check('1 混合会话:头部恰 1 个 badge', mixed.length === 1, describe(mixed))
check('1 混合会话:宿主会话 → warn 汇总 badge', Boolean(mixedWarn && mixedWarn.text.includes('个会话用宿主工具')), describe(mixed))
check(
  '1 混合会话:汇总数字 === 载荷里的非 takeover 会话数',
  badgeNumber(mixedWarn) === MIXED_HOST_SCOPES.length,
  'expect ' + MIXED_HOST_SCOPES.length + ' ' + describe(mixed),
)
check('1 混合会话:没有任何 badge 含「模型可见」', !textsOf(mixed).some((text) => text.includes('模型可见')), describe(mixed))
check('1 混合会话:title 会话行数 === scopes 长度(全部列出,含 takeover)', sessionLines(mixedTitle, MIXED_SCOPES).length === MIXED_SCOPES.length, 'lines=' + JSON.stringify(sessionLines(mixedTitle, MIXED_SCOPES)))
check('1 混合会话:title 每一行都能按 id 找到', MIXED_SCOPES.every((sc) => lineOf(mixedTitle, sc.id).includes(sc.tool || '')), 'title=' + JSON.stringify(mixedTitle))
check('1 混合会话:takeover 行标为「直连接管」', lineOf(mixedTitle, TAKEOVER_ID).includes('直连接管'), 'line=' + JSON.stringify(lineOf(mixedTitle, TAKEOVER_ID)))
check(
  '1 混合会话:非 takeover 行标出实际工具名',
  lineOf(mixedTitle, YIELD_ID).includes(YIELD.tool) && lineOf(mixedTitle, SANDBOX_ID).includes(SANDBOX.tool),
  'title=' + JSON.stringify(mixedTitle),
)
check(
  '1 混合会话:title 含三个会话级计数(数字来自 stats)',
  mixedTitle.includes('委托 ' + MIXED_STATS.delegateCalls) && mixedTitle.includes('守卫拒绝 ' + MIXED_STATS.guardDenials) && mixedTitle.includes('让路轮次 ' + MIXED_STATS.yieldTicks),
  'title=' + JSON.stringify(mixedTitle),
)

// ───────────────────────────────── 2) 数字不能来自 sandboxHiddenScopes ──
// 变异杀手:scopes 只有 1 个宿主会话,stats 故意给 5。
// 正确实现报「1 个会话用宿主工具」;把 mixedCount 换成 sandboxHiddenCount 的实现会报 5。
const MISMATCH_SCOPES = [YIELD]
const MISMATCH_STATS_HIDDEN = 5
const mismatch = await headerBadges(
  payload({ syncStats: syncStats({ hostOnlyScopes: [], sandboxHiddenScopes: MISMATCH_STATS_HIDDEN }), commandTool: commandTool({ scopes: MISMATCH_SCOPES }) }),
  '2 scopes/stats 不一致',
)
const mismatchWarn = badgeWith(mismatch, 'warn')
check('2 scopes/stats 不一致:仍挂 warn 汇总', Boolean(mismatchWarn), describe(mismatch))
check(
  '2 scopes/stats 不一致:数字来自 scopes(1),不来自 sandboxHiddenScopes(5)',
  badgeNumber(mismatchWarn) === MISMATCH_SCOPES.length,
  'expect ' + MISMATCH_SCOPES.length + ' ' + describe(mismatch),
)
check('2 scopes/stats 不一致:title 会话行数 === scopes 长度', sessionLines(titleOf(mismatch), MISMATCH_SCOPES).length === MISMATCH_SCOPES.length, 'title=' + JSON.stringify(titleOf(mismatch)))

// ───────────────────────────────── 3) 有 scopes 时不再走 stats 兜底 ──
// 纯 takeover + 故意给 sandboxHiddenScopes=2:旧兜底逻辑会把它当「2 个会话用宿主工具」而报 warn,
// 正确实现必须仍然是 ok「模型可见」。
const PURE_SCOPES = [TAKEOVER, TAKEOVER2]
const pure = await headerBadges(
  payload({ syncStats: syncStats({ hostOnlyScopes: [], sandboxHiddenScopes: 2 }), commandTool: commandTool({ scopes: PURE_SCOPES }) }),
  '3 纯接管',
)
const pureTitle = titleOf(pure)
check('3 纯接管:恰 1 个 ok badge「模型可见」', pure.length === 1 && Boolean(badgeWith(pure, 'ok')) && pure[0].text === '模型可见', describe(pure))
check('3 纯接管:没有 warn 汇总 badge(有 scopes 就不兜底)', !badgeWith(pure, 'warn'), describe(pure))
check('3 纯接管:没有异常 badge', !textsOf(pure).some((text) => text.includes('异常')), describe(pure))
check('3 纯接管:title 列出全部 takeover 会话', sessionLines(pureTitle, PURE_SCOPES).length === PURE_SCOPES.length, 'lines=' + JSON.stringify(sessionLines(pureTitle, PURE_SCOPES)))
check('3 纯接管:每行都标「直连接管」', PURE_SCOPES.every((sc) => lineOf(pureTitle, sc.id).includes('直连接管')), 'title=' + JSON.stringify(pureTitle))

// ───────────────────────────────── 4) 异常会话:每一类都要报 bad ──
// 4a tool=null 的宿主会话:模型手里一个命令工具都没有 —— 即使服务端 anomaly=false 也必须算异常。
// (故意把 visible 写成 true,把「tool 为空」这一条单独隔出来测,不让 visible===false 抢先命中。)
const NULL_TOOL = scopeFact({ id: NULL_TOOL_ID, kind: 'host', tool: null, hostTool: null, hostTools: [], visible: true, anomaly: false })
const nullTool = await headerBadges(payload({ syncStats: syncStats({}), commandTool: commandTool({ scopes: [NULL_TOOL] }) }), '4a tool=null')
check('4a tool=null:bad 异常 badge', Boolean(badgeWith(nullTool, 'bad')) && textsOf(nullTool).some((text) => text.includes('异常')), describe(nullTool))
check('4a tool=null:异常数字 === 1', badgeNumber(badgeWith(nullTool, 'bad')) === 1, describe(nullTool))
check('4a tool=null:title 有该会话的逐会话行', lineOf(titleOf(nullTool), NULL_TOOL_ID).includes(id8(NULL_TOOL_ID)), 'title=' + JSON.stringify(titleOf(nullTool)))

// 4b 一个载荷里叠三类异常(visible=false / takeover 但宿主工具仍可见 / 服务端标 anomaly),
// 外加一个正常宿主会话:数字必须只数异常的那 3 个,不是 scopes 总数。
const INVISIBLE_TAKEOVER = scopeFact({ id: INVISIBLE_ID, kind: 'takeover', tool: 'envd_shell', ownVisible: true, visible: false })
const LEAKY_TAKEOVER = scopeFact({ id: LEAKY_ID, kind: 'takeover', tool: 'envd_shell', ownVisible: true, hostTools: ['bash'] })
const FLAGGED_HOST = scopeFact({ id: ANOMALY_ID, kind: 'host', tool: 'ops_bash', hostTool: 'ops_bash', hostTools: ['ops_bash'], anomaly: true })
const NORMAL_HOST = scopeFact({ id: NORMAL_HOST_ID, kind: 'host', tool: 'pwsh', hostTool: 'pwsh', hostTools: ['pwsh'] })
const ANOMALY_SCOPES = [INVISIBLE_TAKEOVER, LEAKY_TAKEOVER, FLAGGED_HOST, NORMAL_HOST]
const ANOMALY_EXPECTED = [INVISIBLE_TAKEOVER, LEAKY_TAKEOVER, FLAGGED_HOST] // 载荷里就是这 3 个有问题
const anomalies = await headerBadges(payload({ syncStats: syncStats({}), commandTool: commandTool({ scopes: ANOMALY_SCOPES }) }), '4b 异常会话')
const anomalyTitle = titleOf(anomalies)
const anomalyBadge = badgeWith(anomalies, 'bad')
check('4b 异常会话:bad 异常 badge', Boolean(anomalyBadge && anomalyBadge.text.includes('异常')), describe(anomalies))
check('4b 异常会话:数字 === 载荷里的异常会话数(3),不是 scopes 总数(4)', badgeNumber(anomalyBadge) === ANOMALY_EXPECTED.length, 'expect ' + ANOMALY_EXPECTED.length + ' ' + describe(anomalies))
check('4b 异常会话:title 会话行数 === scopes 长度(全部列出)', sessionLines(anomalyTitle, ANOMALY_SCOPES).length === ANOMALY_SCOPES.length, 'lines=' + JSON.stringify(sessionLines(anomalyTitle, ANOMALY_SCOPES)))
check('4b 异常会话:正常宿主会话不被漏掉也不被算异常', lineOf(anomalyTitle, NORMAL_HOST_ID).includes(NORMAL_HOST.tool), 'title=' + JSON.stringify(anomalyTitle))
check('4b 异常会话:泄漏的宿主工具名出现在该会话行', lineOf(anomalyTitle, LEAKY_ID).includes('bash'), 'line=' + JSON.stringify(lineOf(anomalyTitle, LEAKY_ID)))
check('4b 异常会话:visible=false 的会话行带异常标记', lineOf(anomalyTitle, INVISIBLE_ID).includes('⚠'), 'line=' + JSON.stringify(lineOf(anomalyTitle, INVISIBLE_ID)))

// 4c 「挡了却仍可见」(leaked 非空):anomaly 标志为 false 也必须算异常。
const LEAKED_YIELD = scopeFact({ id: LEAKED_YIELD_ID, kind: 'yield', tool: 'ops_bash', hostTool: 'ops_bash', hostTools: ['ops_bash'], hidesOwn: true, anomaly: false, leaked: ['bash'] })
const leaked = await headerBadges(payload({ syncStats: syncStats({}), commandTool: commandTool({ scopes: [LEAKED_YIELD] }) }), '4c leaked')
check('4c leaked:bad 异常 badge(不依赖服务端 anomaly 标志)', Boolean(badgeWith(leaked, 'bad')) && textsOf(leaked).some((text) => text.includes('异常')), describe(leaked))
check('4c leaked:异常数字 === 1', badgeNumber(badgeWith(leaked, 'bad')) === 1, describe(leaked))

// ───────────────────────────────── 5) 计数不夸大:steadyNow 才是状态,steadyTicks 只是累计 ──
// steadyTicks=999 + steadyNow=false 时 title 绝不能写「稳态」;反过来 steadyNow=true 才写。
const counterStats = { registers: 4, registerTries: 7, ticks: 12, delegateTries: 4, delegateFailures: 1, sandboxHiddenScopes: 0 }
const notSteady = await headerBadges(
  payload({ syncStats: syncStats({ ...counterStats, steadyTicks: 999, steadyNow: false }), commandTool: commandTool({ scopes: MIXED_SCOPES }) }),
  '5a 非稳态',
)
const notSteadyTitle = titleOf(notSteady)
check('5a 非稳态:累计 steadyTicks=999 也不写「稳态」', !notSteadyTitle.includes('稳态'), 'title=' + JSON.stringify(notSteadyTitle))
check('5a 非稳态:title 用「注册尝试」等新计数(数字来自 stats)', notSteadyTitle.includes('注册尝试 ' + counterStats.registerTries), 'title=' + JSON.stringify(notSteadyTitle))
check('5a 非稳态:title 含委托尝试/委托失败计数', notSteadyTitle.includes('委托尝试 ' + counterStats.delegateTries) && notSteadyTitle.includes('委托失败 ' + counterStats.delegateFailures), 'title=' + JSON.stringify(notSteadyTitle))
const steady = await headerBadges(
  payload({ syncStats: syncStats({ ...counterStats, steadyTicks: 999, steadyNow: true }), commandTool: commandTool({ scopes: MIXED_SCOPES }) }),
  '5b 稳态',
)
check('5b 稳态:steadyNow=true 才写「稳态」', titleOf(steady).includes('稳态'), 'title=' + JSON.stringify(titleOf(steady)))

// ───────────────────────────────── 6) 旧版 API:没有 scopes 才兜底,且 title 必须注明「旧版构建」 ──
// 旧版 /envdock-api 没有 commandTool.scopes,只能拿 hostOnlyScopes / sandboxHiddenScopes 汇总。
// 关键:此时不能逐个会话核对,title 里必须说清楚,而不是假装这是完整的逐会话事实。
const legacy = await headerBadges(
  payload({ syncStats: syncStats({ hostOnlyScopes: [YIELD_ID], sandboxHiddenScopes: 2 }), commandTool: commandTool() }),
  '6 旧版 API',
)
const legacyTitle = titleOf(legacy)
const legacyWarn = badgeWith(legacy, 'warn')
check('6 旧版 API:无 scopes 时仍挂 warn 汇总(不报「模型可见」)', Boolean(legacyWarn), describe(legacy))
check('6 旧版 API:badge 文案含「个会话用宿主工具」', Boolean(legacyWarn && legacyWarn.text.includes('个会话用宿主工具')), describe(legacy))
check('6 旧版 API:没有任何 badge 含「模型可见」', !textsOf(legacy).some((text) => text.includes('模型可见')), describe(legacy))
check('6 旧版 API:title 注明「旧版构建」', legacyTitle.includes('旧版构建'), 'title=' + JSON.stringify(legacyTitle))
check('6 旧版 API:title 仍能按 id 列出 hostOnlyScopes 里的会话', lineOf(legacyTitle, YIELD_ID).includes(id8(YIELD_ID)), 'title=' + JSON.stringify(legacyTitle))
check('6 旧版 API:没有异常 badge', !textsOf(legacy).some((text) => text.includes('异常')), describe(legacy))

// ───────────────────────────────── 7) 全局不可见:envd_shell 不在工具表里 ──
// 保持 bad「不可见」,不该出现汇总 badge;sandbox:false 是必须的(沙箱路径另有展示,本来就不挂 bad)。
const invisible = await headerBadges(payload({ syncStats: syncStats({}), commandTool: commandTool({ visible: false, sandbox: false, scopes: [] }) }), '7 全局不可见')
check('7 全局不可见:恰 1 个 bad「不可见」badge', invisible.length === 1 && Boolean(badgeWith(invisible, 'bad')) && invisible[0].text.includes('不可见'), describe(invisible))
check('7 全局不可见:没有汇总 badge', !invisible.some((b) => Boolean(badgeWith(invisible, 'warn')) || b.text.includes('个会话用宿主工具')), describe(invisible))
check('7 全局不可见:不出现「模型可见」', !textsOf(invisible).some((text) => text.includes('模型可见')), describe(invisible))

console.log(failed === 0 ? '\nall panel-render cases passed' : '\n' + failed + ' case(s) failed')
process.exit(failed === 0 ? 0 : 1)
