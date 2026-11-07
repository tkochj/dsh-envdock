/**
 * EnvDock 面板渲染回归测试。
 *
 * client.js 是浏览器脚本(`window.__ModuleLoader__.load`),不能在 Node 里 import;
 * 但它渲染出来的东西完全由 /envdock-api 的 JSON 决定 —— 所以这里用一套极简 React
 * 运行时替身(useState/useEffect/useMemo/useCallback/useRef)+ 桩 slots/locale/fetch,
 * 把 client.js 真跑起来,捕获 EnvDockPanel 的真实渲染树,再遍历头部 .envd-badge 断言。
 *
 * 为什么要锁住这件事:commandTool.visible 只说明「EnvDock 的 envd_shell 此刻在工具表里」,
 * 不说明每个会话里模型拿到的是谁。hostOnlyScopes 非空的会话里模型用的是宿主工具,
 * 头部还单挂一个「模型可见」就是在说谎 —— P0-1 的验收要求就是这个不再发生。
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
  disposes: 1,
  denyApplies: 2,
  steadyTicks: 9,
  unrestrictable: [],
  blockedScopes: [],
  hostOnlyScopes: [],
  lastError: '',
  delegateCalls: 0,
  guardDenials: 0,
  yieldTicks: 0,
  sandboxHiddenScopes: 0,
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

// 固定 id:断言直接按前 8 位写死,失败时能一眼看出是哪个会话
const YIELD_ID = 'aaaa1111bbbbcccc'
const SANDBOX_ID = 'cccc2222dddd0000'
const TAKEOVER_ID = 'eeee3333ffff9999'
const SCOPE = {
  yield: { id: YIELD_ID, kind: 'yield', tool: 'ops_bash', visible: true, hidden: [], hidesOwn: true, confined: false, mode: null },
  sandbox: { id: SANDBOX_ID, kind: 'sandbox-host', tool: 'ops_bash', visible: true, hidden: [], hidesOwn: true, confined: true, mode: 'workspace-write' },
  takeover: { id: TAKEOVER_ID, kind: 'takeover', tool: 'envd_shell', visible: true, hidden: ['bash'], hidesOwn: false, confined: false, mode: null },
}

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

const textsOf = (badges) => badges.map((b) => b.text)
const describe = (badges, extra) => 'badges=' + JSON.stringify(badges.map((b) => b.cls + ' | ' + b.text)) + (extra ? ' ' + extra : '')
const titleOf = (badges) => (badges[0] && badges[0].title) || ''

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

// ── a. 混合会话:visible=true + scopes 三个 kind 各一 + hostOnlyScopes 非空 ──
// 这一条就是 P0-1 的验收:头部不能再单报「模型可见」,必须按会话汇总。
const mixed = await headerBadges(
  payload({
    syncStats: syncStats({ hostOnlyScopes: [YIELD_ID], sandboxHiddenScopes: 2, delegateCalls: 3, guardDenials: 2, yieldTicks: 7 }),
    commandTool: commandTool({ scopes: [SCOPE.yield, SCOPE.sandbox, SCOPE.takeover] }),
  }),
  'a 混合会话',
)
const mixedTitle = titleOf(mixed)
const mixedWarn = mixed.find((b) => /\bwarn\b/.test(b.cls))
check('a 混合会话:头部恰 1 个 badge', mixed.length === 1, describe(mixed))
check(
  'a 混合会话:是 warn 汇总 badge「2 个会话用宿主工具」',
  Boolean(mixedWarn && mixedWarn.text === '2 个会话用宿主工具'),
  describe(mixed),
)
check('a 混合会话:没有任何 badge 含「模型可见」', !textsOf(mixed).some((text) => text.includes('模型可见')), describe(mixed))
check(
  'a 混合会话:title 含逐会话明细(id 前 8 位 + kind 标签 + 工具名)',
  mixedTitle.includes('aaaa1111') && mixedTitle.includes('让路') && mixedTitle.includes('ops_bash') && mixedTitle.includes('cccc2222') && mixedTitle.includes('沙箱让路'),
  'title=' + JSON.stringify(mixedTitle),
)
check(
  'a 混合会话:title 含三个计数(委托/守卫拒绝/让路轮次)',
  mixedTitle.includes('委托 3') && mixedTitle.includes('守卫拒绝 2') && mixedTitle.includes('让路轮次 7'),
  'title=' + JSON.stringify(mixedTitle),
)
check('a 混合会话:takeover 会话不混进汇总', !mixedTitle.includes('eeee3333'), 'title=' + JSON.stringify(mixedTitle))

// ── b. 纯 takeover:模型全走 envd_shell,保持原来的 ok「模型可见」 ──
const pure = await headerBadges(payload({ syncStats: syncStats({}), commandTool: commandTool({ scopes: [SCOPE.takeover] }) }), 'b 纯接管')
check('b 纯接管:恰 1 个 ok badge「模型可见」', pure.length === 1 && /\bok\b/.test(pure[0].cls) && pure[0].text === '模型可见', describe(pure))
check('b 纯接管:没有 warn 汇总 badge', !pure.some((b) => /\bwarn\b/.test(b.cls)), describe(pure))

// ── c. 旧 API 兼容:没有 commandTool.scopes,但 hostOnlyScopes / sandboxHiddenScopes 还在 ──
// 面板必须用保留字段兜底:否则 scopes 还没上线的窗口期,头部又会变回孤立的「模型可见」。
const legacy = await headerBadges(
  payload({ syncStats: syncStats({ hostOnlyScopes: [YIELD_ID], sandboxHiddenScopes: 2 }), commandTool: commandTool({}) }),
  'c 旧 API',
)
const legacyWarn = legacy.find((b) => /\bwarn\b/.test(b.cls))
check('c 旧 API:仍出现汇总 badge', Boolean(legacyWarn && legacyWarn.text.includes('个会话用宿主工具')), describe(legacy))
check('c 旧 API:没有孤立的「模型可见」', !textsOf(legacy).some((text) => text.includes('模型可见')), describe(legacy))
check('c 旧 API:计数按 sandboxHiddenScopes 补齐(2)', Boolean(legacyWarn && legacyWarn.text === '2 个会话用宿主工具'), describe(legacy))
check('c 旧 API:title 仍能列出 hostOnly 会话', titleOf(legacy).includes('aaaa1111'), 'title=' + JSON.stringify(titleOf(legacy)))

// ── d. 全局不可见:envd_shell 不在工具表里 —— 保持 bad「不可见」,不该有汇总 ──
// sandbox:false 是必须的:沙箱会话里可见性走另一条展示路径,bad badge 本来就不挂。
const invisible = await headerBadges(payload({ commandTool: commandTool({ visible: false, sandbox: false, scopes: [] }) }), 'd 全局不可见')
check('d 全局不可见:恰 1 个 bad「不可见」badge', invisible.length === 1 && /\bbad\b/.test(invisible[0].cls) && invisible[0].text.includes('不可见'), describe(invisible))
check('d 全局不可见:没有汇总 badge', !invisible.some((b) => /\bwarn\b/.test(b.cls) || b.text.includes('个会话用宿主工具')), describe(invisible))
check('d 全局不可见:不出现「模型可见」', !textsOf(invisible).some((text) => text.includes('模型可见')), describe(invisible))

console.log(failed === 0 ? '\nall panel-render cases passed' : '\n' + failed + ' case(s) failed')
process.exit(failed === 0 ? 0 : 1)
