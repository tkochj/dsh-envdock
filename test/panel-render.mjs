/**
 * EnvDock 面板渲染回归测试(简洁面板 / 接管可视化 / 审校 15 条)。
 *
 * client.js 是浏览器脚本(`window.__ModuleLoader__.load`),不能在 Node 里 import;
 * 但它渲染出来的东西完全由 /envdock-api 的 JSON 决定 —— 所以这里用一套极简 React
 * 运行时替身(useState/useEffect/useMemo/useCallback/useRef)+ 桩 slots/locale/fetch,
 * 把 client.js 真跑起来,捕获 EnvDockPanel 的真实渲染树再按 class 断言。
 *
 * 替身会保存并执行 effect cleanup,所以卸载路径(轮询定时器要清掉)也测得到。
 * 所有数字/行数都从载荷推导,不写死「2 个」「3 行」—— 把实现改成「读 stats 不读 scopes」
 * 或删掉异常过滤会直接失败,这是变异敏感的来源。
 *
 * 零依赖,Windows 上直接 `node test/panel-render.mjs` 可跑。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', 'client.js'), 'utf8')
// client.js 内联的英文词典块(静态检查用:英文界面不许出现中文)
const EN_BLOCK = SOURCE.slice(SOURCE.indexOf('      en: {'), SOURCE.indexOf('\n      },', SOURCE.indexOf('      en: {')))

// ───────────────────────────────── 极简 React 运行时替身 ──
let states, refs, memoVals, memoDeps, effectDeps, cleanups, cursor, dirty, effectQueue, renderCount

function resetHooks() {
  states = []
  refs = []
  memoVals = []
  memoDeps = []
  effectDeps = []
  cleanups = []
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
      effectQueue.push({ index: i, fn })
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
const allText = (tree) => flattenText(tree)
// 可见文本:跳过 <style>(CSS 注释是中文,跟界面语言无关)
function visibleText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(visibleText).join('')
  if (node.type === 'style') return ''
  if (typeof node.type === 'function') return visibleText(node.type(node.props))
  return (node.children || []).map(visibleText).join('')
}

// 头部 badge:只看 .envd-head 子树
function headerBadges(tree) {
  const header = findOneByClass(tree, 'envd-head')
  if (!header) throw new Error('渲染树里找不到 .envd-head(头部结构变了?)')
  return findAllByClass(header, 'envd-badge').map((el) => ({ cls: el.props.className, text: textOf(el.children), title: el.props.title }))
}

// ───────────────────────────────── 挂载 / 交互 / 卸载 ──
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
      // 默认 zh;英文用例传 locale:'en',由 test/i18n-check.mjs 保证两份词条键一致
      if (name === 'locale') return { getLocale: () => ({ active: options.locale || 'zh' }), subscribe: () => () => {} }
      return null
    },
  }
  let fetchCalls = 0
  globalThis.fetch = async (url, init) => {
    fetchCalls += 1
    const isPost = Boolean(init && init.method === 'POST')
    if (isPost) {
      const reply = typeof options.onPost === 'function' ? options.onPost(init) : { ok: true }
      return { status: 200, json: async () => reply }
    }
    const next = typeof options.payloadFor === 'function' ? options.payloadFor(fetchCalls, body) : body
    return { status: 200, json: async () => next }
  }
  const mod = manifest.factory((name) => (name === 'react' ? React : {}))
  mod.apply(ctx)
  const panel = registered.find((r) => r.def && r.def.key === 'envdock')
  if (!panel) throw new Error('client.js 没有注册 main 面板(key=envdock)')
  let tree = null
  // 渲染 → 跑 effect(fetch 在 effect 里,cleanup 也在这里登记)→ 等数据落地 → 再渲染
  const settle = async () => {
    for (let i = 0; i < 80; i += 1) {
      cursor = 0
      dirty = false
      effectQueue = []
      renderCount += 1
      tree = panel.comp()
      for (const effect of effectQueue) {
        if (typeof cleanups[effect.index] === 'function') cleanups[effect.index]()
        const ret = effect.fn()
        cleanups[effect.index] = typeof ret === 'function' ? ret : null
      }
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
    // 点击某个 class 的节点(替身没有事件系统,直接调 props.onClick 再渲染一轮)
    async click(className, index = 0) {
      const nodes = findAllByClass(tree, className)
      const target = nodes[index]
      if (!target) throw new Error('找不到可点的 .' + className)
      if (typeof target.props.onClick !== 'function') throw new Error('.' + className + ' 没有 onClick')
      await target.props.onClick()
      return settle()
    },
    // 卸载:执行所有 effect cleanup(轮询定时器、mounted 标记)
    unmount() {
      for (const fn of cleanups) {
        if (typeof fn === 'function') fn()
      }
      cleanups = []
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
  scopes: [],
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
  commandTool: commandTool(),
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
const cssText = (tree) => {
  let out = ''
  walk(tree, (el) => {
    if (el.type === 'style') out += flattenText(el.children)
  })
  return out
}
const hasRule = (css, selector, declaration) => {
  const i = css.indexOf(selector + '{')
  if (i < 0) return false
  const block = css.slice(i, css.indexOf('}', i) + 1)
  return block.includes(declaration)
}

try {
  loadClient()
  console.log('ok   client.js 可加载(window.__ModuleLoader__)')
} catch (error) {
  console.log('FAIL client.js 可加载 → ' + (error && error.message))
  process.exit(1)
}

// ───────────────────────────────── 1) 混合会话:头部 1 个 badge + 卡片可视化 ──
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
check('1 混合:badge 文案含会话数且数字 === 载荷宿主会话数', Boolean(mixedWarn && mixedWarn.text.includes('个会话用宿主工具') && badgeNumber(mixedWarn) === MIXED_HOST_SCOPES.length), 'expect ' + MIXED_HOST_SCOPES.length + ' ' + emoji(mixedBadges))
check('1 混合:badge title 不出现孤立的「模型可见」', Boolean(mixedWarn && !String(mixedWarn.title || '').includes('模型可见')), 'title=' + JSON.stringify(mixedWarn && mixedWarn.title))
const headline = findOneByClass(mixed.tree, 'envd-headline')
check('1 混合:headline 只留终端名+版本(状态词只在 badge/卡片)', Boolean(headline && textOf(headline) === 'PowerShell v7.4.0'), headline ? textOf(headline) : '(missing)')
check('1 混合:接管卡片存在', Boolean(findOneByClass(mixed.tree, 'envd-card')))
check('1 混合:逐会话行数 === scopes 长度(含 takeover)', rowCount(mixed.tree) === MIXED_SCOPES.length, 'rows=' + rowCount(mixed.tree))
const rowTexts = findAllByClass(mixed.tree, 'envd-srow').map(textOf)
check('1 混合:takeover 行标为「直连接管」', rowTexts.some((text) => text.includes(id8(TAKEOVER_ID)) && text.includes('直连接管')), JSON.stringify(rowTexts))
check('1 混合:非 takeover 行带实际工具名', rowTexts.some((text) => text.includes(id8(YIELD_ID)) && text.includes(YIELD.tool)), JSON.stringify(rowTexts))
const mixedShellChips = shellChips(mixed.tree)
check('1 混合:已识别宿主命令工具 chips 数量 === 载荷数量', mixedShellChips.length === SHELL_TOOLS.length, 'chips=' + mixedShellChips.length)
check('1 混合:chips 带完整 title(截断时可读)', mixedShellChips.every((chip, i) => String(chip.props.title || '').includes(SHELL_TOOLS[i].name)), JSON.stringify(mixedShellChips.map((c) => c.props.title)))
const execNode = findOneByClass(mixed.tree, 'envd-exec')
check('1 混合:显示执行器族 + 平台默认(无硬编码中文)', Boolean(execNode && textOf(execNode).includes('powershell') && /\(|（/.test(textOf(execNode))), execNode ? textOf(execNode) : '(missing)')
check('1 混合:状态 chip 是 warn 色', Boolean(findWithClasses(mixed.tree, 'envd-statuschip', 'warn')), JSON.stringify(findAllByClass(mixed.tree, 'envd-statuschip').map((el) => el.props.className)))
const statusLines = findAllByClass(mixed.tree, 'envd-statusline')
const statusLineNode = statusLines.find((el) => findAllByClass(el, 'envd-statuschip').length > 0)
const lineLabels = statusLineNode ? findAllByClass(statusLineNode, 'envd-mini-label').length : 0
const lineChipGroups = statusLineNode ? findAllByClass(statusLineNode, 'envd-chips-sm').length : 0
check('1 混合:每个 chips 组都有可见标签(接管模式/沙箱下接管)', lineChipGroups > 0 && lineLabels === lineChipGroups, 'labels=' + lineLabels + ' groups=' + lineChipGroups)
check('1 混合:接管模式 + 沙箱下接管 chips 都在', findAllByClass(mixed.tree, 'envd-chips-sm').length === 2, 'sm=' + findAllByClass(mixed.tree, 'envd-chips-sm').length)

// ───────────────────────────────── 2) 数字不能来自 sandboxHiddenScopes ──
const MISMATCH_SCOPES = [YIELD]
const mismatch = await mountPanel(payload({ syncStats: syncStats({ hostOnlyScopes: [], sandboxHiddenScopes: 5 }), commandTool: commandTool({ scopes: MISMATCH_SCOPES }) }))
const mismatchBadge = headerBadges(mismatch.tree).find((b) => /\bwarn\b/.test(b.cls))
check('2 stats 不一致:数字来自 scopes(1),不来自 sandboxHiddenScopes(5)', Boolean(mismatchBadge && badgeNumber(mismatchBadge) === MISMATCH_SCOPES.length), 'expect ' + MISMATCH_SCOPES.length + ' ' + emoji(headerBadges(mismatch.tree)))
check('2 stats 不一致:会话行数 === scopes 长度', rowCount(mismatch.tree) === MISMATCH_SCOPES.length, 'rows=' + rowCount(mismatch.tree))

// ───────────────────────────────── 3) 纯 takeover + 故意给 sandboxHiddenScopes=2 ──
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
check('3 纯接管:无围栏会话/能力位时不显示沙箱接管 chips', findAllByClass(pure.tree, 'envd-chips-sm').length === 1, 'sm=' + findAllByClass(pure.tree, 'envd-chips-sm').length)
check('3 纯接管:状态 chip 是 ok 色', Boolean(findWithClasses(pure.tree, 'envd-statuschip', 'ok')), JSON.stringify(findAllByClass(pure.tree, 'envd-statuschip').map((el) => el.props.className)))

// ───────────────────────────────── 4) 异常会话:四类 + 正常会话不被算进去 ──
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
check('4 异常:数字 === 载荷异常会话数(不是 scopes 总数)', Boolean(anomalyBadge && badgeNumber(anomalyBadge) === EXPECTED_BAD.length), 'expect ' + EXPECTED_BAD.length + ' ' + emoji(headerBadges(anomalies.tree)))
check('4 异常:逐会话行全部列出', rowCount(anomalies.tree) === BAD_SCOPES.length, 'rows=' + rowCount(anomalies.tree))
check('4 异常:异常行染红且只红 N 行', badRows(anomalies.tree).length === EXPECTED_BAD.length, 'badRows=' + badRows(anomalies.tree).length)
check('4 异常:异常行尾给原因', badRows(anomalies.tree).every((el) => textOf(el).includes('⚠')), JSON.stringify(badRows(anomalies.tree).map(textOf)))
check('4 异常:诊断自动展开', Boolean(findOneByClass(anomalies.tree, 'envd-diag-detail')))
check('4 异常:诊断摘要红字(danger)', Boolean(findWithClasses(anomalies.tree, 'envd-diag-sum', 'danger')))
check('4 异常:诊断详情里有 error 红条目', findAllByClass(anomalies.tree, 'envd-diag-detail').some((el) => findAllByClass(el, 'e').length > 0))
check('4 异常:正常会话没有被染红', findAllByClass(anomalies.tree, 'envd-srow').some((el) => textOf(el).includes(id8(NORMAL_HOST_ID)) && !classTokens(el).includes('bad')), JSON.stringify(findAllByClass(anomalies.tree, 'envd-srow').map(textOf)))

// ───────────────────────────────── 5) 异常会话优先进入可见的 5 行 ──
// 故意把正常会话放在前面:不排序的话前 5 行会全是正常会话,异常就被「还有 N 个」藏了
const MANY = []
for (let i = 0; i < 4; i += 1) MANY.push(scopeFact({ id: 'ok' + i + 'bbbbbbbbbb', kind: 'takeover', tool: 'envd_shell', ownVisible: true }))
for (let i = 0; i < 6; i += 1) MANY.push(scopeFact({ id: 'bad' + i + 'aaaaaaaaaa', kind: 'host', tool: null, hostTool: null }))
const ANOMALIES_IN_MANY = 6
const many = await mountPanel(payload({ syncStats: syncStats({}), commandTool: commandTool({ scopes: MANY }) }))
check('5 异常优先:默认 5 行全是异常行', badRows(many.tree).length === 5 && rowCount(many.tree) === 5, 'rows=' + rowCount(many.tree) + ' bad=' + badRows(many.tree).length)
const moreButton = findOneByClass(many.tree, 'envd-morebtn')
const hiddenAnomalies = ANOMALIES_IN_MANY - 5
check('5 异常优先:「还有 N 个(A 个异常)」数字由载荷推导', Boolean(moreButton && textOf(moreButton).includes(String(MANY.length - 5)) && textOf(moreButton).includes(String(hiddenAnomalies))), moreButton ? textOf(moreButton) : '(missing)')
await many.click('envd-morebtn')
check('5 异常优先:展开后行数 === scopes 长度', rowCount(many.tree) === MANY.length, 'rows=' + rowCount(many.tree))

// ───────────────────────────────── 6) 健康:诊断默认折叠、摘要非空、不染红 ──
const healthy = await mountPanel(mixedPayload)
check('6 健康:诊断默认折叠(无 detail)', !findOneByClass(healthy.tree, 'envd-diag-detail'))
check('6 健康:诊断摘要不是红字', !findWithClasses(healthy.tree, 'envd-diag-sum', 'danger'))
const healthySummary = findOneByClass(healthy.tree, 'envd-diag-sum')
check('6 健康:诊断摘要非空(不许红着却空白)', Boolean(healthySummary && textOf(healthySummary).length > 0), healthySummary ? textOf(healthySummary) : '(missing)')
check('6 健康:健康检查整节不出现(无 issues)', !findOneByClass(healthy.tree, 'envd-fold-health'))
check('6 健康:没有异常会话行', badRows(healthy.tree).length === 0)

// ───────────────────────────────── 7) 旧版 API(没有 scopes 字段) ──
const legacyPayload = payload({ syncStats: syncStats({ hostOnlyScopes: [YIELD_ID], sandboxHiddenScopes: 2 }), commandTool: commandTool() })
delete legacyPayload.commandTool.scopes
const legacy = await mountPanel(legacyPayload)
const legacyBadges = headerBadges(legacy.tree)
const legacyCount = 1 + 2 // hostOnlyScopes.length + sandboxHiddenScopes
check('7 旧版:badge 仍是汇总(不报「模型可见」)', legacyBadges.length === 1 && /\bwarn\b/.test(legacyBadges[0].cls) && !legacyBadges[0].text.includes('模型可见'), emoji(legacyBadges))
check('7 旧版:计数取两者之和且文案是「约 N 个」', Boolean(legacyBadges[0] && badgeNumber(legacyBadges[0]) === legacyCount && legacyBadges[0].text.includes('约')), 'expect ' + legacyCount + ' ' + emoji(legacyBadges))
check('7 旧版:title 注明旧版汇总计数', String(legacyBadges[0].title || '').includes(String(legacyCount)) && String(legacyBadges[0].title || '').includes('旧版'), 'title=' + JSON.stringify(legacyBadges[0].title))
check('7 旧版:卡片注明「旧版构建」', Boolean(findOneByClass(legacy.tree, 'envd-legacy')))
check('7 旧版:fallback 会话按 id 列出', findAllByClass(legacy.tree, 'envd-srow').some((el) => textOf(el).includes(id8(YIELD_ID))), JSON.stringify(findAllByClass(legacy.tree, 'envd-srow').map(textOf)))
const legacyStatus = findOneByClass(legacy.tree, 'envd-statuschip')
check('7 旧版:状态词按 fallback 走(不是「接管中」)', Boolean(legacyStatus && !textOf(legacyStatus).includes('接管中')), legacyStatus ? textOf(legacyStatus) : '(missing)')

// ───────────────────────────────── 8) 新构建 scopes:[](零会话) ──
const emptyScopes = await mountPanel(payload({ syncStats: syncStats({}), commandTool: commandTool({ scopes: [] }) }))
const emptyBadges = headerBadges(emptyScopes.tree)
check('8 零会话:头部 ok「模型可见」(工具注册了,只是还没有会话)', emptyBadges.length === 1 && /\bok\b/.test(emptyBadges[0].cls) && emptyBadges[0].text === '模型可见', emoji(emptyBadges))
check('8 零会话:提示「当前无会话」而不是「旧版构建」', !allText(emptyScopes.tree).includes('旧版构建') && allText(emptyScopes.tree).includes('当前无会话'), '')
check('8 零会话:title 不含旧版说明', !String(emptyBadges[0].title || '').includes('旧版构建'))

// ───────────────────────────────── 9) 全部会话都未接管(host):灰「未接管」,不挂黄 ──
const HOST_ONLY = [
  scopeFact({ id: 'h1aaaaaaaaaaaa', kind: 'host', tool: 'ops_bash', hostTool: 'ops_bash', hostTools: ['ops_bash'] }),
  scopeFact({ id: 'h2bbbbbbbbbbbb', kind: 'host', tool: 'pwsh', hostTool: 'pwsh', hostTools: ['pwsh'] }),
]
const hostOnly = await mountPanel(payload({ syncStats: syncStats({}), commandTool: commandTool({ scopes: HOST_ONLY }) }))
const hostOnlyBadges = headerBadges(hostOnly.tree)
check('9 全未接管:头部灰「未接管」而不是黄色汇总', hostOnlyBadges.length === 1 && /\bmuted\b/.test(hostOnlyBadges[0].cls) && !/\bwarn\b/.test(hostOnlyBadges[0].cls), emoji(hostOnlyBadges))
check('9 全未接管:状态 chip 也是未接管色', Boolean(findWithClasses(hostOnly.tree, 'envd-statuschip', 'muted')), JSON.stringify(findAllByClass(hostOnly.tree, 'envd-statuschip').map((el) => el.props.className)))
// 混合(部分 host + 部分 takeover)才挂黄色汇总 —— 这是「未接管」和「混合」的分界
const MIXED_KIND = [HOST_ONLY[0], TAKEOVER]
const mixedKinds = await mountPanel(payload({ syncStats: syncStats({}), commandTool: commandTool({ scopes: MIXED_KIND }) }))
const mixedKindBadges = headerBadges(mixedKinds.tree)
check('9 混合(host + takeover):挂黄色汇总且数字 === host 会话数', mixedKindBadges.length === 1 && /\bwarn\b/.test(mixedKindBadges[0].cls) && badgeNumber(mixedKindBadges[0]) === 1, emoji(mixedKindBadges))

// ───────────────────────────────── 9b) i18n 文案细节(静态检查) ──
// 用 String.raw 才能在测试源码里精确表达「文件里是两个反斜杠」的字面量
const DICT_PATH_EXAMPLE = String.raw`C:\\tools\\rg.exe`
const pathExampleCount = SOURCE.split(DICT_PATH_EXAMPLE).length - 1
check('9b 文案:自定义路径示例是单反斜杠(中英各一处)', pathExampleCount === 2, 'occurrences=' + pathExampleCount)
check('9b 文案:英文里没有硬编码「平台默认」', !EN_BLOCK.includes('平台默认'))

// ───────────────────────────────── 10) 诊断只有 warn 级:自动展开但摘要非空、不染红;三态切换不假死 ──
const warnOnly = await mountPanel(payload({ syncStats: syncStats({ unrestrictable: ['bash'] }), commandTool: commandTool({ scopes: [TAKEOVER] }) }))
const warnOnlySummary = findOneByClass(warnOnly.tree, 'envd-diag-sum')
check('10 warn 级诊断:自动展开', Boolean(findOneByClass(warnOnly.tree, 'envd-diag-detail')))
check('10 warn 级诊断:摘要非空且不是红字', Boolean(warnOnlySummary && textOf(warnOnlySummary).length > 0) && !findWithClasses(warnOnly.tree, 'envd-diag-sum', 'danger'), warnOnlySummary ? textOf(warnOnlySummary) : '(missing)')
await warnOnly.click('envd-diagtoggle')
check('10 warn 级诊断:点「收起」真的收起(不假死)', !findOneByClass(warnOnly.tree, 'envd-diag-detail'))
await warnOnly.click('envd-diagtoggle')
check('10 warn 级诊断:再点又能展开', Boolean(findOneByClass(warnOnly.tree, 'envd-diag-detail')))

// ───────────────────────────────── 11) reuse(由其它插件提供) ──
const reuse = await mountPanel(payload({ commandTool: commandTool({ reuse: true, takeover: false, name: 'other_shell' }) }))
const reuseBadges = headerBadges(reuse.tree)
check(
  '11 reuse:头部灰「由其它插件提供」,不报「模型可见」',
  reuseBadges.length === 1 && /\bmuted\b/.test(reuseBadges[0].cls) && !reuseBadges[0].text.includes('模型可见') && reuseBadges[0].text.includes('其它插件'),
  emoji(reuseBadges),
)

// ───────────────────────────────── 12) denies / 沙箱下不可见 ──
const denied = await mountPanel(payload({ commandTool: commandTool({ visible: false, sandbox: false, denies: ['bash', 'pwsh'] }) }))
const deniedBadges = headerBadges(denied.tree)
check('12 denies:bad「不可见」且 title 点名被挡的工具', deniedBadges.length === 1 && /\bbad\b/.test(deniedBadges[0].cls) && String(deniedBadges[0].title || '').includes('bash') && String(deniedBadges[0].title || '').includes('pwsh'), emoji(deniedBadges) + ' title=' + JSON.stringify(deniedBadges[0] && deniedBadges[0].title))
const sandboxed = await mountPanel(payload({ commandTool: commandTool({ visible: false, sandbox: true, sandboxConfined: true }) }))
const sandboxedBadges = headerBadges(sandboxed.tree)
check('12 沙箱:可见=false 时挂灰「沙箱」而不是红色不可见', sandboxedBadges.length === 1 && /\bmuted\b/.test(sandboxedBadges[0].cls) && !/\bbad\b/.test(sandboxedBadges[0].cls), emoji(sandboxedBadges))

// ───────────────────────────────── 13) 沙箱策略未知:诊断里有这条,展开可见 ──
const policyUnknown = await mountPanel(
  payload({
    syncStats: syncStats({}),
    sandbox: { capable: true, defaultMode: 'workspace-write', policyKnown: false, delegate: false, scopes: [] },
    commandTool: commandTool({ sandboxConfined: null, scopes: [] }),
  }),
)
await policyUnknown.click('envd-diagtoggle')
const policyDetail = findOneByClass(policyUnknown.tree, 'envd-diag-detail')
check('13 policyKnown=false:展开诊断能看到「策略未知」条目', Boolean(policyDetail && textOf(policyDetail).length > 0 && findAllByClass(policyDetail, 'w').length > 0), policyDetail ? textOf(policyDetail) : '(missing)')

// ───────────────────────────────── 14) 版本管理器行 ──
const MANAGERS = [
  { key: 'fnm', label: 'fnm', command: 'C:\\fnm\\fnm.exe', versions: [{ name: 'v20.19.0', active: true }], active: 'v20.19.0', listed: true },
  { key: 'pyenv', label: 'pyenv', command: 'C:\\pyenv\\pyenv.bat', versions: [], listed: false },
]
const managersPanel = await mountPanel(payload({ versionManagers: MANAGERS }))
check('14 版本管理器:行数 === 载荷数量', findAllByClass(managersPanel.tree, 'envd-manager').length === MANAGERS.length, 'managers=' + findAllByClass(managersPanel.tree, 'envd-manager').length)
check('14 版本管理器:工具链标题计数带上管理器数量', allText(managersPanel.tree).includes(String(MANAGERS.length)), '')

// ───────────────────────────────── 15) POST 失败(opError)可见 ──
const opFailed = await mountPanel(mixedPayload, { onPost: () => ({ ok: false, error: 'boom' }) })
await opFailed.click('envd-chip')
const opErrNode = findOneByClass(opFailed.tree, 'envd-err')
check('15 opError:操作失败给出可见错误框', Boolean(opErrNode && textOf(opErrNode).includes('boom')), opErrNode ? textOf(opErrNode) : '(missing)')

// ───────────────────────────────── 16) 英文界面不出现中文 ──
const enPanel = await mountPanel(mixedPayload, { locale: 'en' })
const titleAttrs = []
walk(enPanel.tree, (el) => {
  if (el.props && typeof el.props.title === 'string') titleAttrs.push(el.props.title)
})
const enText = visibleText(enPanel.tree) + '\n' + titleAttrs.join('\n')
check('16 en:渲染文本与 title 里都没有中文', !/[\u4e00-\u9fa5]/.test(enText), /[\u4e00-\u9fa5]+/.exec(enText) ? 'leak=' + /[\u4e00-\u9fa5]+/.exec(enText)[0] : '')
check('16 en:词典里没有中文', !/[\u4e00-\u9fa5]/.test(EN_BLOCK), /[\u4e00-\u9fa5]+/.exec(EN_BLOCK) ? 'leak=' + /[\u4e00-\u9fa5]+/.exec(EN_BLOCK)[0] : '')
check('16 en:badge / 卡片仍然渲染', headerBadges(enPanel.tree).length === 1 && Boolean(findOneByClass(enPanel.tree, 'envd-card')))

// ───────────────────────────────── 17) 长名字溢出防护(结构 + CSS 规则) ──
const LONG_NAME = 'tenant_' + 'x'.repeat(80) + '_bash'
const longPanel = await mountPanel(
  payload({
    shell: { key: 'pwsh', label: 'PowerShell ' + 'y'.repeat(60), family: 'pwsh', path: 'C:\\very\\long\\pwsh.exe', version: '7.4.0' },
    syncStats: syncStats({ runtimeShellTools: [{ name: LONG_NAME, family: 'bash', learned: false }] }),
    commandTool: commandTool({ scopes: [TAKEOVER] }),
  }),
)
const longChip = shellChips(longPanel.tree)[0]
check('17 长名字:chip 的 title 保留完整名字', Boolean(longChip && String(longChip.props.title || '').includes(LONG_NAME)))
const css = cssText(longPanel.tree)
check('17 溢出 CSS:headline 用 ellipsis', hasRule(css, '.envd-headline', 'text-overflow:ellipsis'))
check('17 溢出 CSS:错误框允许 anywhere 换行', hasRule(css, '.envd-err', 'overflow-wrap:anywhere'))
check('17 溢出 CSS:命令工具 chip 有 max-width', hasRule(css, '.envd-shellchip', 'max-width:100%'))
check('17 溢出 CSS:会话行原因允许收缩+ellipsis', hasRule(css, '.envd-sreason', 'overflow:hidden'))
check('17 溢出 CSS:badge 允许收缩', hasRule(css, '.envd-badge', 'max-width:100%'))

// ───────────────────────────────── 18) 复制失败可见(http 局域网) ──
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

const noClipboard = await mountPanel(payload({ tools: [TOOL] }))
await noClipboard.click('envd-pathbtn')
const copyNote = findOneByClass(noClipboard.tree, 'envd-copy-note')
check('18 复制兜底:两条路都失败时给可见提示', Boolean(copyNote && textOf(copyNote).length > 0), copyNote ? textOf(copyNote) : '(missing)')
check('18 复制兜底:提示区是 aria-live 状态区', Boolean(copyNote && copyNote.props['aria-live'] === 'polite' && copyNote.props.role === 'status'))

// ───────────────────────────────── 19) 复制兜底:没有 clipboard API 时用 execCommand ──
const execCalls = []
const realDocument = globalThis.document
globalThis.document = {
  createElement: () => ({ setAttribute() {}, select() {}, style: {}, value: '' }),
  body: { appendChild() {}, removeChild() {} },
  execCommand: (cmd) => {
    execCalls.push(cmd)
    return true
  },
}
try {
  const copied = await mountPanel(payload({ tools: [TOOL] }))
  await copied.click('envd-pathbtn')
  check('19 execCommand 兜底:真的调用了 copy', execCalls.length === 1 && execCalls[0] === 'copy', JSON.stringify(execCalls))
  const pathBtn = findOneByClass(copied.tree, 'envd-pathbtn')
  check('19 execCommand 兜底:成功后有 ✓ 已复制反馈', Boolean(pathBtn && textOf(pathBtn).startsWith('✓')), pathBtn ? textOf(pathBtn) : '(missing)')
} finally {
  if (realDocument === undefined) delete globalThis.document
  else globalThis.document = realDocument
}

// ───────────────────────────────── 20) 工具链精简 + 折叠 + 底部开关 ──
const toolsPanel = await mountPanel(payload({ tools: [TOOL], issues: [{ level: 'warn', title: 'stale path', detail: 'C:\\gone' }] }))
const pathButtons = findAllByClass(toolsPanel.tree, 'envd-pathbtn')
check('20 工具:路径是可点击按钮(无独立复制按钮)', pathButtons.length === 1 && textOf(pathButtons[0]) === TOOL.defaultPath, JSON.stringify(pathButtons.map(textOf)))
check('20 工具:多版本默认折叠', findAllByClass(toolsPanel.tree, 'envd-vrow').length === 0)
await toolsPanel.click('envd-versionchip')
check('20 工具:点版本 chip 后候选数 === versions 长度', findAllByClass(toolsPanel.tree, 'envd-vrow').length === TOOL.versions.length, 'vrows=' + findAllByClass(toolsPanel.tree, 'envd-vrow').length)
check('20 健康检查:默认折叠(有问题也只一行)', !findOneByClass(toolsPanel.tree, 'envd-issues') && Boolean(findOneByClass(toolsPanel.tree, 'envd-fold-health')))
await toolsPanel.click('envd-fold-health')
check('20 健康检查:点开后条数 === issues 长度', findAllByClass(toolsPanel.tree, 'envd-issue').length === 1)
check('20 简报:默认折叠', !findOneByClass(toolsPanel.tree, 'envd-pre'))
await toolsPanel.click('envd-fold-brief')
check('20 简报:点开后出现正文', Boolean(findOneByClass(toolsPanel.tree, 'envd-pre')))
check('20 底部:有数据时两个开关(简报注入 + 允许局域网)', findAllByClass(toolsPanel.tree, 'envd-switch').length === 2, 'switches=' + findAllByClass(toolsPanel.tree, 'envd-switch').length)

// ───────────────────────────────── 21) 15s 轮询 + 去重剔除易变字段 + 卸载清定时器 ──
const intervals = []
const cleared = []
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
globalThis.setInterval = (fn, ms) => {
  intervals.push({ fn, ms })
  return intervals.length
}
globalThis.clearInterval = (id) => {
  cleared.push(id)
}
const realDocumentForPoll = globalThis.document
globalThis.document = { visibilityState: 'hidden' }
try {
  const base = payload({ syncStats: syncStats({}), commandTool: commandTool({ scopes: [TAKEOVER] }) })
  const cloneOf = (value) => JSON.parse(JSON.stringify(value))
  const polled = await mountPanel(base, {
    payloadFor: (callIndex) => {
      if (callIndex <= 2) return cloneOf(base)
      const next = cloneOf(base)
      if (callIndex === 3) {
        // 只有易变计数变了(宿主每 tick 都会推进):不许触发重渲染
        next.syncStats.ticks += 1
        next.syncStats.steadyTicks += 1
        next.syncStats.lastErrorAt += 1
        return next
      }
      next.syncStats.registers = 99
      return next
    },
  })
  check('21 轮询:挂载时只拉 1 次', polled.fetchCalls() === 1, 'fetch=' + polled.fetchCalls())
  check('21 轮询:注册 15s 定时器', intervals.length === 1 && intervals[0].ms === 15000, JSON.stringify(intervals.map((i) => i.ms)))
  intervals[0].fn()
  await new Promise((r) => setTimeout(r, 12))
  check('21 轮询:页面隐藏时不拉', polled.fetchCalls() === 1, 'fetch=' + polled.fetchCalls())
  globalThis.document = { visibilityState: 'visible' }
  intervals[0].fn()
  await new Promise((r) => setTimeout(r, 12))
  check('21 轮询:可见时才拉', polled.fetchCalls() === 2, 'fetch=' + polled.fetchCalls())
  check('21 轮询:payload 未变不重渲染', polled.isDirty() === false, 'dirty=' + polled.isDirty())
  intervals[0].fn()
  await new Promise((r) => setTimeout(r, 12))
  check('21 轮询:只有易变计数变化时不重渲染(去重剔除 ticks/steadyTicks/lastErrorAt)', polled.fetchCalls() === 3 && polled.isDirty() === false, 'fetch=' + polled.fetchCalls() + ' dirty=' + polled.isDirty())
  intervals[0].fn()
  await new Promise((r) => setTimeout(r, 12))
  check('21 轮询:实质变化才更新', polled.isDirty() === true, 'dirty=' + polled.isDirty())
  await polled.settle()
  polled.unmount()
  check('21 轮询:卸载时清掉定时器', cleared.length === 1 && cleared[0] === 1, JSON.stringify(cleared))
} finally {
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
  if (realDocumentForPoll === undefined) delete globalThis.document
  else globalThis.document = realDocumentForPoll
}

// ───────────────────────────────── 22) 读不到数据(403):不崩、底部只留 allowLan、无假开关 ──
const noData = await mountPanel({ ok: false, error: 'HTTP 403' })
check('22 无数据:显示错误框', Boolean(findOneByClass(noData.tree, 'envd-err')))
check('22 无数据:不渲染接管卡片', !findOneByClass(noData.tree, 'envd-card'))
check('22 无数据:底部只剩 allowLan 一个开关(不显示假的简报开关)', findAllByClass(noData.tree, 'envd-switch').length === 1, 'switches=' + findAllByClass(noData.tree, 'envd-switch').length)
check('22 无数据:头部没有状态 badge', headerBadges(noData.tree).length === 0)

console.log(failed === 0 ? '\nall panel-render cases passed' : '\n' + failed + ' case(s) failed')
process.exit(failed === 0 ? 0 : 1)
