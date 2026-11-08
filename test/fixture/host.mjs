/**
 * EnvDock 宿主夹具(测试共享模块,不随包发布)。
 *
 * 在没有 dsh 宿主的情况下,用一套最小的 Cordis 服务替身把 index.js 的 apply()
 * 真正跑起来。本模块是从 test/host-harness.mjs 里抽出来的**唯一一份**夹具实现:
 *
 *   · prepareHostEnv()   临时 DSH_HOME / PATH 过滤 / 缺失工具桩(import 时自动执行)
 *   · buildHost(opts)    造一个假宿主 → { ctx, services, api(), tools, dispose(), stats(), ... }
 *   · fakeSubprocess / fakeSandboxedShell / fakeSandboxPolicy  可配置的服务替身
 *   · callApi / post / pollSnapshot / freshDetection / waitForBrief  HTTP + 轮询小工具
 *   · decodeEncodedCommand / decodeBashPayload / quotedArgs / isReg / isVersion  断言用解码器
 *
 * 用法(注意必须**动态** import index.js,或先 import 本模块,否则 DSH_HOME 还没被指向临时目录):
 *
 *   import { buildHost, callApi, post } from './fixture/host.mjs'
 *   const host = buildHost({ shippedTools: ['bash'], agentIds: ['agent-a'] })
 *   const { apply } = await import('../index.js')
 *   apply(host.ctx, { syncIntervalMs: 25 })
 *   const snap = (await host.api()).json
 *
 * 状态文件写在临时 DSH_HOME 里,绝不碰用户真实的 ~/.dsh/envdock.json。
 * subprocess 用固定输出的替身(本机沙箱不允许 Node 用管道 stdio 起子进程),
 * 因此每次探测发起几次子进程是可数的 —— 版本缓存的收益也能被断言。
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

// ── 测试自足:临时 DSH_HOME / 桩 bin / 清理钩子 ──
// 换一台没装 node/npm/python/git 的机器也要能跑:缺哪个就在系统临时目录建个空文件桩,
// 版本输出本来就由假 subprocess 的 CANNED 提供,真实 exe 内容不影响判定。
export const cleanupDirs = []
export function cleanupTemp() {
  for (const dir of cleanupDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
}

const pathDirs = () => String(process.env.PATH || process.env.Path || '').split(';').filter(Boolean)
const hasOnPath = (file) =>
  pathDirs().some((dir) => {
    try {
      return existsSync(join(dir, file))
    } catch {
      return false
    }
  })

/**
 * 把进程环境改造成「只有系统自带工具链」的确定性环境。import 时自动跑一次;
 * 重复调用是幂等的(测试里想显式指定顺序时也可以自己调)。
 */
let prepared = false
export function prepareHostEnv() {
  if (prepared) return { home, skipped: true }
  prepared = true
  const home = mkdtempSync(join(tmpdir(), 'envdock-home-'))
  cleanupDirs.push(home)
  process.env.DSH_HOME = home
  // 夹具的断言口径是「这台机器只有系统自带工具链」:装了真实版本管理器(nvm/pyenv/fnm/conda)
  // 后,它们的 list 命令会在每次探测时起子进程,「刷新不重跑版本探测」这类断言就会被机器环境影响。
  // 这里把版本管理器目录从 PATH 里摘掉(PATH 仍保留系统工具),让夹具与真机工具库解耦。
  // 排查问题时可设 ENVDOCK_FULL_PATH=1 跳过过滤(那会暴露本机装了哪些工具链)。
  if (process.env.ENVDOCK_FULL_PATH !== '1') {
    process.env.PATH = pathDirs()
      .filter((dir) => !/(nvm|fnm|pyenv|conda|miniconda|anaconda)/i.test(dir))
      .join(';')
  }
  // node / npm / pnpm / python / git 是断言里用到的 CATALOG 工具:PATH 上没有就建空文件桩。
  const PATH_STUB_NAMES = ['node.exe', 'npm.cmd', 'pnpm.cmd', 'python.exe', 'git.exe']
  const missingOnPath = PATH_STUB_NAMES.filter((file) => !hasOnPath(file))
  if (missingOnPath.length) {
    const stubDir = mkdtempSync(join(tmpdir(), 'envdock-stub-bin-'))
    cleanupDirs.push(stubDir)
    for (const file of missingOnPath) {
      try {
        writeFileSync(join(stubDir, file), '', 'utf8')
      } catch {}
    }
    process.env.PATH = stubDir + ';' + process.env.PATH
  }
  return { home, skipped: false }
}

