/**
 * EnvDock 面板渲染回归测试(简洁一屏 / 接管可视化 / 22 组回归)。
 *
 * client.js 是浏览器脚本(`window.__ModuleLoader__.load`),不能在 Node 里 import;
 * 但它渲染出来的东西完全由 /envdock-api 的 JSON 决定 —— 所以这里用一套极简 React
 * 运行时替身(useState/useEffect/useMemo/useCallback/useRef)+ 桩 slots/locale/fetch,
 * 把 client.js 真跑起来,捕获 EnvDockPanel 的真实渲染树再按 class 断言。
 *
 * 2026-11 面板重做后的 DOM(冻结版):
 *   头部  .envd-head > .envd-h1 / .envd-headline / .envd-badge(唯一胶囊) / .envd-btn.primary
 *   接管卡 .envd-card
 *     .envd-row(终端 .envd-tag + .envd-chips > .envd-chip)
 *     .envd-row(命令 .envd-tag + .envd-statuschip + .envd-tool + .envd-sub
 *               + ghost 会话(仅 scopes 非空)/ 设置 / 详情)
 *     .envd-notes > .envd-note(.warn/.bad)
 *     设置区(默认收起,点「设置」才出现):两组 .envd-chips.envd-chips-sm
 *     .envd-sessions > .envd-srow(异常一定展开;.envd-sdot/.envd-sid/.envd-skind/.envd-stool/.envd-sreason)
 *     .envd-shelltools > .envd-shellchip(仅 scopes 数组或 runtimeShellTools 非空)
 *     .envd-diag-detail(点「详情」才出现;统计 + notes 的 .w/.e 条目)
 *   工具链 .envd-sec > .envd-sec-h(h2 + .n 尾注) / .envd-trow(.envd-tgroup/.envd-tname/.envd-tver/.envd-tpath/.envd-tact)
 *         多版本 .envd-vlist > .envd-vrow;管理器行多带 .envd-manager
 *         健康:健康时 .envd-flag.ok 一行,有问题 .envd-fold-health 折叠行 + .envd-issues > .envd-issue
 *   简报   .envd-sec > h2 环境简报,默认一行,展开 .envd-pre
 *   底部   .envd-foot > 两个 .envd-switch + .envd-copy-note(role=status) + .envd-footmeta
 *
 * 替身会保存并执行 effect cleanup,所以卸载路径(轮询定时器要清掉)也测得到。
 * 所有数字/文案都从载荷与 DICT 推导,不写死「2 个」「3 行」—— 把实现改成「读 stats 不读 scopes」
 * 或删掉异常排序/自动展开会直接失败,这是变异敏感的来源。
 *
 * 零依赖,Windows 上直接 `node test/panel-render.mjs` 可跑。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', 'client.js'), 'utf8')
// client.js 内联的词典块(静态检查用:英文界面不许出现中文)
const ZH_START = SOURCE.indexOf('      zh: {')
const ZH_BLOCK = SOURCE.slice(ZH_START, SOURCE.indexOf('\n      },', ZH_START))
const EN_START = SOURCE.indexOf('      en: {')
const EN_BLOCK = SOURCE.slice(EN_START, SOURCE.indexOf('\n      },', EN_START))

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

function findTag(node, tag) {
  let out = null
  walk(node, (el) => {
    if (!out && el.type === tag) out = el
  })
  return out
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

const isButton = (el) => Boolean(el && el.type === 'button' && typeof el.props.onClick === 'function')

function buttonsIn(node) {
  const out = []
  walk(node, (el) => {
    if (isButton(el)) out.push(el)
  })
  return out
}

// 按可见文案找按钮(测试替身没有事件系统,拿到节点直接调 onClick)
const buttonByText = (node, text) => buttonsIn(node).find((el) => textOf(el).includes(text)) || null

const hasClass = (cls, token) => String(cls || '').split(/\s+/).includes(token)

function classInventory(tree) {
  const set = new Set()
  walk(tree, (el) => classTokens(el).forEach((c) => set.add(c)))
  return [...set].sort().join(' ')
}

function describe(el) {
  if (!el) return '(missing)'
  const cls = typeof el.props.className === 'string' ? el.props.className.split(/\s+/).join('.') : String(el.type)
  const text = textOf(el).replace(/\s+/g, ' ')
  return (cls ? '.' + cls : String(el.type)) + '|' + (text.length > 90 ? text.slice(0, 90) + '…' : text)
}

const describeAll = (els) => (els.length ? els.map(describe).join(' ;; ') : '(none)')

// ───────────────────────────────── 卡片 / 分组导航 ──
const cardOf = (tree) => {
  const card = findOneByClass(tree, 'envd-card')
  if (!card) throw new Error('渲染树里找不到 .envd-card(接管卡结构变了?现有 class: ' + classInventory(tree) + ')')
  return card
}
// 终端行 = 0,命令行 = 1;设置区展开后追加两行(在命令行之后),所以命令行始终是 [1]
const cardRows = (tree) => findAllByClass(cardOf(tree), 'envd-row')
const cmdRow = (tree) => cardRows(tree)[1] || null
const cmdButton = (tree, label) => (cmdRow(tree) ? buttonByText(cmdRow(tree), label) : null)
const cardTags = (tree) => findAllByClass(cardOf(tree), 'envd-tag').map(textOf)

function sections(tree) {
  return findAllByClass(tree, 'envd-sec')
}
function sectionByTitle(tree, title) {
  const sec = sections(tree).find((s) => textOf(findTag(s, 'h2') || null) === title)
  if (!sec) throw new Error('找不到分组「' + title + '」(现有 h2: ' + sections(tree).map((s) => textOf(findTag(s, 'h2') || null)).join(' / ') + ')')
  return sec
}
const sectionTail = (sec) => findAllByClass(sec, 'n').map(textOf).filter(Boolean).join(' ')

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
    classes: () => classInventory(tree),
    // 点击某个 class 的节点(替身没有事件系统,直接调 props.onClick 再渲染一轮)
    async click(className, index = 0) {
      const nodes = findAllByClass(tree, className)
      const target = nodes[index]
      if (!target) throw new Error('找不到可点的 .' + className + '(现有 class: ' + classInventory(tree) + ')')
      if (typeof target.props.onClick !== 'function') throw new Error('.' + className + ' 没有 onClick')
      await target.props.onClick()
      return settle()
    },
    // 点任意按钮节点(配合 cmdButton / buttonByText 使用)
    async clickNode(el) {
      if (!el) throw new Error('找不到要点的节点(现有 class: ' + classInventory(tree) + ')')
      if (typeof el.props.onClick !== 'function') throw new Error('节点不是按钮: ' + describe(el))
      await el.props.onClick()
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
  delegateRefusals: 0,
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
  shell: { key: 'pwsh', label: 'PowerShell', family: 'pwsh', path: 'C:/Program Files/PowerShell/7/pwsh.exe', version: '7.4.0' },
  platform: { os: 'Windows', release: '10.0.26200', arch: 'x64' },
  tools: [],
  terminals: [{ key: 'pwsh', label: 'PowerShell', family: 'pwsh', path: 'C:/Program Files/PowerShell/7/pwsh.exe', version: '7.4.0' }],
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

const TOOL = {
  key: 'node',
  label: 'Node.js',
  group: 'runtime',
  path: 'C:/Program Files/nodejs/node.exe',
  defaultPath: 'C:/Program Files/nodejs/node.exe',
  defaultVersion: '24.18.0',
  version: '24.18.0',
  versions: [
    { version: '24.18.0', path: 'C:/Program Files/nodejs/node.exe' },
    { version: '20.19.0', path: 'C:/nvm/v20.19.0/node.exe' },
  ],
}

const MANAGERS = [
  { key: 'fnm', label: 'fnm', command: 'C:/fnm/fnm.exe', versions: [{ name: 'v20.19.0', active: true }], active: 'v20.19.0', listed: true },
  { key: 'pyenv', label: 'pyenv', command: 'C:/pyenv/pyenv.bat', versions: [], listed: false },
]

// ───────────────────────────────── 断言 ──
let failed = 0
let checked = 0
function check(name, ok, detail) {
  checked += 1
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
const badgeOf = (tree) => headerBadges(tree)[0] || null
const rowCount = (tree) => findAllByClass(tree, 'envd-srow').length
const badRows = (tree) => findAllByClass(tree, 'envd-srow').filter((el) => classTokens(el).includes('bad'))
const shellChips = (tree) => findAllByClass(tree, 'envd-shellchip')
const noteNodes = (tree) => findAllByClass(tree, 'envd-note')
const noteClass = (el) => (typeof el.props.className === 'string' ? el.props.className : '')
const subTexts = (tree) => findAllByClass(tree, 'envd-sub').map(textOf)
const cssText = (tree) => {
  let out = ''
  walk(tree, (el) => {
    if (el.type === 'style') out += flattenText(el.children)
  })
  return out
}
// 选择器可能出现在逗号列表里(如 `.envd-badge,.envd-statuschip{...}`),按「完整选择器项」匹配
function hasRule(css, selector, declaration) {
  let from = 0
  for (;;) {
    const at = css.indexOf(selector, from)
    if (at < 0) return false
    from = at + selector.length
    const before = at === 0 ? '' : css[at - 1]
    const after = at + selector.length >= css.length ? '' : css[at + selector.length]
    const okBefore = before === '' || /[\s},{]/.test(before)
    const okAfter = after === '' || /[\s{,]/.test(after)
    if (!okBefore || !okAfter) continue
    const open = css.indexOf('{', at)
    if (open < 0) return false
    const close = css.indexOf('}', open)
    if (close < 0) continue
    if (css.slice(open + 1, close).includes(declaration)) return true
  }
}

try {
  loadClient()
  console.log('ok   client.js 可加载(window.__ModuleLoader__)')
  checked += 1
} catch (error) {
  console.log('FAIL client.js 可加载 → ' + (error && error.message))
  process.exit(1)
}

// ───────────────────────────────── 1) 混合会话:头部 1 个 badge + 卡片(默认收起)+ 展开 ──
const MIXED_SCOPES = [YIELD, SANDBOX, TAKEOVER]
// 非 takeover 的会话数:头部汇总句只说「几个会话未接管」
const MIXED_NON_TAKEOVER = MIXED_SCOPES.filter((sc) => sc.kind !== 'takeover')
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
check('1 混合:头部常显区恰 1 个 badge(整棵树也只有 1 个)', mixedBadges.length === 1 && findAllByClass(mixed.tree, 'envd-badge').length === 1, 'head=' + mixedBadges.length + ' all=' + findAllByClass(mixed.tree, 'envd-badge').length)
const mixedBadge = mixedBadges[0]
check('1 混合:badge 是 warn 色且数字 === 非 takeover 会话数', Boolean(mixedBadge) && hasClass(mixedBadge.cls, 'warn') && badgeNumber(mixedBadge) === MIXED_NON_TAKEOVER.length, 'expect ' + MIXED_NON_TAKEOVER.length + ' ' + emoji(mixedBadges))
check('1 混合:badge 文案是汇总句(非 takeover 会话用宿主工具——含让路/沙箱,不写成「未接管」)', Boolean(mixedBadge) && mixedBadge.text === '2 个会话用宿主工具' && mixedBadge.text.includes(String(MIXED_NON_TAKEOVER.length)), mixedBadge ? mixedBadge.text : '(missing)')
check(
  '1 混合:badge title 带工具名 + 会话数 + 备注(可补充阅读)',
  Boolean(mixedBadge) && String(mixedBadge.title || '').includes('ops_bash') && String(mixedBadge.title || '').includes('envd_shell') && String(mixedBadge.title || '').includes(String(MIXED_SCOPES.length) + ' 个会话'),
  'title=' + JSON.stringify(mixedBadge && mixedBadge.title),
)
check('1 混合:badge title 不出现孤立的「模型可见」', Boolean(mixedBadge) && !String(mixedBadge.title || '').includes('模型可见'), 'title=' + JSON.stringify(mixedBadge && mixedBadge.title))
const mixedHeadline = findOneByClass(mixed.tree, 'envd-headline')
check('1 混合:headline 只留终端名+版本(状态词只在 badge/卡片)', Boolean(mixedHeadline) && textOf(mixedHeadline) === 'PowerShell v7.4.0', mixedHeadline ? textOf(mixedHeadline) : '(missing)')
check('1 混合:接管卡片存在', Boolean(findOneByClass(mixed.tree, 'envd-card')))
const mixedChip = findOneByClass(mixed.tree, 'envd-statuschip')
check('1 混合:状态 chip 与头部 badge 是同一句结论且恰 1 个', Boolean(mixedChip) && hasClass(mixedChip.props.className, 'warn') && textOf(mixedChip) === mixedBadge.text, mixedChip ? textOf(mixedChip) : '(missing)')
const mixedTool = findOneByClass(mixed.tree, 'envd-tool')
check('1 混合:命令行列出实际命令工具名', Boolean(mixedTool) && textOf(mixedTool).includes('envd_shell') && textOf(mixedTool).includes('ops_bash'), mixedTool ? textOf(mixedTool) : '(missing)')
check('1 混合:.envd-tool 带 title 保留完整工具名', Boolean(mixedTool) && String(mixedTool.props.title || '').includes('envd_shell'), mixedTool ? String(mixedTool.props.title) : '(missing)')
const mixedSessionsSub = subTexts(mixed.tree).find((text) => text.includes('个会话 ·')) || ''
check('1 混合:会话计数一句话说清(直连/让路/沙箱各几)', mixedSessionsSub.includes(String(MIXED_SCOPES.length) + ' 个会话') && mixedSessionsSub.includes('直连') && mixedSessionsSub.includes('让路') && mixedSessionsSub.includes('沙箱'), 'subs=' + JSON.stringify(subTexts(mixed.tree)))
check('1 混合:逐会话默认收起(.envd-sessions 不出现、0 行)', !findOneByClass(mixed.tree, 'envd-sessions') && rowCount(mixed.tree) === 0, 'sessions=' + Boolean(findOneByClass(mixed.tree, 'envd-sessions')) + ' rows=' + rowCount(mixed.tree))
check('1 混合:设置区默认收起(不占常显区,0 组 chips)', findAllByClass(mixed.tree, 'envd-chips-sm').length === 0, 'chips-sm=' + findAllByClass(mixed.tree, 'envd-chips-sm').length)
check('1 混合:常显区标签只有 终端 / 命令', JSON.stringify(cardTags(mixed.tree)) === JSON.stringify(['终端', '命令']), JSON.stringify(cardTags(mixed.tree)))
const mixedNotes = noteNodes(mixed.tree)
check('1 混合:围栏备注以 muted 单行常显(不加 warn/bad 类)', mixedNotes.length === 1 && noteClass(mixedNotes[0]) === 'envd-note' && textOf(mixedNotes[0]).includes('围栏'), describeAll(mixedNotes))
check('1 混合:详情默认收起(.envd-diag-detail 不出现)', !findOneByClass(mixed.tree, 'envd-diag-detail'))
const mixedDiagBtn = cmdButton(mixed.tree, '详情')
check('1 混合:详情按钮默认 aria-expanded=false', Boolean(mixedDiagBtn) && mixedDiagBtn.props['aria-expanded'] === false, mixedDiagBtn ? JSON.stringify(mixedDiagBtn.props['aria-expanded']) : '(missing)')
check('1 混合:健康时详情摘要 = 对账正常', Boolean(mixedDiagBtn) && String(mixedDiagBtn.props.title || '').includes('对账正常'), 'title=' + JSON.stringify(mixedDiagBtn && mixedDiagBtn.props.title))

// 展开设置:两组 chips(接管模式 3 / 沙箱下接管 2)
await mixed.clickNode(cmdButton(mixed.tree, '设置'))
const mixedSm = findAllByClass(mixed.tree, 'envd-chips-sm')
check('1 混合:点「设置」后出现两组设置 chips', mixedSm.length === 2, 'groups=' + mixedSm.length)
check(
  '1 混合:每组设置都有可读组名(.envd-tag + role=group aria-label 成对)',
  JSON.stringify(cardTags(mixed.tree)) === JSON.stringify(['终端', '命令', '接管模式', '沙箱下接管']) && mixedSm.map((el) => el.props['aria-label']).join('|') === '接管模式|沙箱下接管',
  'tags=' + JSON.stringify(cardTags(mixed.tree)) + ' labels=' + JSON.stringify(mixedSm.map((el) => el.props['aria-label'])),
)
check('1 混合:接管模式 3 个 chip / 沙箱下接管 2 个 chip', mixedSm.length === 2 && findAllByClass(mixedSm[0], 'envd-chip').length === 3 && findAllByClass(mixedSm[1], 'envd-chip').length === 2, 'chips=' + mixedSm.map((g) => findAllByClass(g, 'envd-chip').length).join('/'))
check('1 混合:设置 chip 带 aria-pressed 状态(可访问)', mixedSm.every((g) => findAllByClass(g, 'envd-chip').every((c) => typeof c.props['aria-pressed'] === 'boolean')))

// 展开会话:逐会话行 === scopes 长度
await mixed.clickNode(cmdButton(mixed.tree, '会话'))
check('1 混合:点「会话」后逐会话行数 === scopes 长度(含 takeover)', rowCount(mixed.tree) === MIXED_SCOPES.length, 'rows=' + rowCount(mixed.tree) + ' expect=' + MIXED_SCOPES.length)
check('1 混合:会话开关展开后文案变「收起」且 aria-expanded=true', (() => { const b = cmdButton(mixed.tree, '收起'); return Boolean(b) && b.props['aria-expanded'] === true })())
const mixedRowTexts = findAllByClass(mixed.tree, 'envd-srow').map(textOf)
check('1 混合:takeover 行标为「直连」并带工具名', mixedRowTexts.some((text) => text.includes(id8(TAKEOVER_ID)) && text.includes('直连') && text.includes('envd_shell')), JSON.stringify(mixedRowTexts))
check('1 混合:非 takeover 行带实际工具名', mixedRowTexts.some((text) => text.includes(id8(YIELD_ID)) && text.includes(YIELD.tool)), JSON.stringify(mixedRowTexts))
check('1 混合:会话行用 data-kind 标出终局(takeover / yield / sandbox-host)', (() => {
  const kinds = findAllByClass(mixed.tree, 'envd-srow').map((el) => el.props['data-kind'])
  return JSON.stringify(kinds) === JSON.stringify(MIXED_SCOPES.map((sc) => sc.kind))
})(), JSON.stringify(findAllByClass(mixed.tree, 'envd-srow').map((el) => el.props['data-kind'])))
check('1 混合:会话点颜色按终局(直连 ok / 让路与沙箱 warn)', (() => {
  const dots = findAllByClass(mixed.tree, 'envd-sdot').map((el) => el.props.className)
  return dots.length === MIXED_SCOPES.length && dots.filter((c) => hasClass(c, 'ok')).length === 1 && dots.filter((c) => hasClass(c, 'warn')).length === MIXED_NON_TAKEOVER.length
})(), JSON.stringify(findAllByClass(mixed.tree, 'envd-sdot').map((el) => el.props.className)))
check('1 混合:无异常会话时不给原因列', findAllByClass(mixed.tree, 'envd-sreason').length === 0)
check('1 混合:takeover 行在 .envd-sub 里说明已挡掉的宿主工具', findAllByClass(mixed.tree, 'envd-srow').some((el) => textOf(el).includes('已挡 bash')), JSON.stringify(mixedRowTexts))
// 详细诊断:默认收起 → 点开才有统计
await mixed.clickNode(cmdButton(mixed.tree, '详情'))
const mixedDetail = findOneByClass(mixed.tree, 'envd-diag-detail')
check('1 混合:点「详情」展开统计(含注册/tick 计数)', Boolean(mixedDetail) && textOf(mixedDetail).includes('注册') && textOf(mixedDetail).includes('tick'), mixedDetail ? textOf(mixedDetail) : '(missing)')
check('1 混合:详情里 notes 以 .w 条目出现(与常显备注同源)', Boolean(mixedDetail) && findAllByClass(mixedDetail, 'w').length === mixedNotes.length, mixedDetail ? describeAll(findAllByClass(mixedDetail, 'w')) : '(missing)')
const mixedShell = shellChips(mixed.tree)
check('1 混合:已识别宿主命令工具 chips 数量 === 载荷数量', mixedShell.length === SHELL_TOOLS.length, 'chips=' + mixedShell.length)
check('1 混合:chips 带完整 title(截断时可读)', mixedShell.every((chip, i) => String(chip.props.title || '').includes(SHELL_TOOLS[i].name)), JSON.stringify(mixedShell.map((c) => c.props.title)))
check('1 混合:.envd-shelltools 有「已识别宿主工具」引导词', subTexts(mixed.tree).includes('已识别宿主工具'), JSON.stringify(subTexts(mixed.tree)))
check('1 混合:工具链分组有标题 + 计数尾注', Boolean(findTag(sectionByTitle(mixed.tree, '工具链'), 'h2')) && sectionTail(sectionByTitle(mixed.tree, '工具链')).includes('个工具'), sectionTail(sectionByTitle(mixed.tree, '工具链')))
check('1 混合:底部两个开关(简报注入 + 允许局域网)', findAllByClass(mixed.tree, 'envd-switch').length === 2, 'switches=' + findAllByClass(mixed.tree, 'envd-switch').length)

// ───────────────────────────────── 2) 数字不能来自 sandboxHiddenScopes ──
const MISMATCH_SCOPES = [YIELD]
const mismatch = await mountPanel(payload({ syncStats: syncStats({ hostOnlyScopes: [], sandboxHiddenScopes: 5 }), commandTool: commandTool({ scopes: MISMATCH_SCOPES }) }))
const mismatchBadge = badgeOf(mismatch.tree)
check('2 stats 不一致:单一让路会话 = 灰黄「让路」终局,不再算成 N 个计数', Boolean(mismatchBadge) && hasClass(mismatchBadge.cls, 'warn') && mismatchBadge.text === '让路' && Number.isNaN(badgeNumber(mismatchBadge)), emoji(headerBadges(mismatch.tree)))
check('2 stats 不一致:计数来自 scopes(1 个会话),不来自 sandboxHiddenScopes(5)', subTexts(mismatch.tree).some((text) => text.includes(String(MISMATCH_SCOPES.length) + ' 个会话')) && !subTexts(mismatch.tree).some((text) => text.includes('5 个会话')), JSON.stringify(subTexts(mismatch.tree)))
check('2 stats 不一致:badge title 也只带 scopes 的 1 个会话', Boolean(mismatchBadge) && String(mismatchBadge.title || '').includes('1 个会话') && !String(mismatchBadge.title || '').includes('5 个会话'), 'title=' + JSON.stringify(mismatchBadge && mismatchBadge.title))
check('2 stats 不一致:有会话时给出「会话」开关', Boolean(cmdButton(mismatch.tree, '会话')))

// ───────────────────────────────── 3) 纯 takeover ──
const pure = await mountPanel(
  payload({
    syncStats: syncStats({ hostOnlyScopes: [], sandboxHiddenScopes: 2 }),
    sandbox: { capable: false, defaultMode: 'workspace-write', policyKnown: true, delegate: false, scopes: [] },
    commandTool: commandTool({ scopes: [TAKEOVER, TAKEOVER2] }),
  }),
)
const pureBadges = headerBadges(pure.tree)
check('3 纯接管:恰 1 个 ok「接管中」badge(新文案,不再是「模型可见」)', pureBadges.length === 1 && hasClass(pureBadges[0].cls, 'ok') && pureBadges[0].text === '接管中', emoji(pureBadges))
check('3 纯接管:没有 warn/异常 badge', !pureBadges.some((b) => hasClass(b.cls, 'warn') || hasClass(b.cls, 'bad')), emoji(pureBadges))
check('3 纯接管:逐会话默认收起(0 行)', rowCount(pure.tree) === 0, 'rows=' + rowCount(pure.tree))
check('3 纯接管:设置区默认收起', findAllByClass(pure.tree, 'envd-chips-sm').length === 0, 'chips-sm=' + findAllByClass(pure.tree, 'envd-chips-sm').length)
check('3 纯接管:状态 chip 是 ok 色', Boolean(findWithClasses(pure.tree, 'envd-statuschip', 'ok')), JSON.stringify(findAllByClass(pure.tree, 'envd-statuschip').map((el) => el.props.className)))
await pure.clickNode(cmdButton(pure.tree, '会话'))
check('3 纯接管:会话行数 === scopes 长度', rowCount(pure.tree) === 2, 'rows=' + rowCount(pure.tree))
check('3 纯接管:每行都标「直连」', findAllByClass(pure.tree, 'envd-srow').every((el) => textOf(el).includes('直连')), JSON.stringify(findAllByClass(pure.tree, 'envd-srow').map(textOf)))
await pure.clickNode(cmdButton(pure.tree, '设置'))
check('3 纯接管:设置展开后两组仍都在(新 DOM 不按 sandbox.capable 隐藏)', findAllByClass(pure.tree, 'envd-chips-sm').length === 2, 'sm=' + findAllByClass(pure.tree, 'envd-chips-sm').length)

// ───────────────────────────────── 4) 异常会话:四类 + 正常会话不算;自动展开 ──
const NULL_TOOL = scopeFact({ id: NULL_TOOL_ID, kind: 'host', tool: null, hostTool: null, hostTools: [], visible: true, anomaly: false })
const INVISIBLE = scopeFact({ id: INVISIBLE_ID, kind: 'takeover', tool: 'envd_shell', ownVisible: true, visible: false })
const LEAKY = scopeFact({ id: LEAKY_ID, kind: 'takeover', tool: 'envd_shell', ownVisible: true, hostTools: ['bash'] })
const FLAGGED = scopeFact({ id: FLAGGED_ID, kind: 'host', tool: 'ops_bash', hostTool: 'ops_bash', hostTools: ['ops_bash'], anomaly: true })
const NORMAL_HOST = scopeFact({ id: NORMAL_HOST_ID, kind: 'host', tool: 'pwsh', hostTool: 'pwsh', hostTools: ['pwsh'] })
const BAD_SCOPES = [NULL_TOOL, INVISIBLE, LEAKY, FLAGGED, NORMAL_HOST]
const EXPECTED_BAD = [NULL_TOOL, INVISIBLE, LEAKY, FLAGGED]
const anomaly = await mountPanel(payload({ syncStats: syncStats({ lastError: 'boom last error' }), commandTool: commandTool({ scopes: BAD_SCOPES }) }))
const anomalyBadge = badgeOf(anomaly.tree)
check('4 异常:头部 bad「N 个会话异常」', Boolean(anomalyBadge) && hasClass(anomalyBadge.cls, 'bad') && anomalyBadge.text.includes('异常'), emoji(headerBadges(anomaly.tree)))
check('4 异常:数字 === 载荷异常会话数(不是 scopes 总数)', Boolean(anomalyBadge) && badgeNumber(anomalyBadge) === EXPECTED_BAD.length, 'expect ' + EXPECTED_BAD.length + ' ' + emoji(headerBadges(anomaly.tree)))
check('4 异常:逐会话自动展开(异常不许被折叠藏住)', rowCount(anomaly.tree) === BAD_SCOPES.length && Boolean(findOneByClass(anomaly.tree, 'envd-sessions')), 'rows=' + rowCount(anomaly.tree))
check('4 异常:会话开关自动变「收起」且 aria-expanded=true', (() => { const b = cmdButton(anomaly.tree, '收起'); return Boolean(b) && b.props['aria-expanded'] === true })())
check('4 异常:异常行染红且只红 N 行', badRows(anomaly.tree).length === EXPECTED_BAD.length, 'badRows=' + badRows(anomaly.tree).length + ' expect=' + EXPECTED_BAD.length)
const anomalyReasons = findAllByClass(anomaly.tree, 'envd-sreason').map((el) => ({ text: textOf(el), title: el.props.title }))
check('4 异常:异常行尾给原因(看不到命令工具 / 宿主工具仍可见 / 对账异常)', anomalyReasons.length === EXPECTED_BAD.length && anomalyReasons.every((r) => r.text.length > 0 && String(r.title || '').includes(r.text)), JSON.stringify(anomalyReasons))
check('4 异常:四类原因各出现一次(缺工具 / 不可见 / 泄漏 / 对账标红)', (() => {
  const joined = anomalyReasons.map((r) => r.text).join(' | ')
  return joined.includes('看不到命令工具') && joined.includes('宿主 bash 仍可见') && joined.includes('对账异常')
})(), JSON.stringify(anomalyReasons.map((r) => r.text)))
check('4 异常:正常会话没有被染红、也没有原因列', findAllByClass(anomaly.tree, 'envd-srow').some((el) => textOf(el).includes(id8(NORMAL_HOST_ID)) && !classTokens(el).includes('bad') && findAllByClass(el, 'envd-sreason').length === 0), JSON.stringify(findAllByClass(anomaly.tree, 'envd-srow').map(textOf)))
check('4 异常:异常行排在最前(异常优先)', (() => {
  const rows = findAllByClass(anomaly.tree, 'envd-srow')
  const flags = rows.map((el) => classTokens(el).includes('bad'))
  return flags.slice(0, EXPECTED_BAD.length).every(Boolean) && flags.slice(EXPECTED_BAD.length).every((f) => !f)
})(), JSON.stringify(findAllByClass(anomaly.tree, 'envd-srow').map((el) => el.props.className)))
check('4 异常:最近错误以 .envd-note.bad 常显', (() => { const bad = noteNodes(anomaly.tree).filter((el) => hasClass(noteClass(el), 'bad')); return bad.length === 1 && textOf(bad[0]).includes('最近错误') && textOf(bad[0]).includes('boom last error') })(), describeAll(noteNodes(anomaly.tree)))
check('4 异常:详情默认收起(不再把诊断撑在常显区)', !findOneByClass(anomaly.tree, 'envd-diag-detail'))
const anomalyDiagBtn = cmdButton(anomaly.tree, '详情')
check('4 异常:详情摘要点出异常数(aria-expanded=false 时就能读到)', Boolean(anomalyDiagBtn) && String(anomalyDiagBtn.props.title || '').includes(String(EXPECTED_BAD.length) + ' 个会话异常'), 'title=' + JSON.stringify(anomalyDiagBtn && anomalyDiagBtn.props.title))
check('4 异常:badge title 也带上备注(最近错误)', Boolean(anomalyBadge) && String(anomalyBadge.title || '').includes('最近错误'), 'title=' + JSON.stringify(anomalyBadge && anomalyBadge.title))
await anomaly.clickNode(anomalyDiagBtn)
const anomalyDetail = findOneByClass(anomaly.tree, 'envd-diag-detail')
check('4 异常:点「详情」后统计 + 红条目可见(.e)', Boolean(anomalyDetail) && textOf(anomalyDetail).includes('注册') && findAllByClass(anomalyDetail, 'e').length === 1 && textOf(findAllByClass(anomalyDetail, 'e')[0]).includes('boom last error'), anomalyDetail ? describeAll(findAllByClass(anomalyDetail, 'e')) : '(missing)')

// ───────────────────────────────── 5) 异常会话优先 + 自动展开(新 DOM 不再截断 5 行) ──
// 故意把正常会话放在前面:不排序的话异常会被挤到后面
const MANY = []
for (let i = 0; i < 4; i += 1) MANY.push(scopeFact({ id: 'ok' + i + 'bbbbbbbbbb', kind: 'takeover', tool: 'envd_shell', ownVisible: true }))
for (let i = 0; i < 6; i += 1) MANY.push(scopeFact({ id: 'bad' + i + 'aaaaaaaaaa', kind: 'host', tool: null, hostTool: null }))
const ANOMALIES_IN_MANY = 6
const many = await mountPanel(payload({ syncStats: syncStats({}), commandTool: commandTool({ scopes: MANY }) }))
check('5 异常优先:默认就展开全部会话(不再截断 5 行)', rowCount(many.tree) === MANY.length, 'rows=' + rowCount(many.tree) + ' expect=' + MANY.length)
check('5 异常优先:异常行全部排在最前(不按载荷顺序)', (() => {
  const rows = findAllByClass(many.tree, 'envd-srow')
  return badRows(many.tree).length === ANOMALIES_IN_MANY && rows.slice(0, ANOMALIES_IN_MANY).every((el) => classTokens(el).includes('bad'))
})(), 'rows=' + rowCount(many.tree) + ' bad=' + badRows(many.tree).length)
check('5 异常优先:异常之后才是正常行(顺序由载荷推导)', (() => {
  const rows = findAllByClass(many.tree, 'envd-srow')
  return rows.slice(ANOMALIES_IN_MANY).every((el) => !classTokens(el).includes('bad') && textOf(el).includes('直连'))
})(), JSON.stringify(findAllByClass(many.tree, 'envd-srow').map(textOf)))
check('5 异常优先:不再有「还有 N 个」折叠按钮(.envd-morebtn 已删除)', !findOneByClass(many.tree, 'envd-morebtn'))
check('5 异常优先:badge 数字 === 异常会话数', Boolean(badgeOf(many.tree)) && badgeNumber(badgeOf(many.tree)) === ANOMALIES_IN_MANY, emoji(headerBadges(many.tree)))
check('5 异常优先:会话计数一句话说清(总 10 / 4 直连 / 6 未接管)', subTexts(many.tree).some((text) => text.includes(String(MANY.length) + ' 个会话') && text.includes('4 直连') && text.includes(String(ANOMALIES_IN_MANY) + ' 未接管')), JSON.stringify(subTexts(many.tree)))

// ───────────────────────────────── 6) 健康:诊断默认折叠、一路 ok、不染红 ──
const healthy = await mountPanel(mixedPayload)
check('6 健康:诊断默认折叠(无 detail)', !findOneByClass(healthy.tree, 'envd-diag-detail'))
check('6 健康:环境检查健康时「一行 ✓ 通过」', (() => { const flag = findWithClasses(healthy.tree, 'envd-flag', 'ok'); return Boolean(flag) && textOf(flag).includes('通过') && Boolean(findOneByClass(healthy.tree, 'envd-row')) })(), describeAll(findAllByClass(healthy.tree, 'envd-flag')))
check('6 健康:健康时不出现折叠的健康行(.envd-fold-health)', !findOneByClass(healthy.tree, 'envd-fold-health'))
check('6 健康:没有异常会话行', badRows(healthy.tree).length === 0)
check('6 健康:没有 .envd-issue 条目', findAllByClass(healthy.tree, 'envd-issue').length === 0)
check('6 健康:常显备注里没有 warn/bad 级', noteNodes(healthy.tree).every((el) => noteClass(el) === 'envd-note'), describeAll(noteNodes(healthy.tree)))
const healthyDiagBtn = cmdButton(healthy.tree, '详情')
check('6 健康:详情摘要为「对账正常」', Boolean(healthyDiagBtn) && String(healthyDiagBtn.props.title || '').includes('对账正常'), 'title=' + JSON.stringify(healthyDiagBtn && healthyDiagBtn.props.title))

// ───────────────────────────────── 7) 旧版 API(没有 scopes 字段) ──
const legacyPayload = payload({ syncStats: syncStats({ hostOnlyScopes: [YIELD_ID], sandboxHiddenScopes: 2 }), commandTool: commandTool() })
delete legacyPayload.commandTool.scopes
const legacy = await mountPanel(legacyPayload)
const legacyBadges = headerBadges(legacy.tree)
const legacyBadge = legacyBadges[0]
check('7 旧版:badge 仍是汇总语义(ok「接管中」,不报「模型可见」)', legacyBadges.length === 1 && hasClass(legacyBadge.cls, 'ok') && legacyBadge.text === '接管中', emoji(legacyBadges))
check('7 旧版:badge 不显示 1+2 的估算计数(没有逐会话事实就不编数字)', Number.isNaN(badgeNumber(legacyBadge)), emoji(legacyBadges))
check('7 旧版:badge title 注明旧版构建 + 工具名', String(legacyBadge.title || '').includes('旧版') && String(legacyBadge.title || '').includes('envd_shell'), 'title=' + JSON.stringify(legacyBadge.title))
const legacyNotes = noteNodes(legacy.tree)
check('7 旧版:.envd-note.warn 里出现「旧版」文案', legacyNotes.length === 1 && hasClass(noteClass(legacyNotes[0]), 'warn') && textOf(legacyNotes[0]).includes('旧版'), describeAll(legacyNotes))
check('7 旧版:逐会话不渲染(没有 scopes 就没有 .envd-sessions / 行 / 会话按钮)', !findOneByClass(legacy.tree, 'envd-sessions') && rowCount(legacy.tree) === 0 && !cmdButton(legacy.tree, '会话'), 'rows=' + rowCount(legacy.tree))
check('7 旧版:不再有旧的 .envd-legacy 大段警告块', !findOneByClass(legacy.tree, 'envd-legacy'))
check('7 旧版:状态 chip 是汇总终局而不是逐会话结论', (() => { const chip = findOneByClass(legacy.tree, 'envd-statuschip'); return Boolean(chip) && textOf(chip) === '接管中' })())
check('7 旧版:没有「N 个会话」计数(逐会话事实不可用)', !subTexts(legacy.tree).some((text) => text.includes('个会话')), JSON.stringify(subTexts(legacy.tree)))
check('7 旧版:.envd-shelltools 仍渲染(有 scopes 字段?没有,但旧版据此不显示)', !findOneByClass(legacy.tree, 'envd-shelltools'))

// ───────────────────────────────── 8) 新构建 scopes:[](零会话) ──
const emptyScopes = await mountPanel(payload({ syncStats: syncStats({}), commandTool: commandTool({ scopes: [] }) }))
const emptyBadges = headerBadges(emptyScopes.tree)
check('8 零会话:头部 ok「接管中」(工具注册了,只是还没有会话)', emptyBadges.length === 1 && hasClass(emptyBadges[0].cls, 'ok') && emptyBadges[0].text === '接管中', emoji(emptyBadges))
check('8 零会话:提示「当前无会话」而不是「旧版构建」', subTexts(emptyScopes.tree).includes('当前无会话') && !allText(emptyScopes.tree).includes('旧版构建'), JSON.stringify(subTexts(emptyScopes.tree)))
check('8 零会话:title 不含旧版说明', !String(emptyBadges[0].title || '').includes('旧版构建'))
check('8 零会话:没有会话按钮也没有会话行', !cmdButton(emptyScopes.tree, '会话') && rowCount(emptyScopes.tree) === 0)
check('8 零会话:.envd-shelltools 仍在(有 scopes 数组)且提示未识别宿主工具', Boolean(findOneByClass(emptyScopes.tree, 'envd-shelltools')) && subTexts(emptyScopes.tree).includes('未识别到宿主工具'), JSON.stringify(subTexts(emptyScopes.tree)))

// ───────────────────────────────── 9) 全部会话都未接管(host):灰「未接管」,不挂黄 ──
const HOST_ONLY = [
  scopeFact({ id: 'h1aaaaaaaaaaaa', kind: 'host', tool: 'ops_bash', hostTool: 'ops_bash', hostTools: ['ops_bash'] }),
  scopeFact({ id: 'h2bbbbbbbbbbbb', kind: 'host', tool: 'pwsh', hostTool: 'pwsh', hostTools: ['pwsh'] }),
]
const hostOnly = await mountPanel(payload({ syncStats: syncStats({}), commandTool: commandTool({ scopes: HOST_ONLY }) }))
const hostOnlyBadges = headerBadges(hostOnly.tree)
check('9 全未接管:头部灰「未接管」而不是黄色汇总', hostOnlyBadges.length === 1 && hasClass(hostOnlyBadges[0].cls, 'muted') && !hasClass(hostOnlyBadges[0].cls, 'warn') && hostOnlyBadges[0].text === '未接管', emoji(hostOnlyBadges))
check('9 全未接管:状态 chip 也是未接管色', Boolean(findWithClasses(hostOnly.tree, 'envd-statuschip', 'muted')), JSON.stringify(findAllByClass(hostOnly.tree, 'envd-statuschip').map((el) => el.props.className)))
check('9 全未接管:会话计数逐个终局说清', subTexts(hostOnly.tree).some((text) => text.includes(String(HOST_ONLY.length) + ' 个会话') && text.includes(String(HOST_ONLY.length) + ' 未接管')), JSON.stringify(subTexts(hostOnly.tree)))
// 混合(部分 host + 部分 takeover)才挂黄色汇总 —— 这是「未接管」和「混合」的分界
const MIXED_KIND = [HOST_ONLY[0], TAKEOVER]
const mixedKinds = await mountPanel(payload({ syncStats: syncStats({}), commandTool: commandTool({ scopes: MIXED_KIND }) }))
const mixedKindBadge = badgeOf(mixedKinds.tree)
check('9 混合(host + takeover):挂黄色汇总且数字 === host 会话数', Boolean(mixedKindBadge) && hasClass(mixedKindBadge.cls, 'warn') && badgeNumber(mixedKindBadge) === 1, emoji(headerBadges(mixedKinds.tree)))
check('9 混合(host + takeover):工具名两个都列(不谎报单一接管)', (() => { const node = findOneByClass(mixedKinds.tree, 'envd-tool'); const text = node ? textOf(node) : ''; return text.includes(HOST_ONLY[0].tool) && text.includes('envd_shell') })(), (() => { const node = findOneByClass(mixedKinds.tree, 'envd-tool'); return node ? textOf(node) : '(missing)' })())

// ───────────────────────────────── 9b) i18n / 文案细节(静态检查) ──
// 源码里中文/英文词条的「自定义路径示例」应是 4 个反斜杠(渲染成 \\tools\\ 形式),中英各一处
const pathExampleCount = (SOURCE.match(/C:\\{4}tools\\{4}rg\.exe/g) || []).length
check('9b 文案:自定义路径示例中英各一处', pathExampleCount === 2, 'occurrences=' + pathExampleCount)
check('9b 文案:英文里没有硬编码「平台默认」', !EN_BLOCK.includes('平台默认'))
check('9b 文案:新终局词条中英都有(工具并存 / 无命令工具 / 备注)', ['statusConflict', 'statusNoTool', 'noteBroken', 'noteConflict', 'notePolicyUnknown'].every((key) => ZH_BLOCK.includes(key) && EN_BLOCK.includes(key)), 'zh=' + ['statusConflict', 'statusNoTool', 'noteBroken', 'noteConflict', 'notePolicyUnknown'].filter((k) => !ZH_BLOCK.includes(k)) + ' en=' + ['statusConflict', 'statusNoTool', 'noteBroken', 'noteConflict', 'notePolicyUnknown'].filter((k) => !EN_BLOCK.includes(k)))

// ───────────────────────────────── 10) 诊断只有 warn 级:常显备注 + 详情可开关(不假死) ──
const warnOnly = await mountPanel(payload({ syncStats: syncStats({ unrestrictable: ['bash'] }), commandTool: commandTool({ scopes: [TAKEOVER] }) }))
const warnNotes = noteNodes(warnOnly.tree)
check('10 warn 级诊断:常显 .envd-note.warn 点名挡不掉的名字', warnNotes.length === 1 && hasClass(noteClass(warnNotes[0]), 'warn') && textOf(warnNotes[0]).includes('挡不掉') && textOf(warnNotes[0]).includes('bash'), describeAll(warnNotes))
check('10 warn 级诊断:没有 bad 级备注(不是硬故障)', warnNotes.every((el) => !hasClass(noteClass(el), 'bad')), describeAll(warnNotes))
check('10 warn 级诊断:头部 badge 仍是 ok「接管中」(warn 不改终局)', Boolean(badgeOf(warnOnly.tree)) && hasClass(badgeOf(warnOnly.tree).cls, 'ok'), emoji(headerBadges(warnOnly.tree)))
check('10 warn 级诊断:详情默认收起', !findOneByClass(warnOnly.tree, 'envd-diag-detail'))
await warnOnly.clickNode(cmdButton(warnOnly.tree, '详情'))
const warnDetail = findOneByClass(warnOnly.tree, 'envd-diag-detail')
const warnDetailW = warnDetail ? findAllByClass(warnDetail, 'w') : []
check('10 warn 级诊断:点开后有 warn 条目(.w)且文案含挡不掉的名字', warnDetailW.length === warnNotes.length && textOf(warnDetailW[0]).includes('挡不掉') && textOf(warnDetailW[0]).includes('bash'), describeAll(warnDetailW))
check('10 warn 级诊断:详情里没有红条目(.e)', warnDetail ? findAllByClass(warnDetail, 'e').length === 0 : false)
// 详情按钮文案固定是「详情」,靠 aria-expanded 表达开关状态
await warnOnly.clickNode(cmdButton(warnOnly.tree, '详情'))
check('10 warn 级诊断:再点「详情」真的收起(不假死)', !findOneByClass(warnOnly.tree, 'envd-diag-detail'))
check('10 warn 级诊断:收起后 aria-expanded=false', Boolean(cmdButton(warnOnly.tree, '详情')) && cmdButton(warnOnly.tree, '详情').props['aria-expanded'] === false, cmdButton(warnOnly.tree, '详情') ? JSON.stringify(cmdButton(warnOnly.tree, '详情').props['aria-expanded']) : '(missing)')
await warnOnly.clickNode(cmdButton(warnOnly.tree, '详情'))
check('10 warn 级诊断:第三次点击又能展开', Boolean(findOneByClass(warnOnly.tree, 'envd-diag-detail')))
check('10 warn 级诊断:badge title 带上备注文案', Boolean(badgeOf(warnOnly.tree)) && String(badgeOf(warnOnly.tree).title || '').includes('挡不掉'), 'title=' + JSON.stringify(badgeOf(warnOnly.tree) && badgeOf(warnOnly.tree).title))

// ───────────────────────────────── 11) reuse(由其它插件提供) ──
const reuse = await mountPanel(payload({ commandTool: commandTool({ reuse: true, takeover: false, name: 'other_shell' }) }))
const reuseBadges = headerBadges(reuse.tree)
check(
  '11 reuse:头部灰「由其它插件提供」,不报「模型可见」',
  reuseBadges.length === 1 && hasClass(reuseBadges[0].cls, 'muted') && !reuseBadges[0].text.includes('模型可见') && reuseBadges[0].text.includes('其它插件'),
  emoji(reuseBadges),
)
check('11 reuse:命令行工具名取别名 other_shell', textOf(findOneByClass(reuse.tree, 'envd-tool') || '') === 'other_shell', textOf(findOneByClass(reuse.tree, 'envd-tool') || ''))
check('11 reuse:零会话时没有会话按钮', !cmdButton(reuse.tree, '会话'))

// ───────────────────────────────── 12) denies(broken 终局)/ 沙箱下不可见 ──
const denied = await mountPanel(payload({ commandTool: commandTool({ visible: false, sandbox: false, denies: ['bash', 'pwsh'] }) }))
const deniedBadge = badgeOf(denied.tree)
check('12 denies:bad「无命令工具」(visible=false 且无围栏 = 真故障)', Boolean(deniedBadge) && hasClass(deniedBadge.cls, 'bad') && deniedBadge.text === '无命令工具', emoji(headerBadges(denied.tree)))
const deniedNotes = noteNodes(denied.tree)
check('12 denies:.envd-note.bad 点名被挡的宿主工具(bash + pwsh)', deniedNotes.length === 1 && hasClass(noteClass(deniedNotes[0]), 'bad') && textOf(deniedNotes[0]).includes('bash') && textOf(deniedNotes[0]).includes('pwsh'), describeAll(deniedNotes))
check('12 denies:badge title 也带被挡工具名(不再丢信息)', String(deniedBadge.title || '').includes('bash') && String(deniedBadge.title || '').includes('pwsh'), 'title=' + JSON.stringify(deniedBadge.title))
check('12 denies:切了 deny 就没有会话按钮(零会话)', !cmdButton(denied.tree, '会话'))
const sandboxed = await mountPanel(payload({ commandTool: commandTool({ visible: false, sandbox: true, sandboxConfined: true }) }))
const sandboxedBadge = badgeOf(sandboxed.tree)
check('12 沙箱:可见=false 时挂灰「沙箱」而不是红色不可见', Boolean(sandboxedBadge) && hasClass(sandboxedBadge.cls, 'muted') && !hasClass(sandboxedBadge.cls, 'bad') && sandboxedBadge.text === '沙箱', emoji(headerBadges(sandboxed.tree)))
check('12 沙箱:状态 chip 也是沙箱色', Boolean(findWithClasses(sandboxed.tree, 'envd-statuschip', 'muted')))
check('12 沙箱:没有 bad 级备注(围栏是设计内终局)', noteNodes(sandboxed.tree).every((el) => !hasClass(noteClass(el), 'bad')), describeAll(noteNodes(sandboxed.tree)))

// ───────────────────────────────── 13) 沙箱策略未知:常显 muted 备注(新旧 API 同一条) ──
const policyUnknown = await mountPanel(
  payload({
    syncStats: syncStats({}),
    sandbox: { capable: true, defaultMode: 'workspace-write', policyKnown: false, delegate: false, scopes: [] },
    commandTool: commandTool({ sandboxConfined: null, scopes: [] }),
  }),
)
const policyNotes = noteNodes(policyUnknown.tree)
check('13 policyKnown=false(新 API、零会话):常显 muted 备注「策略未知」', policyNotes.length === 1 && noteClass(policyNotes[0]) === 'envd-note' && textOf(policyNotes[0]).includes('策略未知'), describeAll(policyNotes))
check('13 policyKnown=false:策略未知不污染终局(badge 仍 ok 接管中)', Boolean(badgeOf(policyUnknown.tree)) && hasClass(badgeOf(policyUnknown.tree).cls, 'ok'), emoji(headerBadges(policyUnknown.tree)))
const legacyPolicyPayload = payload({
  syncStats: syncStats({}),
  sandbox: { capable: true, defaultMode: 'workspace-write', policyKnown: false, delegate: false, scopes: [] },
  commandTool: commandTool({ sandbox: true, sandboxPolicyKnown: false }),
})
delete legacyPolicyPayload.commandTool.scopes
const legacyPolicy = await mountPanel(legacyPolicyPayload)
const legacyPolicyNotes = noteNodes(legacyPolicy.tree)
check('13 policyKnown=false(旧 API ct.sandboxPolicyKnown):走同一条 muted 备注', legacyPolicyNotes.some((el) => noteClass(el) === 'envd-note' && textOf(el).includes('策略未知')), describeAll(legacyPolicyNotes))
check('13 policyKnown=false(旧 API):旧版备注也还在(各自一条)', legacyPolicyNotes.some((el) => hasClass(noteClass(el), 'warn') && textOf(el).includes('旧版')), describeAll(legacyPolicyNotes))
// 逐会话通道:confined:null 的会话在 .envd-sub 里说明「策略未知」
const POLICY_SCOPE = scopeFact({ id: 'pppp9999qqqq8888', kind: 'sandbox-host', tool: 'envd_shell', confined: null, mode: '' })
const policyScope = await mountPanel(
  payload({
    sandbox: { capable: true, defaultMode: 'workspace-write', policyKnown: false, delegate: false, scopes: [] },
    commandTool: commandTool({ scopes: [POLICY_SCOPE] }),
  }),
)
check('13 policyKnown=false:逐会话默认收起(策略未知不是异常,不抢地方)', rowCount(policyScope.tree) === 0)
await policyScope.clickNode(cmdButton(policyScope.tree, '会话'))
const policyRow = findAllByClass(policyScope.tree, 'envd-srow')[0]
check('13 policyKnown=false:逐会话 .envd-sub 里出现「策略未知」', Boolean(policyRow) && textOf(findOneByClass(policyRow, 'envd-sub') || '').includes('策略未知'), policyRow ? describe(policyRow) : '(missing)')
check('13 policyKnown=false:该行点不是 bad(策略未知不是异常)', Boolean(policyRow) && !classTokens(policyRow).includes('bad') && !findOneByClass(policyRow, 'envd-sdot.bad'), policyRow ? String((findOneByClass(policyRow, 'envd-sdot') || {}).props && findOneByClass(policyRow, 'envd-sdot').props.className) : '(missing)')

// ───────────────────────────────── 14) 版本管理器行 ──
const managersPanel = await mountPanel(payload({ versionManagers: MANAGERS }))
check('14 版本管理器:行数 === 载荷数量', findAllByClass(managersPanel.tree, 'envd-manager').length === MANAGERS.length, 'managers=' + findAllByClass(managersPanel.tree, 'envd-manager').length)
check('14 版本管理器:工具链标题计数带上管理器数量', sectionTail(sectionByTitle(managersPanel.tree, '工具链')).includes('版本管理器') && sectionTail(sectionByTitle(managersPanel.tree, '工具链')).includes(String(MANAGERS.length)), sectionTail(sectionByTitle(managersPanel.tree, '工具链')))
const managerRows = findAllByClass(managersPanel.tree, 'envd-manager')
check('14 版本管理器:首行有分组名 + 激活版本标记', Boolean(managerRows[0]) && textOf(findOneByClass(managerRows[0], 'envd-tgroup')) === '版本管理器' && textOf(managerRows[0]).includes('v20.19.0'), managerRows[0] ? describe(managerRows[0]) : '(missing)')
check('14 版本管理器:未列出版本的管理器有说明文字', Boolean(managerRows[1]) && textOf(managerRows[1]).includes('没能列出'), managerRows[1] ? describe(managerRows[1]) : '(missing)')
check('14 版本管理器:.envd-tact 是空占位(不再堆计数)', managerRows.every((row) => { const tact = findOneByClass(row, 'envd-tact'); return Boolean(tact) && textOf(tact) === '' }), managerRows.map((row) => describe(findOneByClass(row, 'envd-tact'))).join(' ;; '))

// ───────────────────────────────── 15) POST 失败(opError)可见且可关闭 ──
const opFailed = await mountPanel(mixedPayload, { onPost: () => ({ ok: false, error: 'boom' }) })
check('15 opError:操作前没有错误框', !findOneByClass(opFailed.tree, 'envd-err'))
await opFailed.click('envd-chip')
const opErrNode = findOneByClass(opFailed.tree, 'envd-err')
check('15 opError:操作失败给出可见错误框(role=alert)', Boolean(opErrNode && textOf(opErrNode).includes('boom')) && opErrNode.props.role === 'alert', opErrNode ? describe(opErrNode) : '(missing)')
check('15 opError:错误框说明「操作失败」而不是静默', Boolean(opErrNode) && textOf(opErrNode).includes('操作失败'), opErrNode ? textOf(opErrNode) : '(missing)')
const opDismiss = opErrNode ? buttonsIn(opErrNode)[0] : null
check('15 opError:错误框有可点的关闭按钮', Boolean(opDismiss), opErrNode ? describeAll(buttonsIn(opErrNode)) : '(missing)')
await opFailed.clickNode(opDismiss)
check('15 opError:点关闭后错误框消失', !findOneByClass(opFailed.tree, 'envd-err'))

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
check('16 en:状态句是英文(不再漏中文终局词)', textOf(findOneByClass(enPanel.tree, 'envd-statuschip') || '') === MIXED_NON_TAKEOVER.length + ' sessions use the host tool', textOf(findOneByClass(enPanel.tree, 'envd-statuschip') || ''))
check('16 en:健康行是英文', textOf(findWithClasses(enPanel.tree, 'envd-flag', 'ok') || '').includes('OK'), describeAll(findAllByClass(enPanel.tree, 'envd-flag')))

// ───────────────────────────────── 17) 长名字溢出防护(结构 + CSS 规则) ──
const LONG_NAME = 'tenant_' + 'x'.repeat(80) + '_bash'
const LONG_SHELL_LABEL = 'PowerShell ' + 'y'.repeat(60)
const LONG_SCOPE = scopeFact({ id: 'abcdef0123456789abcdef', kind: 'yield', tool: LONG_NAME, hostTool: LONG_NAME, hostTools: [LONG_NAME] })
const longPanel = await mountPanel(
  payload({
    shell: { key: 'pwsh', label: LONG_SHELL_LABEL, family: 'pwsh', path: 'C:/very/long/pwsh.exe', version: '7.4.0' },
    syncStats: syncStats({ runtimeShellTools: [{ name: LONG_NAME, family: 'bash', learned: false }] }),
    commandTool: commandTool({ scopes: [LONG_SCOPE] }),
  }),
)
const longChip = shellChips(longPanel.tree)[0]
check('17 长名字:chip 的 title 保留完整名字', Boolean(longChip && String(longChip.props.title || '').includes(LONG_NAME)), longChip ? String(longChip.props.title) : '(missing)')
check('17 长名字:headline 保留完整终端名(靠 CSS 省略而不是截断数据)', textOf(findOneByClass(longPanel.tree, 'envd-headline') || '') === LONG_SHELL_LABEL + ' v7.4.0', textOf(findOneByClass(longPanel.tree, 'envd-headline') || '(missing)'))
check('17 长名字:.envd-tool 用 title 保留完整工具名', String((findOneByClass(longPanel.tree, 'envd-tool') || {}).props && findOneByClass(longPanel.tree, 'envd-tool').props.title || '').includes(LONG_NAME), String((findOneByClass(longPanel.tree, 'envd-tool') || {}).props && findOneByClass(longPanel.tree, 'envd-tool').props.title))
await longPanel.clickNode(cmdButton(longPanel.tree, '会话'))
const longSrow = findAllByClass(longPanel.tree, 'envd-srow')[0]
check('17 长名字:会话 id 截成 8 位、完整值不塞进一行', Boolean(findOneByClass(longSrow || null, 'envd-sid')) && textOf(findOneByClass(longSrow, 'envd-sid')) === String(LONG_SCOPE.id).slice(0, 8), longSrow ? describe(longSrow) : '(missing)')
check('17 长名字:.envd-stool 的 title 保留完整工具名', Boolean(findOneByClass(longSrow || null, 'envd-stool')) && String(findOneByClass(longSrow, 'envd-stool').props.title || '') === LONG_NAME, findOneByClass(longSrow || null, 'envd-stool') ? String(findOneByClass(longSrow, 'envd-stool').props.title) : '(missing)')
const css = cssText(longPanel.tree)
check('17 溢出 CSS:headline 用 ellipsis', hasRule(css, '.envd-headline', 'text-overflow:ellipsis'))
check('17 溢出 CSS:错误框允许 anywhere 换行', hasRule(css, '.envd-err', 'overflow-wrap:anywhere'))
check('17 溢出 CSS:命令工具 chip 有 max-width', hasRule(css, '.envd-shellchip', 'max-width:100%'))
check('17 溢出 CSS:会话行原因允许收缩+ellipsis', hasRule(css, '.envd-sreason', 'overflow:hidden'))
check('17 溢出 CSS:badge 允许收缩(选择器列表里也认)', hasRule(css, '.envd-badge', 'max-width:100%'))
check('17 溢出 CSS:备注文字允许 anywhere 换行', hasRule(css, '.envd-note', 'overflow-wrap:anywhere'))
check('17 溢出 CSS:路径按钮省略超长路径', hasRule(css, '.envd-tpath', 'text-overflow:ellipsis'))
check('17 溢出 CSS:命令工具名省略超长名字', hasRule(css, '.envd-tool', 'text-overflow:ellipsis'))

// ───────────────────────────────── 18) 复制失败可见(http 局域网) ──
const realDocument = globalThis.document
if (realDocument !== undefined) delete globalThis.document
const noClipboard = await mountPanel(payload({ tools: [TOOL] }))
await noClipboard.click('envd-tpath')
const copyNote = findOneByClass(noClipboard.tree, 'envd-copy-note')
check('18 复制兜底:两条路都失败时给可见提示', Boolean(copyNote && textOf(copyNote).includes('复制失败')), copyNote ? textOf(copyNote) : '(missing)')
check('18 复制兜底:提示区是 aria-live 状态区', Boolean(copyNote && copyNote.props['aria-live'] === 'polite' && copyNote.props.role === 'status'))
const failedPathBtn = findOneByClass(noClipboard.tree, 'envd-tpath')
check('18 复制兜底:失败时不假报成功(路径按钮文案不变)', Boolean(failedPathBtn) && !textOf(failedPathBtn).startsWith('✓') && textOf(failedPathBtn) === TOOL.defaultPath, failedPathBtn ? textOf(failedPathBtn) : '(missing)')

// ───────────────────────────────── 19) 复制兜底:没有 clipboard API 时用 execCommand ──
const execCalls = []
if (globalThis.document !== undefined) delete globalThis.document
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
  await copied.click('envd-tpath')
  check('19 execCommand 兜底:真的调用了 copy', execCalls.length === 1 && execCalls[0] === 'copy', JSON.stringify(execCalls))
  const pathBtn = findOneByClass(copied.tree, 'envd-tpath')
  check('19 execCommand 兜底:成功后有 ✓ 已复制反馈', Boolean(pathBtn && textOf(pathBtn).startsWith('✓')), pathBtn ? textOf(pathBtn) : '(missing)')
  const okNote = findOneByClass(copied.tree, 'envd-copy-note')
  check('19 execCommand 兜底:状态区同步显示已复制', Boolean(okNote) && textOf(okNote).includes('已复制'), okNote ? textOf(okNote) : '(missing)')
  check('19 execCommand 兜底:路径按钮 title 一直保留完整路径', Boolean(pathBtn) && String(pathBtn.props.title || '').includes(TOOL.defaultPath), pathBtn ? String(pathBtn.props.title) : '(missing)')
} finally {
  if (realDocument === undefined) delete globalThis.document
  else globalThis.document = realDocument
}

// ───────────────────────────────── 20) 工具链精简 + 折叠 + 底部开关 ──
const toolsPanel = await mountPanel(payload({ tools: [TOOL], issues: [{ level: 'warn', title: 'stale path', detail: 'C:/gone' }] }))
const pathButtons = findAllByClass(toolsPanel.tree, 'envd-tpath')
check('20 工具:路径是可点击按钮(无独立复制按钮)', pathButtons.length === 1 && isButton(pathButtons[0]) && textOf(pathButtons[0]) === TOOL.defaultPath, describeAll(pathButtons))
const toolRow = findAllByClass(toolsPanel.tree, 'envd-trow')[0]
check('20 工具:一行一个工具(分组/名字/版本/路径都在同一行)', Boolean(toolRow) && textOf(findOneByClass(toolRow, 'envd-tgroup')) === '运行时' && textOf(findOneByClass(toolRow, 'envd-tname')) === TOOL.label && textOf(findOneByClass(toolRow, 'envd-tver')) === 'v' + TOOL.defaultVersion, toolRow ? describe(toolRow) : '(missing)')
check('20 工具:多版本默认折叠', findAllByClass(toolsPanel.tree, 'envd-vrow').length === 0)
const versionBtn = (() => { const tact = findOneByClass(toolRow || null, 'envd-tact'); return tact ? buttonsIn(tact)[0] : null })()
check('20 工具:多版本按钮在 .envd-tact 里,文案带候选数', Boolean(versionBtn) && textOf(versionBtn).includes(String(TOOL.versions.length) + ' 个版本') && versionBtn.props['aria-expanded'] === false, versionBtn ? textOf(versionBtn) : '(missing)')
await toolsPanel.clickNode(versionBtn)
check('20 工具:点版本按钮后候选数 === versions 长度', findAllByClass(toolsPanel.tree, 'envd-vrow').length === TOOL.versions.length, 'vrows=' + findAllByClass(toolsPanel.tree, 'envd-vrow').length)
check('20 工具:展开后标出当前默认版本', findAllByClass(toolsPanel.tree, 'envd-vrow').filter((el) => classTokens(el).includes('on')).length === 1 && Boolean(findOneByClass(toolsPanel.tree, 'envd-cur')), describeAll(findAllByClass(toolsPanel.tree, 'envd-vrow')))
check('20 健康检查:有问题时默认折叠一行(⚠ N 项 + 首条标题)', !findOneByClass(toolsPanel.tree, 'envd-issues') && Boolean(findOneByClass(toolsPanel.tree, 'envd-fold-health')) && (() => { const flag = findWithClasses(toolsPanel.tree, 'envd-flag', 'warn'); return Boolean(flag) && textOf(flag).includes('1 项') })() && textOf(findOneByClass(toolsPanel.tree, 'envd-fold-health')).includes('stale path'), Boolean(findOneByClass(toolsPanel.tree, 'envd-fold-health')) ? textOf(findOneByClass(toolsPanel.tree, 'envd-fold-health')) : '(missing)')
await toolsPanel.click('envd-fold-health')
const issueNodes = findAllByClass(toolsPanel.tree, 'envd-issue')
check('20 健康检查:点开后条数 === issues 长度', issueNodes.length === 1, 'issues=' + issueNodes.length)
check('20 健康检查:条目按 level 上色(warn)且带标题+详情', Boolean(issueNodes[0]) && hasClass(issueNodes[0].props.className, 'warn') && textOf(issueNodes[0]).includes('stale path') && textOf(issueNodes[0]).includes('C:/gone'), describeAll(issueNodes))
const errorIssues = await mountPanel(payload({ tools: [TOOL], issues: [{ level: 'error', title: 'bad path', detail: 'C:/nope' }, { level: 'warn', title: 'stale', detail: 'C:/gone' }] }))
check('20 健康检查:有 error 级时折叠行是 bad 色且计数为 2', Boolean(findWithClasses(errorIssues.tree, 'envd-flag', 'bad')) && textOf(findWithClasses(errorIssues.tree, 'envd-flag', 'bad')).includes('2 项'), describeAll(findAllByClass(errorIssues.tree, 'envd-flag')))
check('20 简报:默认折叠', !findOneByClass(toolsPanel.tree, 'envd-pre'))
const briefSection = sectionByTitle(toolsPanel.tree, '环境简报')
const briefBtn = buttonByText(briefSection, '展开')
check('20 简报:分组标题在,展开按钮在', Boolean(findTag(briefSection, 'h2')) && Boolean(briefBtn))
await toolsPanel.clickNode(briefBtn)
const briefPre = findOneByClass(toolsPanel.tree, 'envd-pre')
check('20 简报:点开后出现正文(.envd-pre)', Boolean(briefPre))
check('20 简报:关掉注入时正文说明简报注入已关闭', Boolean(briefPre) && textOf(briefPre).includes('简报注入已关闭'), briefPre ? textOf(briefPre) : '(missing)')
check('20 底部:有数据时两个开关(简报注入 + 允许局域网)', findAllByClass(toolsPanel.tree, 'envd-switch').length === 2, 'switches=' + findAllByClass(toolsPanel.tree, 'envd-switch').length)
check('20 底部:开关带 aria-pressed + aria-label(可访问)', findAllByClass(toolsPanel.tree, 'envd-switch').every((el) => typeof el.props['aria-pressed'] === 'boolean' && typeof el.props['aria-label'] === 'string'))
check('20 底部:脚注有环境信息', textOf(findOneByClass(toolsPanel.tree, 'envd-footmeta') || '').includes('x64') && textOf(findOneByClass(toolsPanel.tree, 'envd-footmeta') || '').includes('更新于'), textOf(findOneByClass(toolsPanel.tree, 'envd-footmeta') || '(missing)'))

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
const noDataErr = findOneByClass(noData.tree, 'envd-err')
check('22 无数据:显示错误框(带 HTTP 状态)', Boolean(noDataErr) && textOf(noDataErr).includes('HTTP 403'), noDataErr ? textOf(noDataErr) : '(missing)')
check('22 无数据:不渲染接管卡片', !findOneByClass(noData.tree, 'envd-card'))
check('22 无数据:底部只剩 allowLan 一个开关(不显示假的简报开关)', findAllByClass(noData.tree, 'envd-switch').length === 1, 'switches=' + findAllByClass(noData.tree, 'envd-switch').length)
check('22 无数据:头部没有状态 badge', headerBadges(noData.tree).length === 0)
check('22 无数据:错误框里有「重试」按钮', Boolean(noDataErr) && buttonsIn(noDataErr).some((b) => textOf(b).includes('重试')), noDataErr ? describeAll(buttonsIn(noDataErr)) : '(missing)')
check('22 无数据:不渲染骨架/工具链/简报(没数据就不摆空架子)', !findOneByClass(noData.tree, 'envd-loading') && findAllByClass(noData.tree, 'envd-skel').length === 0 && sections(noData.tree).length === 0, 'sections=' + sections(noData.tree).length)
check('22 无数据:没有脚注(不知道平台就不编)', !findOneByClass(noData.tree, 'envd-footmeta'))
check('22 无数据:.envd-copy-note 状态区仍在(复制反馈有地方放)', Boolean(findOneByClass(noData.tree, 'envd-copy-note')))

// ───────────────────────────────── 23) 真实会话 id 形态(session-<uuid>)──
// 真机 id 全是 `session-<uuid>`:直接 slice(0,8) 会让每一行都显示 "session-"。
// 现在先去掉固定前缀再截 8 位,完整 id 进 title;host+被围栏的会话行显示「沙箱」而不是「未接管」。
{
  const realScopes = [
    scopeFact({ id: 'session-9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f', kind: 'takeover', tool: 'envd_shell', hostTool: null, hostTools: [], confined: false }),
    scopeFact({ id: 'session-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d', kind: 'host', tool: 'pwsh', hostTool: 'pwsh', hostTools: ['pwsh'], visible: true, confined: true, mode: 'workspace-write' }),
  ]
  const real = await mountPanel(payload({ commandTool: commandTool({ scopes: realScopes }) }))
  await real.clickNode(cmdButton(real.tree, '会话'))
  const rows = findAllByClass(real.tree, 'envd-srow')
  const sids = findAllByClass(real.tree, 'envd-sid').map(textOf)
  const kinds = findAllByClass(real.tree, 'envd-skind').map(textOf)
  check('23 会话 id:去掉 session- 前缀后前 8 位(不是 8 个 "session-")', sids.every((t) => !t.startsWith('session') && t.length === 8 && /^[0-9a-f]{8}$/.test(t)), JSON.stringify(sids))
  check('23 会话 id:title 保留完整 id', findAllByClass(real.tree, 'envd-sid').every((el) => String(el.props.title || '').startsWith('session-')), JSON.stringify(findAllByClass(real.tree, 'envd-sid').map((el) => el.props.title)))
  check('23 会话行:host + 确定被围栏的会话显示「沙箱」而不是「未接管」', kinds.includes('沙箱') && kinds.includes('直连'), JSON.stringify(kinds))
  check('23 两行 id 不重复(逐会话表能分清谁是谁)', new Set(sids).size === 2, JSON.stringify(sids))
  check('23 会话行数 = 载荷数', rows.length === 2, 'rows=' + rows.length)
}

console.log(failed === 0 ? '\nall panel-render cases passed (' + checked + ' checks)' : '\n' + failed + '/' + checked + ' check(s) failed')
process.exit(failed === 0 ? 0 : 1)
