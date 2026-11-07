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
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

const args = new Set(process.argv.slice(2))
const TIMING = args.has('--timing') || args.has('--verbose')

const home = mkdtempSync(join(tmpdir(), 'envdock-home-'))
process.env.DSH_HOME = home

// 夹具的断言口径是「这台机器只有系统自带工具链」:装了真实版本管理器(nvm/pyenv/fnm/conda)
// 后,它们的 list 命令会在每次探测时起子进程,「刷新不重跑版本探测」这类断言就会被机器环境影响。
// 这里把本机额外的工具链目录从 PATH 里摘掉(PATH 仍保留系统工具),让夹具与真机工具库解耦。
process.env.PATH = String(process.env.PATH || process.env.Path || '')
  .split(';')
  .filter((dir) => dir && !/[\\/]tools[\\/](pwsh7|fnm|nvm)([\\/]|$)/i.test(dir) && !/pyenv|miniconda|anaconda/i.test(dir))
  .join(';')

const failures = []
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

// ───────────────────────────────────── subprocess 服务替身 ──
// 本机沙箱不允许 Node 用管道 stdio 起子进程(spawn EPERM),所以按可执行文件名喂固定输出,
// 这样解析/缓存/聚合逻辑可测且完全确定。
const CANNED = {
  'node.exe': 'v24.18.0',
  'npm.cmd': '11.16.0',
  'pnpm.cmd': '11.24.0',
  'yarn.cmd': '1.22.22',
  'python.exe': 'Python 3.12.10',
  'git.exe': 'git version 2.55.0.windows.1',
  'powershell.exe': '5.1.26100',
  'pwsh.exe': '7.4.6',
  'bash.exe': 'GNU bash, version 5.3.15(1)-release',
  'py.exe': '-V:3.12 *        D:\\python\\python.exe',
  default: '9.9.9',
}

/**
 * `reg query ... /v Path` 的输出替身。
 * 默认让「系统 PATH」= 进程 PATH(即没有漂移),这样老断言的口径不变;
 * 要测「dsh 启动后系统 PATH 变过」就传 options.registryPath 返回别的值。
 */
function regOutput(value) {
  return [
    '',
    'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    '    Path    REG_EXPAND_SZ    ' + String(value || ''),
    '',
  ].join('\r\n')
}

function fakeSubprocess(options = {}) {
  const calls = []
  const state = { rejectNext: false, throwNext: false }
  const registry = () =>
    (typeof options.registryPath === 'function' ? options.registryPath() : options.registryPath) || {
      machine: process.env.PATH || '',
      user: '',
    }
  const service = {
    calls,
    state,
    spawn(req) {
      const argv = req.argv || []
      calls.push({ argv: argv.slice(), cwd: req.cwd })
      if (state.throwNext) {
        state.throwNext = false
        throw new Error('spawn EPERM (injected)')
      }
      const base = String(argv[0] || '')
        .split(/[\\/]/)
        .pop()
        .toLowerCase()
      const key = base === 'py.exe' && argv[1] === '-0p' ? 'py.exe' : base
      // 让指定命令以非 0 退出(测「失败不缓存」):传 exitWhen(argv) 返回 true
      const forcedExit = typeof options.exitWhen === 'function' ? Boolean(options.exitWhen(argv)) : false
      let text = state.rejectNext || options.fail === key || forcedExit ? '' : CANNED[key] ?? CANNED.default
      if (base === 'reg.exe') {
        const spec = registry()
        const isUser = String(argv[2] || '').toUpperCase().startsWith('HKCU')
        text = regOutput(isUser ? spec.user || '' : spec.machine || '')
      }
      const reader = () => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
      return {
        collected: { stdout: reader(), stderr: reader() },
        done: new Promise((resolve, reject) => {
          if (state.rejectNext) {
            state.rejectNext = false
            reject(new Error('provider failure (injected)'))
            return
          }
          setTimeout(() => resolve({ exitCode: forcedExit ? 1 : 0, signal: null }), options.latencyMs || 0)
        }),
        terminate() {},
      }
    },
    terminalEnvironment() {
      return Promise.resolve({ platform: 'windows', defaultShell: 'C:\\Windows\\system32\\cmd.exe' })
    },
  }
  return service
}

// ─────────────────────────────── 宿主沙箱 / 执行器替身 ──
/**
 * 逐会话沙箱策略替身:`resolve({ session })` 按 session.key 给模式。
 * 真机上 dsh 的 sandboxPolicy.resolve 就是「会话最后一次 sandbox/mode 覆盖 > 部署默认」。
 */
