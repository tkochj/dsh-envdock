/**
 * EnvDock 宿主夹具(测试共享模块,不随包发布)。
 *
 * 在没有 dsh 宿主的情况下,用一套最小的 Cordis 服务替身把 index.js 的 apply()
 * 真正跑起来。本模块是从 test/host-harness.mjs 里抽出来的**唯一一份**夹具实现:
 *
 *   · prepareHostEnv()   临时 DSH_HOME / PATH 过滤 / 缺失工具桩(import 时自动执行)
 *   · buildHost(opts)    造一个假宿主 → { ctx, services, api(), tools, dispose(), disposeAgent(), stats(), ... }
 *   · fakeSubprocess / fakeSandboxedShell / fakeSandboxPolicy  可配置的服务替身
 *   · withPath / makeStubBin  临时改 PATH(「本机没有 Git Bash」这类用例)
 *   · callApi / post / pollSnapshot / freshDetection / waitForBrief  HTTP + 轮询小工具
 *   · decodeEncodedCommand / decodeBashPayload / quotedArgs / isReg / isVersion  断言用解码器
 *
 * 0.6 起 tools 试身按真机(dsh-tools)语义搭了三层 + 遮挡/守卫:
 *
 *   全局层  root `ctx.tools.register()` / `shippedTools`        → 所有作用域继承,可 restrict
 *   祖先层  `options.shellDefinitions`(preset / 第三方发布)      → 所有作用域继承,可 restrict
 *   自有层  `options.agentTools` / `registerAgentTool()`         → 只有该 agent 看得见,**restrict 挡不掉**
 *
 *   真机口径(实测 dsh-tools):
 *     · `view(scope)` 返回 `{ visible: Map, knownNames: Set, restrictableNames: Set }`;
 *       restrictableNames 只含继承层,自有层名字不在里面;
 *     · 对自有层名字 `restrict({deny})` 抛
 *       `tools.restrict() names unknown global tool "pwsh"; known global tools: ...`;
 *     · 根作用域(`ctx.tools`,没有 agent)调 restrict 直接抛(全局遮挡会遮住所有 agent);
 *     · `guard(fn)` 在根层注册一次,`fn({name, agent, arguments})` 返回字符串即拒绝。
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
/** 一个最小可用的工具定义(缺的字段补默认值)。 */
function toolDefinition(name, description, extra = {}) {
  const spec = extra && typeof extra === 'object' ? extra : {}
  return {
    name: String(name || ''),
    description: description === undefined ? String(spec.description || '') : String(description || ''),
    parameters: spec.parameters || { type: 'object', properties: {} },
    output: spec.output || { schema: { type: 'object' }, render: () => [] },
    execute: typeof spec.execute === 'function' ? spec.execute : async () => ({}),
  }
}

/**
 * 夹具内核:造一个最小的 Cordis ctx + 服务替身。**不要直接调用** ——
 * 用 buildHost(options) 拿到带 api()/dispose()/stats() 的宿主对象。
 *
 * 0.6 的 tools 试身按真机 dsh-tools 搭三层(见文件头):全局 / 祖先 / 作用域自有。
 * 关键语义:
 *   · `get(name, scope)` / `executable(name, scope)` 的第二个参数是 agent(或 id),
 *     省略 = 服务绑定的那个作用域;自有层永远压过继承层(restrict 挡不住自有层)。
 *   · `definitions(scope)` 返回该作用域可见定义数组(被 deny 的过滤掉)。
 *   · `view(scope)` 返回真机形状 `{ visible: Map, knownNames: Set, restrictableNames: Set }`
 *     (额外附 visibleNames / visibleDefinitions 两个数组,方便断言)。
 *   · `restrict({deny})` 在根作用域直接抛;名字不在 restrictableNames 里也抛(真机原话)。
 *   · `guard(fn)` 可注册在任意作用域(真机允许),但 host-harness 的不变量是「只在根层注册一次」。
 */