const prepared0 = prepareHostEnv()

/** 本次测试进程的临时 DSH_HOME(状态文件就写在这里,绝不碰真实的 ~/.dsh)。 */
export const home = prepared0.home

// 失败退出(process.exit(1))也要清掉临时 DSH_HOME 与桩目录,别在 %TEMP% 里越堆越多
process.on('exit', cleanupTemp)
process.on('SIGINT', () => {
  cleanupTemp()
  process.exit(130)
})

// ───────────────────────────────────── subprocess 服务替身 ──
// 本机沙箱不允许 Node 用管道 stdio 起子进程(spawn EPERM),所以按可执行文件名喂固定输出,
// 这样解析/缓存/聚合逻辑可测且完全确定。
export const CANNED = {
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
export function regOutput(value) {
  return [
    '',
    'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    '    Path    REG_EXPAND_SZ    ' + String(value || ''),
    '',
  ].join('\r\n')
}

export function fakeSubprocess(options = {}) {
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
export function fakeSandboxPolicy(fallback, bySession = {}) {
  return {
    resolve(request) {
      const key = request && request.session ? request.session.key : ''
      const mode = key && Object.prototype.hasOwnProperty.call(bySession, key) ? bySession[key] : fallback
      return { mode, workspaceRoot: process.cwd() }
    },
  }
}

/**
 * 带围栏的宿主执行器替身:记录 resolve 收到的请求,execute 返回固定结果。
 *
 * options.className 模拟执行器实现类名(PwshSandboxExecutor / BashSandboxExecutor):
 * index.js 的委托包装器必须跟**执行器语法族**走,不是跟宿主工具名走。
 * 返回对象上的 .state 可运行中改:fail='resolve'|'execute'|'result' 让对应阶段抛错,
 * runnerFailed=true 让结果带「围栏 runner 失败」(命令根本没跑),用来测委托失败分阶段记账。
 */
export function fakeSandboxedShell({ mode = 'workspace-write', stdout = 'host-ran\n', denied = false, className = '', runnerFailed = false } = {}) {
  const calls = { resolved: [], executed: [] }
  const state = { fail: '', runnerFailed, denied, aborted: false, emptyResult: false }
  const shell = {
    calls,
    state,
    sandboxMode: mode,
    resolve(request) {
      calls.resolved.push(request)
      if (state.fail === 'resolve') throw new Error('resolver unavailable (injected)')
      return { ...request, onExpiry: 'kill', stdoutMaxBytes: 262144 }
    },
    async execute(spec) {
      calls.executed.push(spec)
      if (state.fail === 'execute') throw new Error('start failed (injected)')
      return {
        result: async () => {
          if (state.fail === 'result') throw new Error('result failed (injected)')
          if (state.emptyResult) return null
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            aborted: state.aborted,
            timeoutMs: spec.timeoutMs,
            stdout: { text: stdout, truncated: false },
            stderr: { text: '', truncated: false },
            sandbox: { mode: (spec.sandboxPolicy && spec.sandboxPolicy.mode) || mode, denied: state.denied, runnerFailed: state.runnerFailed },
          }
        },
      }
    },
  }
  // index.js 用 shell.name / id / constructor.name 探测执行器族;夹具用 name 承载类名。
  if (className) shell.name = className
  return shell
}

// ───────────────────────────────────── Cordis ctx 替身 ──
/**
 * 夹具内核:造一个最小的 Cordis ctx + 服务替身。**不要直接调用** ——
 * 用 buildHost(options) 拿到带 api()/dispose()/stats() 的宿主对象。
 */
function createHarnessCore(options = {}) {
  const state = {
    effects: [],
    toolDefs: new Map(),
    /** 每个作用域各自的遮挡集合:真机上 restrict 是 per-agent 的,不是全局共享的一份。 */
    deny: new Map(),
    listeners: new Map(),
    agents: [],
    /** tools.guard 的替身:返回拒绝理由的第一条(真机语义:任一 guard 拒绝即拒绝) */
    guards: [],
    /** 每一次 restrict 的真实尝试(含抛错的):测重试窗口/过期重试用,别靠副作用猜 */
    restrictCalls: [],
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
  const toolsFor = (scopeId) => {
    const api = {
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
        state.restrictCalls.push(deny.slice())
        const set = denyOf(scopeId)
        const blocked = options.unrestrictable || []
        // 真机坑:agent 自己层注册的同名工具,restrict 返回成功却挡不住。
        // options.restrictNoop(scopeId, deny) 返回 true → 夹具照常返回 disposer,但遮挡不生效。
        const noop = typeof options.restrictNoop === 'function' ? Boolean(options.restrictNoop(scopeId, deny)) : Boolean(options.restrictNoop)
        // 只记「这次真的新增的」名字:disposer 只能撤销自己这一层遮挡,
        // 不能把别的插件在这期间加的遮挡一起抹掉(真机上 restrict 是可组合的)。
        // 真机坑(安全审校 P1-4):restrict 可能**先落地再抛错**(publication reentry),
        // deny 已经生效、disposer 却丢了。restrictApplyThenThrow(scopeId, deny) 复现这条路径。
        const applyThenThrow =
          typeof options.restrictApplyThenThrow === 'function' ? Boolean(options.restrictApplyThenThrow(scopeId, deny)) : false
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
            if (!noop) set.add(name)
            added.push(name)
          }
        }
        // 落地之后再抛:调用方拿不到 disposer,这份遮挡成为「无主 deny」(撤不掉)。
        if (applyThenThrow) throw new Error('restrict applied then threw (injected)')
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
    }
    /**
     * 真机语义:`tools.definitions(scope)` 枚举「这个作用域此刻看得见的工具定义」,
     * 连注册在 agent 祖先层、全局 get 查不到的都算(预设 / 第三方插件发布的命令工具)。
     * index.js 靠它认出第三方发布名(tenant_bash 之类)和家族。
     * 夹具返回:全局 register 的定义 + options.shellDefinitions 注入的定义;
     * 被本作用域 deny 掉的名字不返回(挡住之后定义面也看不到,和真机一致)。
     * options.definitions === false 模拟老宿主:连方法都不挂,插件必须回退到按名字探可见性。
     */
    if (options.definitions !== false) {
      api.definitions = function definitions() {
        const denied = scopeId !== null ? denyOf(scopeId) : null
        const seen = new Set()
        const defs = []
        const add = (def) => {
          const name = def && def.name ? String(def.name) : ''
          if (!name || seen.has(name)) return
          if (denied && denied.has(name)) return
          seen.add(name)
          defs.push(def)
        }
        for (const [, def] of state.toolDefs) add(def)
        for (const def of options.shellDefinitions || []) add(def)
        return defs
      }
    }
    return api
  }
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
  // 模拟 preset / 第三方插件把命令工具发布在 agent 祖先层:每个作用域都看得见,
  // 但不是「本插件 register 的全局工具」。options.shellDefinitions 是定义原文,
  // 供 definitions(scope) 枚举 —— 动态识别用例靠它注入 tenant_bash 这类发布名。
  for (const def of options.shellDefinitions || []) {
    if (!def || !def.name) continue
    if (!state.toolDefs.has(def.name)) {
      state.toolDefs.set(def.name, {
        name: def.name,
        description: def.description || '',
        parameters: def.parameters || { type: 'object', properties: {} },
        output: def.output || { schema: { type: 'object' }, render: () => [] },
        execute: typeof def.execute === 'function' ? def.execute : async () => ({}),
      })
    }
  }
  const subprocess = fakeSubprocess(options.subprocess)
  const services = {
    subprocess,
    tools,
    // 宿主 shell 服务替身(默认没有):沙箱用例靠它公布 sandboxMode / 提供 resolve+execute
    shell: options.shell,
    // 受管的 DSH_* 环境快照(官方 shell 工具同款):默认没有 → 委托不带 dshEnv(安全降级)
    shellEnv: options.shellEnv,
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
  return { ctx, state, webRoutes, services, subprocess, makeAgent, emit, toolsFor, setScopeDeny, guardReason, webServer }
}

// ───────────────────────────────────── HTTP 请求替身 ──
/**
 * 假 req。除了 Node 的最小面,还额外暴露 `__bodyRead`:
 * 「请求体有没有被读过」—— 用来断言 413 / 403 是**在读 body 之前**拒绝的
 * (读过的请求会挂上 data/end 监听器)。
 */
export function fakeReq({ method = 'GET', body = '', remoteAddress = '127.0.0.1', headers = null } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.socket = { remoteAddress, address: () => ({ address: remoteAddress }) }
  // 真浏览器/HTTP1.1 客户端一定会带 Host:真实面板走的是 `127.0.0.1:<port>`。
  // index.js 用 Host 做 DNS-rebinding 防护(回环来源必须配回环 Host),所以默认值必须像真请求。
  req.headers = headers || { host: '127.0.0.1:3080' }
  if (!Object.prototype.hasOwnProperty.call(req.headers, 'host')) req.headers.host = '127.0.0.1:3080'
  req.rawHeaders = []
  req.__bodyRead = false
  const rawOn = req.on.bind(req)
  req.on = (event, listener) => {
    if (event === 'data' || event === 'end') req.__bodyRead = true
    return rawOn(event, listener)
  }
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
export function fakeRes() {
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

/**
 * 对当前注册的 /envdock-api 路由发一次假请求。
 *   api()                        GET
 *   api('/envdock-api', {method:'POST', body:{op:'refresh'}})
 *   api('/envdock-api', {method:'POST', body:'{oops', headers:{...}, remoteAddress:'192.168.1.9'})
 * 返回 { status, json, raw, headers, bodyRead }。
 */
export async function requestApi(h, url = '/envdock-api', init = {}) {
  const path = typeof url === 'string' ? String(url).split('?')[0] : '/envdock-api'
  const routes = (h && h.webRoutes) || []
  // 取匹配路径的最后注册的那条:热重载用例里同一 ctx 会 apply 两次,旧路由已被卸载
  const route = routes.filter((r) => r && r.path === path).pop() || routes[routes.length - 1]
  if (!route) throw new Error('没有注册的路由: ' + String(url))
  const rawBody = init.body === undefined ? '' : typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
  const method = init.method || (rawBody ? 'POST' : 'GET')
  const req = fakeReq({ method, body: rawBody, remoteAddress: init.remoteAddress, headers: init.headers || null })
  const res = fakeRes()
  await route.handler(req, res)
  let json = null
  try {
    json = JSON.parse(res.text)
  } catch {}
  return { status: res.statusCode, json, raw: res.text, headers: res.headers, bodyRead: req.__bodyRead === true }
}

// ───────────────────────────────────── 夹具宿主对象 ──
/**
 * 造一个假 Cordis 宿主并返回操作句柄。
 *
 * options(全部可选):
 *   shippedTools       宿主已注册的命令工具名(数组),模拟 preset 自带的 bash/pwsh
 *   agentIds           agent 列表:字符串(无会话)或 { id, session }
 *   shell              宿主 shell 服务替身:fakeSandboxedShell(...) 或 { sandboxMode } / {}
 *   shellEnv           受管的 DSH_* 快照收集器
 *   sandboxPolicy      逐会话沙箱策略替身(见 fakeSandboxPolicy)
 *   subprocess         假 subprocess 的配置({ registryPath, exitWhen, fail, latencyMs })
 *   shellDefinitions   发布在 agent 祖先层的命令工具定义原文(动态识别用例)
 *   definitions        false → 模拟老宿主(没有 tools.definitions)
 *   unrestrictable / unrestrictableFor   哪些宿主工具挡不掉(作用域私有)
 *   restrictNoop       restrict 成功却挡不住
 *   executableFor      get 与 executable 分歧(ptc 折叠)
 *
 * 返回:{ ctx, services, state, webRoutes, subprocess, makeAgent, emit, toolsFor,
 *        setScopeDeny, guardReason, tools, api(), dispose(), stats() }
 */
export function buildHost(options = {}) {
  const core = createHarnessCore(options)
  const host = {
    ...core,
    /** 全局工具表视图(和 ctx.tools 是同一个对象)。 */
    tools: core.ctx.tools,
    /** api(url, init) —— 对 /envdock-api 发一次假请求,见 requestApi。 */
    api: (url = '/envdock-api', init = {}) => requestApi(core, url, init),
    /** 卸载:跑掉所有 effect disposer(可重复调用)。 */
    dispose() {
      const effects = core.state.effects.splice(0)
      for (const { dis } of effects) {
        try {
          if (typeof dis === 'function') dis()
        } catch {}
      }
      return effects.length
    },
    /** 当前夹具状态快照(诊断 / 断言用;不要在这里修改任何东西)。 */
    stats() {
      return {
        effects: core.state.effects.length,
        toolDefs: [...core.state.toolDefs.keys()],
        webRoutes: core.webRoutes.map((r) => r && r.path),
        guards: core.state.guards.length,
        restrictCalls: core.state.restrictCalls.length,
        agents: core.state.agents.map((a) => a.id),
        listeners: [...core.state.listeners.keys()],
        subprocessCalls: core.subprocess.calls.length,
      }
    },
  }
  return host
}

/** host-harness.mjs 的历史名字:行为与 buildHost 完全一致。 */
export const makeHarness = buildHost

// ───────────────────────────────────── 断言用解码器 / 计数器 ──
/** 取出宿主包装串里的单引号参数(包装器把每个参数逐个单引号包起来)。 */
export function quotedArgs(command) {
  const text = String(command || '')
  const out = []
  let i = 0
  while (i < text.length) {
    if (text[i] !== "'") {
      i++
      continue
    }
    let j = i + 1
    let value = ''
    while (j < text.length) {
      if (text[j] === "'") {
        // PowerShell 的单引号转义:内部单引号写两遍
        if (text[j + 1] === "'" && text[j + 2] !== "'") {
          value += "'"
          j += 2
          continue
        }
        break
      }
      value += text[j]
      j++
    }
    out.push(value)
    i = j + 1
  }
  return out
}

/** PowerShell 目标:-EncodedCommand 的 base64(UTF-16LE)还原成命令原文(老约定,保留兼容)。 */
export function decodeEncodedCommand(command) {
  for (const arg of quotedArgs(command)) {
    if (!/^[A-Za-z0-9+/=]+$/.test(arg) || arg.length < 16) continue
    try {
      const text = Buffer.from(arg, 'base64').toString('utf16le')
      if (text && text.trim()) return text
    } catch {}
  }
  return ''
}

/** bash 目标:env ENVD_CMD 存的是用户命令的 base64;解码回来核对。 */
export function decodeBashPayload(spec) {
  const raw = spec && spec.env && typeof spec.env.ENVD_CMD === 'string' ? spec.env.ENVD_CMD : ''
  if (!raw) return ''
  try {
    return Buffer.from(raw, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

/** PowerShell 目标的新约定:-Command 脚本里从 $env:ENVD_CMD 的 base64 还原命令。 */
export function decodePowerShellPayload(spec) {
  const raw = spec && spec.env && typeof spec.env.ENVD_CMD === 'string' ? spec.env.ENVD_CMD : ''
  if (!raw) return ''
  try {
    return Buffer.from(raw, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

/** 探测要读系统 PATH(注册表),这两次 reg.exe 不等于「版本探测」,断言里要分开算。 */
export const isReg = (call) => String((call.argv || [])[0] || '').split(/[\\/]/).pop().toLowerCase() === 'reg.exe'
export const isVersion = (call) => !isReg(call) && (call.argv || [])[1] !== '-0p'

// ───────────────────────────────────── HTTP / 轮询小工具 ──
export async function callApi(h, opts) {
  return requestApi(h, '/envdock-api', opts || {})
}
export const post = (h, body, extra = {}) => callApi(h, { method: 'POST', body: JSON.stringify(body), ...extra })

/** 轮询 GET 直到 predicate 成立(或超时),返回最后一次快照。 */
export async function pollSnapshot(h, pred, timeoutMs = 5000) {
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
// 探测缓存现在只被「影响探测的写入」作废,测试要新快照就直接 force 刷新
export const freshDetection = (h) => post(h, { op: 'refresh' })

export async function waitForBrief(h, ms = 5000) {
  const started = Date.now()
  for (;;) {
    const text = h.state.brief.text()
    if (text && !text.includes('正在探测')) return text
    if (Date.now() - started > ms) return text
    await new Promise((r) => setTimeout(r, 50))
  }
}