function fakeSandboxPolicy(fallback, bySession = {}) {
  return {
    resolve(request) {
      const key = request && request.session ? request.session.key : ''
      const mode = key && Object.prototype.hasOwnProperty.call(bySession, key) ? bySession[key] : fallback
      return { mode, workspaceRoot: process.cwd() }
    },
  }
}

/** 带围栏的宿主执行器替身:记录 resolve 收到的请求,execute 返回固定结果。 */
function fakeSandboxedShell({ mode = 'workspace-write', stdout = 'host-ran\n', denied = false } = {}) {
  const calls = { resolved: [], executed: [] }
  return {
    calls,
    sandboxMode: mode,
    resolve(request) {
      calls.resolved.push(request)
      return { ...request, onExpiry: 'kill', stdoutMaxBytes: 262144 }
    },
    async execute(spec) {
      calls.executed.push(spec)
      return {
        result: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          timeoutMs: spec.timeoutMs,
          stdout: { text: stdout, truncated: false },
          stderr: { text: '', truncated: false },
          sandbox: { mode: (spec.sandboxPolicy && spec.sandboxPolicy.mode) || mode, denied },
        }),
      }
    },
  }
}

// ───────────────────────────────────── Cordis ctx 替身 ──
function makeHarness(options = {}) {
  const state = {
    effects: [],
    toolDefs: new Map(),
    /** 每个作用域各自的遮挡集合:真机上 restrict 是 per-agent 的,不是全局共享的一份。 */
    deny: new Map(),
    listeners: new Map(),
    agents: [],
    /** tools.guard 的替身:返回拒绝理由的第一条(真机语义:任一 guard 拒绝即拒绝) */
    guards: [],
  }
  const denyOf = (scopeId) => {
    if (!state.deny.has(scopeId)) state.deny.set(scopeId, new Set())
    return state.deny.get(scopeId)
  }
  /**
   * 某个作用域看到的工具表。
   * 关键两条真机语义都在这里:
   *   · 被 restrict 掉的**全局工具**在这个作用域里读作「不存在」;
   *   · 对不存在的名字 restrict 直接失败(所以调用方必须先 hasTool 确认)。
   */
  const toolsFor = (scopeId) => ({
    register(def) {
      if (state.toolDefs.has(def.name)) throw new Error('duplicate tool ' + def.name)
      state.toolDefs.set(def.name, def)
      return () => state.toolDefs.delete(def.name)
    },
    get(name) {
      if (scopeId !== null && denyOf(scopeId).has(name)) return null
      return state.toolDefs.get(name) || null
    },
    /**
     * 真机语义(dsh-ops 口径):`get` 回答「注册了没有」,`executable` 回答「这一单真的能调」。
     * ptc 模式下模型直呼只允许 run_code 时,替代工具会「get 有、executable 无」——
     * 拿 get 判就绪就会把真正能用的宿主工具藏掉,模型于是收到零命令工具。
     * 默认与 get 同口径(注册且未被本作用域 deny);夹具用 options.executableFor(scopeId, name)
     * 制造分歧:返回 false → 视为不可执行(返回 null);返回 undefined / true → 回落 get。
     */
    executable(name) {
      const forced = typeof options.executableFor === 'function' ? options.executableFor(scopeId, name) : undefined
      if (forced === false) return null
      return scopeId !== null && denyOf(scopeId).has(name) ? null : state.toolDefs.get(name) || null
    },
    restrict(spec) {
      const deny = (spec && spec.deny) || []
      if (!deny.length) throw new Error('empty restriction')
      const set = denyOf(scopeId)
      const blocked = options.unrestrictable || []
      // 只记「这次真的新增的」名字:disposer 只能撤销自己这一层遮挡,
      // 不能把别的插件在这期间加的遮挡一起抹掉(真机上 restrict 是可组合的)。
      const added = []
      for (const name of deny) {
        if (!state.toolDefs.has(name)) throw new Error('unknown tool ' + name)
        // 真机语义:作用域私有的名字挡不掉(restrict 直接失败)。
        // unrestrictableFor(scopeId, name) 可以按作用域给出不同答案(测「不株连」)。
        const scopeBlocked =
          typeof options.unrestrictableFor === 'function'
            ? Boolean(options.unrestrictableFor(scopeId, name))
            : blocked.includes(name)
        if (scopeBlocked) throw new Error('scope-local tool ' + name)
        if (!set.has(name)) {
          set.add(name)
          added.push(name)
        }
      }
      return () => {
        for (const name of added) set.delete(name)
      }
    },
    /** 真机:全局 guard(经 ctx.tools.guard 注册)对每次调用求理由,任一拒绝即拒绝 */
    guard(fn) {
      state.guards.push(fn)
      return () => {
        const i = state.guards.indexOf(fn)
        if (i >= 0) state.guards.splice(i, 1)
      }
    },
  })
  const tools = toolsFor(null)
  // 模拟 preset 注册的宿主 shell 工具(接管判定靠它)
  for (const name of options.shippedTools || []) {
    state.toolDefs.set(name, {
      name,
      description: 'shipped ' + name,
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] },
      execute: async () => ({}),
    })
    state.shipped = (state.shipped || new Set()).add(name)
  }
  const subprocess = fakeSubprocess(options.subprocess)
  const services = {
    subprocess,
    tools,
    // 宿主 shell 服务替身(默认没有):沙箱用例靠它公布 sandboxMode / 提供 resolve+execute
    shell: options.shell,
    // 逐会话沙箱策略替身(默认没有):沙箱用例靠它给出「本会话有效策略」
    sandboxPolicy: options.sandboxPolicy,
    workingDirectory: { defaultDirectory: process.cwd(), ensure: async () => process.cwd() },
    agents: { list: () => state.agents },
    systemPrompt: {
      context(spec) {
        state.brief = spec
        return () => {}
      },
    },
  }
  const webRoutes = []
  const webServer = {
    register(route) {
      webRoutes.push(route)
      return () => {
        const i = webRoutes.indexOf(route)
        if (i >= 0) webRoutes.splice(i, 1)
      }
    },
  }
  const makeCtx = (extra) => ({
    tools: (extra && extra.tools) || tools,
    get(name) {
      return extra && name in extra ? extra[name] : services[name]
    },
    effect(fn, label) {
      const dis = fn()
      state.effects.push({ label, dis })
      return dis
    },
    on(event, listener) {
      const list = state.listeners.get(event) || []
      list.push(listener)
      state.listeners.set(event, list)
      return () => {
        const i = list.indexOf(listener)
        if (i >= 0) list.splice(i, 1)
      }
    },
    inject(deps, cb) {
      if (deps.includes('webServer')) cb({ ...makeCtx({ webServer }), webServer })
    },
  })
  const ctx = makeCtx({ webServer })
  /** 造一个 agent:作用域里的工具表带自己的遮挡集合,restrict 才真的有效果 */
  const makeAgent = (id, session) => {
    const actx = makeCtx({ tools: toolsFor(id) })
    return { id, ctx: actx, session }
  }
  const emit = (event, payload) => {
    for (const listener of [...(state.listeners.get(event) || [])]) {
      try {
        listener(payload)
      } catch {}
    }
  }
  // agentIds 可以是字符串(没有会话)或 { id, session }:沙箱用例要按会话判策略
  for (const entry of options.agentIds || []) {
    if (typeof entry === 'string') state.agents.push(makeAgent(entry))
    else state.agents.push(makeAgent(entry.id, entry.session))
  }
  /**
   * 直接改某个作用域的遮挡集合(模拟别的插件遮住了我们的工具 / 后来放开了)。
   * 必须**就地**改 Set:替换实例会让已经捕获旧 Set 的 restrict disposer 变成孤儿,
   * 我们放开遮挡时删不到真实的集合 —— 那是夹具的 bug,不是插件的。
   */
  const setScopeDeny = (id, names) => {
    const set = denyOf(id)
    set.clear()
    for (const name of names || []) set.add(name)
  }
  /** 某次调用的 guard 结论(真机:任一 guard 拒绝即拒绝) */
  const guardReason = (name, agent) => {
    for (const fn of state.guards) {
      try {
        const reason = fn({ name, agent })
        if (typeof reason === 'string' && reason) return reason
      } catch {}
    }
    return undefined
  }
  return { ctx, state, webRoutes, services, subprocess, makeAgent, emit, toolsFor, setScopeDeny, guardReason }
}

