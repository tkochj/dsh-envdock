/**
 * EnvDock 面板渲染回归测试(简洁版面板 / 接管可视化)。
 *
 * client.js 是浏览器脚本(`window.__ModuleLoader__.load`),不能在 Node 里 import;
 * 但它渲染出来的东西完全由 /envdock-api 的 JSON 决定 —— 所以这里用一套极简 React
 * 运行时替身(useState/useEffect/useMemo/useCallback/useRef)+ 桩 slots/locale/fetch,
 * 把 client.js 真跑起来,捕获 EnvDockPanel 的真实渲染树再按 class 断言。
 *
 * 为什么要这样测:
 *   · 头部只有 1 个状态 badge,数字必须来自 scopes(逐会话事实),不是 syncStats 的汇总数;
 *   · 接管卡片要真的把每个会话、宿主命令工具、执行器族画出来;
 *   · 异常会话要自动展开红色的诊断摘要;
 *   · 15s 轮询只在页面可见时拉、payload 没变不重渲染。
 * 所有数字/行数都从载荷推导(不写死「2 个」「3 行」),所以把实现改成「读 stats 不读 scopes」
 * 或「删掉异常过滤」会直接失败 —— 这是变异敏感的来源。
 *
 * 零依赖,Windows 上直接 `node test/panel-render.mjs` 可跑。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', 'client.js'), 'utf8')

// ───────────────────────────────── 极简 React 运行时替身 ──
let states, refs, memoVals, memoDeps, effectDeps, cursor, dirty, effectQueue, renderCount

function resetHooks() {
  states = []
  refs = []
  memoVals = []
  memoDeps = []
  effectDeps = []
  cursor = 0
  dirty = false
  effectQueue = []
  renderCount = 0
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
let manifest = null
function loadClient() {
  const win = { __ModuleLoader__: { load(m) { manifest = m } } }
  new Function('window', SOURCE)(win)
  if (!manifest || typeof manifest.factory !== 'function') throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
  if (manifest.id !== 'dsh-envdock') throw new Error('ModuleLoader id 不是 dsh-envdock: ' + manifest.id)
  return manifest
}

// ───────────────────────────────── 渲染树工具 ──
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

const classTokens = (el) => (el && el.props && typeof el.props.className === 'string' ? el.props.className.split(/\s+/) : [])

function findAllByClass(node, className) {
  const out = []
  walk(node, (el) => {
    if (classTokens(el).includes(className)) out.push(el)
  })
  return out
}

function findOneByClass(node, className) {
  return findAllByClass(node, className)[0] || null
}

// 一个节点可能同时带几个 class(如 envd-statuschip warn)
function findWithClasses(node, ...classes) {
  return findAllByClass(node, classes[0]).find((el) => classes.every((c) => classTokens(el).includes(c))) || null
}

const textOf = (node) => flattenText(node).trim()

// 头部 badge:只看 .envd-head 子树(头部只能有 1 个状态 badge)
function headerBadges(tree) {
  const header = findOneByClass(tree, 'envd-head')
  if (!header) throw new Error('渲染树里找不到 .envd-head(头部结构变了?)')
  return findAllByClass(header, 'envd-badge').map((el) => ({ cls: el.props.className, text: textOf(el.children), title: el.props.title }))
}

// ───────────────────────────────── 挂载 / 交互 ──
async function mountPanel(body, options = {}) {
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
      // 语言固定 zh:断言的就是中文文案,英文那侧由 test/i18n-check.mjs 保键一致
      if (name === 'locale') return { getLocale: () => ({ active: 'zh' }), subscribe: () => () => {} }
      return null
    },
  }
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    const next = typeof options.payloadFor === 'function' ? options.payloadFor(fetchCalls, body) : body
    return { status: 200, json: async () => next }
  }
  const mod = manifest.factory((name) => (name === 'react' ? React : {}))
  mod.apply(ctx)
  const panel = registered.find((r) => r.def && r.def.key === 'envdock')
  if (!panel) throw new Error('client.js 没有注册 main 面板(key=envdock)')
  let tree = null
  // 渲染 → 跑 effect(fetch 在 effect 里)→ 等数据落地 → 再渲染,直到没有 setState
  const settle = async () => {
    for (let i = 0; i < 80; i += 1) {
      cursor = 0
      dirty = false
      effectQueue = []
      renderCount += 1
      tree = panel.comp()
      for (const fn of effectQueue) fn()
      await new Promise((r) => setTimeout(r, 4))
      if (!dirty) return tree
    }
    throw new Error('渲染循环没收敛(80 轮后仍在 setState)')
  }
  await settle()
  return {
    settle,
    get tree() {
      return tree
    },
    renders: () => renderCount,
    fetchCalls: () => fetchCalls,
    isDirty: () => dirty,
    // 点击某个 class 的节点(我们的替身没有事件系统,直接调 props.onClick 再渲染一轮)
    async click(className, index = 0) {
      const nodes = findAllByClass(tree, className)
      const target = nodes[index]
      if (!target) throw new Error('找不到可点的 .' + className)
      if (typeof target.props.onClick !== 'function') throw new Error('.' + className + ' 没有 onClick')
      await target.props.onClick()
      return settle()
    },
  }
}

// ───────────────────────────────── 载荷 ──
const syncStats = (over) => ({
  registers: 4,
  registerTries: 7,
  disposes: 1,
  denyApplies: 2,
  ticks: 12,
  steadyTicks: 9,
  steadyNow: true,
  unrestrictable: [],
  blockedScopes: [],
  hostOnlyScopes: [],
  lastError: '',
  lastErrorAt: 0,
  delegateCalls: 0,
  delegateTries: 0,
  delegateFailures: 0,
  guardDenials: 0,
  yieldTicks: 0,
  denyDrops: 0,
  ownHides: 0,
  hostDenyApplies: 0,
  denyNoops: 0,
  transientMisses: 0,
  sandboxHiddenScopes: 0,
  scopeAnomalies: [],
  runtimeShellTools: [],
  executorFamily: '',
  executorFamilySource: 'unknown',
  guardReady: true,
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
  detectedAt: 1700000000000,
  hasSubprocess: true,
  brief: 'demo brief',
  sandbox: { capable: true, defaultMode: 'workspace-write', policyKnown: true, delegate: false, scopes: [] },
  shippedShell: 'bash',
  syncStats: syncStats({}),
  ...over,
})

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

const YIELD_ID = 'aaaa1111bbbbcccc'
const SANDBOX_ID = 'cccc2222dddd0000'
const TAKEOVER_ID = 'eeee3333ffff9999'
const TAKEOVER2_ID = 'ffff4444aaaa5555'
const NULL_TOOL_ID = 'dddd4444eeee5555'
const INVISIBLE_ID = '1111aaaa2222bbbb'
const LEAKY_ID = '2222bbbb3333cccc'
const FLAGGED_ID = '3333cccc4444dddd'
const NORMAL_HOST_ID = '4444dddd5555eeee'

const YIELD = scopeFact({ id: YIELD_ID, kind: 'yield', tool: 'ops_bash', hostTool: 'ops_bash', hostTools: ['ops_bash'], hidesOwn: true })
const SANDBOX = scopeFact({ id: SANDBOX_ID, kind: 'sandbox-host', tool: 'ops_bash', hostTool: 'ops_bash', hostTools: ['ops_bash'], hidesOwn: true, confined: true, mode: 'workspace-write' })
const TAKEOVER = scopeFact({ id: TAKEOVER_ID, kind: 'takeover', tool: 'envd_shell', ownVisible: true, hidden: ['bash'] })
const TAKEOVER2 = scopeFact({ id: TAKEOVER2_ID, kind: 'takeover', tool: 'envd_shell', ownVisible: true, hidden: ['bash'] })
const SHELL_TOOLS = [
  { name: 'bash', family: 'bash', learned: false },
  { name: 'ops_bash', family: 'bash', learned: true },
  { name: 'pwsh', family: 'powershell', learned: false },
]

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
const badgeNumber = (badge) => {
  const m = /(\d+)/.exec(badge ? badge.text : '')
  return m ? Number(m[1]) : NaN
}
const emoji = (badges) => 'badges=' + JSON.stringify(badges.map((b) => b.cls + ' | ' + b.text))
const rowCount = (tree) => findAllByClass(tree, 'envd-srow').length
const badRows = (tree) => findAllByClass(tree, 'envd-srow').filter((el) => classTokens(el).includes('bad'))
const shellChips = (tree) => findAllByClass(tree, 'envd-shellchip')

try {
  loadClient()
  console.log('ok   client.js 可加载(window.__ModuleLoader__)')
} catch (error) {
  console.log('FAIL client.js 可加载 → ' + (error && error.message))
  process.exit(1)
}

// ───────────────────────────────── 1) 混合会话:头部 1 个 badge + 接管卡片可视化 ──
// 载荷:2 个宿主会话 + 1 个 takeover;syncStats.sandboxHiddenScopes 故意给 2。
// badge 数字必须来自 scopes 的宿主会话数(2),不是 stats —— 见 2) 的拆开用例。
const MIXED_SCOPES = [YIELD, SANDBOX, TAKEOVER]
const MIXED_HOST_SCOPES = [YIELD, SANDBOX]
const mixedPayload = payload({
  syncStats: syncStats({
    hostOnlyScopes: [YIELD_ID],
    sandboxHiddenScopes: 2,
    runtimeShellTools: SHELL_TOOLS,
    executorFamily: 'powershell',
    executorFamilySource: 'platform',
  }),
  commandTool: commandTool({ scopes: MIXED_SCOPES }),
})
const mixed = await mountPanel(mixedPayload)
const mixedBadges = headerBadges(mixed.tree)
const mixedWarn = mixedBadges.find((b) => /\bwarn\b/.test(b.cls))
check('1 混合:头部恰 1 个 badge', mixedBadges.length === 1, emoji(mixedBadges))
check('1 混合:badge 文案含会话数且数字 === 载荷里的宿主会话数', Boolean(mixedWarn && mixedWarn.text.includes('个会话用宿主工具') && badgeNumber(mixedWarn) === MIXED_HOST_SCOPES.length), 'expect ' + MIXED_HOST_SCOPES.length + ' ' + emoji(mixedBadges))
check('1 混合:badge title 不出现孤立的「模型可见」', Boolean(mixedWarn && !String(mixedWarn.title || '').includes('模型可见')), 'title=' + JSON.stringify(mixedWarn && mixedWarn.title))
check('1 混合:接管卡片存在', Boolean(findOneByClass(mixed.tree, 'envd-card')))
check('1 混合:逐会话行数 === scopes 长度(含 takeover)', rowCount(mixed.tree) === MIXED_SCOPES.length, 'rows=' + rowCount(mixed.tree) + ' scopes=' + MIXED_SCOPES.length)
const rowTexts = findAllByClass(mixed.tree, 'envd-srow').map(textOf)
check('1 混合:takeover 行标为「直连接管」', rowTexts.some((text) => text.includes(id8(TAKEOVER_ID)) && text.includes('直连接管')), JSON.stringify(rowTexts))
check('1 混合:非 takeover 行带实际工具名', rowTexts.some((text) => text.includes(id8(YIELD_ID)) && text.includes(YIELD.tool)), JSON.stringify(rowTexts))
const mixedShellChips = shellChips(mixed.tree)
check('1 混合:已识别宿主命令工具 chips 数量 === 载荷数量', mixedShellChips.length === SHELL_TOOLS.length, 'chips=' + mixedShellChips.length + ' expect=' + SHELL_TOOLS.length)
check('1 混合:chips 里每个工具名都出现', SHELL_TOOLS.every((item) => mixedShellChips.some((chip) => textOf(chip).includes(item.name))), JSON.stringify(mixedShellChips.map(textOf)))
const execNode = findOneByClass(mixed.tree, 'envd-exec')
check('1 混合:显示执行器族(取自 executorFamily)', Boolean(execNode && textOf(execNode).includes('powershell')), execNode ? textOf(execNode) : '(missing)')
check('1 混合:状态 chip 是 warn 色(有会话用宿主工具)', Boolean(findWithClasses(mixed.tree, 'envd-statuschip', 'warn')), JSON.stringify(findAllByClass(mixed.tree, 'envd-statuschip').map((el) => el.props.className)))
check('1 混合:接管模式 + 沙箱下接管 chips 都在', findAllByClass(mixed.tree, 'envd-chips-sm').length === 2, 'sm=' + findAllByClass(mixed.tree, 'envd-chips-sm').length)

// ───────────────────────────────── 2) 数字不能来自 sandboxHiddenScopes ──
// scopes 只有 1 个宿主会话,stats 故意给 5:正确实现报 1,读 stats 的实现会报 5。
const MISMATCH_SCOPES = [YIELD]
const mismatch = await mountPanel(
  payload({ syncStats: syncStats({ hostOnlyScopes: [], sandboxHiddenScopes: 5 }), commandTool: commandTool({ scopes: MISMATCH_SCOPES }) }),
)
const mismatchBadge = headerBadges(mismatch.tree).find((b) => /\bwarn\b/.test(b.cls))
check('2 stats 不一致:数字来自 scopes(1),不来自 sandboxHiddenScopes(5)', Boolean(mismatchBadge && badgeNumber(mismatchBadge) === MISMATCH_SCOPES.length), 'expect ' + MISMATCH_SCOPES.length + ' ' + emoji(headerBadges(mismatch.tree)))
check('2 stats 不一致:会话行数 === scopes 长度', rowCount(mismatch.tree) === MISMATCH_SCOPES.length, 'rows=' + rowCount(mismatch.tree))

// ───────────────────────────────── 3) 纯 takeover + 故意给 sandboxHiddenScopes=2 ──
// 有 scopes 时不再走 stats 兜底:必须仍是 ok「模型可见」,且没有沙箱下接管 chips。
const pure = await mountPanel(
  payload({
    syncStats: syncStats({ hostOnlyScopes: [], sandboxHiddenScopes: 2 }),
    sandbox: { capable: false, defaultMode: 'workspace-write', policyKnown: true, delegate: false, scopes: [] },
    commandTool: commandTool({ scopes: [TAKEOVER, TAKEOVER2] }),
  }),
)
const pureBadges = headerBadges(pure.tree)
check('3 纯接管:恰 1 个 ok「模型可见」badge', pureBadges.length === 1 && /\bok\b/.test(pureBadges[0].cls) && pureBadges[0].text === '模型可见', emoji(pureBadges))
check('3 纯接管:没有 warn/异常 badge', !pureBadges.some((b) => /\bwarn\b|\bbad\b/.test(b.cls)), emoji(pureBadges))
check('3 纯接管:会话行数 === scopes 长度', rowCount(pure.tree) === 2, 'rows=' + rowCount(pure.tree))
check('3 纯接管:每行都标「直连接管」', findAllByClass(pure.tree, 'envd-srow').every((el) => textOf(el).includes('直连接管')), JSON.stringify(findAllByClass(pure.tree, 'envd-srow').map(textOf)))
check('3 纯接管:没有围栏会话/能力位时不显示沙箱接管 chips', findAllByClass(pure.tree, 'envd-chips-sm').length === 1, 'sm=' + findAllByClass(pure.tree, 'envd-chips-sm').length)
check('3 纯接管:状态 chip 是 ok 色', Boolean(findWithClasses(pure.tree, 'envd-statuschip', 'ok')), JSON.stringify(findAllByClass(pure.tree, 'envd-statuschip').map((el) => el.props.className)))

// ───────────────────────────────── 4) 异常会话:tool=null / visible=false / hostTools 泄漏 / anomaly 标志 ──
// 4 类是客户端自己能判定的:零工具(null)、不可见、接管下宿主工具仍可见、服务端标 anomaly。
// 第 5 个会话完全正常,必须不被算进异常数字,也不能从逐会话列表里漏掉。
const NULL_TOOL = scopeFact({ id: NULL_TOOL_ID, kind: 'host', tool: null, hostTool: null, hostTools: [], visible: true, anomaly: false })
const INVISIBLE = scopeFact({ id: INVISIBLE_ID, kind: 'takeover', tool: 'envd_shell', ownVisible: true, visible: false })
const LEAKY = scopeFact({ id: LEAKY_ID, kind: 'takeover', tool: 'envd_shell', ownVisible: true, hostTools: ['bash'] })
const FLAGGED = scopeFact({ id: FLAGGED_ID, kind: 'host', tool: 'ops_bash', hostTool: 'ops_bash', hostTools: ['ops_bash'], anomaly: true })
const NORMAL_HOST = scopeFact({ id: NORMAL_HOST_ID, kind: 'host', tool: 'pwsh', hostTool: 'pwsh', hostTools: ['pwsh'] })
const BAD_SCOPES = [NULL_TOOL, INVISIBLE, LEAKY, FLAGGED, NORMAL_HOST]
const EXPECTED_BAD = [NULL_TOOL, INVISIBLE, LEAKY, FLAGGED]
const anomalies = await mountPanel(payload({ syncStats: syncStats({}), commandTool: commandTool({ scopes: BAD_SCOPES }) }))
const anomalyBadge = headerBadges(anomalies.tree).find((b) => /\bbad\b/.test(b.cls))
check('4 异常:头部 bad「N 个会话命令工具异常」', Boolean(anomalyBadge && anomalyBadge.text.includes('异常')), emoji(headerBadges(anomalies.tree)))
check('4 异常:数字 === 载荷里的异常会话数(不是 scopes 总数)', Boolean(anomalyBadge && badgeNumber(anomalyBadge) === EXPECTED_BAD.length), 'expect ' + EXPECTED_BAD.length + ' ' + emoji(headerBadges(anomalies.tree)))
check('4 异常:逐会话行全部列出', rowCount(anomalies.tree) === BAD_SCOPES.length, 'rows=' + rowCount(anomalies.tree) + ' scopes=' + BAD_SCOPES.length)
check('4 异常:异常行染红,且只红 4 行', badRows(anomalies.tree).length === EXPECTED_BAD.length, 'badRows=' + badRows(anomalies.tree).length)
check('4 异常:异常行尾给原因', badRows(anomalies.tree).every((el) => textOf(el).includes('⚠')), JSON.stringify(badRows(anomalies.tree).map(textOf)))
check('4 异常:诊断自动展开(不需要点)', Boolean(findOneByClass(anomalies.tree, 'envd-diag-detail')))
check('4 异常:诊断摘要红字(danger)', Boolean(findWithClasses(anomalies.tree, 'envd-diag-sum', 'danger')), JSON.stringify(findAllByClass(anomalies.tree, 'envd-diag-sum').map((el) => el.props.className)))
check('4 异常:诊断详情里有 error 红条目', findAllByClass(anomalies.tree, 'envd-diag-detail').some((el) => findAllByClass(el, 'e').length > 0), 'detail 里找不到 .e')
check('4 异常:正常会话没有被染红', findAllByClass(anomalies.tree, 'envd-srow').some((el) => textOf(el).includes(id8(NORMAL_HOST_ID)) && !classTokens(el).includes('bad')), JSON.stringify(findAllByClass(anomalies.tree, 'envd-srow').map(textOf)))

// ───────────────────────────────── 5) 健康:诊断默认折叠,不自动展开 ──
const healthy = await mountPanel(mixedPayload)
check('5 健康:诊断默认折叠(无 detail)', !findOneByClass(healthy.tree, 'envd-diag-detail'))
check('5 健康:诊断摘要不是红字', !findWithClasses(healthy.tree, 'envd-diag-sum', 'danger'))
check('5 健康:健康检查整节不出现(无 issues)', !findOneByClass(healthy.tree, 'envd-fold-health'))
check('5 健康:没有异常会话行', badRows(healthy.tree).length === 0, 'badRows=' + badRows(healthy.tree).length)

// ───────────────────────────────── 6) 旧版 API:没有 commandTool.scopes ──
// 不能崩,不能退回孤立的「模型可见」;card 里必须说明这是旧版构建、只能给汇总。
const legacy = await mountPanel(
  payload({ syncStats: syncStats({ hostOnlyScopes: [YIELD_ID], sandboxHiddenScopes: 2 }), commandTool: commandTool() }),
)
const legacyBadges = headerBadges(legacy.tree)
const legacyNote = findOneByClass(legacy.tree, 'envd-legacy')
check('6 旧版:头部仍有汇总 badge(无孤立「模型可见」)', legacyBadges.length === 1 && /\bwarn\b/.test(legacyBadges[0].cls) && !legacyBadges[0].text.includes('模型可见'), emoji(legacyBadges))
check('6 旧版:卡片里注明「旧版构建」', Boolean(legacyNote && textOf(legacyNote).includes('旧版构建')), legacyNote ? textOf(legacyNote) : '(missing)')
check('6 旧版:fallback 会话按 id 列出', findAllByClass(legacy.tree, 'envd-srow').some((el) => textOf(el).includes(id8(YIELD_ID))), JSON.stringify(findAllByClass(legacy.tree, 'envd-srow').map(textOf)))

// ───────────────────────────────── 7) 工具链精简 + 折叠 + 底部开关 ──
const TOOL = {
  key: 'node',
  label: 'Node.js',
  group: 'runtime',
  path: 'C:\\Program Files\\nodejs\\node.exe',
  defaultPath: 'C:\\Program Files\\nodejs\\node.exe',
  defaultVersion: '24.18.0',
  version: '24.18.0',
  versions: [
    { version: '24.18.0', path: 'C:\\Program Files\\nodejs\\node.exe' },
    { version: '20.19.0', path: 'C:\\nvm\\v20.19.0\\node.exe' },
  ],
}
const toolsPanel = await mountPanel(
  payload({ tools: [TOOL], issues: [{ level: 'warn', title: 'stale path', detail: 'C:\\gone' }] }),
)
const pathButtons = findAllByClass(toolsPanel.tree, 'envd-pathbtn')
check('7 工具:路径是可点击的按钮(不再是独立复制按钮)', pathButtons.length === 1 && textOf(pathButtons[0]) === TOOL.defaultPath, JSON.stringify(pathButtons.map(textOf)))
check('7 工具:多版本默认折叠', findAllByClass(toolsPanel.tree, 'envd-vrow').length === 0, 'vrows=' + findAllByClass(toolsPanel.tree, 'envd-vrow').length)
await toolsPanel.click('envd-versionchip')
check('7 工具:点版本 chip 后展开候选数 === versions 长度', findAllByClass(toolsPanel.tree, 'envd-vrow').length === TOOL.versions.length, 'vrows=' + findAllByClass(toolsPanel.tree, 'envd-vrow').length)
check('7 健康检查:默认折叠(有问题也只一行)', !findOneByClass(toolsPanel.tree, 'envd-issues') && Boolean(findOneByClass(toolsPanel.tree, 'envd-fold-health')))
await toolsPanel.click('envd-fold-health')
check('7 健康检查:点开后列表条数 === issues 长度', findAllByClass(toolsPanel.tree, 'envd-issue').length === 1, 'issues=' + findAllByClass(toolsPanel.tree, 'envd-issue').length)
check('7 简报:默认折叠(没有 <pre>)', !findOneByClass(toolsPanel.tree, 'envd-pre'))
await toolsPanel.click('envd-fold-brief')
check('7 简报:点开后出现简报正文', Boolean(findOneByClass(toolsPanel.tree, 'envd-pre')))
check('7 底部:两个紧凑开关一行(简报注入 / 允许局域网)', findAllByClass(toolsPanel.tree, 'envd-switch').length === 2, 'switches=' + findAllByClass(toolsPanel.tree, 'envd-switch').length)
check('7 底部:不再有单独的「选项」大节', !findOneByClass(toolsPanel.tree, 'envd-opt'))

// ───────────────────────────────── 8) 逐会话最多 5 行,超出给「还有 N 个」 ──
const MANY_SCOPES = Array.from({ length: 6 }, (_, i) => scopeFact({ id: 'scope' + i + 'aaaaaaaaaa', kind: 'takeover', tool: 'envd_shell', ownVisible: true }))
const many = await mountPanel(payload({ syncStats: syncStats({}), commandTool: commandTool({ scopes: MANY_SCOPES }) }))
check('8 多会话:默认最多 5 行', rowCount(many.tree) === 5, 'rows=' + rowCount(many.tree))
const moreButton = findOneByClass(many.tree, 'envd-morebtn')
const remaining = MANY_SCOPES.length - 5
check('8 多会话:「还有 N 个」的 N 由载荷推导', Boolean(moreButton && textOf(moreButton).includes(String(remaining))), moreButton ? textOf(moreButton) : '(missing)')
await many.click('envd-morebtn')
check('8 多会话:展开后行数 === scopes 长度', rowCount(many.tree) === MANY_SCOPES.length, 'rows=' + rowCount(many.tree))

// ───────────────────────────────── 9) 15s 轮询:可见才拉,payload 未变不重渲染 ──
// 定时器做成可捕获的桩,手工触发 tick —— 不真的等 15s。
const intervals = []
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
let pollTick = 0
globalThis.setInterval = (fn, ms) => {
  intervals.push({ fn, ms })
  return intervals.length
}
globalThis.clearInterval = () => {}
globalThis.document = { visibilityState: 'hidden' }
try {
  const base = payload({ syncStats: syncStats({}), commandTool: commandTool({ scopes: [TAKEOVER] }) })
  // 每次 fetch 都返回**新对象**(内容可能相同):这样「内容相同就不 setData」才有意义 ——
  // 若桩复用同一个对象引用,React 的 setState 会因引用相同而天然 bail,测不出 dedupe 是否还在。
  const cloneOf = (value) => JSON.parse(JSON.stringify(value))
  const polled = await mountPanel(base, {
    payloadFor: (callIndex) => {
      // 第 1 次(初始加载)与第 2 次(第一次可见 tick)内容相同;之后换一份事实。
      if (callIndex <= 2) return cloneOf(base)
      const next = cloneOf(base)
      next.detectedAt += pollTick + 1
      next.syncStats.registers = 99
      return next
    },
  })
  check('9 轮询:挂载时只拉 1 次', polled.fetchCalls() === 1, 'fetch=' + polled.fetchCalls())
  check('9 轮询:注册了 15s 定时器', intervals.length === 1 && intervals[0].ms === 15000, JSON.stringify(intervals.map((i) => i.ms)))
  // 页面隐藏:不拉
  intervals[0].fn()
  await new Promise((r) => setTimeout(r, 12))
  check('9 轮询:页面隐藏时不拉', polled.fetchCalls() === 1, 'fetch=' + polled.fetchCalls())
  // 页面可见 + payload 相同:拉了但不 setData(不重渲染)
  globalThis.document = { visibilityState: 'visible' }
  intervals[0].fn()
  await new Promise((r) => setTimeout(r, 12))
  check('9 轮询:页面可见时才拉', polled.fetchCalls() === 2, 'fetch=' + polled.fetchCalls())
  check('9 轮询:payload 未变不触发重渲染', polled.isDirty() === false, 'dirty=' + polled.isDirty())
  // 页面可见 + payload 变了:必须 setData
  pollTick += 1
  intervals[0].fn()
  await new Promise((r) => setTimeout(r, 12))
  check('9 轮询:payload 变了才更新(触发重渲染)', polled.isDirty() === true, 'dirty=' + polled.isDirty())
  await polled.settle()
  check('9 轮询:更新后仍是同一张卡片(没崩)', Boolean(findOneByClass(polled.tree, 'envd-card')))
} finally {
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
  delete globalThis.document
}

// ───────────────────────────────── 10) 读不到数据(例如非 loopback 被 403):不崩,底部开关仍可用 ──
// allowLan 必须能点到 —— 它是被 403 挡在门外的唯一解法,所以不能跟 data 绑定。
const noData = await mountPanel({ ok: false, error: 'HTTP 403' })
check('10 无数据:显示错误框而不是崩溃', Boolean(findOneByClass(noData.tree, 'envd-err')))
check('10 无数据:不渲染接管卡片', !findOneByClass(noData.tree, 'envd-card'))
check('10 无数据:底部两个开关仍在(含「允许局域网访问」)', findAllByClass(noData.tree, 'envd-switch').length === 2, 'switches=' + findAllByClass(noData.tree, 'envd-switch').length)
check('10 无数据:头部没有状态 badge', headerBadges(noData.tree).length === 0, emoji(headerBadges(noData.tree)))

console.log(failed === 0 ? '\nall panel-render cases passed' : '\n' + failed + ' case(s) failed')
process.exit(failed === 0 ? 0 : 1)
