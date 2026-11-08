/**
 * EnvDock 面板渲染回归测试(0.6.1 首屏收敏 / 两套语法 / badge 三态)。
 *
 * client.js 是浏览器脚本(`window.__ModuleLoader__.load`),不能在 Node 里 import;
 * 但它渲染出来的东西完全由 /envdock-api 的 JSON 决定 —— 所以这里用一套极简 React
 * 运行时替身(useState/useEffect/useMemo/useCallback/useRef)+ 桩 slots/locale/fetch,
 * 把 client.js 真跑起来,捕获 EnvDockPanel 的真实渲染树再按 class 断言。
 *
 * 0.6.1 首屏收敏后的 DOM(5 秒看懂三件事:这是什么 / AI 用什么命令环境 / 去哪改):
 *   头部   .envd-headblock > .envd-head(图标 + 标题 + 默认终端 + 1 个 badge + 重新探测)
 *                          > .envd-subtitle(一句用途说明)
 *          badge 三态白话:就绪(ok) / 受限(warn) / 只展示(muted),不再挂族后缀。
 *   命令卡 .envd-card
 *     .envd-row(终端 .envd-tag + .envd-chips > .envd-chip,chip 上不再有族小标)
 *     .envd-row.envd-cmdrow(命令 .envd-tag + .envd-fam(「bash 语法」/「PowerShell 语法」,手动带 · 手动)
 *               + .envd-tool(envd_shell 或 ——)+ .envd-host(其它：ops_bash)+ 详情按钮)
 *     .envd-notes > .envd-note —— 最多两行:未提供原因 / 受限 / 回退 / 混用 / 已隐藏 / 环境差异
 *     .envd-diag-detail(点「详情」才出现):.envd-diag-stat(扫描 / 最近 / 注册尝试 / 隐藏 / 拒绝)
 *       + .envd-diag-shelltools > .envd-shellchip(带语法标签;被隐藏的带 hidden class 划掉,
 *         只能拒绝的标「调用会被拒绝」,启发式认出的标「只展示（没有隐藏）」)+ 最近错误(.e)
 *   简报   .envd-sec(环境简报):左侧「已注入给 AI / 未注入」+ .envd-switch(注入)+ 复制 + 展开
 *   高级设置 .envd-advanced > .envd-foldrow.envd-fold-advanced(默认收起)
 *          展开后两个开关:隐藏另一族命令工具 / 允许局域网访问面板 API
 *   底部   .envd-foot —— 有数据时没有开关,只剩复制反馈 + 环境脚注;
 *          无数据(403)时保留 allowLan 一个开关(=唯一解法入口)
 *   没有:逐会话表(.envd-sessions/.envd-srow/…)、接管模式 chips(.envd-chips-sm)、
 *         状态胶囊(.envd-statuschip)、kind 推导、异常/让路/并存/沙箱终局的任何渲染。
 *   工具链 / 环境检查 / 轮询 / 复制兜底保持不变。
 *
 * 替身会保存并执行 effect cleanup,所以卸载路径(轮询定时器要清掉)也测得到。
 * 所有数字/文案都从载荷与 DICT 推导,不写死内部实现 —— 把 badge 换回「按会话推导」、
 * 把命令行写死「envd_shell」、把语法标签删掉、把高级设置展开成常显,都会直接失败。
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
// 0.6:被隐藏的名字在详情里仍然占一格(划掉),所以 chips 要分「看得见 / 已隐藏」两类。
const visibleChips = (tree) => shellChips(tree).filter((el) => !classTokens(el).includes('hidden'))
const hiddenChips = (tree) => shellChips(tree).filter((el) => classTokens(el).includes('hidden'))
// 语法标签 / 详情里的「已隐藏 / 会被拒 / 只展示」标签 / 高级设置折叠行
const famBadgeOf = (tree) => findOneByClass(cmdRow(tree), 'envd-fam')
const famBadgeText = (tree) => textOf(famBadgeOf(tree) || '')
const advancedToggle = (tree) => findOneByClass(tree, 'envd-fold-advanced')
const footerOf = (tree) => findOneByClass(tree, 'envd-foot')
const briefSwitchOf = (tree) => findOneByClass(sectionByTitle(tree, COPY.brief), 'envd-switch')
const chipLabel = (chip) => textOf(chip)
const chipByLabel = (tree, label) => findAllByClass(tree, 'envd-chip').find((el) => chipLabel(el) === label) || null
// 详情 chip 上的状态标签:被隐藏(hidden)/ 只能拒绝(refused)/ 只展示(display)
const chipsWithTag = (tree, tag) => shellChips(tree).filter((el) => classTokens(el).includes(tag))
// badge 文案 = 三态结论 · 语法族(族为空时只有结论)
const switchByLabel = (tree, label) => findAllByClass(tree, 'envd-switch').find((el) => el.props['aria-label'] === label) || null
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

// ───────────────────────────────── 载荷(0.6 两族形状) ──
const syncStats = (over) => ({
  ticks: 12,
  lastAt: 1700000005000,
  intervalMs: 5000,
  detections: 3,
  lastDetectMs: 12,
  hostToolScans: 5,
  registerTries: 2,
  restrictApplied: 0,
  guardRefusals: 0,
  lastError: '',
  lastErrorAt: 0,
  ...over,
})

// 命令工具:0.6 多了 group(工具分组)与 syntax family(bash / powershell)。
const HOST_TOOLS = [
  { name: 'ops_bash', family: 'bash', learned: true, group: 'bash' },
  { name: 'pwsh', family: 'powershell', learned: false, group: 'powershell' },
]
// bash 族会话里 PowerShell 族内置名被隐藏:hostTools 只报「此刻看得见」的那些。
const BASH_HOST_TOOLS = [{ name: 'ops_bash', family: 'bash', learned: true, group: 'bash' }]
const PWSH_HOST_TOOLS = [{ name: 'pwsh', family: 'powershell', learned: false, group: 'powershell' }]

const commandTool = (over) => ({
  name: 'envd_shell',
  registered: true,
  visible: true,
  skipReason: null,
  // 0.6:逐会话语法族(冻结形状)
  family: 'bash',
  familySource: 'auto',
  // 手动选的族不可用 → 已回退 auto(index.js 的新字段;旧载荷没有它)
  familyFallback: false,
  blockOtherFamily: true,
  hidden: [],
  refuseOnly: [],
  displayOnly: [],
  mixed: false,
  sessions: { total: 1, bash: 1, powershell: 0, other: 0 },
  shell: { label: 'Git Bash', family: 'bash', version: '5.3.15', path: 'E:/Git/bin/bash.exe' },
  refuseWhenConfined: true,
  hostTools: HOST_TOOLS,
  sandbox: { capable: true, present: true, defaultMode: 'workspace-write', anyUnconfined: true, confinedCount: 0, sessionCount: 1, delegatable: true },
  ...over,
})

const payload = (over) => ({
  ok: true,
  // 顶层族事实(0.6):这台机器的会话会被判成 bash 族(看得到 ops_bash)。
  family: 'bash',
  familySource: 'auto',
  familyFallback: false,
  state: { defaultShell: 'auto', options: { injectBrief: false, allowLan: false, blockOtherFamily: true }, customTools: [] },
  shell: { key: 'bash', label: 'Git Bash', family: 'bash', path: 'E:/Git/bin/bash.exe', version: '5.3.15' },
  platform: { os: 'Windows', release: '10.0.26200', version: '10.0.26200', arch: 'x64', host: 'LAPTOP-QF9MS1KH' },
  tools: [],
  terminals: [
    { key: 'pwsh', label: 'PowerShell 7', family: 'powershell', path: 'E:/tools/pwsh7/pwsh.exe', version: '7.4.6' },
    { key: 'cmd', label: 'cmd', family: 'cmd', path: 'C:/Windows/System32/cmd.exe', version: '10.0.26200' },
  ],
  versionManagers: [],
  issues: [],
  detectedAt: 1700000000000,
  hasSubprocess: true,
  brief: 'demo brief',
  sandbox: { present: true, capable: true, defaultMode: 'workspace-write', policyKnown: true, sessionCount: 1, confinedCount: 0, anyUnconfined: true, delegatable: true },
  syncStats: syncStats({}),
  // 默认就是这台机器此刻的样子:bash 族会话,pwsh 被隐藏。
  commandTool: commandTool({ hostTools: BASH_HOST_TOOLS, hidden: ['pwsh'] }),
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

// 0.6 冻结文案(面板与用户唯一约定,改文案必须先改规格)
const COPY = {
  additive: '就绪',
  displayOnly: '只展示',
  hostPrefix: '其它：',
  hostNone: '没有其它命令工具',
  hintOwn: 'EnvDock 提供的命令工具：用你的终端和 PATH',
  hintHost: '其它命令工具：由 dsh 提供，环境和 PATH 跟你的终端可能不一样；要用你自己的工具时用 envd_shell',
  noFamilyTerminal: '没找到可用的终端（bash 语法需要 Git Bash，PowerShell 语法需要 pwsh）',
  noUnconfined: '没有不受沙箱限制的会话，暂时不会提供 envd_shell',
  taken: '和别的插件重名了，暂时不提供 envd_shell',
  registerFailed: '没能提供命令工具（注册失败）',
  fence: (n) => '另有 ' + String(n) + ' 个会话受沙箱限制：envd_shell 在那些会话里不会执行命令，请改用其它命令工具',
  fenceSandboxed: (n) => '另有 ' + String(n) + ' 个会话受沙箱限制：envd_shell 会在沙箱内执行（文件写入可能被拒绝）',
  hiddenPwsh: (names) => '已隐藏 ' + names + '（避免两套语法混用）',
  notBlocked: 'PowerShell 的命令工具没有隐藏（开关已关）',
  noBashHost: '这个会话没有可用的 bash 命令工具，未隐藏 PowerShell 工具',
  familyFallback: '手动选的语法不可用（没有对应终端，也没有对应命令工具），已自动改回按会话选择',
  mixedNote: '手动选了 PowerShell 语法：PowerShell 与 bash 工具都在，各按自己的语法写，别混用',
  famBash: 'bash 语法',
  famPwsh: 'PowerShell 语法',
  manual: '手动',
  autoShell: '自动',
  subtitle: '告诉 AI 你的工具装在哪、用哪个版本、命令该写哪套语法。',
  advanced: '高级设置',
  hostToolHidden: '已隐藏',
  hostToolRefused: '调用会被拒绝',
  displayOnlyTag: '只展示（没有隐藏）',
  optBlockOtherFamily: '隐藏另一族命令工具',
  optBlockOtherFamilyHint: 'bash 会话里隐藏 PowerShell 的 pwsh / powershell',
  optBlockOtherFamilyHintTitle: 'bash 会话里隐藏 PowerShell 的 pwsh / powershell；关掉则两族同时可见',
  hostTools: '命令工具',
  lastError: '最近错误',
  diag: '详情',
  tools: '工具链',
  brief: '环境简报',
  health: '环境检查',
  healthy: '通过',
  injectBrief: '把环境简报注入给 AI',
  allowLan: '允许局域网访问面板 API',
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

// ───────────────────────────────── 1) 就绪态:badge「就绪」+ 命令行 ──
const ready = await mountPanel(payload({}))
const readyBadges = headerBadges(ready.tree)
check('1 就绪:头部恰 1 个 badge(整棵树也只有 1 个)', readyBadges.length === 1 && findAllByClass(ready.tree, 'envd-badge').length === 1, 'head=' + readyBadges.length + ' all=' + findAllByClass(ready.tree, 'envd-badge').length)
check('1 就绪:badge 是 ok「就绪」(白话三态,不带族后缀)', Boolean(badgeOf(ready.tree)) && hasClass(badgeOf(ready.tree).cls, 'ok') && badgeOf(ready.tree).text === COPY.additive, emoji(readyBadges))
check('1 就绪:badge 只有 ok 一个状态类(不带 warn/muted)', classTokens(findOneByClass(ready.tree, 'envd-badge')).filter((c) => ['ok', 'warn', 'muted', 'bad'].includes(c)).join(',') === 'ok')
check('1 就绪:headline 只留终端名 + 版本(默认终端来自 shell)', textOf(findOneByClass(ready.tree, 'envd-headline') || '') === 'Git Bash v5.3.15', textOf(findOneByClass(ready.tree, 'envd-headline') || '(missing)'))
check('1 就绪:命令卡存在', Boolean(findOneByClass(ready.tree, 'envd-card')))
check('1 就绪:命令卡常显标签只有 终端 / 命令', JSON.stringify(cardTags(ready.tree)) === JSON.stringify(['终端', '命令']), JSON.stringify(cardTags(ready.tree)))
check('1 就绪:命令行节点存在(.envd-cmdrow)', Boolean(cmdRow(ready.tree)))
const readyOwn = ownTool(ready.tree)
check('1 就绪:命令行首个工具名 = envd_shell(已注册不写破折号)', Boolean(readyOwn) && textOf(readyOwn) === 'envd_shell', readyOwn ? textOf(readyOwn) : '(missing)')
check('1 就绪:envd_shell 与「其它」之间没有多余分隔符', !sepNode(ready.tree), describe(sepNode(ready.tree)))
const readyHost = hostNode(ready.tree)
check('1 就绪:命令行「其它」段 = 其它：+ 此刻看得见的工具(被隐藏的不算)', Boolean(readyHost) && textOf(readyHost) === COPY.hostPrefix + 'ops_bash', readyHost ? textOf(readyHost) : '(missing)')
check('1 就绪:命令行整行 = 语法标签 + envd_shell + 其它命令工具', (() => { const t = textOf(cmdRow(ready.tree)); return t.includes('envd_shell') && t.includes('ops_bash') && t.includes(COPY.famBash) })(), textOf(cmdRow(ready.tree) || null))
check('1 就绪:命令行语法标签 = 「bash 语法」(自动选时不加后缀)', famBadgeText(ready.tree) === COPY.famBash, famBadgeText(ready.tree) || '(missing)')
check('1 就绪:语法标签用 .envd-fam class(断言不靠下标)', Boolean(famBadgeOf(ready.tree)) && classTokens(famBadgeOf(ready.tree)).includes('envd-fam'), describe(famBadgeOf(ready.tree)))
check('1 就绪:envd_shell 带 title 说明它用你的终端/PATH', String((readyOwn || {}).props && readyOwn.props.title || '') === COPY.hintOwn, JSON.stringify(readyOwn && readyOwn.props.title))
check('1 就绪:「其它」段 title 说清环境差异 + 何时用 envd_shell(原备注长句挪到这里)', String((readyHost || {}).props && readyHost.props.title || '') === COPY.hintHost && String((readyHost || {}).props && readyHost.props.title || '').includes('envd_shell'), JSON.stringify(readyHost && readyHost.props.title))
check('1 就绪:整树 0 个 .envd-statuschip(状态胶囊已彻底删除)', statusChips(ready.tree).length === 0, JSON.stringify(statusChips(ready.tree).map((el) => el.props.className)))
check('1 就绪:没有任何逐会话节点(.envd-sessions/.envd-srow)', !findOneByClass(ready.tree, 'envd-sessions') && findAllByClass(ready.tree, 'envd-srow').length === 0)
check('1 就绪:没有接管模式 chips 容器(.envd-chips-sm)', findAllByClass(ready.tree, 'envd-chips-sm').length === 0)
check('1 就绪:命令卡里没有设置按钮(注入在简报区、其余在高级设置)', buttonsIn(cardOf(ready.tree)).every((el) => !textOf(el).includes('设置')), describeAll(buttonsIn(cardOf(ready.tree))))
check('1 就绪:常显备注只剩真正需要的 1 行(已隐藏 pwsh)', noteNodes(ready.tree).length === 1 && noteTexts(ready.tree)[0] === COPY.hiddenPwsh('pwsh'), JSON.stringify(noteTexts(ready.tree)))
check('1 就绪:这一行是 muted 级(普通事实不吓人)', noteNodes(ready.tree).length === 1 && noteNodes(ready.tree).every((el) => noteClass(el) === 'envd-note'), describeAll(noteNodes(ready.tree)))
check('1 就绪:备注最多两行(常显区没有第三行)', noteNodes(ready.tree).length <= 2, 'notes=' + noteNodes(ready.tree).length)
check('1 就绪:badge title 只拼这一行备注(不再有环境差异长句)', Boolean(badgeOf(ready.tree)) && String(badgeOf(ready.tree).title || '').includes('pwsh') && !String(badgeOf(ready.tree).title || '').includes('envd_shell'), JSON.stringify(badgeOf(ready.tree) && badgeOf(ready.tree).title))
check('1 就绪:详情默认收起(.envd-diag-detail 不出现)', !detailOf(ready.tree))
const readyDiagBtn = cmdButton(ready.tree, COPY.diag)
check('1 就绪:详情按钮默认 aria-expanded=false', Boolean(readyDiagBtn) && readyDiagBtn.props['aria-expanded'] === false, readyDiagBtn ? JSON.stringify(readyDiagBtn.props['aria-expanded']) : '(missing)')
check('1 就绪:详情按钮 title 就是扫描计数(收起时也能读到)', Boolean(readyDiagBtn) && String(readyDiagBtn.props.title || '') === countsText(), JSON.stringify(readyDiagBtn && readyDiagBtn.props.title))
check('1 就绪:默认 0 个命令工具 chip(只在详情里)', shellChips(ready.tree).length === 0 && !shellChipBlock(ready.tree), 'chips=' + shellChips(ready.tree).length)
check('1 就绪:终端 chips = 自动 + 载荷里的终端数', findAllByClass(ready.tree, 'envd-chip').length === 1 + payload({}).terminals.length, 'chips=' + findAllByClass(ready.tree, 'envd-chip').length)
check('1 就绪:终端 chips 容器带 role=group 与可读组名', (() => { const group = findOneByClass(ready.tree, 'envd-chips'); return Boolean(group) && group.props.role === 'group' && group.props['aria-label'] === '终端' })(), describe(findOneByClass(ready.tree, 'envd-chips')))
check('1 就绪:当前终端 chip 有 aria-pressed=true', findAllByClass(ready.tree, 'envd-chip').some((el) => el.props['aria-pressed'] === true && classTokens(el).includes('on')), describeAll(findAllByClass(ready.tree, 'envd-chip')))
// 0.6.1:终端 chip 只写终端名(族小标已删,语法只在命令行说一次)。
check('1 就绪:auto chip 文案 = 自动', Boolean(chipByLabel(ready.tree, COPY.autoShell)) && textOf(chipByLabel(ready.tree, COPY.autoShell)) === COPY.autoShell, describeAll(findAllByClass(ready.tree, 'envd-chip')))
check('1 就绪:终端 chip 不再带族小标(bash / pwsh 只留在命令行)', findAllByClass(ready.tree, 'envd-chipfam').length === 0 && findAllByClass(ready.tree, 'envd-chiplabel').length === 0, classInventory(ready.tree))
check('1 就绪:auto chip 的 title = 按会话自动选语法族（推荐）', String((chipByLabel(ready.tree, COPY.autoShell) || {}).props && chipByLabel(ready.tree, COPY.autoShell).props.title || '') === '按会话自动选语法族（推荐）', JSON.stringify((chipByLabel(ready.tree, COPY.autoShell) || {}).props && chipByLabel(ready.tree, COPY.autoShell).props.title))
check('1 就绪:头部下一行有用途说明(.envd-subtitle)', textOf(findOneByClass(ready.tree, 'envd-subtitle') || '') === COPY.subtitle, textOf(findOneByClass(ready.tree, 'envd-subtitle') || '(missing)'))
check('1 就绪:工具链分组有标题 + 计数尾注', Boolean(findTag(sectionByTitle(ready.tree, COPY.tools), 'h2')) && sectionTail(sectionByTitle(ready.tree, COPY.tools)).includes('个工具'), sectionTail(sectionByTitle(ready.tree, COPY.tools)))
check('1 就绪:环境检查健康时一行「✓ 通过」', (() => { const flag = findWithClasses(ready.tree, 'envd-flag', 'ok'); return Boolean(flag) && textOf(flag).includes(COPY.healthy) })(), describeAll(findAllByClass(ready.tree, 'envd-flag')))
check('1 就绪:简报分组在(默认折叠)', Boolean(sectionByTitle(ready.tree, COPY.brief)))

// ───────────────────────────────── 2) 详情:扫描计数 + 命令工具 chips + 最近错误 ──
await ready.clickNode(readyDiagBtn)
const readyDetail = detailOf(ready.tree)
const readyStat = statOf(ready.tree)
check('2 详情:点开后出现 .envd-diag-detail', Boolean(readyDetail))
check('2 详情:扫描计数 = 扫描 N 次 · 最近 Nms · 注册尝试 N', Boolean(readyStat) && textOf(readyStat) === countsText(), readyStat ? textOf(readyStat) : '(missing)')
check('2 详情:计数分别来自 detections / lastDetectMs / registerTries', Boolean(readyStat) && textOf(readyStat).includes('扫描 ' + syncStats().detections + ' 次') && textOf(readyStat).includes('最近 ' + syncStats().lastDetectMs + 'ms') && textOf(readyStat).includes('注册尝试 ' + syncStats().registerTries), readyStat ? textOf(readyStat) : '(missing)')
check('2 详情:命令工具引导词 + chips 都在详情块内', Boolean(shellChipBlock(ready.tree)) && textOf(shellChipBlock(ready.tree)).includes(COPY.hostTools) && findAllByClass(readyDetail, 'envd-shellchip').length === shellChips(ready.tree).length, shellChipBlock(ready.tree) ? textOf(shellChipBlock(ready.tree)) : '(missing)')
// 0.6:hostTools 只报「此刻看得见」的;被隐藏的内置名要补一格并划掉,否则等于它凭空消失。
check('2 详情:chips = 看得见的命令工具 + 被隐藏的名字各一格', visibleChips(ready.tree).length === 1 && hiddenChips(ready.tree).length === 1, 'visible=' + visibleChips(ready.tree).length + ' hidden=' + hiddenChips(ready.tree).length)
const readyChips = shellChips(ready.tree)
check('2 详情:第一个 chip 是 ops_bash · bash 语法 且带 ✦(启发式识别)', Boolean(readyChips[0]) && textOf(readyChips[0]).includes('ops_bash') && textOf(readyChips[0]).includes(COPY.famBash) && textOf(readyChips[0]).includes('✦'), readyChips[0] ? textOf(readyChips[0]) : '(missing)')
check('2 详情:第二个 chip 是 pwsh · PowerShell 语法 且不带 ✦(内置名单)', Boolean(readyChips[1]) && textOf(readyChips[1]).includes('pwsh') && textOf(readyChips[1]).includes(COPY.famPwsh) && !textOf(readyChips[1]).includes('✦'), readyChips[1] ? textOf(readyChips[1]) : '(missing)')
check('2 详情:被隐藏的名字带 hidden class + 「已隐藏」后缀', Boolean(readyChips[1]) && classTokens(readyChips[1]).includes('hidden') && textOf(readyChips[1]).includes(COPY.hostToolHidden) && !classTokens(readyChips[0]).includes('hidden'), describeAll(readyChips))
check('2 详情:chip title 保留名字 + 语法 + 识别方式', String((readyChips[0] || {}).props && readyChips[0].props.title || '') === 'ops_bash · bash 语法 · 自动识别', JSON.stringify(readyChips[0] && readyChips[0].props.title))
check('2 详情:被隐藏 chip 的 title 也说清已隐藏', String((readyChips[1] || {}).props && readyChips[1].props.title || '') === 'pwsh · PowerShell 语法 · 已隐藏', JSON.stringify(readyChips[1] && readyChips[1].props.title))
check('2 详情:没有被拒 / 只展示的名字时 chip 不多挂标签', !textOf(readyChips[0]).includes(COPY.hostToolRefused) && !textOf(readyChips[0]).includes(COPY.displayOnlyTag), describeAll(readyChips))
check('2 详情:详情计数只有三项(没有隐藏/拒绝累计)', Boolean(readyStat) && textOf(readyStat) === countsText() && !textOf(readyStat).includes('隐藏') && !textOf(readyStat).includes('拒绝'), readyStat ? textOf(readyStat) : '(missing)')
check('2 详情:没有最近错误时不出红条目(.e)', readyDetail ? findAllByClass(readyDetail, 'e').length === 0 : false)
check('2 详情:详情块不重复摆备注(原因/提示只在常显区)', readyDetail ? findAllByClass(readyDetail, 'envd-note').length === 0 : false)
await ready.clickNode(cmdButton(ready.tree, COPY.diag))
check('2 详情:再点「详情」真的收起(不假死)', !detailOf(ready.tree))
check('2 详情:收起后 aria-expanded=false', Boolean(cmdButton(ready.tree, COPY.diag)) && cmdButton(ready.tree, COPY.diag).props['aria-expanded'] === false)
await ready.clickNode(cmdButton(ready.tree, COPY.diag))
check('2 详情:第三次点击又能展开', Boolean(detailOf(ready.tree)))

// ───────────────────────────────── 3) 没找到可用终端:「—」+ 原因备注 ──
// 0.6:skipReason 只有 'no-family-terminal' | 'no-unconfined-session' | 'taken' | 'error';
// 'same-family' 随「同族不重复提供」整条删除了。
const noTerminalPayload = payload({
  commandTool: commandTool({ registered: false, visible: false, skipReason: 'no-family-terminal', hostTools: BASH_HOST_TOOLS, hidden: ['pwsh'] }),
})
const noTerminal = await mountPanel(noTerminalPayload)
check('3 无终端:badge 是 muted「只展示」', badgeState(noTerminal.tree) === 'muted' && badgeOf(noTerminal.tree).text === COPY.displayOnly, emoji(headerBadges(noTerminal.tree)))
check('3 无终端:未注册时命令行写「—」', Boolean(ownTool(noTerminal.tree)) && textOf(ownTool(noTerminal.tree)) === '—', ownTool(noTerminal.tree) ? textOf(ownTool(noTerminal.tree)) : '(missing)')
check('3 无终端:命令工具照样列出(只展示)', Boolean(hostNode(noTerminal.tree)) && textOf(hostNode(noTerminal.tree)) === COPY.hostPrefix + 'ops_bash', hostNode(noTerminal.tree) ? textOf(hostNode(noTerminal.tree)) : '(missing)')
check('3 无终端:备注 = 没找到可用终端(两套语法各需要什么说清楚)', noteTexts(noTerminal.tree)[0] === COPY.noFamilyTerminal, JSON.stringify(noteTexts(noTerminal.tree)))
check('3 无终端:备注里点名 Git Bash 与 pwsh', noteTexts(noTerminal.tree)[0].includes('Git Bash') && noteTexts(noTerminal.tree)[0].includes('pwsh'), JSON.stringify(noteTexts(noTerminal.tree)))
check('3 无终端:原因备注是 muted 级', noteClass(noteNodes(noTerminal.tree)[0]) === 'envd-note', describeAll(noteNodes(noTerminal.tree)))
check('3 无终端:未注册时备注只说原因,不提「用你自己的工具」', !noteTexts(noTerminal.tree).some((text) => text.includes('用你自己的工具')), JSON.stringify(noteTexts(noTerminal.tree)))
check('3 无终端:badge title 带原因', String(badgeOf(noTerminal.tree).title || '').includes(COPY.noFamilyTerminal), JSON.stringify(badgeOf(noTerminal.tree).title))
check('3 无终端:零个状态胶囊,结论只在 badge', statusChips(noTerminal.tree).length === 0)
check('3 无终端:0.5 的 same-family 词条与分支都已删除', !SOURCE.includes("'same-family'") && !ZH_BLOCK.includes('skipSameFamily') && !EN_BLOCK.includes('skipSameFamily'), 'zh=' + ZH_BLOCK.includes('skipSameFamily') + ' en=' + EN_BLOCK.includes('skipSameFamily'))
await noTerminal.clickNode(cmdButton(noTerminal.tree, COPY.diag))
check('3 无终端:详情仍能看命令工具 chips(展示真相)', shellChips(noTerminal.tree).length === 2 && hiddenChips(noTerminal.tree).length === 1, describeAll(shellChips(noTerminal.tree)))
check('3 无终端:详情里没有最近错误红条目', detailOf(noTerminal.tree) ? findAllByClass(detailOf(noTerminal.tree), 'e').length === 0 : false)
// 被隐藏的名字不在 hostTools 里(dsh 只报此刻看得见的):详情要自己把两格补上并划掉。
const twoHidden = await mountPanel(payload({ commandTool: commandTool({ hidden: ['pwsh', 'powershell'], hostTools: BASH_HOST_TOOLS }) }))
await twoHidden.clickNode(cmdButton(twoHidden.tree, COPY.diag))
check('3b 隐藏两名:pwsh / powershell 都补进详情并划掉', hiddenChips(twoHidden.tree).length === 2 && textOf(twoHidden.tree).includes('powershell'), describeAll(shellChips(twoHidden.tree)))
check('3b 隐藏两名:备注点名两个名字', noteTexts(twoHidden.tree)[0] === COPY.hiddenPwsh('pwsh, powershell'), JSON.stringify(noteTexts(twoHidden.tree)))

// ───────────────────────────────── 4) 没有不受限会话 ──
const noUnconfined = await mountPanel(
  payload({
    commandTool: commandTool({
      registered: false,
      visible: false,
      skipReason: 'no-unconfined-session',
      sandbox: { capable: true, present: true, defaultMode: 'workspace-write', anyUnconfined: false, confinedCount: 2, sessionCount: 2, delegatable: false },
    }),
  }),
)
check('4 没有不受限会话:badge muted「只展示」', badgeState(noUnconfined.tree) === 'muted' && badgeOf(noUnconfined.tree).text === COPY.displayOnly, emoji(headerBadges(noUnconfined.tree)))
check('4 没有不受限会话:备注说「没有不受限的会话，暂时不会提供 envd_shell」', noteTexts(noUnconfined.tree)[0] === COPY.noUnconfined, JSON.stringify(noteTexts(noUnconfined.tree)))
check('4 没有不受限会话:命令行写「—」', textOf(ownTool(noUnconfined.tree)) === '—')
check('4 没有不受限会话:没注册就不教训「会拒绝」(备注只一行原因)', noteNodes(noUnconfined.tree).length === 1 && !noteTexts(noUnconfined.tree).some((text) => text.includes('会拒绝')), JSON.stringify(noteTexts(noUnconfined.tree)))
check('4 没有不受限会话:备注里也没有环境差异长句', !noteTexts(noUnconfined.tree).some((text) => text.includes('PATH') || text.includes('用你自己的工具')), JSON.stringify(noteTexts(noUnconfined.tree)))
check('4 没有不受限会话:badge title 带原因', String(badgeOf(noUnconfined.tree).title || '') === COPY.noUnconfined)

// ───────────────────────────────── 5) 与其它插件同名 ──
const taken = await mountPanel(payload({ commandTool: commandTool({ registered: false, visible: false, skipReason: 'taken' }) }))
check('5 同名:badge muted「只展示」', badgeState(taken.tree) === 'muted' && badgeOf(taken.tree).text === COPY.displayOnly, emoji(headerBadges(taken.tree)))
check('5 同名:备注说「与其它插件同名，未注册」', noteTexts(taken.tree)[0] === COPY.taken, JSON.stringify(noteTexts(taken.tree)))
check('5 同名:命令行写「—」', textOf(ownTool(taken.tree)) === '—')
check('5 同名:命令工具仍列出', textOf(hostNode(taken.tree)).includes('ops_bash'))

// ───────────────────────────────── 6) 注册失败(error) ──
const regFailed = await mountPanel(payload({ commandTool: commandTool({ registered: false, visible: false, skipReason: 'error' }) }))
check('6 注册失败:badge muted「只展示」', badgeState(regFailed.tree) === 'muted' && badgeOf(regFailed.tree).text === COPY.displayOnly, emoji(headerBadges(regFailed.tree)))
check('6 注册失败:备注说「注册失败，未注册」', noteTexts(regFailed.tree)[0] === COPY.registerFailed, JSON.stringify(noteTexts(regFailed.tree)))
check('6 注册失败:失败原因染 warn(要用户看见)', hasClass(noteClass(noteNodes(regFailed.tree)[0]), 'warn'), describeAll(noteNodes(regFailed.tree)))
check('6 注册失败:命令行写「—」', textOf(ownTool(regFailed.tree)) === '—')

// ───────────────────────────────── 7) 受限信息只进备注:可委托时说「会在沙箱内执行」 ──
// 面板是全局的,badge 不能拿「某些会话被限制」当面板结论;0.6.2 起受限会话能把命令交给沙箱执行器。
const confinedPayload = payload({
  commandTool: commandTool({ sandbox: { capable: true, present: true, defaultMode: 'workspace-write', anyUnconfined: true, confinedCount: 2, sessionCount: 3, delegatable: true } }),
})
const confined = await mountPanel(confinedPayload)
check('7 受限信息只进备注:badge 仍是 ok「就绪」', badgeState(confined.tree) === 'ok' && badgeOf(confined.tree).text === COPY.additive, emoji(headerBadges(confined.tree)))
check('7 受限信息只进备注:badge 不带 warn 色(不再出现「受限」)', !hasClass(badgeOf(confined.tree).cls, 'warn'))
check('7 受限信息只进备注:受限时工具仍是已注册的 envd_shell', textOf(ownTool(confined.tree)) === 'envd_shell')
check('7 受限信息只进备注:备注只剩受限一行', noteNodes(confined.tree).length === 1, 'notes=' + JSON.stringify(noteTexts(confined.tree)))
check('7 受限信息只进备注:delegatable=true 时说「会在沙箱内执行」(不再吓人)', noteTexts(confined.tree)[0] === COPY.fenceSandboxed(2) && noteTexts(confined.tree)[0].includes('会在沙箱内执行'), JSON.stringify(noteTexts(confined.tree)))
check('7 受限信息只进备注:可委托时是 muted 信息色、不带 ⚠', noteClass(noteNodes(confined.tree)[0]) === 'envd-note' && !textOf(noteNodes(confined.tree)[0]).startsWith('⚠') && textOf(noteNodes(confined.tree)[0]).startsWith('·'), describe(noteNodes(confined.tree)[0]))
check('7 受限信息只进备注:badge title 带上这一行(悬停可读)', Boolean(badgeOf(confined.tree)) && String(badgeOf(confined.tree).title || '').includes(COPY.fenceSandboxed(2)), JSON.stringify(badgeOf(confined.tree) && badgeOf(confined.tree).title))
check('7 受限信息只进备注:受限数量来自聚合 confinedCount(载荷 2)', noteTexts(confined.tree)[0].includes('2 个会话'), JSON.stringify(noteTexts(confined.tree)))
check('7 受限信息只进备注:没有 .envd-statuschip / 逐会话节点', statusChips(confined.tree).length === 0 && !findOneByClass(confined.tree, 'envd-sessions') && findAllByClass(confined.tree, 'envd-srow').length === 0)
check('7 受限信息只进备注:详情照常(扫描计数 + chips)', (await (async () => { await confined.clickNode(cmdButton(confined.tree, COPY.diag)); return Boolean(statOf(confined.tree)) && shellChips(confined.tree).length === HOST_TOOLS.length })()))
// 向后兼容:delegatable=false / 旧载荷缺字段 → 仍是 warn「不会执行命令」。
const confinedNoDelegate = await mountPanel(payload({ commandTool: commandTool({ sandbox: { capable: true, present: true, defaultMode: 'workspace-write', anyUnconfined: true, confinedCount: 2, sessionCount: 3, delegatable: false } }) }))
check('7 受限信息只进备注:delegatable=false 仍是 warn「不会执行命令」', noteTexts(confinedNoDelegate.tree)[0] === COPY.fence(2) && hasClass(noteClass(noteNodes(confinedNoDelegate.tree)[0]), 'warn') && textOf(noteNodes(confinedNoDelegate.tree)[0]).startsWith('⚠'), describe(noteNodes(confinedNoDelegate.tree)[0]))
const confinedLegacy = await mountPanel(payload({ commandTool: commandTool({ sandbox: { capable: true, present: true, defaultMode: 'workspace-write', anyUnconfined: true, confinedCount: 2, sessionCount: 3 } }) }))
check('7 受限信息只进备注:旧载荷缺 delegatable 时同样 warn(不凭空许诺能跑)', noteTexts(confinedLegacy.tree)[0] === COPY.fence(2) && hasClass(noteClass(noteNodes(confinedLegacy.tree)[0]), 'warn'), describeAll(noteNodes(confinedLegacy.tree)))
check('7 受限信息只进备注:两种说法都只占一行,不超过两行', noteNodes(confined.tree).length === 1 && noteNodes(confinedNoDelegate.tree).length === 1 && noteNodes(confinedLegacy.tree).length === 1)


// ───────────────────────────────── 8) 没注册 + 受限:只展示,不教训受限 ──
const muteAndConfined = await mountPanel(
  payload({
    commandTool: commandTool({
      registered: false,
      visible: false,
      skipReason: 'no-family-terminal',
      sandbox: { capable: true, present: true, defaultMode: 'workspace-write', anyUnconfined: false, confinedCount: 2, sessionCount: 2, delegatable: false },
    }),
  }),
)
check('8 未注册+受限:badge 是 muted「只展示」(状态结论优先说没工具)', badgeState(muteAndConfined.tree) === 'muted' && badgeOf(muteAndConfined.tree).text === COPY.displayOnly, emoji(headerBadges(muteAndConfined.tree)))
check('8 未注册+受限:只剩一句未注册原因(不重复说会拒绝)', noteNodes(muteAndConfined.tree).length === 1 && noteTexts(muteAndConfined.tree)[0] === COPY.noFamilyTerminal, JSON.stringify(noteTexts(muteAndConfined.tree)))
check('8 未注册+受限:备注永远不超过两行', noteNodes(muteAndConfined.tree).length <= 2)

// ───────────────────────────────── 9) 注册了但不可见 ──
const invisible = await mountPanel(payload({ commandTool: commandTool({ visible: false, skipReason: null }) }))
check('9 不可见:badge muted「只展示」(可见性是真相的一部分)', badgeState(invisible.tree) === 'muted' && badgeOf(invisible.tree).text === COPY.displayOnly, emoji(headerBadges(invisible.tree)))
check('9 不可见:命令行仍写 envd_shell(注册过就是注册过)', textOf(ownTool(invisible.tree)) === 'envd_shell')
check('9 不可见:没有原因时就不硬编一条备注', noteNodes(invisible.tree).length === 0, describeAll(noteNodes(invisible.tree)))

// ───────────────────────────────── 10) 一个其它命令工具都没识别到 ──
const hostNone = await mountPanel(payload({ commandTool: commandTool({ hostTools: [], sandbox: { confinedCount: 0, sessionCount: 0, delegatable: true } }) }))
check('10 无其它命令工具:命令行写「没有其它命令工具」', textOf(hostNode(hostNone.tree)) === COPY.hostNone, textOf(hostNode(hostNone.tree)))
check('10 无命令工具:envd_shell 照常显示', textOf(ownTool(hostNone.tree)) === 'envd_shell')
check('10 无命令工具:badge 仍是 ok「就绪」', badgeState(hostNone.tree) === 'ok', emoji(headerBadges(hostNone.tree)))
await hostNone.clickNode(cmdButton(hostNone.tree, COPY.diag))
check('10 无命令工具:详情 0 个 chip', shellChips(hostNone.tree).length === 0)
check('10 无其它命令工具:详情用文字说明「没有其它命令工具」', Boolean(shellChipBlock(hostNone.tree)) && textOf(shellChipBlock(hostNone.tree)).includes(COPY.hostNone), shellChipBlock(hostNone.tree) ? textOf(shellChipBlock(hostNone.tree)) : '(missing)')
check('10 无命令工具:扫描计数照样有', Boolean(statOf(hostNone.tree)) && textOf(statOf(hostNone.tree)) === countsText(), statOf(hostNone.tree) ? textOf(statOf(hostNone.tree)) : '(missing)')

// ───────────────────────────────── 11) 载荷缺 commandTool(dsh 还没换新形状) ──
const noCt = await mountPanel(payload({ commandTool: undefined }))
check('11 缺 commandTool:不崩,命令行写「—」', Boolean(cmdRow(noCt.tree)) && textOf(ownTool(noCt.tree)) === '—')
check('11 缺 commandTool:「其它」段写「没有其它命令工具」', textOf(hostNode(noCt.tree)) === COPY.hostNone)
check('11 缺 commandTool:badge 是 muted「只展示」', badgeState(noCt.tree) === 'muted', emoji(headerBadges(noCt.tree)))
check('11 缺 commandTool:一整棵树里没有状态胶囊', statusChips(noCt.tree).length === 0)

// ───────────────────────────────── 12) badge 二态互斥(唯一状态结论) ──
const twoStates = [ready, noTerminal].map((panel) => ({ state: badgeState(panel.tree), text: badgeOf(panel.tree).text }))
check('12 二态:ok / muted 各出现一次', JSON.stringify(twoStates.map((x) => x.state)) === JSON.stringify(['ok', 'muted']), JSON.stringify(twoStates))
check('12 二态:两句话分别是 就绪 / 只展示', JSON.stringify(twoStates.map((x) => x.text)) === JSON.stringify([COPY.additive, COPY.displayOnly]), JSON.stringify(twoStates))
check('12 二态:受限载荷也落在 ok(「受限」这个 badge 已删除)', badgeState(confined.tree) === 'ok' && badgeOf(confined.tree).text === COPY.additive, emoji(headerBadges(confined.tree)))
check('12 二态:每个面板整树只有一个 badge', [ready, noTerminal, confined].every((panel) => findAllByClass(panel.tree, 'envd-badge').length === 1))
check('12 二态:badge 不再出现 bad 色(没有「无命令工具」这种终局)', [ready, noTerminal, confined].every((panel) => !hasClass(badgeOf(panel.tree).cls, 'bad')))


// ───────────────────────────────── 13) 删掉的东西:DOM / 源码 / 词条 ──
const DEAD_CLASSES = ['envd-statuschip', 'envd-chipfam', 'envd-chiplabel', 'envd-sep', 'envd-sessions', 'envd-srow', 'envd-sdot', 'envd-sid', 'envd-skind', 'envd-stool', 'envd-sreason', 'envd-chips-sm', 'envd-legacy', 'envd-diag-sum', 'envd-shelltools', 'envd-learned']
for (const dead of DEAD_CLASSES) {
  check('13 删除:' + dead + ' 渲染树里 0 个', findAllByClass(confined.tree, dead).length === 0 && findAllByClass(ready.tree, dead).length === 0, 'confined=' + findAllByClass(confined.tree, dead).length + ' ready=' + findAllByClass(ready.tree, dead).length)
}
const DEAD_SOURCE_TOKENS = [
  'envd-statuschip', 'envd-sessions', 'envd-srow', 'envd-sdot', 'envd-sid', 'envd-skind', 'envd-stool', 'envd-sreason',
  'envd-chips-sm', 'envd-legacy', 'envd-diag-sum', 'takeover', 'sandboxTakeover', 'shellTakeover', 'scopeReasons', 'scopeKind',
  'shortId', 'runtimeShellTools', 'yieldTicks', 'denyApplies',
  'envd-chipfam', 'envd-chiplabel', 'envd-sep',
]
// 0.6 有意让 restrict / guard 回到事实层(隐藏计数);0.6.2 又让 delegate 回到沙箱执行,都不再当删除词。
for (const token of DEAD_SOURCE_TOKENS) {
  check('13 删除:源码里不再出现 ' + token, !SOURCE.includes(token), 'still in client.js')
}
// 0.6 删掉的 0.5 口径:同族不重复提供 / 二者都可用,优先 envd_shell。
const DEAD_COPY_06 = ['与默认终端同族', '不重复提供', '二者都可用', '优先 envd_shell', 'same-family']
for (const word of DEAD_COPY_06) {
  check('13 删除:0.5 口径「' + word + '」中英词典与源码都不再出现', !SOURCE.includes(word), 'still in client.js')
}
const DEAD_COPY = ['接管', '让路', '并存', '沙箱下接管', '逐会话', '异常会话', '状态胶囊']
for (const word of DEAD_COPY) {
  check('13 删除:中文界面不再出现「' + word + '」', !visibleText(confined.tree).includes(word) && !visibleText(ready.tree).includes(word) && !ZH_BLOCK.includes(word), 'zh-dict=' + ZH_BLOCK.includes(word))
}
check('13 删除:源码里没有 kind 推导残留', !SOURCE.includes("kind === 'takeover'") && !SOURCE.includes("scopeKindText") && !SOURCE.includes('badScopes'))
check('13 删除:命令卡里不再有接管设置两行(chips-sm)', findAllByClass(confined.tree, 'envd-chips-sm').length === 0 && buttonsIn(cardOf(confined.tree)).length >= 1)
check('13 删除:整树没有 .envd-note 之外的状态词', !visibleText(ready.tree).includes('未接管') && !visibleText(ready.tree).includes('工具并存'))

// 词条:新增的中英成对,删掉的中英都不在
const NEW_KEYS = [
  'statusAdditive', 'statusDisplayOnly', 'cmdHintEnvDock', 'cmdHintHost',
  'skipNoFamilyTerminal', 'skipNoUnconfined', 'skipTaken', 'hostToolsNone',
  // 0.6 两族词条
  'famBash', 'famPwsh', 'famManual', 'autoShellHint',
  'noteHiddenPwsh', 'noteNotBlocked', 'noteNoBashHost', 'noteFamilyFallback', 'noteMixed',
  'subtitle', 'advanced', 'briefOffDetail',
  'blockOtherFamily', 'blockOtherFamilyHint', 'blockOtherFamilyHintTitle',
  'hostToolHidden', 'hostToolRefused', 'displayOnlyTag',
]
const keyPresent = (block, key) => new RegExp('^\\s{8}' + key + ':', 'm').test(block)
for (const key of NEW_KEYS) {
  check('13 词条:新增 ' + key + ' 中英都有', keyPresent(ZH_BLOCK, key) && keyPresent(EN_BLOCK, key), 'zh=' + keyPresent(ZH_BLOCK, key) + ' en=' + keyPresent(EN_BLOCK, key))
}
const DEAD_PANEL_KEYS = ['statusConfined', 'envHint', 'dRestrictApplied', 'dGuardRefusals']
const deadPanelKeys = DEAD_PANEL_KEYS.filter((key) => keyPresent(ZH_BLOCK, key) || keyPresent(EN_BLOCK, key))
check('13 词条:0.6.1 收掉的「受限」/环境差异/累计计数词条都已删除', deadPanelKeys.length === 0, JSON.stringify(deadPanelKeys))
check('13 词条:0.5 的 skipSameFamily 已从两份词典删除', !keyPresent(ZH_BLOCK, 'skipSameFamily') && !keyPresent(EN_BLOCK, 'skipSameFamily'))
check('13 词条:语法标签中英各自成对(bash 语法 / bash syntax)', ZH_BLOCK.includes("famBash: 'bash 语法'") && EN_BLOCK.includes("famBash: 'bash syntax'") && ZH_BLOCK.includes("famPwsh: 'PowerShell 语法'") && EN_BLOCK.includes("famPwsh: 'PowerShell syntax'"))
const DEAD_KEYS = ['statusTakeover', 'statusMixed', 'statusConflict', 'statusHost', 'statusSandbox', 'statusYield', 'statusAnomaly', 'statusNoTool', 'takeoverAuto', 'takeoverOn', 'takeoverOff', 'sandboxTakeover', 'sandboxDelegate', 'sandboxRefuse', 'sandboxDelegateHint', 'modeLabel', 'scopeConfined', 'scopeHidden', 'sessionKindTakeover', 'sessionKindHost', 'noteSandbox', 'notePolicyUnknown', 'diagHealthy', 'syncYieldTicks', 'syncGuardDenials', 'syncDelegate', 'nSessions', 'nDirect', 'nHost', 'nYield', 'nSandbox']
const deadPairs = DEAD_KEYS.filter((key) => keyPresent(ZH_BLOCK, key) || keyPresent(EN_BLOCK, key))
check('13 词条:接管/逐会话词条中英都已删除', deadPairs.length === 0, JSON.stringify(deadPairs))
check('13 词条:受限提示还在中英词典里(只进备注)', keyPresent(ZH_BLOCK, 'noteConfined') && keyPresent(EN_BLOCK, 'noteConfined'))
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
check('14 长名字:「其它」段保留完整工具名', textOf(hostNode(longPanel.tree)) === COPY.hostPrefix + LONG_NAME, textOf(hostNode(longPanel.tree)))
await longPanel.clickNode(cmdButton(longPanel.tree, COPY.diag))
const longChip = shellChips(longPanel.tree)[0]
check('14 长名字:chip 的 title 保留完整名字', Boolean(longChip && String(longChip.props.title || '').includes(LONG_NAME)), longChip ? String(longChip.props.title) : '(missing)')
check('14 长名字:chip 有省略号兜底(max-width)', Boolean(longChip) && classTokens(longChip).includes('envd-shellchip'))
const longCss = cssText(longPanel.tree)
check('14 溢出 CSS:headline 用 ellipsis', hasRule(longCss, '.envd-headline', 'text-overflow:ellipsis'))
check('14 溢出 CSS:错误框允许 anywhere 换行', hasRule(longCss, '.envd-err', 'overflow-wrap:anywhere'))
check('14 溢出 CSS:命令工具 chip 有 max-width', hasRule(longCss, '.envd-shellchip', 'max-width:100%'))
check('14 溢出 CSS:「其它」段允许省略', hasRule(longCss, '.envd-host', 'text-overflow:ellipsis'))
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
check('15 终端:cmd 终端 chip 可按 label 找到(chip 内有族短标也不影响)', (() => { const chip = chipByLabel(termPanel.tree, 'cmd'); return Boolean(chip) })(), describeAll(findAllByClass(termPanel.tree, 'envd-chip')))
const cmdChip = chipByLabel(termPanel.tree, 'cmd')
await termPanel.clickNode(cmdChip)
check('15 终端:POST 体是 { op:setShell, key:cmd }', posted.length === 1 && posted[0].op === 'setShell' && posted[0].key === 'cmd', JSON.stringify(posted))
check('15 终端:切换后该 chip 标为选中(.on + aria-pressed)', (() => { const chip = chipByLabel(termPanel.tree, 'cmd'); return Boolean(chip) && classTokens(chip).includes('on') && chip.props['aria-pressed'] === true })())
check('15 终端:未选中的 chip 是老实的 aria-pressed=false', findAllByClass(termPanel.tree, 'envd-chip').filter((el) => el.props['aria-pressed'] === false).length === findAllByClass(termPanel.tree, 'envd-chip').length - 1)
check('15 终端:cmd chip 文案就是 cmd(不带族小标)', textOf(chipByLabel(termPanel.tree, 'cmd')) === 'cmd' && findAllByClass(termPanel.tree, 'envd-chipfam').length === 0, describeAll(findAllByClass(termPanel.tree, 'envd-chip')))
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

// ───────────────────────────────── 19) 底部 footer:只剩复制反馈 + 环境脚注 ──
// 首屏收敏:注入开关搬进环境简报区,其余两个开关进「高级设置」;footer 不再摆开关。
{
  let optionState = { injectBrief: false, allowLan: false, blockOtherFamily: true }
  const posted = []
  const optionPayload = () => payload({ state: { defaultShell: 'auto', options: Object.assign({}, optionState), customTools: [] } })
  const briefPanel = await mountPanel(optionPayload(), {
    payloadFor: () => optionPayload(),
    onPost: (init) => {
      const body = JSON.parse(init.body)
      posted.push(body)
      if (body.op === 'setOption' && Object.prototype.hasOwnProperty.call(body, 'injectBrief')) {
        optionState = Object.assign({}, optionState, { injectBrief: body.injectBrief })
      }
      return { ok: true }
    },
  })
  check('19 底部:footer 里没有开关(注入在简报区、其余在高级设置)', findAllByClass(footerOf(briefPanel.tree), 'envd-switch').length === 0, describeAll(findAllByClass(briefPanel.tree, 'envd-switch')))
  check('19 底部:脚注有平台与更新时间', textOf(findOneByClass(briefPanel.tree, 'envd-footmeta') || '').includes('x64') && textOf(findOneByClass(briefPanel.tree, 'envd-footmeta') || '').includes('更新于'), textOf(findOneByClass(briefPanel.tree, 'envd-footmeta') || '(missing)'))
  check('19 底部:复制状态区在(role=status aria-live=polite)', (() => { const node = findOneByClass(briefPanel.tree, 'envd-copy-note'); return Boolean(node) && node.props.role === 'status' && node.props['aria-live'] === 'polite' })())
  // 简报区那一行 = 状态 + 开关 + 复制 + 展开;开关的 aria-label 才是完整说明,左text 不重复整串。
  const briefSwitch = briefSwitchOf(briefPanel.tree)
  check('19 简报:注入开关就在简报区那一行', Boolean(briefSwitch) && briefSwitch.props['aria-label'] === COPY.injectBrief && briefSwitch.props.title === COPY.injectBrief, describe(briefSwitch))
  check('19 简报:未注入时开关 off,左侧文字 = 未注入', Boolean(briefSwitch) && !classTokens(briefSwitch).includes('on') && briefSwitch.props['aria-pressed'] === false && textOf(findOneByClass(sectionByTitle(briefPanel.tree, COPY.brief), 'envd-sub') || '').includes('未注入'), describe(briefSwitch))
  check('19 简报:简报区不重复「把环境简报注入给 AI」这串字', !textOf(sectionByTitle(briefPanel.tree, COPY.brief)).includes(COPY.injectBrief), textOf(sectionByTitle(briefPanel.tree, COPY.brief)))
  await briefPanel.clickNode(briefSwitch)
  check('19 简报:点击提交 { op:setOption, injectBrief:true }', posted.length === 1 && posted[0].op === 'setOption' && posted[0].injectBrief === true, JSON.stringify(posted))
  const briefSwitchOn = briefSwitchOf(briefPanel.tree)
  check('19 简报:开启后开关 on + aria-pressed=true', Boolean(briefSwitchOn) && classTokens(briefSwitchOn).includes('on') && briefSwitchOn.props['aria-pressed'] === true, describe(briefSwitchOn))
  check('19 简报:开启后左侧文字 = 已注入给 AI', textOf(findOneByClass(sectionByTitle(briefPanel.tree, COPY.brief), 'envd-sub') || '').includes('已注入给 AI'), textOf(sectionByTitle(briefPanel.tree, COPY.brief)))
  const briefOpenBtn = buttonByText(sectionByTitle(briefPanel.tree, COPY.brief), '展开')
  await briefPanel.clickNode(briefOpenBtn)
  check('19 简报:开启后展开能看到原文', (() => { const pre = findOneByClass(briefPanel.tree, 'envd-pre'); return Boolean(pre) && textOf(pre).includes('demo brief') })(), describe(findOneByClass(briefPanel.tree, 'envd-pre')))
}

// ───────────────────────────────── 19b) 高级设置:默认收起,展开后两个开关 ──
{
  let optionState = { injectBrief: false, allowLan: false, blockOtherFamily: true }
  const posted = []
  const optionPayload = () =>
    payload({
      state: { defaultShell: 'auto', options: Object.assign({}, optionState), customTools: [] },
      commandTool: optionState.blockOtherFamily
        ? commandTool({ hostTools: BASH_HOST_TOOLS, hidden: ['pwsh'] })
        : commandTool({ blockOtherFamily: false, hostTools: HOST_TOOLS, hidden: [] }),
    })
  const advPanel = await mountPanel(optionPayload(), {
    payloadFor: () => optionPayload(),
    onPost: (init) => {
      const body = JSON.parse(init.body)
      posted.push(body)
      if (body.op === 'setOption') {
        if (Object.prototype.hasOwnProperty.call(body, 'blockOtherFamily')) optionState = Object.assign({}, optionState, { blockOtherFamily: body.blockOtherFamily })
        if (Object.prototype.hasOwnProperty.call(body, 'allowLan')) optionState = Object.assign({}, optionState, { allowLan: body.allowLan })
      }
      return { ok: true }
    },
  })
  check('19b 高级:默认收起(没有开关,只有一行 + 展开)', !findOneByClass(advPanel.tree, 'envd-adv') && findAllByClass(findOneByClass(advPanel.tree, 'envd-advanced'), 'envd-switch').length === 0, describe(findOneByClass(advPanel.tree, 'envd-advanced')))
  const advToggle = advancedToggle(advPanel.tree)
  check('19b 高级:收起行写「高级设置」+ 右侧「展开」', Boolean(advToggle) && textOf(advToggle).includes(COPY.advanced) && textOf(advToggle).includes('展开') && advToggle.props['aria-expanded'] === false, describe(advToggle))
  check('19b 高级:收起时整面板只有简报区 1 个开关', findAllByClass(advPanel.tree, 'envd-switch').length === 1, describeAll(findAllByClass(advPanel.tree, 'envd-switch')))
  await advPanel.clickNode(advToggle)
  const advToggleOpen = advancedToggle(advPanel.tree)
  check('19b 高级:点开后 aria-expanded=true', Boolean(advToggleOpen) && advToggleOpen.props['aria-expanded'] === true)
  check('19b 高级:展开后内容包在 div.envd-adv 里,恰两个开关', Boolean(findOneByClass(advPanel.tree, 'envd-adv')) && findAllByClass(findOneByClass(advPanel.tree, 'envd-adv'), 'envd-switch').length === 2, describeAll(findAllByClass(advPanel.tree, 'envd-switch')))
  check('19b 高级:.envd-adv 有细线 + 缩进(不贴在折叠行下面)', hasRule(cssText(advPanel.tree), '.envd-adv', 'border-top:1px solid var(--dsw-alias-border-l1)') && hasRule(cssText(advPanel.tree), '.envd-adv', 'padding-top:8px'), cssText(advPanel.tree).split('\n').filter((line) => line.startsWith('.envd-adv')).join(' ;; '))
  const blockSwitch = switchByLabel(advPanel.tree, COPY.optBlockOtherFamily)
  check('19b 高级:隐藏另一族开关默认开(on + aria-pressed)', Boolean(blockSwitch) && classTokens(blockSwitch).includes('on') && blockSwitch.props['aria-pressed'] === true, describe(blockSwitch))
  check('19b 高级:可见说明只有一行短句(不再把「关掉则两族同时可见」写在面板上)', textOf(advPanel.tree).includes(COPY.optBlockOtherFamilyHint) && !textOf(advPanel.tree).includes('关掉则两族同时可见'), describe(findOneByClass(advPanel.tree, 'envd-adv')))
  check('19b 高级:长说明在开关 title 里(关掉则两族同时可见)', String((blockSwitch || {}).props && blockSwitch.props.title || '') === COPY.optBlockOtherFamilyHintTitle, JSON.stringify((blockSwitch || {}).props && blockSwitch.props.title))
  check('19b 高级:blockOtherFamily=true 时开关是 on 态(track 高亮 + knob 在右)', Boolean(blockSwitch) && classTokens(blockSwitch).includes('on') && blockSwitch.props['aria-pressed'] === true && hasRule(cssText(advPanel.tree), '.envd-switch.on', 'background:var(--dsw-alias-brand-primary)') && hasRule(cssText(advPanel.tree), '.envd-switch.on::after', 'translateX(15px)'), describe(blockSwitch))
  await advPanel.clickNode(blockSwitch)
  check('19b 高级:点击提交 { op:setOption, blockOtherFamily:false }', posted.length === 1 && posted[0].op === 'setOption' && posted[0].blockOtherFamily === false, JSON.stringify(posted))
  check('19b 高级:关掉后备注改说「PowerShell 的命令工具没有隐藏」', noteTexts(advPanel.tree).includes(COPY.notBlocked), JSON.stringify(noteTexts(advPanel.tree)))
  check('19b 高级:关掉后两族工具都在命令行里', textOf(hostNode(advPanel.tree)) === COPY.hostPrefix + 'ops_bash · pwsh', textOf(hostNode(advPanel.tree)))
  const lanSwitch = switchByLabel(advPanel.tree, COPY.allowLan)
  check('19b 高级:局域网开关默认关,title 有说明', Boolean(lanSwitch) && lanSwitch.props['aria-pressed'] === false && String(lanSwitch.props.title || '').length > 0, describe(lanSwitch))
  await advPanel.clickNode(lanSwitch)
  check('19b 高级:点击提交 { op:setOption, allowLan:true }', posted.length === 2 && posted[1].op === 'setOption' && posted[1].allowLan === true, JSON.stringify(posted))
  check('19b 高级:局域网开关开启后 on', (() => { const el = switchByLabel(advPanel.tree, COPY.allowLan); return Boolean(el) && classTokens(el).includes('on') && el.props['aria-pressed'] === true })())
}


// ───────────────────────────────── 20) 英文界面 ──
const enReady = await mountPanel(payload({}), { locale: 'en' })
const enBadge = badgeOf(enReady.tree)
check('20 en:badge 是 ok「Ready」', Boolean(enBadge) && hasClass(enBadge.cls, 'ok') && enBadge.text === 'Ready', emoji(headerBadges(enReady.tree)))
check('20 en:副标题是英文用途说明', textOf(findOneByClass(enReady.tree, 'envd-subtitle') || '') === 'Tells the agent where your tools live, which version to use, and which shell syntax to write.', textOf(findOneByClass(enReady.tree, 'envd-subtitle') || '(missing)'))
check('20 en:命令行「其它」段是 Other: + 工具名', textOf(hostNode(enReady.tree)) === 'Other: ops_bash', textOf(hostNode(enReady.tree)))
check('20 en:envd_shell 的 title 是英文提示', String((ownTool(enReady.tree) || {}).props && ownTool(enReady.tree).props.title || '') === 'Command tool provided by EnvDock: runs with your terminal and PATH', JSON.stringify(ownTool(enReady.tree) && ownTool(enReady.tree).props.title))
check('20 en:语法标签是「bash syntax」(自动不加后缀)', famBadgeText(enReady.tree) === 'bash syntax', famBadgeText(enReady.tree) || '(missing)')
check('20 en:备注只剩已隐藏一行(环境差异已进 title)', JSON.stringify(noteTexts(enReady.tree)) === JSON.stringify(['Hid pwsh (to avoid mixing the two syntaxes)']), JSON.stringify(noteTexts(enReady.tree)))
const enConfined = await mountPanel(payload({ commandTool: commandTool({ sandbox: { confinedCount: 2, sessionCount: 3, anyUnconfined: true, delegatable: true } }) }), { locale: 'en' })
check('20 en:受限也只影响备注,badge 仍是「Ready」', badgeState(enConfined.tree) === 'ok' && badgeOf(enConfined.tree).text === 'Ready', emoji(headerBadges(enConfined.tree)))
check('20 en:可委托的受限备注是 muted 英文「runs inside the sandbox」', noteTexts(enConfined.tree)[0] === '2 other sessions are sandbox-limited: envd_shell runs inside the sandbox (file writes may be refused)' && noteClass(noteNodes(enConfined.tree)[0]) === 'envd-note' && !textOf(noteNodes(enConfined.tree)[0]).startsWith('⚠'), JSON.stringify(noteTexts(enConfined.tree)))
const enMuted = await mountPanel(payload({ commandTool: commandTool({ registered: false, visible: false, skipReason: 'no-family-terminal' }) }), { locale: 'en' })
check('20 en:未提供 badge 是「Display only」', badgeState(enMuted.tree) === 'muted' && badgeOf(enMuted.tree).text === 'Display only', emoji(headerBadges(enMuted.tree)))
check('20 en:没终端的备注是英文', noteTexts(enMuted.tree)[0] === 'No usable terminal found (bash syntax needs Git Bash, PowerShell syntax needs pwsh)', JSON.stringify(noteTexts(enMuted.tree)))
const enMixed = await mountPanel(
  payload({ family: 'powershell', familySource: 'manual', commandTool: commandTool({ family: 'powershell', familySource: 'manual', mixed: true, hostTools: [PWSH_HOST_TOOLS[0], BASH_HOST_TOOLS[0]], hidden: [] }) }),
  { locale: 'en' },
)
check('20 en:混用警告是英文', noteTexts(enMixed.tree)[0] === 'PowerShell syntax was picked manually: both PowerShell and bash tools are available; write each command in its own syntax, do not mix them', JSON.stringify(noteTexts(enMixed.tree)))
check('20 en:语法标签手动时带 manual 后缀', famBadgeText(enMixed.tree) === 'PowerShell syntax · manual', famBadgeText(enMixed.tree) || '(missing)')
check('20 en:详情按钮文案是 Details', Boolean(cmdButton(enReady.tree, 'Details')))
const enTitleAttrs = []
walk(enConfined.tree, (el) => {
  if (el.props && typeof el.props.title === 'string') enTitleAttrs.push(el.props.title)
})
check('20 en:渲染文本里没有中文', !/[\u4e00-\u9fa5]/.test(visibleText(enConfined.tree)))
check('20 en:title 属性里没有中文', !/[\u4e00-\u9fa5]/.test(enTitleAttrs.join('\n')))
check('20 en:英文词典里没有中文', !/[\u4e00-\u9fa5]/.test(EN_BLOCK))
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
check('25 无数据:footer 里保留 allowLan 一个开关(唯一入口)', findAllByClass(noData.tree, 'envd-switch').length === 1 && Boolean(switchByLabel(noData.tree, COPY.allowLan)), describeAll(findAllByClass(noData.tree, 'envd-switch')))
check('25 无数据:没有高级设置(没数据就没有可改的开关)', !findOneByClass(noData.tree, 'envd-advanced') && (() => { const adv = findOneByClass(noData.tree, 'envd-advanced'); return !adv })())
check('25 无数据:用途说明仍常显(陌生人先知道这插件是干嘛的)', textOf(findOneByClass(noData.tree, 'envd-subtitle') || '') === COPY.subtitle, textOf(findOneByClass(noData.tree, 'envd-subtitle') || '(missing)'))
check('25 无数据:allowLan 开关真的可点(点完不崩)', (() => { const el = switchByLabel(noData.tree, COPY.allowLan); return Boolean(el) && typeof el.props.onClick === 'function' })())
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
// 这台机器:默认终端 PowerShell 7(手动),会话里又看得到 ops_bash → 两族同时可见。
const realWorld = await mountPanel(
  payload({
    family: 'powershell',
    familySource: 'manual',
    state: { defaultShell: 'pwsh', options: { injectBrief: true, allowLan: false, blockOtherFamily: true }, customTools: [] },
    shell: { key: 'pwsh', label: 'PowerShell 7', family: 'powershell', path: 'E:/tools/pwsh7/pwsh.exe', version: '7.4.6' },
    commandTool: commandTool({
      family: 'powershell',
      familySource: 'manual',
      mixed: true,
      hidden: [],
      hostTools: [PWSH_HOST_TOOLS[0], BASH_HOST_TOOLS[0]],
      shell: { label: 'PowerShell 7', family: 'powershell', version: '7.4.6', path: 'E:/tools/pwsh7/pwsh.exe' },
    }),
  }),
)
check('27 真机:headline 是 PowerShell 7 v7.4.6', textOf(findOneByClass(realWorld.tree, 'envd-headline') || '') === 'PowerShell 7 v7.4.6', textOf(findOneByClass(realWorld.tree, 'envd-headline') || '(missing)'))
check('27 真机:语法标签 = PowerShell 语法 · 手动', famBadgeText(realWorld.tree) === COPY.famPwsh + ' · ' + COPY.manual, famBadgeText(realWorld.tree) || '(missing)')
check('27 真机:命令行 = envd_shell · 其它：pwsh · ops_bash(手动 PowerShell 不隐藏)', textOf(hostNode(realWorld.tree)) === COPY.hostPrefix + 'pwsh · ops_bash', textOf(hostNode(realWorld.tree)))
check('27 真机:两族同时可见时第一行是混用警告', noteTexts(realWorld.tree)[0] === COPY.mixedNote, JSON.stringify(noteTexts(realWorld.tree)))
check('27 真机:混用警告是 warn 级 + ⚠ 图标', hasClass(noteClass(noteNodes(realWorld.tree)[0]), 'warn') && textOf(noteNodes(realWorld.tree)[0]).startsWith('⚠'), describe(noteNodes(realWorld.tree)[0]))
check('27 真机:备注只剩混用一行(环境差异说明在「其它」title 里)', noteNodes(realWorld.tree).length === 1 && noteTexts(realWorld.tree)[0] === COPY.mixedNote && String((hostNode(realWorld.tree) || {}).props.title || '').includes('envd_shell'), JSON.stringify(noteTexts(realWorld.tree)))
await realWorld.clickNode(cmdButton(realWorld.tree, COPY.diag))
check('27 真机:手动 PowerShell 时 0 个名字被隐藏', hiddenChips(realWorld.tree).length === 0 && visibleChips(realWorld.tree).length === 2, describeAll(shellChips(realWorld.tree)))

// ───────────────────────────────── 28) 过渡期:dsh 还是旧版 API ──
// client.js 热更新、index.js 要重启才换。旧形状没有 registered / hostTools / family,
// 面板必须说「旧版构建」并尽量照常展示,不能显示成「— / 未识别到」,也不能编一个族出来。
{
  const legacyPayload = payload({
    family: undefined,
    familySource: undefined,
    // 旧宿主的 options 里没有 blockOtherFamily:面板不许摆一个按下去只会 400 的假开关。
    state: { defaultShell: 'auto', options: { injectBrief: false, allowLan: false }, customTools: [] },
    commandTool: { name: 'envd_shell', visible: true, hostName: 'ops_bash', denies: ['pwsh'], sandbox: true, sandboxMode: 'workspace-write', sandboxConfined: null, sandboxDelegate: true, sandboxPolicyKnown: true, scopes: [] },
  })
  const legacy = await mountPanel(legacyPayload)
  const badge = headerBadges(legacy.tree)[0]
  check('28 旧版 API:仍按 visible 判「就绪」而不是「只展示」', Boolean(badge) && badge.text !== COPY.displayOnly, badge ? badge.text : '(missing)')
  check('28 旧版 API:备注明确说「旧版构建、重启 dsh」', noteTexts(legacy.tree).some((text) => text.includes('旧版') && text.includes('重启 dsh')), JSON.stringify(noteTexts(legacy.tree)))
  check('28 旧版 API:命令行仍列出 envd_shell 与命令工具(hostName 兜底)', textOf(findOneByClass(legacy.tree, 'envd-tool') || '') === 'envd_shell' && textOf(hostNode(legacy.tree) || '').includes('ops_bash'), JSON.stringify({ own: textOf(findOneByClass(legacy.tree, 'envd-tool') || ''), host: textOf(hostNode(legacy.tree) || '') }))
  check('28 旧版 API:没有族事实就不硬编语法标签', !famBadgeOf(legacy.tree), describe(famBadgeOf(legacy.tree)))
  check('28 旧版 API:badge 也不硬编族后缀(只说结论)', Boolean(badge) && badge.text === COPY.additive, badge ? badge.text : '(missing)')
check('28 旧版 API:宿主不认 blockOtherFamily 时不摆假开关', !switchByLabel(legacy.tree, COPY.optBlockOtherFamily) && findAllByClass(legacy.tree, 'envd-switch').length === 1 && Boolean(briefSwitchOf(legacy.tree)), describeAll(findAllByClass(legacy.tree, 'envd-switch')))
  check('28 旧版 API:不渲染逐会话表等已删除节点', !findOneByClass(legacy.tree, 'envd-sessions') && findAllByClass(legacy.tree, 'envd-statuschip').length === 0)
}

// ───────────────────────────────── 29) 语法标签:bash / PowerShell / 无法判断 ──
{
  const famPwshManual = await mountPanel(
    payload({
      family: 'powershell',
      familySource: 'manual',
      state: { defaultShell: 'pwsh', options: { injectBrief: false, allowLan: false, blockOtherFamily: true }, customTools: [] },
      shell: { key: 'pwsh', label: 'PowerShell 7', family: 'powershell', path: 'E:/tools/pwsh7/pwsh.exe', version: '7.4.6' },
      commandTool: commandTool({ family: 'powershell', familySource: 'manual', hostTools: PWSH_HOST_TOOLS, hidden: [] }),
    }),
  )
  check('29 语法标签:bash 语法(自动不加后缀)(就绪态)', famBadgeText(ready.tree) === COPY.famBash, famBadgeText(ready.tree))
  check('29 语法标签:PowerShell 语法 · 手动', famBadgeText(famPwshManual.tree) === COPY.famPwsh + ' · ' + COPY.manual, famBadgeText(famPwshManual.tree))
  // badge 是唯一状态结论,族跟在结论后面(规格:badge 同时标出当前的族)。
  check('29 badge:三态结论后跟族「就绪 · bash 族」', badgeOf(ready.tree).text === COPY.additive, badgeOf(ready.tree).text)
  check('29 badge:PowerShell 族会话也带族', badgeOf(famPwshManual.tree).text === COPY.additive, badgeOf(famPwshManual.tree).text)
  check('29 语法标签:PowerShell 族会话不隐藏任何名字', hiddenChips(famPwshManual.tree).length === 0 && textOf(hostNode(famPwshManual.tree)) === COPY.hostPrefix + 'pwsh', textOf(hostNode(famPwshManual.tree)))
  check('29 语法标签:PowerShell 族会话不说「已隐藏」', !noteTexts(famPwshManual.tree).some((text) => text.includes('已隐藏')), JSON.stringify(noteTexts(famPwshManual.tree)))
  const famNone = await mountPanel(
    payload({
      family: '',
      familySource: '',
      shell: { key: 'cmd', label: 'cmd', family: 'cmd', path: 'C:/Windows/System32/cmd.exe', version: '10.0.26200' },
      commandTool: commandTool({ family: '', familySource: '', hostTools: [], hidden: [] }),
    }),
  )
  check('29 语法标签:cmd / 自定义终端不显示语法标签', !famBadgeOf(famNone.tree), describe(famBadgeOf(famNone.tree)))
  check('29 badge:无族(cmd / 自定义)时 badge 只写结论', badgeOf(famNone.tree).text === COPY.additive, badgeOf(famNone.tree).text)
check('29 语法标签:无族时命令行与 chip 都不显示语法信息', !famBadgeOf(famNone.tree) && findAllByClass(famNone.tree, 'envd-chipfam').length === 0, classInventory(famNone.tree))
  check('29 语法标签:无族时命令行其余部分照常', textOf(ownTool(famNone.tree)) === 'envd_shell' && textOf(hostNode(famNone.tree)) === COPY.hostNone, JSON.stringify({ own: textOf(ownTool(famNone.tree)), host: textOf(hostNode(famNone.tree)) }))
}

// ───────────────────────────────── 30) 手动 bash + 没有任何 bash 入口:只有真没隐藏时才说「未隐藏」 ──
// 0.6.3:手动 bash 优先遮挡 —— 能遮挡时 pwsh 已被隐藏,此时说「未隐藏」会自相矛盾(用户报的 bug)。
{
  const manualBashPayload = (over) =>
    payload({
      family: 'bash',
      familySource: 'manual',
      state: { defaultShell: 'bash', options: { injectBrief: false, allowLan: false, blockOtherFamily: true }, customTools: [] },
      commandTool: commandTool(Object.assign({ family: 'bash', familySource: 'manual', hostTools: PWSH_HOST_TOOLS }, over)),
    })
  // 真的什么都没藏(pwsh 没被隐藏、也没有只能拒绝的名字)→ 说「未隐藏」
  const manualBashNoHost = await mountPanel(manualBashPayload({ hidden: [], refuseOnly: [] }))
  check('30 手动 bash 无 bash 入口:语法标签仍是 bash 语法 · 手动', famBadgeText(manualBashNoHost.tree) === COPY.famBash + ' · ' + COPY.manual, famBadgeText(manualBashNoHost.tree))
  check('30 手动 bash 无 bash 入口:真没隐藏时备注说「未隐藏」', noteTexts(manualBashNoHost.tree)[0] === COPY.noBashHost, JSON.stringify(noteTexts(manualBashNoHost.tree)))
  check('30 手动 bash 无 bash 入口:文案说「没有可用的 bash 命令工具」(不再和 envd_shell 矛盾)', noteTexts(manualBashNoHost.tree)[0].includes('没有可用的 bash 命令工具'), JSON.stringify(noteTexts(manualBashNoHost.tree)))
  check('30 手动 bash 无 bash 入口:没有名字被划掉(真的没挡)', hiddenChips(manualBashNoHost.tree).length === 0 && textOf(hostNode(manualBashNoHost.tree)) === COPY.hostPrefix + 'pwsh', textOf(hostNode(manualBashNoHost.tree)))
  // 回归(用户报的 bug):manual bash + 载荷 hidden:['pwsh'] → pwsh 已隐藏,绝不能再冒「未隐藏」
  const manualBashHidden = await mountPanel(manualBashPayload({ hidden: ['pwsh'], refuseOnly: [] }))
  check('30 回归:manual bash 且 pwsh 已隐藏时不出「未隐藏」备注', !noteTexts(manualBashHidden.tree).some((text) => text.includes('未隐藏 PowerShell 工具')), JSON.stringify(noteTexts(manualBashHidden.tree)))
  check('30 回归:该场景改成如实说「已隐藏 pwsh」', noteTexts(manualBashHidden.tree).some((text) => text.includes('已隐藏 pwsh')), JSON.stringify(noteTexts(manualBashHidden.tree)))
  // 只能拒绝(agent 自有层,restrict 挡不掉)时也不说「未隐藏」
  const manualBashRefused = await mountPanel(manualBashPayload({ hidden: [], refuseOnly: ['pwsh'] }))
  check('30 回归:manual bash 但有只能拒绝的名字时也不出「未隐藏」', !noteTexts(manualBashRefused.tree).some((text) => text.includes('未隐藏 PowerShell 工具')), JSON.stringify(noteTexts(manualBashRefused.tree)))
  // 三种都只占一行,不超过两行
  check('30 回归:「未隐藏」那条无论出不出都不超过两行', noteNodes(manualBashNoHost.tree).length <= 2 && noteNodes(manualBashHidden.tree).length <= 2 && noteNodes(manualBashRefused.tree).length <= 2)
}

// ───────────────────────────────── 31) 只展示 / 会被拒:详情点名,永不隐藏 ──
{
  const onlyNames = await mountPanel(
    payload({
      commandTool: commandTool({
        hostTools: [BASH_HOST_TOOLS[0], { name: 'pwsh_alt', family: 'powershell', learned: true, group: 'powershell' }],
        hidden: ['pwsh'],
        refuseOnly: ['pwsh_agent'],
        displayOnly: ['pwsh_alt'],
      }),
    }),
  )
  await onlyNames.clickNode(cmdButton(onlyNames.tree, COPY.diag))
  const onlyChips = shellChips(onlyNames.tree)
  const displayChip = onlyChips.find((el) => textOf(el).includes('pwsh_alt'))
  const refuseChip = onlyChips.find((el) => textOf(el).includes('pwsh_agent'))
  check('31 只展示:启发式认出的名字标「只展示（未隐藏）」', Boolean(displayChip) && textOf(displayChip).includes(COPY.displayOnlyTag) && classTokens(displayChip).includes('display'), displayChip ? textOf(displayChip) : describeAll(onlyChips))
  check('31 只展示:启发式认出的名字不划掉(不隐藏第三方工具)', !classTokens(displayChip || null).includes('hidden') && hiddenChips(onlyNames.tree).length === 1 && hiddenChips(onlyNames.tree)[0].props.title.includes('pwsh'), describeAll(onlyChips))
  check('31 会被拒:只能拒绝的名字标「调用会被拒绝」', Boolean(refuseChip) && textOf(refuseChip).includes(COPY.hostToolRefused) && classTokens(refuseChip).includes('refused'), refuseChip ? textOf(refuseChip) : describeAll(onlyChips))
  check('31 标签:三类标签各用各的 class(hidden / refused / display)', chipsWithTag(onlyNames.tree, 'hidden').length === 1 && chipsWithTag(onlyNames.tree, 'refused').length === 1 && chipsWithTag(onlyNames.tree, 'display').length === 1, describeAll(onlyChips))
  check('31 标签:四个名字各占一格 chip(不另起一行)', onlyChips.length === 4 && findAllByClass(detailOf(onlyNames.tree), 'envd-diag-only').length === 0, describeAll(onlyChips))
}

// ───────────────────────────────── 32) 详情计数:只留稳定三项,历史累计不上面板 ──
// 截图事故:PowerShell 族、此刻什么都没隐藏,详情却写着「隐藏 9 次」(历史累计),误导用户。
{
  const statsPanel = await mountPanel(payload({ syncStats: syncStats({ restrictApplied: 9, guardRefusals: 3 }) }))
  await statsPanel.clickNode(cmdButton(statsPanel.tree, COPY.diag))
  const statText = textOf(statOf(statsPanel.tree) || '')
  check('32 计数:历史累计(restrictApplied 很大)也不进详情', statText === countsText(), statText || '(missing)')
  check('32 计数:详情里不再出现「隐藏 N 次 / 拒绝 N 次」', !statText.includes('隐藏') && !statText.includes('拒绝'), statText)
  check('32 计数:详情按钮 title 也只有三项', String((cmdButton(statsPanel.tree, COPY.diag) || {}).props && cmdButton(statsPanel.tree, COPY.diag).props.title || '') === countsText(), JSON.stringify((cmdButton(statsPanel.tree, COPY.diag) || {}).props && cmdButton(statsPanel.tree, COPY.diag).props.title))
  check('32 计数:API 字段仍在载荷里(只是面板不显示)', syncStats({ restrictApplied: 9, guardRefusals: 3 }).restrictApplied === 9 && syncStats({ restrictApplied: 9, guardRefusals: 3 }).guardRefusals === 3)
  const zeroStats = await mountPanel(payload({ syncStats: syncStats({ restrictApplied: 0, guardRefusals: 0 }) }))
  await zeroStats.clickNode(cmdButton(zeroStats.tree, COPY.diag))
  check('32 计数:0 值同样只有三项', textOf(statOf(zeroStats.tree) || '') === countsText(), textOf(statOf(zeroStats.tree) || ''))
}


// ───────────────────────────────── 33) 备注优先级:最多两行,警告不被淹没 ──
{
  const bothWarn = await mountPanel(
    payload({
      family: 'powershell',
      familySource: 'manual',
      commandTool: commandTool({ family: 'powershell', familySource: 'manual', mixed: true, hostTools: [PWSH_HOST_TOOLS[0], BASH_HOST_TOOLS[0]], hidden: [], sandbox: { confinedCount: 2, sessionCount: 3, anyUnconfined: true, delegatable: false } }),
    }),
  )
  check('33 优先级:围栏 + 混用都出现时仍不超过两行', noteNodes(bothWarn.tree).length === 2, 'notes=' + JSON.stringify(noteTexts(bothWarn.tree)))
  check('33 优先级:围栏在前、混用在后(先说出路,再提醒语法)', noteTexts(bothWarn.tree)[0] === COPY.fence(2) && noteTexts(bothWarn.tree)[1] === COPY.mixedNote, JSON.stringify(noteTexts(bothWarn.tree)))
  const bashHiddenConfined = await mountPanel(payload({ commandTool: commandTool({ hostTools: BASH_HOST_TOOLS, hidden: ['pwsh'], sandbox: { confinedCount: 1, sessionCount: 2, anyUnconfined: true, delegatable: false } }) }))
  check('33 优先级:受限 + 已隐藏正好两行(没有第三条环境差异)', noteTexts(bashHiddenConfined.tree)[0] === COPY.fence(1) && noteTexts(bashHiddenConfined.tree)[1] === COPY.hiddenPwsh('pwsh') && noteNodes(bashHiddenConfined.tree).length === 2, JSON.stringify(noteTexts(bashHiddenConfined.tree)))
}

// ───────────────────────────────── 34) 手动族回退:familyFallback ──
// 手动选的族「既没有终端、也没有按该族发布的命令工具」时宿主回退 auto 并置 familyFallback=true。
// 此刻 payload.family / familySource 报的已经是生效结果(auto):面板要警告,但徽标不许再写「手动」。
{
  const fallbackPanel = await mountPanel(
    payload({
      family: 'bash',
      familySource: 'auto',
      familyFallback: true,
      commandTool: commandTool({
        family: 'bash',
        familySource: 'auto',
        familyFallback: true,
        hostTools: BASH_HOST_TOOLS,
        hidden: ['pwsh'],
      }),
    }),
  )
  check('34 回退:familyFallback=true 渲染一条 warn 备注', noteNodes(fallbackPanel.tree).length >= 1 && noteTexts(fallbackPanel.tree)[0] === COPY.familyFallback, JSON.stringify(noteTexts(fallbackPanel.tree)))
  check('34 回退:回退备注是 warn 级 + ⚠ 图标', hasClass(noteClass(noteNodes(fallbackPanel.tree)[0]), 'warn') && textOf(noteNodes(fallbackPanel.tree)[0]).startsWith('⚠'), describe(noteNodes(fallbackPanel.tree)[0]))
  check('34 回退:备注说清原因(没有对应终端或命令工具)', noteTexts(fallbackPanel.tree)[0].includes('没有对应终端') && noteTexts(fallbackPanel.tree)[0].includes('命令工具'), JSON.stringify(noteTexts(fallbackPanel.tree)))
  check('34 回退:徽标显示生效族且不带「手动」后缀', famBadgeText(fallbackPanel.tree) === COPY.famBash && !famBadgeText(fallbackPanel.tree).includes(COPY.manual), famBadgeText(fallbackPanel.tree) || '(missing)')
  check('34 回退:badge 也按生效族说话(不暗示手动族还在生效)', badgeOf(fallbackPanel.tree).text === COPY.additive, badgeOf(fallbackPanel.tree).text)
  check('34 回退:备注仍最多两行(回退 + 已隐藏)', noteNodes(fallbackPanel.tree).length === 2 && noteTexts(fallbackPanel.tree)[1] === COPY.hiddenPwsh('pwsh'), JSON.stringify(noteTexts(fallbackPanel.tree)))
  // 回退只认 true:false / 缺字段都不许报警(旧载荷没有这个字段)。
  const noFallbackField = payload({})
  delete noFallbackField.familyFallback
  delete noFallbackField.commandTool.familyFallback
  const oldish = await mountPanel(noFallbackField)
  check('34 回退:旧载荷没有 familyFallback 时不渲染假告警', !noteTexts(oldish.tree).includes(COPY.familyFallback) && noteNodes(oldish.tree).length === 1, JSON.stringify(noteTexts(oldish.tree)))
  check('34 回退:familyFallback=false 时也不告警', !noteTexts(ready.tree).includes(COPY.familyFallback), JSON.stringify(noteTexts(ready.tree)))
  // 顶层缺字段、只有 commandTool 报回退时也要认(两个字段取并集)。
  const ctOnly = payload({ commandTool: commandTool({ familyFallback: true, hostTools: BASH_HOST_TOOLS, hidden: ['pwsh'] }) })
  delete ctOnly.familyFallback
  const ctOnlyPanel = await mountPanel(ctOnly)
  check('34 回退:只有 commandTool 报回退时也认', noteTexts(ctOnlyPanel.tree)[0] === COPY.familyFallback, JSON.stringify(noteTexts(ctOnlyPanel.tree)))
}

// ───────────────────────────────── 35) 首屏收敏:关键子串与结构 ──
// 陌生人 5 秒内要能看懂:这是什么 / AI 用什么命令环境 / 去哪里改。
{
  const firstScreen = visibleText(ready.tree)
  check('35 收敏:首屏有用途说明一句', firstScreen.includes(COPY.subtitle))
  check('35 收敏:首屏备注用白话「已隐藏」', noteTexts(ready.tree).some((text) => text.includes('已隐藏')), JSON.stringify(noteTexts(ready.tree)))
  check('35 收敏:受限备注用白话「受沙箱限制」', noteTexts(confined.tree).some((text) => text.includes('受沙箱限制')), JSON.stringify(noteTexts(confined.tree)))
  check('35 收敏:混用备注用白话「别混用」', noteTexts(realWorld.tree).some((text) => text.includes('别混用')), JSON.stringify(noteTexts(realWorld.tree)))
  const fallbackAgain = await mountPanel(
    payload({ family: 'bash', familySource: 'auto', familyFallback: true, commandTool: commandTool({ family: 'bash', familySource: 'auto', familyFallback: true, hostTools: BASH_HOST_TOOLS, hidden: ['pwsh'] }) }),
  )
  check('35 收敏:回退备注用白话「已自动改回」', noteTexts(fallbackAgain.tree).some((text) => text.includes('已自动改回')), JSON.stringify(noteTexts(fallbackAgain.tree)))
  check('35 收敏:首屏不再出现黑话「宿主 / 围栏 / 增补」', ['宿主', '围栏', '增补'].every((word) => !firstScreen.includes(word)), ['宿主', '围栏', '增补'].filter((word) => firstScreen.includes(word)).join(','))
  check('35 收敏:自动选语法时命令行不出现「· 自动」', !textOf(cmdRow(ready.tree)).includes('自动'), textOf(cmdRow(ready.tree) || null))
  check('35 收敏:手动选语法时命令行带「· 手动」', textOf(cmdRow(realWorld.tree)).includes('· ' + COPY.manual), textOf(cmdRow(realWorld.tree) || null))
  check('35 收敏:首屏只留四块(命令卡 / 工具链 / 简报 / 高级设置行)', Boolean(findOneByClass(ready.tree, 'envd-card')) && sections(ready.tree).length === 2 && Boolean(findOneByClass(ready.tree, 'envd-advanced')), 'sections=' + sections(ready.tree).length)
  const quietPwsh = await mountPanel(payload({ family: 'powershell', familySource: 'auto', shell: { key: 'pwsh', label: 'PowerShell 7', family: 'powershell', path: 'E:/tools/pwsh7/pwsh.exe', version: '7.4.6' }, commandTool: commandTool({ family: 'powershell', familySource: 'auto', hostTools: PWSH_HOST_TOOLS, hidden: [] }) }))
  check('35 收敏:PowerShell 会话什么都没隐藏时备注为空(不再有常驻长句)', noteNodes(quietPwsh.tree).length === 0, JSON.stringify(noteTexts(quietPwsh.tree)))
  check('35 收敏:这种安静状态下 badge 是 ok「就绪」', badgeState(quietPwsh.tree) === 'ok' && badgeOf(quietPwsh.tree).text === COPY.additive, emoji(headerBadges(quietPwsh.tree)))
  check('35 收敏:高级设置默认收起(首屏不摆开关)', !findOneByClass(ready.tree, 'envd-adv'))
  check('35 收敏:footer 只有复制反馈 + 脚注,没有开关', findAllByClass(footerOf(ready.tree), 'envd-switch').length === 0 && Boolean(findOneByClass(ready.tree, 'envd-copy-note')) && Boolean(findOneByClass(ready.tree, 'envd-footmeta')))
}

console.log(failed === 0 ? '\nall panel-render cases passed (' + checked + ' checks)' : '\n' + failed + '/' + checked + ' check(s) failed')
process.exit(failed === 0 ? 0 : 1)