// ───────────────────────────────────── HTTP 请求替身 ──
function fakeReq({ method = 'GET', body = '', remoteAddress = '127.0.0.1' } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.socket = { remoteAddress, address: () => ({ address: remoteAddress }) }
  req.rawHeaders = []
  if (body) {
    const buf = Buffer.from(body)
    process.nextTick(() => {
      req.emit('data', buf)
      req.emit('end')
    })
  } else {
    process.nextTick(() => req.emit('end'))
  }
  req.destroy = () => {}
  return req
}
function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    text: '',
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers
    },
    end(body) {
      this.text += body || ''
    },
  }
}

/** 探测要读系统 PATH(注册表),这两次 reg.exe 不等于「版本探测」,断言里要分开算。 */
const isReg = (call) => String((call.argv || [])[0] || '').split(/[\\/]/).pop().toLowerCase() === 'reg.exe'
const isVersion = (call) => !isReg(call) && (call.argv || [])[1] !== '-0p'

async function callApi(h, opts) {
  // 取最后注册的那条路由:热重载用例里同一 ctx 会 apply 两次,旧路由已被卸载
  const route = h.webRoutes[h.webRoutes.length - 1]
  const req = fakeReq(opts)
  const res = fakeRes()
  await route.handler(req, res)
  let json = null
  try {
    json = JSON.parse(res.text)
  } catch {}
  return { status: res.statusCode, json, raw: res.text }
}
const post = (h, body, extra = {}) => callApi(h, { method: 'POST', body: JSON.stringify(body), ...extra })

