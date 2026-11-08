/**
 * EnvDock 面板渲染回归测试(辅助展示模型 / 增补工具 / badge 三态)。
 *
 * client.js 是浏览器脚本(`window.__ModuleLoader__.load`),不能在 Node 里 import;
 * 但它渲染出来的东西完全由 /envdock-api 的 JSON 决定 —— 所以这里用一套极简 React
 * 运行时替身(useState/useEffect/useMemo/useCallback/useRef)+ 桩 slots/locale/fetch,
 * 把 client.js 真跑起来,捕获 EnvDockPanel 的真实渲染树再按 class 断言。
 *
 * 0.5「辅助展示」模型的 DOM(规格 docs/notes/assist-model.md §2):
 *   头部   .envd-head > .envd-h1 / .envd-headline / .envd-badge(唯一状态胶囊,三态 ok|warn|muted)
 *          整个面板 0 个 .envd-statuschip;badge 是唯一的状态结论。
 *   命令卡 .envd-card
 *     .envd-row(终端 .envd-tag + .envd-chips > .envd-chip)
 *     .envd-row.envd-cmdrow(命令 .envd-tag + .envd-tool(envd_shell 或 ——)+
 *               .envd-sep(·)+ .envd-host(宿主 ops_bash · pwsh / 未识别到宿主命令工具)+ 详情按钮)
 *     .envd-notes > .envd-note —— 最多两行:未注册原因 / 围栏提示 / 环境差异提示
 *     .envd-diag-detail(点「详情」才出现):.envd-diag-stat(扫描 3 次 · 最近 12ms · 注册尝试 2)
 *       + .envd-diag-shelltools > .envd-shellchip(含 ✦)+ 最近错误(.e)
 *   没有:逐会话表(.envd-sessions/.envd-srow/…)、接管模式 chips(.envd-chips-sm)、
 *         状态胶囊(.envd-statuschip)、kind 推导、异常/让路/并存/沙箱终局的任何渲染。
 *   工具链 / 环境检查 / 简报 / 底部开关 / 轮询 / 复制兜底保持不变。
 *
 * 替身会保存并执行 effect cleanup,所以卸载路径(轮询定时器要清掉)也测得到。
 * 所有数字/文案都从载荷与 DICT 推导,不写死内部实现 —— 把 badge 换回「按会话推导」、
 * 把命令行写死「envd_shell」、把备注改成常显三条,都会直接失败。
 *
 * 零依赖,Windows 上直接 `node test/panel-render.mjs` 可跑。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', 'client.js'), 'utf8')
// client.js 内联的词典块(静态检查用:英文界面不许出现中文、词条增删要对)
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

// 一个节点可能同时带几个 class(如 envd-badge warn / envd-note warn)
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

// ───────────────────────────────── 命令卡 / 分组导航 ──
const cardOf = (tree) => {
  const card = findOneByClass(tree, 'envd-card')
  if (!card) throw new Error('渲染树里找不到 .envd-card(命令卡结构变了?现有 class: ' + classInventory(tree) + ')')
  return card
}
// 终端行 = 0,命令行 = .envd-cmdrow(不靠下标,显式 class 更稳)
const cardRows = (tree) => findAllByClass(cardOf(tree), 'envd-row')
const cmdRow = (tree) => findOneByClass(cardOf(tree), 'envd-cmdrow')
const cmdButton = (tree, label) => (cmdRow(tree) ? buttonByText(cmdRow(tree), label) : null)
const cardTags = (tree) => findAllByClass(cardOf(tree), 'envd-tag').map(textOf)
const ownTool = (tree) => findOneByClass(cmdRow(tree), 'envd-tool')
const hostNode = (tree) => findOneByClass(cmdRow(tree), 'envd-host')
const sepNode = (tree) => findOneByClass(cmdRow(tree), 'envd-sep')
const detailOf = (tree) => findOneByClass(tree, 'envd-diag-detail')
const statOf = (tree) => findOneByClass(tree, 'envd-diag-stat')
const shellChips = (tree) => findAllByClass(tree, 'envd-shellchip')
const shellChipBlock = (tree) => findOneByClass(tree, 'envd-diag-shelltools')
const noteNodes = (tree) => findAllByClass(tree, 'envd-note')
const noteClass = (el) => (el && typeof el.props.className === 'string' ? el.props.className : '')
// 备注正文 = 第 2 个子节点(第 1 个是 ⚠/· 图标)
const noteBody = (el) => textOf((el && el.children && el.children[1]) || el)
const noteTexts = (tree) => noteNodes(tree).map(noteBody)
const statusChips = (tree) => findAllByClass(tree, 'envd-statuschip')

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

// ───────────────────────────────── 载荷(0.5 新形状) ──
const syncStats = (over) => ({
  ticks: 12,
  lastAt: 1700000005000,
  intervalMs: 5000,
  detections: 3,
  lastDetectMs: 12,
  hostToolScans: 5,
  registerTries: 2,
  lastError: '',
  lastErrorAt: 0,
  ...over,
})

const HOST_TOOLS = [
  { name: 'ops_bash', family: 'bash', learned: true },
  { name: 'pwsh', family: 'pwsh', learned: false },
]

const commandTool = (over) => ({
  name: 'envd_shell',
  registered: true,
  visible: true,
  skipReason: null,
  shell: { label: 'Git Bash', family: 'bash', version: '5.3.15', path: 'E:/Git/bin/bash.exe' },
  refuseWhenConfined: true,
  hostTools: HOST_TOOLS,
  sandbox: { capable: true, present: true, defaultMode: 'workspace-write', anyUnconfined: true, confinedCount: 0, sessionCount: 1 },
  ...over,
})

const payload = (over) => ({
  ok: true,
  state: { defaultShell: 'pwsh', options: { injectBrief: false, allowLan: false }, customTools: [] },
  shell: { key: 'bash', label: 'Git Bash', family: 'bash', path: 'E:/Git/bin/bash.exe', version: '5.3.15' },
  platform: { os: 'Windows', release: '10.0.26200', version: '10.0.26200', arch: 'x64', host: 'LAPTOP-QF9MS1KH' },
  tools: [],
  terminals: [
    { key: 'pwsh', label: 'PowerShell 7', family: 'pwsh', path: 'E:/tools/pwsh7/pwsh.exe', version: '7.4.6' },
    { key: 'cmd', label: 'cmd', family: 'cmd', path: 'C:/Windows/System32/cmd.exe', version: '10.0.26200' },
  ],
  versionManagers: [],
  issues: [],
  detectedAt: 1700000000000,
  hasSubprocess: true,
  brief: 'demo brief',
  sandbox: { present: true, capable: true, defaultMode: 'workspace-write', policyKnown: true, sessionCount: 1, confinedCount: 0, anyUnconfined: true },
  syncStats: syncStats({}),
  commandTool: commandTool({}),
  ...over,
})

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

// 0.5 冻结文案(面板与用户唯一约定,改文案必须先改规格)
const COPY = {
  additive: '增补就绪',
  displayOnly: '只展示',
  confined: '围栏',
  hostPrefix: '宿主',
  hostNone: '未识别到宿主命令工具',
  hintOwn: 'EnvDock 增补的命令工具：用你的终端与 PATH',
  hintHost: '宿主命令工具：环境与 PATH 由宿主决定',
  sameFamily: (tool) => '与 ' + tool + ' 同族，EnvDock 不重复提供',
  noUnconfined: '没有无围栏会话，暂不注册',
  taken: '与其它插件同名，未注册',
  registerFailed: '注册失败，未注册',
  fence: (n) => String(n) + ' 个会话被围栏：envd_shell 会拒绝，请用宿主工具',
  envHint: '宿主工具的环境/PATH 未必等于你的；需要你的终端时用 envd_shell',
  hostTools: '宿主工具',
  lastError: '最近错误',
  diag: '详情',
  tools: '工具链',
  brief: '环境简报',
  health: '环境检查',
  healthy: '通过',
}

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

const emoji = (badges) => 'badges=' + JSON.stringify(badges.map((b) => b.cls + ' | ' + b.text))
const badgeOf = (tree) => headerBadges(tree)[0] || null
const badgeState = (tree) => {
  const badge = badgeOf(tree)
  if (!badge) return '(none)'
  return ['ok', 'warn', 'muted'].find((tone) => hasClass(badge.cls, tone)) || '?'
}
const countsText = (over = {}) => {
  const s = syncStats(over)
  return '扫描 ' + s.detections + ' 次 · 最近 ' + s.lastDetectMs + 'ms · 注册尝试 ' + s.registerTries
}
function cssText(tree) {
  let out = ''
  walk(tree, (el) => {
    if (el.type === 'style') out += flattenText(el.children)
  })
  return out
}
// 选择器可能出现在逗号列表里(如 `.envd-badge,.envd-x{...}`),按「完整选择器项」匹配
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

// ───────────────────────────────── 1) 就绪态:badge「增补就绪」+ 命令行 ──
const ready = await mountPanel(payload({}))
const readyBadges = headerBadges(ready.tree)
check('1 就绪:头部恰 1 个 badge(整棵树也只有 1 个)', readyBadges.length === 1 && findAllByClass(ready.tree, 'envd-badge').length === 1, 'head=' + readyBadges.length + ' all=' + findAllByClass(ready.tree, 'envd-badge').length)
check('1 就绪:badge 是 ok「增补就绪」', Boolean(badgeOf(ready.tree)) && hasClass(badgeOf(ready.tree).cls, 'ok') && badgeOf(ready.tree).text === COPY.additive, emoji(readyBadges))
check('1 就绪:badge 只有 ok 一个状态类(不带 warn/muted)', classTokens(findOneByClass(ready.tree, 'envd-badge')).filter((c) => ['ok', 'warn', 'muted', 'bad'].includes(c)).join(',') === 'ok')
check('1 就绪:headline 只留终端名 + 版本(默认终端来自 shell)', textOf(findOneByClass(ready.tree, 'envd-headline') || '') === 'Git Bash v5.3.15', textOf(findOneByClass(ready.tree, 'envd-headline') || '(missing)'))
check('1 就绪:命令卡存在', Boolean(findOneByClass(ready.tree, 'envd-card')))
check('1 就绪:命令卡常显标签只有 终端 / 命令', JSON.stringify(cardTags(ready.tree)) === JSON.stringify(['终端', '命令']), JSON.stringify(cardTags(ready.tree)))
check('1 就绪:命令行节点存在(.envd-cmdrow)', Boolean(cmdRow(ready.tree)))
const readyOwn = ownTool(ready.tree)
check('1 就绪:命令行首个工具名 = envd_shell(已注册不写破折号)', Boolean(readyOwn) && textOf(readyOwn) === 'envd_shell', readyOwn ? textOf(readyOwn) : '(missing)')
check('1 就绪:命令行中间是 · 分隔符', Boolean(sepNode(ready.tree)) && textOf(sepNode(ready.tree)) === '·', sepNode(ready.tree) ? textOf(sepNode(ready.tree)) : '(missing)')
const readyHost = hostNode(ready.tree)
check('1 就绪:命令行宿主段 = 宿主 + 全部宿主工具名', Boolean(readyHost) && textOf(readyHost) === COPY.hostPrefix + ' ops_bash · pwsh', readyHost ? textOf(readyHost) : '(missing)')
check('1 就绪:命令行整行文本 = envd_shell + 宿主工具列表', (() => { const t = textOf(cmdRow(ready.tree)); return t.includes('envd_shell') && t.includes('ops_bash') && t.includes('pwsh') })(), textOf(cmdRow(ready.tree) || null))
check('1 就绪:envd_shell 带 title 说明它用你的终端/PATH', String((readyOwn || {}).props && readyOwn.props.title || '') === COPY.hintOwn, JSON.stringify(readyOwn && readyOwn.props.title))
check('1 就绪:宿主段带 title 说明环境由宿主决定', String((readyHost || {}).props && readyHost.props.title || '') === COPY.hintHost, JSON.stringify(readyHost && readyHost.props.title))
check('1 就绪:整树 0 个 .envd-statuschip(状态胶囊已彻底删除)', statusChips(ready.tree).length === 0, JSON.stringify(statusChips(ready.tree).map((el) => el.props.className)))
check('1 就绪:没有任何逐会话节点(.envd-sessions/.envd-srow)', !findOneByClass(ready.tree, 'envd-sessions') && findAllByClass(ready.tree, 'envd-srow').length === 0)
check('1 就绪:没有接管模式 chips 容器(.envd-chips-sm)', findAllByClass(ready.tree, 'envd-chips-sm').length === 0)
check('1 就绪:命令卡里没有「设置」按钮(内容都在底部)', buttonsIn(cardOf(ready.tree)).every((el) => !textOf(el).includes('设置')), describeAll(buttonsIn(cardOf(ready.tree))))
check('1 就绪:常显备注恰 1 行且是环境差异提示', noteNodes(ready.tree).length === 1 && noteTexts(ready.tree)[0] === COPY.envHint, JSON.stringify(noteTexts(ready.tree)))
check('1 就绪:环境差异提示是 muted 级(不加 warn/bad 类)', noteNodes(ready.tree).length === 1 && noteClass(noteNodes(ready.tree)[0]) === 'envd-note', describeAll(noteNodes(ready.tree)))
check('1 就绪:备注最多两行(常显区没有第三行)', noteNodes(ready.tree).length <= 2, 'notes=' + noteNodes(ready.tree).length)
check('1 就绪:badge title 带上常显备注(可补充阅读)', Boolean(badgeOf(ready.tree)) && String(badgeOf(ready.tree).title || '').includes(COPY.envHint), JSON.stringify(badgeOf(ready.tree) && badgeOf(ready.tree).title))
check('1 就绪:详情默认收起(.envd-diag-detail 不出现)', !detailOf(ready.tree))
const readyDiagBtn = cmdButton(ready.tree, COPY.diag)
check('1 就绪:详情按钮默认 aria-expanded=false', Boolean(readyDiagBtn) && readyDiagBtn.props['aria-expanded'] === false, readyDiagBtn ? JSON.stringify(readyDiagBtn.props['aria-expanded']) : '(missing)')
check('1 就绪:详情按钮 title 就是扫描计数(收起时也能读到)', Boolean(readyDiagBtn) && String(readyDiagBtn.props.title || '') === countsText(), JSON.stringify(readyDiagBtn && readyDiagBtn.props.title))
check('1 就绪:默认 0 个宿主工具 chip(只在详情里)', shellChips(ready.tree).length === 0 && !shellChipBlock(ready.tree), 'chips=' + shellChips(ready.tree).length)
check('1 就绪:终端 chips = 自动 + 载荷里的终端数', findAllByClass(ready.tree, 'envd-chip').length === 1 + payload({}).terminals.length, 'chips=' + findAllByClass(ready.tree, 'envd-chip').length)
check('1 就绪:终端 chips 容器带 role=group 与可读组名', (() => { const group = findOneByClass(ready.tree, 'envd-chips'); return Boolean(group) && group.props.role === 'group' && group.props['aria-label'] === '终端' })(), describe(findOneByClass(ready.tree, 'envd-chips')))
check('1 就绪:当前终端 chip 有 aria-pressed=true', findAllByClass(ready.tree, 'envd-chip').some((el) => el.props['aria-pressed'] === true && classTokens(el).includes('on')), describeAll(findAllByClass(ready.tree, 'envd-chip')))
check('1 就绪:工具链分组有标题 + 计数尾注', Boolean(findTag(sectionByTitle(ready.tree, COPY.tools), 'h2')) && sectionTail(sectionByTitle(ready.tree, COPY.tools)).includes('个工具'), sectionTail(sectionByTitle(ready.tree, COPY.tools)))
check('1 就绪:环境检查健康时一行「✓ 通过」', (() => { const flag = findWithClasses(ready.tree, 'envd-flag', 'ok'); return Boolean(flag) && textOf(flag).includes(COPY.healthy) })(), describeAll(findAllByClass(ready.tree, 'envd-flag')))
check('1 就绪:简报分组在(默认折叠)', Boolean(sectionByTitle(ready.tree, COPY.brief)))

// ───────────────────────────────── 2) 详情:扫描计数 + 宿主工具 chips + 最近错误 ──
await ready.clickNode(readyDiagBtn)
const readyDetail = detailOf(ready.tree)
const readyStat = statOf(ready.tree)
check('2 详情:点开后出现 .envd-diag-detail', Boolean(readyDetail))
check('2 详情:扫描计数 = 扫描 N 次 · 最近 Nms · 注册尝试 N', Boolean(readyStat) && textOf(readyStat) === countsText(), readyStat ? textOf(readyStat) : '(missing)')
check('2 详情:计数分别来自 detections / lastDetectMs / registerTries', Boolean(readyStat) && textOf(readyStat).includes('扫描 ' + syncStats().detections + ' 次') && textOf(readyStat).includes('最近 ' + syncStats().lastDetectMs + 'ms') && textOf(readyStat).includes('注册尝试 ' + syncStats().registerTries), readyStat ? textOf(readyStat) : '(missing)')
check('2 详情:宿主工具引导词 + chips 都在详情块内', Boolean(shellChipBlock(ready.tree)) && textOf(shellChipBlock(ready.tree)).includes(COPY.hostTools) && findAllByClass(readyDetail, 'envd-shellchip').length === shellChips(ready.tree).length, shellChipBlock(ready.tree) ? textOf(shellChipBlock(ready.tree)) : '(missing)')
check('2 详情:chip 数量 === 载荷 hostTools 数量', shellChips(ready.tree).length === HOST_TOOLS.length, 'chips=' + shellChips(ready.tree).length + ' expect=' + HOST_TOOLS.length)
const readyChips = shellChips(ready.tree)
check('2 详情:第一个 chip 是 ops_bash · bash 且带 ✦(启发式识别)', Boolean(readyChips[0]) && textOf(readyChips[0]).includes('ops_bash') && textOf(readyChips[0]).includes('bash') && textOf(readyChips[0]).includes('✦'), readyChips[0] ? textOf(readyChips[0]) : '(missing)')
check('2 详情:第二个 chip 是 pwsh 且不带 ✦(内置名单)', Boolean(readyChips[1]) && textOf(readyChips[1]).includes('pwsh') && !textOf(readyChips[1]).includes('✦'), readyChips[1] ? textOf(readyChips[1]) : '(missing)')
check('2 详情:chip title 保留名字 + 家族 + 识别方式', String((readyChips[0] || {}).props && readyChips[0].props.title || '') === 'ops_bash · bash · 自动识别', JSON.stringify(readyChips[0] && readyChips[0].props.title))
check('2 详情:内置 chip 的 title 不带识别方式后缀', String((readyChips[1] || {}).props && readyChips[1].props.title || '') === 'pwsh · pwsh', JSON.stringify(readyChips[1] && readyChips[1].props.title))
check('2 详情:没有最近错误时不出红条目(.e)', readyDetail ? findAllByClass(readyDetail, 'e').length === 0 : false)
check('2 详情:详情块不重复摆备注(原因/提示只在常显区)', readyDetail ? findAllByClass(readyDetail, 'envd-note').length === 0 : false)
await ready.clickNode(cmdButton(ready.tree, COPY.diag))
check('2 详情:再点「详情」真的收起(不假死)', !detailOf(ready.tree))
check('2 详情:收起后 aria-expanded=false', Boolean(cmdButton(ready.tree, COPY.diag)) && cmdButton(ready.tree, COPY.diag).props['aria-expanded'] === false)
await ready.clickNode(cmdButton(ready.tree, COPY.diag))
check('2 详情:第三次点击又能展开', Boolean(detailOf(ready.tree)))

// ───────────────────────────────── 3) 同族跳过:「—」+ 原因备注 ──
const samePayload = payload({ commandTool: commandTool({ registered: false, visible: false, skipReason: 'same-family' }) })
const same = await mountPanel(samePayload)
check('3 同族:badge 是 muted「只展示」', badgeState(same.tree) === 'muted' && badgeOf(same.tree).text === COPY.displayOnly, emoji(headerBadges(same.tree)))
check('3 同族:未注册时命令行写「—」', Boolean(ownTool(same.tree)) && textOf(ownTool(same.tree)) === '—', ownTool(same.tree) ? textOf(ownTool(same.tree)) : '(missing)')
check('3 同族:宿主工具照样列出(只展示)', Boolean(hostNode(same.tree)) && textOf(hostNode(same.tree)) === COPY.hostPrefix + ' ops_bash · pwsh', hostNode(same.tree) ? textOf(hostNode(same.tree)) : '(missing)')
check('3 同族:备注 = 与 ops_bash 同族，EnvDock 不重复提供', noteNodes(same.tree).length === 1 && noteTexts(same.tree)[0] === COPY.sameFamily('ops_bash'), JSON.stringify(noteTexts(same.tree)))
check('3 同族:原因备注是 muted 级', noteClass(noteNodes(same.tree)[0]) === 'envd-note', describeAll(noteNodes(same.tree)))
check('3 同族:未注册时不说环境差异提示(用 envd_shell 是句假话)', !noteTexts(same.tree).includes(COPY.envHint), JSON.stringify(noteTexts(same.tree)))
check('3 同族:badge title 带原因', String(badgeOf(same.tree).title || '') === COPY.sameFamily('ops_bash'), JSON.stringify(badgeOf(same.tree).title))
check('3 同族:零个状态胶囊,结论只在 badge', statusChips(same.tree).length === 0)
await same.clickNode(cmdButton(same.tree, COPY.diag))
check('3 同族:详情仍能看宿主工具 chips(展示真相)', shellChips(same.tree).length === HOST_TOOLS.length, 'chips=' + shellChips(same.tree).length)
check('3 同族:详情里没有最近错误红条目', detailOf(same.tree) ? findAllByClass(detailOf(same.tree), 'e').length === 0 : false)
// 同族工具可能不是列表第一个:原因要点名真正同族的那个
const familySecond = await mountPanel(
  payload({
    commandTool: commandTool({
      registered: false,
      visible: false,
      skipReason: 'same-family',
      hostTools: [
        { name: 'pwsh', family: 'pwsh', learned: false },
        { name: 'tenant_bash', family: 'bash', learned: true },
      ],
    }),
  }),
)
check('3 同族:原因点名与终端同族的那个工具(不是列表第一个)', noteTexts(familySecond.tree)[0] === COPY.sameFamily('tenant_bash'), JSON.stringify(noteTexts(familySecond.tree)))
check('3 同族:宿主段按载荷顺序列出全部工具', textOf(hostNode(familySecond.tree)) === COPY.hostPrefix + ' pwsh · tenant_bash', textOf(hostNode(familySecond.tree)))

// ───────────────────────────────── 4) 没有无围栏会话 ──
const noUnconfined = await mountPanel(
  payload({
    commandTool: commandTool({
      registered: false,
      visible: false,
      skipReason: 'no-unconfined-session',
      sandbox: { capable: true, present: true, defaultMode: 'workspace-write', anyUnconfined: false, confinedCount: 2, sessionCount: 2 },
    }),
  }),
)
check('4 无无围栏会话:badge muted「只展示」', badgeState(noUnconfined.tree) === 'muted' && badgeOf(noUnconfined.tree).text === COPY.displayOnly, emoji(headerBadges(noUnconfined.tree)))
check('4 无无围栏会话:备注说「没有无围栏会话，暂不注册」', noteTexts(noUnconfined.tree)[0] === COPY.noUnconfined, JSON.stringify(noteTexts(noUnconfined.tree)))
check('4 无无围栏会话:命令行写「—」', textOf(ownTool(noUnconfined.tree)) === '—')
check('4 无无围栏会话:没注册就不教训「会拒绝」(备注只一行原因)', noteNodes(noUnconfined.tree).length === 1 && !noteTexts(noUnconfined.tree).some((text) => text.includes('会拒绝')), JSON.stringify(noteTexts(noUnconfined.tree)))
check('4 无无围栏会话:环境差异提示同样不出现', !noteTexts(noUnconfined.tree).includes(COPY.envHint))
check('4 无无围栏会话:badge title 带原因', String(badgeOf(noUnconfined.tree).title || '') === COPY.noUnconfined)

// ───────────────────────────────── 5) 与其它插件同名 ──
const taken = await mountPanel(payload({ commandTool: commandTool({ registered: false, visible: false, skipReason: 'taken' }) }))
check('5 同名:badge muted「只展示」', badgeState(taken.tree) === 'muted' && badgeOf(taken.tree).text === COPY.displayOnly, emoji(headerBadges(taken.tree)))
check('5 同名:备注说「与其它插件同名，未注册」', noteTexts(taken.tree)[0] === COPY.taken, JSON.stringify(noteTexts(taken.tree)))
check('5 同名:命令行写「—」', textOf(ownTool(taken.tree)) === '—')
check('5 同名:宿主工具仍列出', textOf(hostNode(taken.tree)).includes('ops_bash'))

// ───────────────────────────────── 6) 注册失败(error) ──
const regFailed = await mountPanel(payload({ commandTool: commandTool({ registered: false, visible: false, skipReason: 'error' }) }))
check('6 注册失败:badge muted「只展示」', badgeState(regFailed.tree) === 'muted' && badgeOf(regFailed.tree).text === COPY.displayOnly, emoji(headerBadges(regFailed.tree)))
check('6 注册失败:备注说「注册失败，未注册」', noteTexts(regFailed.tree)[0] === COPY.registerFailed, JSON.stringify(noteTexts(regFailed.tree)))
check('6 注册失败:失败原因染 warn(要用户看见)', hasClass(noteClass(noteNodes(regFailed.tree)[0]), 'warn'), describeAll(noteNodes(regFailed.tree)))
check('6 注册失败:命令行写「—」', textOf(ownTool(regFailed.tree)) === '—')

// ───────────────────────────────── 7) 围栏:badge warn + 两行备注 ──
const confinedPayload = payload({
  commandTool: commandTool({ sandbox: { capable: true, present: true, defaultMode: 'workspace-write', anyUnconfined: true, confinedCount: 2, sessionCount: 3 } }),
})
const confined = await mountPanel(confinedPayload)
check('7 围栏:badge 是 warn「围栏」', badgeState(confined.tree) === 'warn' && badgeOf(confined.tree).text === COPY.confined, emoji(headerBadges(confined.tree)))
check('7 围栏:围栏时工具仍是已注册的 envd_shell', textOf(ownTool(confined.tree)) === 'envd_shell')
check('7 围栏:备注恰两行(围栏 + 环境差异)', noteNodes(confined.tree).length === 2, 'notes=' + JSON.stringify(noteTexts(confined.tree)))
check('7 围栏:第一行 = N 个会话被围栏:envd_shell 会拒绝,请用宿主工具', noteTexts(confined.tree)[0] === COPY.fence(2), JSON.stringify(noteTexts(confined.tree)))
check('7 围栏:围栏备注带 warn 类与 ⚠ 图标', hasClass(noteClass(noteNodes(confined.tree)[0]), 'warn') && textOf(noteNodes(confined.tree)[0]).startsWith('⚠'), describe(noteNodes(confined.tree)[0]))
check('7 围栏:第二行仍是 muted 的环境差异提示', noteClass(noteNodes(confined.tree)[1]) === 'envd-note' && noteTexts(confined.tree)[1] === COPY.envHint, describe(noteNodes(confined.tree)[1]))
check('7 围栏:badge title 两条备注都在', Boolean(badgeOf(confined.tree)) && String(badgeOf(confined.tree).title || '').includes(COPY.fence(2)) && String(badgeOf(confined.tree).title || '').includes(COPY.envHint), JSON.stringify(badgeOf(confined.tree) && badgeOf(confined.tree).title))
check('7 围栏:围栏数量来自聚合 confinedCount(载荷 2)', noteTexts(confined.tree)[0].includes('2 个会话'), JSON.stringify(noteTexts(confined.tree)))
check('7 围栏:没有 .envd-statuschip / 逐会话节点', statusChips(confined.tree).length === 0 && !findOneByClass(confined.tree, 'envd-sessions') && findAllByClass(confined.tree, 'envd-srow').length === 0)
check('7 围栏:详情照常(扫描计数 + chips)', (await (async () => { await confined.clickNode(cmdButton(confined.tree, COPY.diag)); return Boolean(statOf(confined.tree)) && shellChips(confined.tree).length === HOST_TOOLS.length })()))

// ───────────────────────────────── 8) 没注册 + 有围栏:只展示,不教训围栏 ──
const muteAndConfined = await mountPanel(
  payload({
    commandTool: commandTool({
      registered: false,
      visible: false,
      skipReason: 'same-family',
      sandbox: { capable: true, present: true, defaultMode: 'workspace-write', anyUnconfined: false, confinedCount: 2, sessionCount: 2 },
    }),
  }),
)
check('8 未注册+围栏:badge 是 muted「只展示」(状态结论优先说没工具)', badgeState(muteAndConfined.tree) === 'muted' && badgeOf(muteAndConfined.tree).text === COPY.displayOnly, emoji(headerBadges(muteAndConfined.tree)))
check('8 未注册+围栏:只剩一句未注册原因(不重复说会拒绝)', noteNodes(muteAndConfined.tree).length === 1 && noteTexts(muteAndConfined.tree)[0] === COPY.sameFamily('ops_bash'), JSON.stringify(noteTexts(muteAndConfined.tree)))
check('8 未注册+围栏:备注永远不超过两行', noteNodes(muteAndConfined.tree).length <= 2)

// ───────────────────────────────── 9) 注册了但不可见 ──
const invisible = await mountPanel(payload({ commandTool: commandTool({ visible: false, skipReason: null }) }))
check('9 不可见:badge muted「只展示」(可见性是真相的一部分)', badgeState(invisible.tree) === 'muted' && badgeOf(invisible.tree).text === COPY.displayOnly, emoji(headerBadges(invisible.tree)))
check('9 不可见:命令行仍写 envd_shell(注册过就是注册过)', textOf(ownTool(invisible.tree)) === 'envd_shell')
check('9 不可见:没有原因时就不硬编一条备注', noteNodes(invisible.tree).length === 0, describeAll(noteNodes(invisible.tree)))

// ───────────────────────────────── 10) 一个宿主工具都没识别到 ──
const hostNone = await mountPanel(payload({ commandTool: commandTool({ hostTools: [], sandbox: { confinedCount: 0, sessionCount: 0 } }) }))
check('10 无宿主工具:命令行写「未识别到宿主命令工具」', textOf(hostNode(hostNone.tree)) === COPY.hostNone, textOf(hostNode(hostNone.tree)))
check('10 无宿主工具:envd_shell 照常显示', textOf(ownTool(hostNone.tree)) === 'envd_shell')
check('10 无宿主工具:badge 仍是 ok「增补就绪」', badgeState(hostNone.tree) === 'ok', emoji(headerBadges(hostNone.tree)))
await hostNone.clickNode(cmdButton(hostNone.tree, COPY.diag))
check('10 无宿主工具:详情 0 个 chip', shellChips(hostNone.tree).length === 0)
check('10 无宿主工具:详情用文字说明「未识别到宿主命令工具」', Boolean(shellChipBlock(hostNone.tree)) && textOf(shellChipBlock(hostNone.tree)).includes(COPY.hostNone), shellChipBlock(hostNone.tree) ? textOf(shellChipBlock(hostNone.tree)) : '(missing)')
check('10 无宿主工具:扫描计数照样有', Boolean(statOf(hostNone.tree)) && textOf(statOf(hostNone.tree)) === countsText(), statOf(hostNone.tree) ? textOf(statOf(hostNone.tree)) : '(missing)')

// ───────────────────────────────── 11) 载荷缺 commandTool(宿主还没换新形状) ──
const noCt = await mountPanel(payload({ commandTool: undefined }))
check('11 缺 commandTool:不崩,命令行写「—」', Boolean(cmdRow(noCt.tree)) && textOf(ownTool(noCt.tree)) === '—')
check('11 缺 commandTool:宿主段写「未识别到宿主命令工具」', textOf(hostNode(noCt.tree)) === COPY.hostNone)
check('11 缺 commandTool:badge 是 muted「只展示」', badgeState(noCt.tree) === 'muted', emoji(headerBadges(noCt.tree)))
check('11 缺 commandTool:一整棵树里没有状态胶囊', statusChips(noCt.tree).length === 0)

// ───────────────────────────────── 12) badge 三态互斥(唯一状态结论) ──
const triStates = [ready, same, confined].map((panel) => ({ state: badgeState(panel.tree), text: badgeOf(panel.tree).text }))
check('12 三态:ok / muted / warn 各出现一次', JSON.stringify(triStates.map((x) => x.state)) === JSON.stringify(['ok', 'muted', 'warn']), JSON.stringify(triStates))
check('12 三态:三句话分别是 增补就绪 / 只展示 / 围栏', JSON.stringify(triStates.map((x) => x.text)) === JSON.stringify([COPY.additive, COPY.displayOnly, COPY.confined]), JSON.stringify(triStates))
check('12 三态:每个面板整树只有一个 badge', [ready, same, confined].every((panel) => findAllByClass(panel.tree, 'envd-badge').length === 1))
check('12 三态:badge 不再出现 bad 色(没有「无命令工具」这种终局)', [ready, same, confined].every((panel) => !hasClass(badgeOf(panel.tree).cls, 'bad')))

// ───────────────────────────────── 13) 删掉的东西:DOM / 源码 / 词条 ──
const DEAD_CLASSES = ['envd-statuschip', 'envd-sessions', 'envd-srow', 'envd-sdot', 'envd-sid', 'envd-skind', 'envd-stool', 'envd-sreason', 'envd-chips-sm', 'envd-legacy', 'envd-diag-sum', 'envd-shelltools', 'envd-learned']
for (const dead of DEAD_CLASSES) {
  check('13 删除:' + dead + ' 渲染树里 0 个', findAllByClass(confined.tree, dead).length === 0 && findAllByClass(ready.tree, dead).length === 0, 'confined=' + findAllByClass(confined.tree, dead).length + ' ready=' + findAllByClass(ready.tree, dead).length)
}
const DEAD_SOURCE_TOKENS = [
  'envd-statuschip', 'envd-sessions', 'envd-srow', 'envd-sdot', 'envd-sid', 'envd-skind', 'envd-stool', 'envd-sreason',
  'envd-chips-sm', 'envd-legacy', 'envd-diag-sum', 'takeover', 'sandboxTakeover', 'shellTakeover', 'scopeReasons', 'scopeKind',
  'shortId', 'runtimeShellTools', 'unrestrictable', 'delegate', 'guardDenials', 'yieldTicks', 'denyApplies', 'restrict',
]
for (const token of DEAD_SOURCE_TOKENS) {
  check('13 删除:源码里不再出现 ' + token, !SOURCE.includes(token), 'still in client.js')
}
const DEAD_COPY = ['接管', '让路', '并存', '沙箱下接管', '逐会话', '异常会话', '状态胶囊']
for (const word of DEAD_COPY) {
  check('13 删除:中文界面不再出现「' + word + '」', !visibleText(confined.tree).includes(word) && !visibleText(ready.tree).includes(word) && !ZH_BLOCK.includes(word), 'zh-dict=' + ZH_BLOCK.includes(word))
}
check('13 删除:源码里没有 kind 推导残留', !SOURCE.includes("kind === 'takeover'") && !SOURCE.includes("scopeKindText") && !SOURCE.includes('badScopes'))
check('13 删除:命令卡里不再有接管设置两行(chips-sm)', findAllByClass(confined.tree, 'envd-chips-sm').length === 0 && buttonsIn(cardOf(confined.tree)).length >= 1)
check('13 删除:整树没有 .envd-note 之外的状态词', !visibleText(ready.tree).includes('未接管') && !visibleText(ready.tree).includes('工具并存'))

// 词条:新增的中英成对,删掉的中英都不在
const NEW_KEYS = ['statusAdditive', 'statusDisplayOnly', 'statusConfined', 'cmdHintEnvDock', 'cmdHintHost', 'skipSameFamily', 'skipNoUnconfined', 'skipTaken', 'envHint', 'hostToolsNone']
const keyPresent = (block, key) => new RegExp('^\\s{8}' + key + ':', 'm').test(block)
for (const key of NEW_KEYS) {
  check('13 词条:新增 ' + key + ' 中英都有', keyPresent(ZH_BLOCK, key) && keyPresent(EN_BLOCK, key), 'zh=' + keyPresent(ZH_BLOCK, key) + ' en=' + keyPresent(EN_BLOCK, key))
}
const DEAD_KEYS = ['statusTakeover', 'statusMixed', 'statusConflict', 'statusHost', 'statusSandbox', 'statusYield', 'statusAnomaly', 'statusNoTool', 'takeoverAuto', 'takeoverOn', 'takeoverOff', 'sandboxTakeover', 'sandboxDelegate', 'sandboxRefuse', 'sandboxDelegateHint', 'modeLabel', 'scopeConfined', 'scopeHidden', 'sessionKindTakeover', 'sessionKindHost', 'noteSandbox', 'notePolicyUnknown', 'diagHealthy', 'syncYieldTicks', 'syncGuardDenials', 'syncDelegate', 'nSessions', 'nDirect', 'nHost', 'nYield', 'nSandbox']
const deadPairs = DEAD_KEYS.filter((key) => keyPresent(ZH_BLOCK, key) || keyPresent(EN_BLOCK, key))
check('13 词条:接管/逐会话词条中英都已删除', deadPairs.length === 0, JSON.stringify(deadPairs))
check('13 词条:环境差异提示与围栏提示都在中英词典里', keyPresent(ZH_BLOCK, 'envHint') && keyPresent(EN_BLOCK, 'envHint') && keyPresent(ZH_BLOCK, 'noteConfined') && keyPresent(EN_BLOCK, 'noteConfined'))
check('13 词条:最近错误标签保留(详情要用)', keyPresent(ZH_BLOCK, 'noteLastError') && keyPresent(EN_BLOCK, 'noteLastError'))

// ───────────────────────────────── 14) 长名字溢出防护 ──
const LONG_NAME = 'tenant_' + 'x'.repeat(80) + '_bash'
const LONG_SHELL_LABEL = 'PowerShell ' + 'y'.repeat(60)
const longPanel = await mountPanel(
  payload({
    shell: { key: 'pwsh', label: LONG_SHELL_LABEL, family: 'pwsh', path: 'C:/very/long/pwsh.exe', version: '7.4.6' },
    syncStats: syncStats({}),
    commandTool: commandTool({ hostTools: [{ name: LONG_NAME, family: 'bash', learned: true }] }),
  }),
)
check('14 长名字:headline 保留完整终端名(靠 CSS 省略而不是截数据)', textOf(findOneByClass(longPanel.tree, 'envd-headline') || '') === LONG_SHELL_LABEL + ' v7.4.6', textOf(findOneByClass(longPanel.tree, 'envd-headline') || '(missing)'))
check('14 长名字:宿主段保留完整工具名', textOf(hostNode(longPanel.tree)) === COPY.hostPrefix + ' ' + LONG_NAME, textOf(hostNode(longPanel.tree)))
await longPanel.clickNode(cmdButton(longPanel.tree, COPY.diag))
const longChip = shellChips(longPanel.tree)[0]
check('14 长名字:chip 的 title 保留完整名字', Boolean(longChip && String(longChip.props.title || '').includes(LONG_NAME)), longChip ? String(longChip.props.title) : '(missing)')
check('14 长名字:chip 有省略号兜底(max-width)', Boolean(longChip) && classTokens(longChip).includes('envd-shellchip'))
const longCss = cssText(longPanel.tree)
check('14 溢出 CSS:headline 用 ellipsis', hasRule(longCss, '.envd-headline', 'text-overflow:ellipsis'))
check('14 溢出 CSS:错误框允许 anywhere 换行', hasRule(longCss, '.envd-err', 'overflow-wrap:anywhere'))
check('14 溢出 CSS:宿主工具 chip 有 max-width', hasRule(longCss, '.envd-shellchip', 'max-width:100%'))
check('14 溢出 CSS:宿主段允许省略', hasRule(longCss, '.envd-host', 'text-overflow:ellipsis'))
check('14 溢出 CSS:badge 允许收缩', hasRule(longCss, '.envd-badge', 'max-width:100%'))
check('14 溢出 CSS:备注文字允许 anywhere 换行', hasRule(longCss, '.envd-note', 'overflow-wrap:anywhere'))
check('14 溢出 CSS:路径按钮省略超长路径', hasRule(longCss, '.envd-tpath', 'text-overflow:ellipsis'))
check('14 溢出 CSS:命令工具名省略超长名字', hasRule(longCss, '.envd-tool', 'text-overflow:ellipsis'))
check('14 溢出 CSS:详情计数允许断行', hasRule(longCss, '.envd-diag-stat', 'word-break:break-word'))
check('14 溢出 CSS:没有逐会话选择器残留', !longCss.includes('.envd-srow') && !longCss.includes('.envd-statuschip') && !longCss.includes('.envd-chips-sm'))

// ───────────────────────────────── 15) 终端选择 / 自定义终端表单 ──
const posted = []
let termShell = 'pwsh'
const termPanel = await mountPanel(payload({}), {
  payloadFor: () => {
    const next = payload({})
    next.state.defaultShell = termShell
    return next
  },
  onPost: (init) => {
    const body = JSON.parse(init.body)
    posted.push(body)
    if (body.op === 'setShell') termShell = body.key
    return { ok: true }
  },
})
check('15 终端:点 cmd 终端 chip 提交 setShell', (() => { const chip = findAllByClass(termPanel.tree, 'envd-chip').find((el) => textOf(el) === 'cmd'); return Boolean(chip) })(), describeAll(findAllByClass(termPanel.tree, 'envd-chip')))
const cmdChip = findAllByClass(termPanel.tree, 'envd-chip').find((el) => textOf(el) === 'cmd')
await termPanel.clickNode(cmdChip)
check('15 终端:POST 体是 { op:setShell, key:cmd }', posted.length === 1 && posted[0].op === 'setShell' && posted[0].key === 'cmd', JSON.stringify(posted))
check('15 终端:切换后该 chip 标为选中(.on + aria-pressed)', (() => { const chip = findAllByClass(termPanel.tree, 'envd-chip').find((el) => textOf(el) === 'cmd'); return Boolean(chip) && classTokens(chip).includes('on') && chip.props['aria-pressed'] === true })())
check('15 终端:未选中的 chip 是老实的 aria-pressed=false', findAllByClass(termPanel.tree, 'envd-chip').filter((el) => el.props['aria-pressed'] === false).length === findAllByClass(termPanel.tree, 'envd-chip').length - 1)
const addBtn = buttonsIn(cardOf(termPanel.tree)).find((el) => textOf(el) === '+')
await termPanel.clickNode(addBtn)
check('15 自定义终端:点「+」出现表单(3 个输入)', findAllByClass(termPanel.tree, 'envd-input').length === 3, 'inputs=' + findAllByClass(termPanel.tree, 'envd-input').length)
check('15 自定义终端:表单输入带占位提示', findAllByClass(termPanel.tree, 'envd-input').every((el) => typeof el.props.placeholder === 'string' && el.props.placeholder.length > 0), JSON.stringify(findAllByClass(termPanel.tree, 'envd-input').map((el) => el.props.placeholder)))
const addSubmit = () => buttonsIn(cardOf(termPanel.tree)).find((el) => textOf(el) === '添加')
check('15 自定义终端:路径为空时「添加」是禁用的', Boolean(addSubmit()) && addSubmit().props.disabled === true, addSubmit() ? JSON.stringify(addSubmit().props.disabled) : '(missing)')
const pathInput = findAllByClass(termPanel.tree, 'envd-input')[0]
pathInput.props.onChange({ target: { value: 'C:/tools/mybash.exe' } })
await termPanel.settle()
check('15 自定义终端:填了路径后「添加」可用', Boolean(addSubmit()) && addSubmit().props.disabled === false, addSubmit() ? JSON.stringify(addSubmit().props.disabled) : '(missing)')
check('15 自定义终端:表单里有收起按钮', Boolean(buttonsIn(cardOf(termPanel.tree)).find((el) => textOf(el) === '收起')))
await termPanel.clickNode(addSubmit())
check('15 自定义终端:添加提交 setCustomShell(带路径)', posted.length === 2 && posted[1].op === 'setCustomShell' && posted[1].path === 'C:/tools/mybash.exe', JSON.stringify(posted.slice(1)))
check('15 自定义终端:添加成功后表单收起', findAllByClass(termPanel.tree, 'envd-input').length === 0, 'inputs=' + findAllByClass(termPanel.tree, 'envd-input').length)

// ───────────────────────────────── 16) 工具链(一行一个工具 + 多版本 + 管理器) ──
const toolsPanel = await mountPanel(payload({ tools: [TOOL] }))
const pathButtons = findAllByClass(toolsPanel.tree, 'envd-tpath')
check('16 工具:路径是可点击按钮(点一下复制)', pathButtons.length === 1 && isButton(pathButtons[0]) && textOf(pathButtons[0]) === TOOL.defaultPath, describeAll(pathButtons))
const toolRow = findAllByClass(toolsPanel.tree, 'envd-trow')[0]
check('16 工具:一行一个工具(分组/名字/版本/路径)', Boolean(toolRow) && textOf(findOneByClass(toolRow, 'envd-tgroup')) === '运行时' && textOf(findOneByClass(toolRow, 'envd-tname')) === TOOL.label && textOf(findOneByClass(toolRow, 'envd-tver')) === 'v' + TOOL.defaultVersion, toolRow ? describe(toolRow) : '(missing)')
check('16 工具:多版本默认折叠', findAllByClass(toolsPanel.tree, 'envd-vrow').length === 0)
const versionBtn = (() => { const tact = findOneByClass(toolRow || null, 'envd-tact'); return tact ? buttonsIn(tact)[0] : null })()
check('16 工具:多版本按钮文案带候选数', Boolean(versionBtn) && textOf(versionBtn).includes(String(TOOL.versions.length) + ' 个版本') && versionBtn.props['aria-expanded'] === false, versionBtn ? textOf(versionBtn) : '(missing)')
await toolsPanel.clickNode(versionBtn)
check('16 工具:点开候选数 === versions 长度', findAllByClass(toolsPanel.tree, 'envd-vrow').length === TOOL.versions.length, 'vrows=' + findAllByClass(toolsPanel.tree, 'envd-vrow').length)
check('16 工具:展开后标出当前默认版本', findAllByClass(toolsPanel.tree, 'envd-vrow').filter((el) => classTokens(el).includes('on')).length === 1 && Boolean(findOneByClass(toolsPanel.tree, 'envd-cur')))
check('16 工具:无工具时给空态提示', Boolean(findOneByClass(ready.tree, 'envd-empty')), describe(findOneByClass(ready.tree, 'envd-empty')))
const managersPanel = await mountPanel(payload({ versionManagers: MANAGERS }))
check('16 管理器:行数 === 载荷数量', findAllByClass(managersPanel.tree, 'envd-manager').length === MANAGERS.length, 'managers=' + findAllByClass(managersPanel.tree, 'envd-manager').length)
check('16 管理器:工具链尾注带上管理器数量', sectionTail(sectionByTitle(managersPanel.tree, COPY.tools)).includes('版本管理器') && sectionTail(sectionByTitle(managersPanel.tree, COPY.tools)).includes(String(MANAGERS.length)), sectionTail(sectionByTitle(managersPanel.tree, COPY.tools)))
const managerRows = findAllByClass(managersPanel.tree, 'envd-manager')
check('16 管理器:首行有分组名 + 激活版本标记', Boolean(managerRows[0]) && textOf(findOneByClass(managerRows[0], 'envd-tgroup')) === '版本管理器' && textOf(managerRows[0]).includes('v20.19.0'), managerRows[0] ? describe(managerRows[0]) : '(missing)')
check('16 管理器:列不出版本的管理器有说明', Boolean(managerRows[1]) && textOf(managerRows[1]).includes('没能列出'), managerRows[1] ? describe(managerRows[1]) : '(missing)')

// ───────────────────────────────── 17) 环境检查 ──
const issuePanel = await mountPanel(payload({ tools: [TOOL], issues: [{ level: 'warn', title: 'stale path', detail: 'C:/gone' }] }))
check('17 健康:有问题时默认折叠一行(⚠ N 项 + 首条标题)', !findOneByClass(issuePanel.tree, 'envd-issues') && Boolean(findOneByClass(issuePanel.tree, 'envd-fold-health')) && (() => { const flag = findWithClasses(issuePanel.tree, 'envd-flag', 'warn'); return Boolean(flag) && textOf(flag).includes('1 项') })(), describe(findOneByClass(issuePanel.tree, 'envd-fold-health')))
await issuePanel.click('envd-fold-health')
check('17 健康:点开后条数 === issues 长度', findAllByClass(issuePanel.tree, 'envd-issue').length === 1, 'issues=' + findAllByClass(issuePanel.tree, 'envd-issue').length)
const issueNode = findAllByClass(issuePanel.tree, 'envd-issue')[0]
check('17 健康:条目按 level 上色且带标题 + 详情', Boolean(issueNode) && hasClass(issueNode.props.className, 'warn') && textOf(issueNode).includes('stale path') && textOf(issueNode).includes('C:/gone'), describe(issueNode))
const errorIssues = await mountPanel(payload({ tools: [TOOL], issues: [{ level: 'error', title: 'bad path', detail: 'C:/nope' }, { level: 'warn', title: 'stale', detail: 'C:/gone' }] }))
check('17 健康:有 error 级时折叠行是 bad 色且计数 2', Boolean(findWithClasses(errorIssues.tree, 'envd-flag', 'bad')) && textOf(findWithClasses(errorIssues.tree, 'envd-flag', 'bad')).includes('2 项'), describeAll(findAllByClass(errorIssues.tree, 'envd-flag')))
check('17 健康:健康时不出现折叠行', !findOneByClass(ready.tree, 'envd-fold-health') && findAllByClass(ready.tree, 'envd-issue').length === 0)

// ───────────────────────────────── 18) 简报 ──
check('18 简报:默认折叠', !findOneByClass(ready.tree, 'envd-pre'))
const briefSection = sectionByTitle(ready.tree, COPY.brief)
const briefBtn = buttonByText(briefSection, '展开')
check('18 简报:分组标题 + 展开按钮都在', Boolean(findTag(briefSection, 'h2')) && Boolean(briefBtn))
await ready.clickNode(briefBtn)
const briefPre = findOneByClass(ready.tree, 'envd-pre')
check('18 简报:点开后出现正文(.envd-pre)', Boolean(briefPre), briefPre ? textOf(briefPre) : '(missing)')
check('18 简报:关掉注入时正文说明注入已关闭', Boolean(briefPre) && textOf(briefPre).includes('简报注入已关闭'), briefPre ? textOf(briefPre) : '(missing)')
check('18 简报:复制按钮在分组里', Boolean(buttonByText(sectionByTitle(ready.tree, COPY.brief), '复制')))

// ───────────────────────────────── 19) 底部开关 + 脚注 ──
check('19 底部:有数据时两个开关(简报注入 + 允许局域网)', findAllByClass(ready.tree, 'envd-switch').length === 2, 'switches=' + findAllByClass(ready.tree, 'envd-switch').length)
check('19 底部:开关带 aria-pressed + aria-label', findAllByClass(ready.tree, 'envd-switch').every((el) => typeof el.props['aria-pressed'] === 'boolean' && typeof el.props['aria-label'] === 'string'))
check('19 底部:脚注有平台与更新时间', textOf(findOneByClass(ready.tree, 'envd-footmeta') || '').includes('x64') && textOf(findOneByClass(ready.tree, 'envd-footmeta') || '').includes('更新于'), textOf(findOneByClass(ready.tree, 'envd-footmeta') || '(missing)'))
check('19 底部:复制状态区在(role=status aria-live=polite)', (() => { const node = findOneByClass(ready.tree, 'envd-copy-note'); return Boolean(node) && node.props.role === 'status' && node.props['aria-live'] === 'polite' })())
const switchOn = await mountPanel(payload({ state: { defaultShell: 'bash', options: { injectBrief: true, allowLan: true }, customTools: [] } }))
check('19 底部:注入开启时开关是 on 且 aria-pressed=true', findAllByClass(switchOn.tree, 'envd-switch').filter((el) => classTokens(el).includes('on') && el.props['aria-pressed'] === true).length === 2, describeAll(findAllByClass(switchOn.tree, 'envd-switch')))
check('19 底部:注入开启时简报正文提示「已注入给 AI」', textOf(findOneByClass(sectionByTitle(switchOn.tree, COPY.brief), 'envd-sub') || '').includes('已注入给 AI'))
const switchOnBriefBtn = buttonByText(sectionByTitle(switchOn.tree, COPY.brief), '展开')
await switchOn.clickNode(switchOnBriefBtn)
check('19 底部:注入开启时展开简报能看到原文', (() => { const pre = findOneByClass(switchOn.tree, 'envd-pre'); return Boolean(pre) && textOf(pre).includes('demo brief') })(), describe(findOneByClass(switchOn.tree, 'envd-pre')))

// ───────────────────────────────── 20) 英文界面 ──
const enReady = await mountPanel(payload({}), { locale: 'en' })
const enBadge = badgeOf(enReady.tree)
check('20 en:badge 是 ok「Additive」', Boolean(enBadge) && hasClass(enBadge.cls, 'ok') && enBadge.text === 'Additive', emoji(headerBadges(enReady.tree)))
check('20 en:命令行宿主段是 host + 工具名', textOf(hostNode(enReady.tree)) === 'host ops_bash · pwsh', textOf(hostNode(enReady.tree)))
check('20 en:envd_shell 的 title 是英文提示', String((ownTool(enReady.tree) || {}).props && ownTool(enReady.tree).props.title || '') === 'EnvDock additive command tool: runs with your terminal and PATH', JSON.stringify(ownTool(enReady.tree) && ownTool(enReady.tree).props.title))
check('20 en:备注是英文环境差异提示', noteTexts(enReady.tree)[0] === 'The host tool environment/PATH may differ from yours; use envd_shell for your terminal', JSON.stringify(noteTexts(enReady.tree)))
const enConfined = await mountPanel(payload({ commandTool: commandTool({ sandbox: { confinedCount: 2, sessionCount: 3, anyUnconfined: true } }) }), { locale: 'en' })
check('20 en:围栏态 badge 是「Confined」', badgeState(enConfined.tree) === 'warn' && badgeOf(enConfined.tree).text === 'Confined', emoji(headerBadges(enConfined.tree)))
check('20 en:围栏备注是英文且带数量', noteTexts(enConfined.tree)[0] === '2 sessions are confined: envd_shell will refuse; use the host tool', JSON.stringify(noteTexts(enConfined.tree)))
const enMuted = await mountPanel(payload({ commandTool: commandTool({ registered: false, visible: false, skipReason: 'same-family' }) }), { locale: 'en' })
check('20 en:未注册 badge 是「Display only」', badgeState(enMuted.tree) === 'muted' && badgeOf(enMuted.tree).text === 'Display only', emoji(headerBadges(enMuted.tree)))
check('20 en:同族原因备注是英文', noteTexts(enMuted.tree)[0] === 'Same family as ops_bash; EnvDock does not duplicate it', JSON.stringify(noteTexts(enMuted.tree)))
check('20 en:详情按钮文案是 Details', Boolean(cmdButton(enReady.tree, 'Details')))
const enTitleAttrs = []
walk(enConfined.tree, (el) => {
  if (el.props && typeof el.props.title === 'string') enTitleAttrs.push(el.props.title)
})
check('20 en:渲染文本里没有中文', !/[\u4e00-\u9fa5]/.test(visibleText(enConfined.tree)), /[\u4e00-\u9fa5]+/.exec(visibleText(enConfined.tree)) ? 'leak=' + /[\u4e00-\u9fa5]+/.exec(visibleText(enConfined.tree))[0] : '')
check('20 en:title 属性里没有中文', !/[\u4e00-\u9fa5]/.test(enTitleAttrs.join('\n')), /[\u4e00-\u9fa5]+/.exec(enTitleAttrs.join('\n')) ? 'leak=' + /[\u4e00-\u9fa5]+/.exec(enTitleAttrs.join('\n'))[0] : '')
check('20 en:英文词典里没有中文', !/[\u4e00-\u9fa5]/.test(EN_BLOCK), /[\u4e00-\u9fa5]+/.exec(EN_BLOCK) ? 'leak=' + /[\u4e00-\u9fa5]+/.exec(EN_BLOCK)[0] : '')
check('20 en:整树仍只有 1 个 badge、0 个状态胶囊', findAllByClass(enConfined.tree, 'envd-badge').length === 1 && statusChips(enConfined.tree).length === 0)

// ───────────────────────────────── 21) 复制兜底:两条路都失败 ──
const realDocument = globalThis.document
if (realDocument !== undefined) delete globalThis.document
const noClipboard = await mountPanel(payload({ tools: [TOOL] }))
await noClipboard.click('envd-tpath')
const copyNote = findOneByClass(noClipboard.tree, 'envd-copy-note')
check('21 复制兜底:两条路都失败时给可见提示', Boolean(copyNote && textOf(copyNote).includes('复制失败')), copyNote ? textOf(copyNote) : '(missing)')
check('21 复制兜底:失败时不假报成功(路径按钮文案不变)', (() => { const btn = findOneByClass(noClipboard.tree, 'envd-tpath'); return Boolean(btn) && !textOf(btn).startsWith('✓') && textOf(btn) === TOOL.defaultPath })(), textOf(findOneByClass(noClipboard.tree, 'envd-tpath') || '(missing)'))

// ───────────────────────────────── 22) 复制兜底:execCommand ──
const execCalls = []
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
  check('22 execCommand:真的调用了 copy', execCalls.length === 1 && execCalls[0] === 'copy', JSON.stringify(execCalls))
  const pathBtn = findOneByClass(copied.tree, 'envd-tpath')
  check('22 execCommand:成功后有 ✓ 已复制反馈', Boolean(pathBtn && textOf(pathBtn).startsWith('✓')), pathBtn ? textOf(pathBtn) : '(missing)')
  const okNote = findOneByClass(copied.tree, 'envd-copy-note')
  check('22 execCommand:状态区同步显示已复制', Boolean(okNote) && textOf(okNote).includes('已复制'), okNote ? textOf(okNote) : '(missing)')
  check('22 execCommand:路径按钮 title 一直保留完整路径', Boolean(pathBtn) && String(pathBtn.props.title || '').includes(TOOL.defaultPath), pathBtn ? String(pathBtn.props.title) : '(missing)')
} finally {
  if (realDocument === undefined) delete globalThis.document
  else globalThis.document = realDocument
}

// ───────────────────────────────── 23) 操作失败(opError)可见且可关闭 ──
const opFailed = await mountPanel(payload({}), { onPost: () => ({ ok: false, error: 'boom' }) })
check('23 opError:操作前没有错误框', !findOneByClass(opFailed.tree, 'envd-err'))
await opFailed.click('envd-chip')
const opErrNode = findOneByClass(opFailed.tree, 'envd-err')
check('23 opError:操作失败给出可见错误框(role=alert)', Boolean(opErrNode && textOf(opErrNode).includes('boom')) && opErrNode.props.role === 'alert', opErrNode ? describe(opErrNode) : '(missing)')
check('23 opError:错误框说明「操作失败」而不是静默', Boolean(opErrNode) && textOf(opErrNode).includes('操作失败'), opErrNode ? textOf(opErrNode) : '(missing)')
const opDismiss = opErrNode ? buttonsIn(opErrNode)[0] : null
check('23 opError:错误框有可点的关闭按钮', Boolean(opDismiss), opErrNode ? describeAll(buttonsIn(opErrNode)) : '(missing)')
await opFailed.clickNode(opDismiss)
check('23 opError:点关闭后错误框消失', !findOneByClass(opFailed.tree, 'envd-err'))

// ───────────────────────────────── 24) 15s 轮询 + 去重剔除易变字段 + 卸载清定时器 ──
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
  const base = payload({})
  const cloneOf = (value) => JSON.parse(JSON.stringify(value))
  const polled = await mountPanel(base, {
    payloadFor: (callIndex) => {
      if (callIndex <= 2) return cloneOf(base)
      const next = cloneOf(base)
      if (callIndex === 3) {
        // 只有易变计数变了(宿主每 tick 都会推进):不许触发重渲染
        next.syncStats.ticks += 1
        next.syncStats.lastAt += 1
        next.syncStats.lastErrorAt += 1
        return next
      }
      next.syncStats.hostToolScans = 99
      return next
    },
  })
  check('24 轮询:挂载时只拉 1 次', polled.fetchCalls() === 1, 'fetch=' + polled.fetchCalls())
  check('24 轮询:注册 15s 定时器', intervals.length === 1 && intervals[0].ms === 15000, JSON.stringify(intervals.map((i) => i.ms)))
  intervals[0].fn()
  await new Promise((r) => setTimeout(r, 12))
  check('24 轮询:页面隐藏时不拉', polled.fetchCalls() === 1, 'fetch=' + polled.fetchCalls())
  globalThis.document = { visibilityState: 'visible' }
  intervals[0].fn()
  await new Promise((r) => setTimeout(r, 12))
  check('24 轮询:可见时才拉', polled.fetchCalls() === 2, 'fetch=' + polled.fetchCalls())
  check('24 轮询:payload 未变不重渲染', polled.isDirty() === false, 'dirty=' + polled.isDirty())
  intervals[0].fn()
  await new Promise((r) => setTimeout(r, 12))
  check('24 轮询:只有易变计数变化时不重渲染(ticks/lastAt/lastErrorAt)', polled.fetchCalls() === 3 && polled.isDirty() === false, 'fetch=' + polled.fetchCalls() + ' dirty=' + polled.isDirty())
  intervals[0].fn()
  await new Promise((r) => setTimeout(r, 12))
  check('24 轮询:实质变化(hostToolScans)才更新', polled.isDirty() === true, 'dirty=' + polled.isDirty())
  await polled.settle()
  polled.unmount()
  check('24 轮询:卸载时清掉定时器', cleared.length === 1 && cleared[0] === 1, JSON.stringify(cleared))
} finally {
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
  if (realDocumentForPoll === undefined) delete globalThis.document
  else globalThis.document = realDocumentForPoll
}

// ───────────────────────────────── 25) 读不到数据(403) ──
const noData = await mountPanel({ ok: false, error: 'HTTP 403' })
const noDataErr = findOneByClass(noData.tree, 'envd-err')
check('25 无数据:显示错误框(带 HTTP 状态)', Boolean(noDataErr) && textOf(noDataErr).includes('HTTP 403'), noDataErr ? textOf(noDataErr) : '(missing)')
check('25 无数据:不渲染命令卡', !findOneByClass(noData.tree, 'envd-card'))
check('25 无数据:头部没有状态 badge', headerBadges(noData.tree).length === 0)
check('25 无数据:底部只剩 allowLan 一个开关', findAllByClass(noData.tree, 'envd-switch').length === 1, 'switches=' + findAllByClass(noData.tree, 'envd-switch').length)
check('25 无数据:错误框里有「重试」按钮', Boolean(noDataErr) && buttonsIn(noDataErr).some((b) => textOf(b).includes('重试')))
check('25 无数据:不摆空架子(没有骨架/工具链/简报)', !findOneByClass(noData.tree, 'envd-loading') && findAllByClass(noData.tree, 'envd-skel').length === 0 && sections(noData.tree).length === 0, 'sections=' + sections(noData.tree).length)
check('25 无数据:没有脚注(不知道平台就不编)', !findOneByClass(noData.tree, 'envd-footmeta'))
check('25 无数据:.envd-copy-note 状态区仍在', Boolean(findOneByClass(noData.tree, 'envd-copy-note')))
check('25 无数据:错误重试按钮可点(点完仍报错但不崩)', (() => { const retry = noDataErr ? buttonsIn(noDataErr)[0] : null; return typeof (retry && retry.props.onClick) === 'function' })())

// ───────────────────────────────── 26) 没有 subprocess:一句警告 ──
const noSub = await mountPanel(payload({ hasSubprocess: false }))
check('26 subprocess:没有 subprocess 时给一句可见警告', textOf(noSub.tree).includes('版本探测会缺失'), (() => { const err = findOneByClass(noSub.tree, 'envd-err'); return err ? textOf(err) : '(missing)' })())
check('26 subprocess:警告不改状态(badge 仍是 ok)', badgeState(noSub.tree) === 'ok', emoji(headerBadges(noSub.tree)))
check('26 subprocess:命令卡照常渲染', Boolean(findOneByClass(noSub.tree, 'envd-card')))

// ───────────────────────────────── 27) 真实终端标签(本机实测形态) ──
const realWorld = await mountPanel(
  payload({
    shell: { key: 'pwsh', label: 'PowerShell 7', family: 'pwsh', path: 'E:/tools/pwsh7/pwsh.exe', version: '7.4.6' },
    commandTool: commandTool({ shell: { label: 'PowerShell 7', family: 'pwsh', version: '7.4.6', path: 'E:/tools/pwsh7/pwsh.exe' }, hostTools: [{ name: 'ops_bash', family: 'bash', learned: true }] }),
  }),
)
check('27 真机:headline 是 PowerShell 7 v7.4.6', textOf(findOneByClass(realWorld.tree, 'envd-headline') || '') === 'PowerShell 7 v7.4.6', textOf(findOneByClass(realWorld.tree, 'envd-headline') || '(missing)'))
check('27 真机:命令行 = envd_shell · 宿主 ops_bash', textOf(hostNode(realWorld.tree)) === COPY.hostPrefix + ' ops_bash', textOf(hostNode(realWorld.tree)))
check('27 真机:备注仍是 envd_shell 提醒(它与终端同族与否由宿主决定)', noteTexts(realWorld.tree)[0] === COPY.envHint, JSON.stringify(noteTexts(realWorld.tree)))

// ───────────────────────────────── 28) 过渡期:宿主还是旧版 API ──
// client.js 热更新、index.js 要重启才换。旧形状没有 registered / hostTools,
// 面板必须说「旧版构建」并尽量照常展示,不能显示成「— / 未识别到」。
{
  const legacyPayload = payload({
    commandTool: { name: 'envd_shell', takeover: true, visible: true, hostName: 'ops_bash', denies: ['pwsh'], sandbox: true, sandboxMode: 'workspace-write', sandboxConfined: null, sandboxDelegate: true, sandboxPolicyKnown: true, scopes: [] },
  })
  const legacy = await mountPanel(legacyPayload)
  const badge = headerBadges(legacy.tree)[0]
  check('28 旧版 API:仍按 visible 判「增补就绪」而不是「只展示」', Boolean(badge) && badge.text !== COPY.statusDisplayOnly, badge ? badge.text : '(missing)')
  check('28 旧版 API:备注明确说「旧版构建、重启 dsh」', noteTexts(legacy.tree).some((text) => text.includes('旧版') && text.includes('重启 dsh')), JSON.stringify(noteTexts(legacy.tree)))
  check('28 旧版 API:命令行仍列出 envd_shell 与宿主工具(hostName 兜底)', textOf(findOneByClass(legacy.tree, 'envd-tool') || '') === 'envd_shell' && textOf(hostNode(legacy.tree) || '').includes('ops_bash'), JSON.stringify({ own: textOf(findOneByClass(legacy.tree, 'envd-tool') || ''), host: textOf(hostNode(legacy.tree) || '') }))
  check('28 旧版 API:不渲染逐会话表等已删除节点', !findOneByClass(legacy.tree, 'envd-sessions') && findAllByClass(legacy.tree, 'envd-statuschip').length === 0)
}

console.log(failed === 0 ? '\nall panel-render cases passed (' + checked + ' checks)' : '\n' + failed + '/' + checked + ' check(s) failed')
process.exit(failed === 0 ? 0 : 1)