function createHarnessCore(options = {}) {
  const state = {
    effects: [],
    /** 全局层:root `tools.register()` / `shippedTools` */
    toolDefs: new Map(),
    /** 祖先层:`options.shellDefinitions`(preset / 第三方插件发布,不是本插件注册的全局工具) */
    inheritDefs: new Map(),
    /** 作用域自有层:scopeId → Map(name → definition)(`options.agentTools` / `registerAgentTool`) */
    ownDefs: new Map(),
    /** 每个作用域各自的遮挡集合:真机上 restrict 是 per-agent 的,不是全局共享一份 */
    deny: new Map(),
    listeners: new Map(),
    agents: [],
    /** tools.guard 的替身:真机语义是「任一 guard 返回字符串即拒绝」 */
    guards: [],
    /** 每次 guard 注册来自哪个作用域:'(root)' / agent id(钉「只在根层注册一次」) */
    guardScopes: [],
    /** guardReason 累计拒绝次数(夹具侧诊断;插件的 syncStats.guardRefusals 是另一本账) */
    guardRefusals: 0,
    /** 每一次 restrict 的真实尝试(含抛错的):测重试窗口/稳态不重试,别靠副作用猜 */
    restrictAttempts: [],
    /** 成功落地(拿到 disposer)的 restrict 次数 */
    successfulRestrictCalls: 0,
    /** 每个作用域由 restrict 派发出去的 disposer:agent 作用域 dispose 时统一撤销 */
    scopeDisposers: new Map(),
  }
  /** 作用域 id(agent 对象 / id 字符串 / null=全局)。 */
  const idOf = (scope) => {
    if (scope === null || scope === undefined) return null
    if (typeof scope === 'string' || typeof scope === 'number') return String(scope)
    if (typeof scope === 'object') {
      if (typeof scope.id === 'string' && scope.id) return scope.id
      if (typeof scope.key === 'string' && scope.key) return scope.key
    }
    return null
  }
  /** 本次调用的作用域:参数省略 = 服务绑定的那个;显式传 agent = 那个 agent。 */
  const scopeOfArg = (scopeId, scope) => {
    if (scope === undefined) return scopeId
    if (scope === null) return null
    const id = idOf(scope)
    return id === null ? scopeId : id
  }
  const denyOf = (scopeId) => {
    if (!state.deny.has(scopeId)) state.deny.set(scopeId, new Set())
    return state.deny.get(scopeId)
  }
  const ownOf = (scopeId) => {
    if (!state.ownDefs.has(scopeId)) state.ownDefs.set(scopeId, new Map())
    return state.ownDefs.get(scopeId)
  }
  /** 继承层 = 全局层 + 祖先层(可被 restrict;真机 restrictableNames 的口径)。 */
  const inheritedDefs = () => {
    const out = new Map()
    for (const [name, def] of state.toolDefs) out.set(name, def)
    for (const [name, def] of state.inheritDefs) if (!out.has(name)) out.set(name, def)
    return out
  }
  /** 可 restrict 的名字集合:只有继承层(agent 自有层不在里面 = restrict 挡不掉)。 */
  const restrictableFor = () => new Set(inheritedDefs().keys())
  /** 该作用域登记过的名字:继承层 + 自有层。 */
  const knownFor = (scopeId) => {
    const names = new Set(inheritedDefs().keys())
    if (scopeId !== null) for (const name of ownOf(scopeId).keys()) names.add(name)
    return names
  }
  /**
   * 该作用域此刻看得见的定义:继承层扣掉本作用域的 deny(再扣 executable 激活条件),
   * 然后自有层整体叠上去(限制只过滤「继承来的」,不过滤自己的注册 —— 真机原话)。
   */
  const visibleFor = (scopeId) => {
    const denied = scopeId !== null ? denyOf(scopeId) : null
    const out = new Map()
    for (const [name, def] of inheritedDefs()) {
      if (denied && denied.has(name)) continue
      const forced = typeof options.executableFor === 'function' ? options.executableFor(scopeId, name) : undefined
      if (forced === false) continue
      out.set(name, def)
    }
    if (scopeId !== null) for (const [name, def] of ownOf(scopeId)) out.set(name, def)
    return out
  }
  /**
   * 某个作用域看到的工具服务。
   * 关键真机语义都在这里:
   *   · 被 restrict 掉的**继承层工具**在这个作用域里读作「不存在」;
   *   · 自有层注册的名字 restrict 挡不掉(restrict 直接抛);
   *   · 根作用域(scopeId === null)没有 restrict:全局遮挡会遮住所有 agent,真机直接拒绝。
   */
  const toolsFor = (scopeId) => {
    const api = {
      register(def) {
        const name = def && def.name ? String(def.name) : ''
        if (!name) throw new Error('tool definition needs a name')
        if (state.toolDefs.has(name)) throw new Error('duplicate tool ' + name)
        state.toolDefs.set(name, def)
        return () => state.toolDefs.delete(name)
      },
      get(name, scope) {
        const at = scopeOfArg(scopeId, scope)
        if (at !== null && ownOf(at).has(name)) return ownOf(at).get(name)
        if (at !== null && denyOf(at).has(name)) return null
        return inheritedDefs().get(name) || null
      },
      /**
       * 真机语义(dsh-ops 口径):`get` 回答「注册了没有」,`executable` 回答「这一单真的能调」。
       * ptc 模式下模型直呼只允许 run_code 时,替代工具会「get 有、executable 无」——
       * 拿 get 判就绪就会把真正能用的宿主工具藏掉,模型于是收到零命令工具。
       * 默认与 get 同口径;夹具用 options.executableFor(scopeId, name) 制造分歧:
       * 返回 false → 视为不可执行(返回 null);返回 undefined / true → 回落 get。
       */
      executable(name, scope) {
        const at = scopeOfArg(scopeId, scope)
        const forced = typeof options.executableFor === 'function' ? options.executableFor(at, name) : undefined
        if (forced === false) return null
        if (at !== null && ownOf(at).has(name)) return ownOf(at).get(name)
        if (at !== null && denyOf(at).has(name)) return null
        return inheritedDefs().get(name) || null
      },
      /**
       * 真机 restrict:只能挡**继承层**的名字;根作用域调用直接抛。
       * 返回的就是撤销这一层遮挡的 disposer(组合语义:只撤销自己加的名字)。
       */
      restrict(spec) {
        const deny = spec && Array.isArray(spec.deny) ? spec.deny.map(String) : []
        const attempt = { scope: scopeId, deny: deny.slice(), ok: false, error: '', added: [] }
        state.restrictAttempts.push(attempt)
        if (scopeId === null) {
          // 真机原话(dsh-tools):全局限制会把每个 agent 都遮住
          attempt.error = 'tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent'
          throw new Error(attempt.error)
        }
        if (!deny.length) {
          attempt.error = 'tools.restrict({}) is a no-op'
          throw new Error(attempt.error)
        }
        const restrictable = restrictableFor()
        const unknown = deny.filter((name) => !restrictable.has(name))
        if (unknown.length) {
          // 真机原话:作用域私有注册(agent 自有层)挡不掉,restrict 直接抛。
          attempt.error =
            'tools.restrict() names unknown global tool' +
            (unknown.length > 1 ? 's' : '') +
            ' ' +
            unknown.map((name) => '"' + name + '"').join(', ') +
            '; known global tools: ' +
            ([...restrictable].sort().join(', ') || '(none)')
          throw new Error(attempt.error)
        }
        const set = denyOf(scopeId)
        const added = []
        for (const name of deny) {
          if (set.has(name)) continue
          set.add(name)
          added.push(name)
        }
        attempt.ok = true
        attempt.added = added.slice()
        state.successfulRestrictCalls++
        let live = true
        const dispose = () => {
          if (!live) return
          live = false
          for (const name of added) set.delete(name)
          const bucket = state.scopeDisposers.get(scopeId)
          if (bucket) bucket.delete(dispose)
        }
        let bucket = state.scopeDisposers.get(scopeId)
        if (!bucket) {
          bucket = new Set()
          state.scopeDisposers.set(scopeId, bucket)
        }
        bucket.add(dispose)
        return dispose
      },
      /** 真机:guard(经 ctx.tools.guard 注册)对每次调用求理由,任一返回字符串即拒绝 */
      guard(fn) {
        if (typeof fn !== 'function') throw new Error('tools.guard() needs a function')
        state.guards.push(fn)
        state.guardScopes.push(scopeId === null ? '(root)' : String(scopeId))
        return () => {
          const i = state.guards.indexOf(fn)
          if (i < 0) return
          state.guards.splice(i, 1)
          state.guardScopes.splice(i, 1)
        }
      },
    }
    /**
     * 真机语义:`tools.definitions(scope)` 枚举「这个作用域此刻看得见的工具定义」,
     * 连注册在 agent 祖先层、全局 get 查不到的都算(预设 / 第三方插件发布的命令工具)。
     * index.js 靠它认出第三方发布名(tenant_bash 之类)和家族。
     * 夹具返回:全局 register 的定义 + 祖先层 + (该作用域)自有层;被 deny 掉的不返回。
     * options.definitions === false 模拟老宿主:连方法都不挂,插件必须回退到按名字探可见性。
     */
    if (options.definitions !== false) {
      api.definitions = function definitions(scope) {
        return [...visibleFor(scopeOfArg(scopeId, scope)).values()]
      }
      /**
       * 真机 `tools.view(scope)` 的形状:`visible` 是 Map,knownNames / restrictableNames 是 Set。
       * 只含名字的调用方(view.knownNames 之类)与真机一致;额外给两个数组只是方便断言。
       */
      if (options.view !== false) {
        api.view = function view(scope) {
          const at = scopeOfArg(scopeId, scope)
          const visible = visibleFor(at)
          return {
            visible,
            knownNames: knownFor(at),
            restrictableNames: restrictableFor(),
            visibleNames: [...visible.keys()],
            visibleDefinitions: [...visible.values()],
          }
        }
      }
    }
    return api
  }
  const tools = toolsFor(null)
  // 模拟 preset 注册的宿主 shell 工具(接管判定靠它)
  for (const name of options.shippedTools || []) {
    state.toolDefs.set(name, toolDefinition(name, 'shipped ' + name))
    state.shipped = (state.shipped || new Set()).add(name)
  }
  // 模拟 preset / 第三方插件把命令工具发布在 agent 祖先层:每个作用域都看得见,
  // 但不是「本插件 register 的全局工具」。options.shellDefinitions 是定义原文,
  // 供 definitions(scope) 枚举 —— 动态识别用例靠它注入 tenant_bash 这类发布名。
  // 注意:祖先层与全局层分开存,这样 restrict 语义能按真机口径检查 restrictableNames。
  for (const def of options.shellDefinitions || []) {
    if (!def || !def.name) continue
    state.inheritDefs.set(String(def.name), toolDefinition(def.name, def.description, def))
  }
  /**
   * 作用域自有层注册(模拟 preset 把 pwsh 发布在 agent 层 / dsh-ops 的 ops_bash 在自有层):
   * definitions(agent) 看得见、knownNames 有、restrictableNames 没有、restrict 会抛。
   * 支持写名字(只用来测「挡不掉」)或完整定义。
   */
  const registerAgentTool = (agentId, item) => {
    const def = typeof item === 'string' ? toolDefinition(item, 'agent-layer ' + item) : toolDefinition(item && item.name, item && item.description, item || {})
    if (!def.name) throw new Error('agent tool needs a name')
    ownOf(String(agentId)).set(def.name, def)
    return def
  }
  const unregisterAgentTool = (agentId, name) => ownOf(String(agentId)).delete(String(name))
  for (const [agentId, defs] of Object.entries(options.agentTools || {})) {
    for (const item of defs || []) registerAgentTool(agentId, item)
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
  const addAgent = (id, session) => {
    const agent = makeAgent(id, session)
    state.agents.push(agent)
    return agent
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
  /** 直接往全局层加一个工具(运行时模拟「宿主后来又装了命令工具」)。 */
  const registerGlobalTool = (item) => {
    const def = typeof item === 'string' ? toolDefinition(item, 'global ' + item) : toolDefinition(item && item.name, item && item.description, item || {})
    if (!def.name) throw new Error('global tool needs a name')
    if (state.toolDefs.has(def.name)) throw new Error('duplicate tool ' + def.name)
    state.toolDefs.set(def.name, def)
    return def
  }
  const unregisterGlobalTool = (name) => state.toolDefs.delete(String(name))
  /**
   * agent 作用域 dispose(真机语义):
   *   · 该作用域里挂的 restrict effect 自动撤销(restrict 返回的 disposer 正好是那个 effect 的句柄);
   *   · 作用域消失 → 该作用域的 deny 集合不再有意义,一并清掉;
   *   · 自有层注册随作用域销毁;
   *   · 从 `agents.list()` 移除,再派发 `agent/disposed`({ agent })(真机 payload 就是这个形状)。
   * 先撤句柄再派发:插件收到事件时不该看到「还挂着遮挡」的中间态。
   */
  const disposeAgent = (agent) => {
    if (!agent) return false
    const id = idOf(agent)
    if (id === null) return false
    const bucket = state.scopeDisposers.get(id)
    if (bucket) {
      for (const dispose of [...bucket]) {
        try {
          dispose()
        } catch {}
      }
      state.scopeDisposers.delete(id)
    }
    denyOf(id).clear()
    const own = state.ownDefs.get(id)
    if (own) own.clear()
    const i = state.agents.indexOf(agent)
    if (i >= 0) state.agents.splice(i, 1)
    emit('agent/disposed', { agent })
    return true
  }
  /** 某次调用的 guard 结论(真机:任一 guard 拒绝即拒绝)。真机 exec 形状含 arguments。 */
  const guardReason = (name, agent) => {
    const exec = { name: String(name || ''), agent: agent || undefined, arguments: {} }
    for (const fn of [...state.guards]) {
      try {
        const reason = fn(exec)
        if (typeof reason === 'string' && reason) {
          state.guardRefusals++
          return reason
        }
      } catch {}
    }
    return undefined
  }
  return {
    ctx,
    state,
    webRoutes,
    services,
    subprocess,
    makeAgent,
    addAgent,
    emit,
    toolsFor,
    setScopeDeny,
    guardReason,
    webServer,
    disposeAgent,
    registerGlobalTool,
    unregisterGlobalTool,
    registerAgentTool,
    unregisterAgentTool,
  }
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
 *   shippedTools       宿主已注册的命令工具名(数组),模拟 preset 自带的 bash/pwsh(全局层)
 *   agentIds           agent 列表:字符串(无会话)或 { id, session }
 *   shell              宿主 shell 服务替身:fakeSandboxedShell(...) 或 { sandboxMode } / {}
 *   shellEnv           受管的 DSH_* 快照收集器
 *   sandboxPolicy      逐会话沙箱策略替身(见 fakeSandboxPolicy)
 *   subprocess         假 subprocess 的配置({ registryPath, exitWhen, fail, latencyMs })
 *   shellDefinitions   发布在 agent 祖先层的命令工具定义原文(动态识别用例)
 *   agentTools         { agentId: [name|definition] } 注册进某个 agent 的**自有层**
 *                      (模拟 preset 把 pwsh 发布在 agent 层 / ops_bash 在自有层)
 *   definitions        false → 模拟老宿主(没有 tools.definitions / view)
 *   view               false → 只模拟「有 definitions、没有 view」的中间代宿主
 *   executableFor      (scopeId, name) → false 时 get 有、executable 无(ptc 折叠)
 *
 * 返回:{ ctx, services, state, webRoutes, subprocess, makeAgent, addAgent, emit, toolsFor,
 *        setScopeDeny, guardReason, disposeAgent, registerGlobalTool, unregisterGlobalTool,
 *        registerAgentTool, unregisterAgentTool, tools, api(), dispose(), stats() }
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
    /**
     * agent 作用域 dispose(见 createHarnessCore 里的注释)。
     * 返回 true 表示派发了 agent/disposed(监听者已跑)。
     */
    disposeAgent: (agent) => core.disposeAgent(agent),
    /** 当前夹具状态快照(诊断 / 断言用;不要在这里修改任何东西)。 */
    stats() {
      const activeDenies = {}
      for (const [scopeId, set] of core.state.deny) {
        if (!set || set.size === 0) continue
        activeDenies[scopeId === null ? '(root)' : scopeId] = [...set].sort()
      }
      return {
        effects: core.state.effects.length,
        toolDefs: [...core.state.toolDefs.keys()],
        inheritedDefs: [...core.state.inheritDefs.keys()],
        ownLayers: Object.fromEntries([...core.state.ownDefs.entries()].map(([id, map]) => [id, [...map.keys()].sort()])),
        webRoutes: core.webRoutes.map((r) => r && r.path),
        guards: core.state.guards.length,
        guardScopes: core.state.guardScopes.slice(),
        guardRefusals: core.state.guardRefusals,
        /** 每一次 restrict 尝试的次数(含抛错的) */
        restrictCalls: core.state.restrictAttempts.length,
        /** 成功拿到 disposer 的 restrict 次数 */
        successfulRestrictCalls: core.state.successfulRestrictCalls,
        /** 每次尝试的明细:{ scope, deny, ok, error }(scope 为 '(root)' 表示根层,真机不允许) */
        restrictAttempts: core.state.restrictAttempts.map((attempt) => ({
          scope: attempt.scope === null ? '(root)' : attempt.scope,
          deny: attempt.deny.slice(),
          ok: attempt.ok,
          error: attempt.error,
        })),
        /** 此刻还生效的遮挡(每作用域);空 = 没有残留 */
        activeDenies,
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

// ───────────────────────────────────── PATH 辅助(「没有 Git Bash」等) ──
/**
 * 临时把 `process.env.PATH` 过滤成 predicate 保留的目录,跑完恢复。
 *
 * ⚠ 探测缓存两个坑,调用方必须自己处理:
 *   1. 探测结果有 45s TTL 与进程级缓存 → 改完 PATH 必须 `post(h, {op:'refresh'})` 拿新快照,
 *      跑完恢复 PATH 后也要再 refresh 一次,否则后面的夹具会吃到桩环境的探测结果;
 *   2. 「系统 PATH」走注册表(fakeSubprocess 默认返回 process.env.PATH),refresh 时才会重读。
 *
 * 回调拿到 `{ path, dirs }`(过滤后的 PATH 与实际目录),方便用例断言。
 */
export async function withPath(predicate, fn) {
  const before = process.env.PATH
  const keep = typeof predicate === 'function' ? predicate : () => Boolean(predicate)
  const dirs = pathDirs().filter(keep)
  process.env.PATH = dirs.join(';')
  try {
    return await fn({ path: process.env.PATH, dirs: dirs.slice() })
  } finally {
    process.env.PATH = before
  }
}

/**
 * 建一个只放指定空文件桩的临时 bin 目录(自动登记清理)。
 * 用于「机器上没有 Git Bash、也没有 git→bash 兜底」这类用例:把 PATH 换成一
 * 只有 git.exe 桩的目录,index.js 的 git 兜底(dirname(dirname(git)))就找不到 bash。
 */
export function makeStubBin(files = []) {
  const dir = mkdtempSync(join(tmpdir(), 'envdock-stubbin-'))
  cleanupDirs.push(dir)
  for (const file of files) {
    try {
      writeFileSync(join(dir, file), '', 'utf8')
    } catch {}
  }
  return dir
}

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