/** 轮询 GET 直到 predicate 成立(或超时),返回最后一次快照。 */
async function pollSnapshot(h, pred, timeoutMs = 5000) {
  const started = Date.now()
  let snap = null
  for (;;) {
    snap = (await callApi(h)).json
    if (snap && pred(snap)) return snap
    if (Date.now() - started > timeoutMs) return snap
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/**
 * 让某个 fixture 用一份全新的探测结果。
 * 模块级探测缓存是进程共享的(生产里一个 dsh 进程只有一个 EnvDock),
 * 所以同一进程里起多个 fixture 时,靠一次状态写入把缓存打掉(invalidateDetection)。
 */
const freshDetection = (h) => post(h, { op: 'setOption', injectBrief: true })

const waitForBrief = async (h, ms = 5000) => {
  const started = Date.now()
  for (;;) {
    const text = h.state.brief.text()
    if (text && !text.includes('正在探测')) return text
    if (Date.now() - started > ms) return text
    await new Promise((r) => setTimeout(r, 50))
  }
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
const lanAllowed = await post(h, { op: 'setOption', allowLan: true }, { remoteAddress: '192.168.1.9' })
check('局域网里可以打开「允许局域网访问」', lanAllowed.status === 200 && lanAllowed.json.ok === true, String(lanAllowed.status))
const lanNow = await callApi(h, { remoteAddress: '192.168.1.9' })
check('打开后局域网 GET 放行', lanNow.status === 200, String(lanNow.status))
await post(h, { op: 'setOption', allowLan: false })
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
  check('本机 PATH 上没有 py.exe,启动器断言跳过', true, '')
}
const resolveBash = await envd.execute({ action: 'resolve', name: 'bash' })
check('envd resolve bash(终端)', resolveBash.ok === true, resolveBash.text.slice(0, 120))
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

// 围栏下调用 envd_shell:没有可委托的宿主执行器 → 拒绝,绝不 spawn 一条无 policy 的命令
const mixTool = hMix.state.toolDefs.get('envd_shell')
const refusedHere = await mixTool.execute({ command: 'echo portable-bypass', cwd: process.cwd() }, { signal: null, agent: { session: { key: 'locked' } } })
check('围栏会话调用 envd_shell:拒绝而不是 spawn', refusedHere.ok === false && refusedHere.text.includes('沙箱围栏'), String(refusedHere.text).slice(0, 140))
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
check(
  '命令经环境变量 ENVD_CMD 传入,没有拼进命令字符串',
  hostShell.calls.executed[0].env.ENVD_CMD === 'echo delegated' && !String(hostShell.calls.executed[0].command).includes('echo delegated'),
  String(hostShell.calls.executed[0].command),
)
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
check('envd_shell 不可见时 guard 放行宿主 shell(零工具保险)', hGuard.guardReason('bash', hGuard.state.agents[0]) === undefined)
hGuard.setScopeDeny('agent-guard', [])

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
// 还没到下一轮对账:执行侧必须自己挡住,不能靠「5 秒内会拆」兜底
const refused = await lifeTool.execute({ command: 'echo hi' }, { signal: null, agent: null })
check('沙箱出现后、对账之前,执行侧拒绝 spawn(无围栏窗口为 0)', refused.ok === false && refused.text.includes('沙箱'), String(refused.text).slice(0, 120))
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
  await post(hPyFail, { op: 'setOption', injectBrief: true }) // 作废探测缓存
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
    check('系统 PATH 新加目录里的工具立刻能扫到', true, '机器上 CATALOG 里的工具都装了,跳过')
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
  'PTC 折叠下的简报不自称「已接管」,而是说清宿主工具可用 / envd_shell 已让路',
  !ptcBrief.includes('已接管') && ptcBrief.includes('已让路') && ptcBrief.includes('bash'),
  ptcBrief.split('\n').find((l) => l.includes('命令工具')) || '',
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
]) {
  try {
    if (typeof dis === 'function') dis()
  } catch {}
}

rmSync(home, { recursive: true, force: true })

console.log('\n' + (failures.length ? failures.length + ' 项失败:' : '全部通过') + '  (' + (Date.now() - t0) + ' ms)')
for (const f of failures) console.log('  · ' + f)
process.exit(failures.length ? 1 : 0)
