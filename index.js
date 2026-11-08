/**
 * EnvDock · Host half.
 *
 * 职责:
 *   1. 探测机器上的工具链(Node/Python/Git/包管理器)、多版本、版本管理器与终端。
 *   2. 把「系统 + 终端 + 工具版本」写成一条运行环境简报,注入给模型。
 *   3. 注册 `envd` 工具:按名字解析绝对路径 / 版本 / 该终端下的正确命令语法。
 *   4. 默认终端不是 pwsh 时,注册一个跑该终端的命令工具,并只保留一个命令入口。
 *   5. 提供 /envdock-api 给侧边栏面板读写状态。
 *
 * 刻意不 import 任何 @deepseek-ai/* 包:本地目录安装是 link 检出,
 * 包内 import 解析不到 profile 的 node_modules。只用 node: 内置模块。
 */
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, copyFileSync, mkdirSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir, release, arch, hostname, type, version as osVersion } from 'node:os'

const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_DIR = DSH_HOME
const STATE_FILE = join(DSH_HOME, 'envdock.json')
const API_PATH = '/envdock-api'
const CACHE_TTL_MS = 45_000
const COMSPEC = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe'

// ─────────────────────────────────────────── 状态文件(用户选择) ──

const DEFAULT_STATE = {
  version: 1,
  /** 'auto' | 'pwsh' | 'powershell' | 'cmd' | 'bash' | 'custom' */
  defaultShell: 'auto',
  /** 自定义终端: { label, path, args: string[] } ,args 里用 {command} 占位 */
  customShell: null,
  /** 工具默认版本: { node: 'C:\\...\\node.exe', python: '...' } */
  selections: {},
  /** 用户手工加的工具: [{ key, label, path, versionArgs: string[] }] */
  customTools: [],
  /** 选项开关(面板可改,写进 ~/.dsh/envdock.json) */
  options: {
    injectBrief: true,
    /** 'auto' = 默认终端与宿主自带 shell 不同族时才接管; 'takeover' = 总是; 'off' = 只管简报 */
    shellTakeover: 'auto',
    /**
     * 本会话真的被沙箱围栏时,EnvDock 怎么处理:
     *   'delegate'(默认)=把命令委托给带围栏的宿主执行器(ctx.shell)执行,围栏挂在宿主进程上,
     *                    子终端继承它 —— 功能保住,沙箱不被绕过;
     *   'refuse'       =干脆不接管,把带围栏的宿主命令工具留给模型。
     * 无论哪种,EnvDock 都**绝不**自己 spawn 一条没有 sandboxPolicy 的命令。
     */
    sandboxTakeover: 'delegate',
    /** 允许非 loopback 请求访问 /envdock-api(默认关:面板数据含本机路径与终端) */
    allowLan: false,
  },
}

const TAKEOVER_MODES = ['auto', 'takeover', 'off']
const SANDBOX_TAKEOVER_MODES = ['delegate', 'refuse']
const STATE_BACKUP = STATE_FILE + '.corrupt'

/**
 * options 白名单归一化。
 *
 * 状态文件是**用户可手改**的(也是老版本写的):里面的布尔可能是 "yes"/1,枚举可能是任意字符串。
 * 全部在这里收敛成「布尔只有 true/false、shellTakeover 只有三个合法值」,消费端才能一律用 === true 判断
 * —— 否则 Boolean("false") 为真这类坑会在面板和接管逻辑两边各踩一次。
 */
function normalizeOptions(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    injectBrief: src.injectBrief === false ? false : true,
    shellTakeover: TAKEOVER_MODES.includes(src.shellTakeover) ? src.shellTakeover : 'auto',
    sandboxTakeover: SANDBOX_TAKEOVER_MODES.includes(src.sandboxTakeover) ? src.sandboxTakeover : 'delegate',
    allowLan: src.allowLan === true,
  }
}

/** 自定义工具条目:path 强制 String(手改过的 json 里可能是数字/对象),没有 path 的条目直接丢掉。 */
function normalizeCustomTool(raw) {
  if (!raw || typeof raw !== 'object') return null
  const path = raw.path === undefined || raw.path === null ? '' : String(raw.path).trim()
  if (!path) return null
  const label = raw.label === undefined || raw.label === null ? '' : String(raw.label).trim()
  const key = (raw.key === undefined || raw.key === null ? '' : String(raw.key)).trim()
  return {
    key: key || label.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || basename(path),
    label: label || basename(path),
    path,
    versionArgs: Array.isArray(raw.versionArgs) && raw.versionArgs.length ? raw.versionArgs.map(String) : ['--version'],
  }
}

/** 默认版本选择:只收「非空字符串 → 路径」这种条目。 */
function normalizeSelections(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw)) if (typeof value === 'string' && value) out[key] = value
  return out
}

/**
 * 最近一次读到损坏状态文件的说明(给面板 issue 用;成功写回后清掉)。
 * 每次 readState 都调用,所以按 mtime+size 去重:同一个坏文件只备份一次,不反复写盘。
 */
let stateCorrupt = null

function noteStateCorrupt(error) {
  try {
    const st = statSync(STATE_FILE)
    const sig = st.mtimeMs + ':' + st.size
    if (stateCorrupt && stateCorrupt.sig === sig) return
    let backup = ''
    try {
      copyFileSync(STATE_FILE, STATE_BACKUP)
      backup = STATE_BACKUP
    } catch {}
    stateCorrupt = { sig, at: Date.now(), reason: String((error && error.message) || error), backup }
  } catch {
    // 文件不存在(首次运行)/ 读不到:不算损坏,不要制造 issue
  }
}

/** 面板里那条「状态文件损坏」的 issue(健康时返回 null)。 */
function stateIssue() {
  if (!stateCorrupt) return null
  return {
    level: 'warn',
    title: '状态文件损坏,已回落默认设置',
    detail:
      STATE_FILE +
      ' 无法解析(' +
      stateCorrupt.reason +
      ')。' +
      (stateCorrupt.backup ? '原文件已备份到 ' + stateCorrupt.backup + '。' : '') +
      '改一次设置即可写回正常文件。',
  }
}

/**
 * 状态文件的内存缓存。
 *
 * 简报每个模型请求都要读一次 state;以前每次都 readFileSync + JSON.parse。
 * 用「mtime+size」当签名:文件没变就直接复用解析结果,别把磁盘读放进热路径。
 * 任何写入路径结束都会主动失效,不依赖 mtime 精度。
 */
let stateCache = { signature: null, value: null }
function stateFileSignature() {
  try {
    const st = statSync(STATE_FILE)
    return st.mtimeMs + ':' + st.size
  } catch {
    return 'missing'
  }
}
function invalidateStateCache() {
  stateCache = { signature: null, value: null }
}

function readState() {
  const signature = stateFileSignature()
  if (stateCache.value && stateCache.signature === signature) return stateCache.value
  let raw = null
  try {
    raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('状态文件不是 JSON 对象')
  } catch (error) {
    // ENOENT = 首次运行(正常);其余(坏 JSON / 不是对象)才算损坏:留 .corrupt 并给面板一条 issue。
    if (error && error.code !== 'ENOENT') noteStateCorrupt(error)
    raw = null
  }
  const normalized = {
    ...DEFAULT_STATE,
    ...(raw || {}),
    options: normalizeOptions(raw && raw.options),
    selections: normalizeSelections(raw && raw.selections),
    customTools: Array.isArray(raw && raw.customTools) ? raw.customTools.map(normalizeCustomTool).filter(Boolean) : [],
  }
  stateCache = { signature, value: normalized }
  return normalized
}

function writeState(patch) {
  const current = readState()
  const next = { ...current, ...patch }
  // options 只能经白名单进来:调用方给什么就存什么,会让状态文件里出现未知键和字符串布尔。
  next.options = normalizeOptions({ ...current.options, ...(patch && patch.options) })
  let tmp = ''
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    // 原子写:先写同目录临时文件再 rename。直接写目标文件时,进程在写一半被杀留下的半截
    // JSON 就是「损坏状态」的唯一来源;rename 之后要么是旧文件,要么是完整的新文件。
    tmp =
      STATE_FILE + '.tmp-' + process.pid + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    try {
      renameSync(tmp, STATE_FILE)
      tmp = ''
    } catch (error) {
      // Windows 上杀毒/索引器偶尔占着目标文件(EPERM/EBUSY):退让后原地覆盖写。
      // 刻意**不先 unlink** —— 那会先把旧状态删掉,万一写失败就什么都没有了。
      if (!(error && (error.code === 'EPERM' || error.code === 'EBUSY'))) throw error
      writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8')
      try {
        unlinkSync(tmp)
      } catch {}
      tmp = ''
    }
    // 写成功 = 状态文件恢复健康:面板上的「损坏」issue 可以收了(备份文件仍留着)。
    stateCorrupt = null
    // 内存缓存跟着失效:下一次读必须看到刚写的内容
    invalidateStateCache()
    // 只有**影响探测结果**的写入才作废探测缓存。以前任何 setOption(如 allowLan)都作废,
    // 面板上点一下开关就白跑一次全 PATH 重扫 + 版本管理器 list。
    const affectsDetection = ['defaultShell', 'customShell', 'selections', 'customTools'].some((key) =>
      Object.prototype.hasOwnProperty.call(patch || {}, key),
    )
    if (affectsDetection) invalidateDetection()
    // 接管状态也要立刻重算:否则面板上点了「只给简报」,还要等下一个 5 秒 tick 才生效。
    try {
      if (notifyStateChange) notifyStateChange()
    } catch {}
    return next
  } catch (error) {
    if (tmp) {
      try {
        unlinkSync(tmp)
      } catch {}
    }
    throw new Error('无法写入 ' + STATE_FILE + ':' + (error && error.message ? error.message : String(error)))
  }
}

// ─────────────────────────────────────── PATH 扫描(不依赖外部命令) ──

/** Windows 的 PATH 里可能留着没展开的 %VAR%(老安装器写的),顺手展开。 */
function expandEnvInPath(value) {
  if (!IS_WIN) return value
  return String(value).replace(/%([^%]+)%/g, (whole, name) => process.env[name] || whole)
}

/** PATH 被解析一次就够了:一次探测里 findAll 会按 20+ 个名字反复查它。 */
let pathMemo = { sig: null, entries: [] }

/** 目录真实存在吗?PATH 里挂着但已经被删掉的目录就是「失效目录」。 */
function dirExists(dir) {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * 目录写法的归一化:注册表里的 `D:\python` 和进程里继承下来的 `D:\python\` 是同一个目录,
 * 不归一化就会在 PATH 列表里出现两份(面板数量和失效计数都会重复)。盘符根 `C:\` 保留。
 */
function normalizeDir(dir) {
  if (!IS_WIN) return dir
  let out = dir
  while (out.length > 3 && /[\\/]$/.test(out)) out = out.slice(0, -1)
  return out
}

/**
 * 解析 junction / symlink,给出真实路径。
 * 否则「C 盘上一个 0 字节入口」会被当成工具的真实位置写进面板与简报
 * (用户看到的是 C:\Users\...\.pyenv\... 而文件其实在 E 盘)。
 */
function canonicalPath(p) {
  if (!p) return p
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** 一条 PATH 字符串 → 规整后的目录列表(展开 %VAR%、去引号、去空、归一化、去重)。 */
function splitPath(raw) {
  const seen = new Set()
  const out = []
  for (const piece of String(raw || '').split(IS_WIN ? ';' : ':')) {
    const dir = normalizeDir(expandEnvInPath(piece).replace(/^"|"$/g, '').trim())
    if (!dir) continue
    const key = IS_WIN ? dir.toLowerCase() : dir
    if (seen.has(key)) continue
    seen.add(key)
    out.push(dir)
  }
  return out
}

/**
 * 「系统此刻的 PATH」。
 *
 * process.env.PATH 是 dsh **启动那一刻**的快照:用户之后在系统里删掉一个失效目录、
 * 或装了新工具把新目录加进 PATH,进程里那份都不会变。只重扫它就等于「点了重新探测也不更新,
 * 非要重启 dsh」—— 所以这里再从注册表问一次系统当前值(取不到时才退回进程快照)。
 */
const LIVE_PATH_TTL_MS = 30_000
const livePath = { at: 0, dirs: null, triedAt: 0, inflight: null }

function systemPathQuery() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return {
    reg: join(root, 'System32', 'reg.exe'),
    machine: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    user: 'HKCU\\Environment',
  }
}

/** `reg query ... /v Path` 的输出里把值那一行拿出来(`    Path    REG_EXPAND_SZ    C:\\...`)。 */
async function runRegQuery(runner, reg, key) {
  try {
    const res = await runner.spawnRead([reg, 'query', key, '/v', 'Path'], 5000)
    if (!res || !res.text) return ''
    for (const line of String(res.text).split(/\r?\n/)) {
      const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i.exec(line)
      if (m) return m[1].trim()
    }
  } catch {
    /* 读不到就当没有 */
  }
  return ''
}

async function readSystemPath(runner) {
  if (!IS_WIN || !runner) return null
  const q = systemPathQuery()
  const machine = await runRegQuery(runner, q.reg, q.machine)
  const user = await runRegQuery(runner, q.reg, q.user)
  const dirs = splitPath([machine, user].filter(Boolean).join(';'))
  return dirs.length ? dirs : null
}

/**
 * 需要时刷新「系统当前 PATH」。force=true 一定重读(用户点了「重新探测」)。
 * 并发只读一份;读失败也不反复重试(30s 内只试一次,免得每次刷新都白起两个子进程)。
 */
async function ensureLivePath(runner, force) {
  if (!IS_WIN || !runner) return Boolean(livePath.dirs)
  const now = Date.now()
  if (!force) {
    if (livePath.dirs && now - livePath.at < LIVE_PATH_TTL_MS) return true
    if (now - livePath.triedAt < LIVE_PATH_TTL_MS) return Boolean(livePath.dirs)
  }
  if (livePath.inflight) {
    try {
      await livePath.inflight
    } catch {}
    if (!force) return Boolean(livePath.dirs)
  }
  livePath.triedAt = now
  const job = (async () => {
    try {
      const dirs = await readSystemPath(runner)
      if (dirs && dirs.length) {
        livePath.dirs = dirs
        livePath.at = Date.now()
      }
    } catch {
      /* 读不到就继续用进程快照,不报错 */
    } finally {
      livePath.inflight = null
    }
    return Boolean(livePath.dirs)
  })()
  livePath.inflight = job
  return job
}

/**
 * 把「系统当前的 PATH」并进进程快照:
 *   · 进程有、系统已删、目录也不在 → 丢掉(用户从系统 PATH 删掉的僵尸项,这就是「改了不生效」的根因)
 *   · 进程有、系统已删、但目录还在 → 保留(启动器/终端自己塞进来的,不归系统 PATH 管)
 *   · 系统有、进程没有 → 追加(启动 dsh 之后新装的工具,不重启也能看见)
 */
function mergeLivePath(entries, liveDirs) {
  const lower = (p) => (IS_WIN ? p.toLowerCase() : p)
  const liveKeys = new Set(liveDirs.map(lower))
  const have = new Set()
  const kept = []
  for (const dir of entries) {
    const key = lower(dir)
    if (have.has(key)) continue
    if (!liveKeys.has(key) && !dirExists(dir)) continue
    have.add(key)
    kept.push(dir)
  }
  for (const dir of liveDirs) {
    const key = lower(dir)
    if (have.has(key)) continue
    have.add(key)
    // 系统 PATH 里但不存在 → 留着,让健康检查照样报「失效目录」(那是真的坏了)
    kept.push(dir)
  }
  entries.length = 0
  entries.push(...kept)
}

/** 探测实际用的 PATH 和进程快照是否已经不一致(不一致就说明 dsh 启动后系统 PATH 变过)。 */
function processPathDrift(used) {
  const base = splitPath(process.env.PATH || process.env.Path || '')
  if (base.length !== used.length) return true
  return base.some((dir, i) => dir !== used[i])
}

function pathEntries() {
  const raw = process.env.PATH || process.env.Path || ''
  const sig = raw + '\u0000' + (livePath.dirs ? livePath.dirs.join(';') : '')
  if (pathMemo.sig === sig) return pathMemo.entries
  const entries = splitPath(raw)
  if (livePath.dirs && livePath.dirs.length) mergeLivePath(entries, livePath.dirs)
  pathMemo = { sig, entries }
  return entries
}

function executableExts() {
  // Windows 只按 PATHEXT 解析,不带扩展名的同名文件(npm / pnpm 的 sh 脚本)永远不可执行,
  // 放在候选里会抢到 .cmd 垫片前面,导致版本探测落空。
  if (!IS_WIN) return ['']
  const raw = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD'
  return String(raw)
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * 每个 PATH 目录只 readdir 一次,按名字建索引。
 * 以前 findAll 是「名字 × 目录 × PATHEXT 扩展名」逐个 statSync:16 个名字 × 30 个目录 × 5 种扩展名
 * ≈ 2400 次系统调用,在 Windows 冷缓存下要一秒多,而且全在事件循环上阻塞。
 */
let dirIndexMemo = new Map()

function clearDirIndex() {
  dirIndexMemo = new Map()
}

function namesInDir(dir) {
  const key = IS_WIN ? dir.toLowerCase() : dir
  let set = dirIndexMemo.get(key)
  if (set) return set
  set = new Set()
  for (const ent of listDir(dir)) {
    if (ent.isFile() || ent.isSymbolicLink()) set.add(ent.name.toLowerCase())
  }
  dirIndexMemo.set(key, set)
  return set
}

/** 沿 PATH 找同名可执行文件,返回全部命中(去重)。 */
function findAll(name) {
  const fixedDir = name.includes('/') || name.includes('\\')
  const hasExt = /\.[a-z0-9]{1,5}$/i.test(name)
  if (fixedDir) {
    if (existsSync(name)) return [name]
    return []
  }
  const exts = hasExt ? [''] : executableExts()
  const lower = name.toLowerCase()
  const hits = []
  for (const dir of pathEntries()) {
    const names = namesInDir(dir)
    if (!names.size) continue
    for (const ext of exts) {
      if (!names.has(lower + ext)) continue
      const candidate = join(dir, name + ext)
      if (!hits.some((h) => h.toLowerCase() === candidate.toLowerCase())) hits.push(candidate)
    }
  }
  return hits
}

function firstHit(name) {
  const hits = findAll(name)
  return hits.length ? canonicalPath(hits[0]) : null
}

function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

// ────────────────────────────────────────────────────── 命令探测 ──

function createRunner(ctx) {
  const sp = ctx.get('subprocess')
  if (!sp || typeof sp.spawn !== 'function') return null

  function spawnRead(argv, timeoutMs) {
    return new Promise((resolve) => {
      let handle
      try {
        handle = sp.spawn({
          argv,
          cwd: process.cwd(),
          stdio: { stdin: 'ignore', stdout: { maxBytes: 262144 }, stderr: { maxBytes: 32768 } },
          graceMs: 1500,
        })
      } catch (error) {
        resolve({ ok: false, text: String((error && error.message) || error), exitCode: null })
        return
      }
      let settled = false
      const finish = (exitCode) => {
        if (settled) return
        settled = true
        let out = ''
        try {
          const s = handle.collected && handle.collected.stdout
          if (s) out += s.readFrom(0).text || ''
        } catch {}
        try {
          const e = handle.collected && handle.collected.stderr
          if (e) out += (out ? '\n' : '') + (e.readFrom(0).text || '')
        } catch {}
        resolve({ ok: exitCode === 0, text: out, exitCode })
      }
      const timer = setTimeout(() => {
        try {
          handle.terminate()
        } catch {}
        finish(null)
      }, Math.max(500, timeoutMs || 5000))
      handle.done.then(
        (outcome) => {
          clearTimeout(timer)
          finish(outcome ? outcome.exitCode : null)
        },
        (error) => {
          clearTimeout(timer)
          finish(null)
          void error
        },
      )
    })
  }

  /**
   * 跑一个可执行文件。Windows 的 .cmd/.bat 垫片必须经 cmd.exe 启动,
   * 且要用 `call` + 未加引号的 argv:Node 拼命令行时会把含空格的参数用 `"` 包住并把内部 `"` 转义,
   * 直接传 `"path" args` 会被 cmd 的引号剥离规则吃掉。
   */
  function runPath(exe, args, timeoutMs) {
    if (!exe) return Promise.resolve({ ok: false, text: '', exitCode: null })
    if (IS_WIN && /\.(cmd|bat)$/i.test(exe)) {
      return spawnRead([COMSPEC, '/d', '/c', 'call', exe, ...(args || [])], timeoutMs)
    }
    return spawnRead([exe, ...(args || [])], timeoutMs)
  }

  return { spawnRead, runPath, terminalEnv: () => (typeof sp.terminalEnvironment === 'function' ? sp.terminalEnvironment() : Promise.resolve(null)) }
}

// ───────────────────────────────────────────────────── 工具目录 ──

const CATALOG = [
  { key: 'node', label: 'Node.js', names: ['node'], versionArgs: ['--version'], group: 'runtime' },
  { key: 'npm', label: 'npm', names: ['npm'], versionArgs: ['--version'], group: 'package' },
  { key: 'pnpm', label: 'pnpm', names: ['pnpm'], versionArgs: ['--version'], group: 'package' },
  { key: 'yarn', label: 'yarn', names: ['yarn'], versionArgs: ['--version'], group: 'package' },
  { key: 'bun', label: 'bun', names: ['bun'], versionArgs: ['--version'], group: 'runtime' },
  { key: 'deno', label: 'Deno', names: ['deno'], versionArgs: ['--version'], group: 'runtime' },
  // py 是 Windows 的启动器(不是解释器):放在最后当兜底 —— python.exe 在 PATH 上时首选它,
  // 只有 py.exe 时也不会让整条 Python 记录消失。它同时是 python 的别名(envd resolve py)。
  { key: 'python', label: 'Python', names: ['python', 'python3', 'py'], versionArgs: ['--version'], group: 'runtime' },
  { key: 'pip', label: 'pip', names: ['pip', 'pip3'], versionArgs: ['--version'], group: 'package' },
  { key: 'uv', label: 'uv', names: ['uv'], versionArgs: ['--version'], group: 'package' },
  { key: 'git', label: 'Git', names: ['git'], versionArgs: ['--version'], group: 'vcs' },
  { key: 'conda', label: 'conda', names: ['conda'], versionArgs: ['--version'], group: 'env' },
]

const TERMINALS = [
  { key: 'pwsh', label: 'PowerShell 7', names: ['pwsh'], family: 'powershell', versionArgs: ['--version'] },
  {
    key: 'powershell',
    label: 'Windows PowerShell',
    names: ['powershell'],
    family: 'powershell',
    versionArgs: ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
  },
  { key: 'cmd', label: 'cmd', names: ['cmd'], family: 'cmd', versionArgs: null },
  { key: 'bash', label: 'Git Bash', names: ['bash'], family: 'bash', versionArgs: ['--version'] },
  { key: 'sh', label: 'sh', names: ['sh'], family: 'bash', versionArgs: null },
  { key: 'zsh', label: 'zsh', names: ['zsh'], family: 'bash', versionArgs: ['--version'] },
  { key: 'wsl', label: 'WSL', names: ['wsl'], family: 'wsl', versionArgs: null },
]

/** 已注册的 shell 工具名 → 终端家族。用来在运行时认出「宿主自带哪个 shell」。 */
const SHELL_TOOL_FAMILY = {
  pwsh: 'powershell',
  powershell: 'powershell',
  cmd: 'cmd',
  bash: 'bash',
  sh: 'bash',
  zsh: 'bash',
  fish: 'bash',
  // dsh-ops 在 cordis 模式下用 ops_bash 顶替官方 pwsh/bash 工具(同一套 bash 语法)。
  // 不认它就会同时看到两个命令工具(EnvDock 想藏也藏不掉),所以按 bash 家族认领。
  ops_bash: 'bash',
}

/** 发现顺序:先看宿主最可能自带的那个。 */
const SHELL_TOOL_ORDER = IS_WIN ? ['pwsh', 'powershell', 'cmd', 'bash', 'ops_bash'] : ['bash', 'zsh', 'sh', 'ops_bash']
const SHELL_TOOL_NAMES = Object.freeze(Object.keys(SHELL_TOOL_FAMILY))
/** 宿主沙箱策略的合法闭集:resolve 出别的值一律按「策略不可知」保守处理 */
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])

/**
 * 名字里的家族 token:用来认 `ops_bash` 之外的第三方发布名(`tenant_bash`、`pwsh_sandbox` 之类)。
 * dsh-ops 的发布规则是 `ops_ + raw`,但换前缀 / 换平台 / 别的插件发布同类工具时,
 * 写死一份名单一定会漏认,漏认的后果就是模型手里两个命令工具。所以按 token 认家族。
 */
const SHELL_FAMILY_TOKENS = [
  { family: 'powershell', re: /^(pwsh|powershell)$/ },
  { family: 'cmd', re: /^cmd$/ },
  { family: 'wsl', re: /^wsl$/ },
  { family: 'bash', re: /^(bash|gitbash|msys|sh|zsh|fish)$/ },
]

/** 只按名字判家族;认不出返回 ''。 */
function shellFamilyByName(name) {
  const lower = String(name || '').toLowerCase()
  if (!lower || lower === ENVD_SHELL_NAME) return ''
  if (SHELL_TOOL_FAMILY[lower]) return SHELL_TOOL_FAMILY[lower]
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean)
  for (const token of tokens) {
    for (const entry of SHELL_FAMILY_TOKENS) if (entry.re.test(token)) return entry.family
  }
  return ''
}

/**
 * 从工具定义认宿主命令工具(有 `tools.definitions` 的宿主机才走这条)。
 * 名字有 token 就认;名字没有线索时,只有「描述明确提到某种 shell」且「参数里有 command」
 * 才认 —— 否则会把 `ops_read_files` 这类文件工具、或别的插件的 RPC 工具卷进来挡住。
 */
function shellFamilyFromDefinition(definition) {
  const name = definition && definition.name ? String(definition.name) : ''
  if (!name || name === ENVD_SHELL_NAME) return ''
  // 内置名单里的名字直接认(官方 pwsh/bash、dsh-ops 的 ops_bash)。
  const exact = SHELL_TOOL_FAMILY[name.toLowerCase()]
  if (exact) return exact
  const props = definition && definition.parameters && definition.parameters.properties
  // 名字里带 shell token **不等于**命令工具:`run_cmd`(任务参数)、`wc_cmd_palette`(UI 面板)
  // 这类名字会被误认成宿主 shell → 接管时静默挡掉无关工具。必须同时有命令参数。
  const hasCommandParam = Boolean(
    props && (typeof props.command === 'object' || typeof props.cmd === 'object' || typeof props.script === 'object' || typeof props.commandline === 'object'),
  )
  if (!hasCommandParam) return ''
  const named = shellFamilyByName(name)
  if (named) return named
  const text = String(definition.description || '')
  if (/(?:^|[^a-z])(?:bash|gitbash|msys)(?:[^a-z]|$)/i.test(text) || /\b(?:sh|zsh|fish)\b/i.test(text)) return 'bash'
  if (/pwsh|powershell/i.test(text)) return 'powershell'
  if (/\bcmd(?:\.exe)?\b/i.test(text)) return 'cmd'
  if (/\bwsl\b/i.test(text)) return 'wsl'
  return ''
}

/** 运行态已知的家族:学到的优先,内置表兜底。名字大小写不敏感(工具名大小写混用时不漏认)。 */
function familyOf(runtime, name) {
  const raw = String(name || '')
  if (!raw) return ''
  const key = raw.toLowerCase()
  const learned = runtime && runtime.learnedShells
  if (learned && typeof learned.get === 'function') {
    if (learned.has(raw)) return learned.get(raw) || ''
    if (learned.has(key)) return learned.get(key) || ''
  }
  return SHELL_TOOL_FAMILY[key] || ''
}

/** 这个名字是不是宿主命令工具(含运行时学到的第三方发布名)。 */
function isShellToolName(runtime, name) {
  const key = String(name || '')
  if (!key || key === ENVD_SHELL_NAME) return false
  if (familyOf(runtime, key)) return true
  return Boolean(runtime && runtime.learnedShells && runtime.learnedShells.has(key))
}

const SYNTAX_NOTES = {
  powershell: [
    '串联用 `;`,条件串联 `&&`/`||` 只有 PowerShell 7 支持(5.1 必须用 `; if ($?) {}`)',
    '环境变量 `$env:NAME`,调用外部程序要 `& $exe` 或用完整路径',
    '路径分隔符 `\\` 可用,但含空格必须整体引号包裹',
    '列目录 `Get-ChildItem`,删文件 `Remove-Item`,查命令位置 `Get-Command`',
  ],
  cmd: [
    '串联用 `&`(无条件)或 `&&`(前一条成功才继续),`|` 管道',
    '环境变量 `%NAME%`,路径含空格用双引号,不要用单引号',
    '列目录 `dir`,删文件 `del`/`rmdir /s`,查命令位置 `where`',
  ],
  bash: [
    '串联用 `;`、`&&`、`||`,环境变量 `$NAME`,路径用 `/c/Users/...` 形式',
    '列目录 `ls -la`,删文件 `rm -rf`,查命令位置 `command -v`',
    'Windows 原生程序在 Git Bash 里要写 `.exe`,注意 CRLF',
  ],
  wsl: ['命令在 WSL 内执行,Windows 盘符是 `/mnt/c/...`,不要写 `C:\\`'],
  custom: ['按该终端自身的语法书写命令'],
}

// ──────────────────────────────────────────────────────── 探测 ──

let cache = { at: 0, value: null, inflight: null }
/** 每次作废探测就 +1:探测启动时记下代数,落地时代数变了说明中途有状态写入,这份结果不能进缓存。 */
let detectGeneration = 0

/**
 * 版本探测缓存:同一个 (可执行文件 + 参数) 不必每次刷新都重启一遍子进程。
 * key 里带 mtime+size —— 同一个路径下的二进制被升级/替换,mtime 变了自然 miss,
 * 所以「重新探测」可以放心复用缓存,只补测新出现的东西。
 */
const VERSION_CACHE_TTL_MS = 10 * 60_000
const VERSION_CACHE_MAX = 256
const versionCache = new Map()

function invalidateDetection() {
  cache.at = 0
  detectGeneration += 1
}

function statSignature(file) {
  try {
    const st = statSync(file)
    return st.mtimeMs + ':' + st.size
  } catch {
    return 'missing'
  }
}

function versionCacheKey(exe, args) {
  return String(exe).toLowerCase() + '\u0000' + statSignature(exe) + '\u0000' + (args || []).join('\u0001')
}

function rememberVersion(key, version) {
  if (!version) return
  if (versionCache.size >= VERSION_CACHE_MAX) {
    // 简单裁掉最早的一批,不让缓存无限长
    const drop = Math.ceil(VERSION_CACHE_MAX / 4)
    let i = 0
    for (const k of versionCache.keys()) {
      versionCache.delete(k)
      if (++i >= drop) break
    }
  }
  versionCache.set(key, { at: Date.now(), version })
}

/** `py -0p` 的清单也缓存:它跟版本探测一样贵,而且一次探测里没有它就没法列出 Python 多版本。 */
const pyLauncherCache = { key: null, at: 0, paths: [] }

/** 状态一变就立刻重新对一次接管(不然点完选项要等下一个 5s tick 才生效)。 */
let notifyStateChange = null

/**
 * 接管命令工具的固定名字。
 *
 * 以前工具名跟着终端走(powershell / bash / pwsh):切一次终端就等于「拆掉旧名 + 注册新名」,
 * 而 DSH 的工具可见性是**每次模型请求**重新解析的 —— 拆和建之间的任何空窗,落到哪一步,
 * 那一步调命令工具就是 UNKNOWN_TOOL。宿主注册表里明明有、当前这一步却调不到,就是这么来的。
 *
 * 固定名字 + 执行时读当前终端(见 apply 里的 activeShell)之后,切终端只改「怎么执行」和简报,
 * 注册表一个字节都不用动。名字刻意取 envd_ 前缀,不和 宿主/其它插件 的 shell 名争抢。
 */
const ENVD_SHELL_NAME = 'envd_shell'
/**
 * 结构性挡不掉的宿主工具重试间隔:restrict 只过滤继承面,作用域私有注册永远挡不掉。
 * 试一次就够,10 分钟后再给新注册一次机会;期间不重试、不写 lastError(否则面板刷红)。
 */
const HARD_UNRESTRICTABLE_MS = 600000

/**
 * 接管运行态(每个 apply 一份,由 sync 维护,brief 与 API 读它)。
 *
 * 刻意**不放在模块级**:同一进程里 apply 可能不止一次(插件热重载、测试夹具),
 * 共享一份就会互相清账本 —— 上一代的 cleanup 把新一代的状态抹成「没接管」,
 * 面板/简报于是指着一个已经调不到的工具名。按实例持有之后,谁的状态谁负责。
 */
function createRuntime() {
  return {
    toolName: null,
    owns: false,
    denyName: null,
    reuse: false,
    shippedName: null,
    family: null,
    /** 上一次**实际验证过**的可见性(注册成功 ≠ 模型看得见,这里记 tools.get 的真实结果) */
    toolVisible: false,
    /** 当前对所有 agent 作用域遮挡的宿主 shell 名 */
    denyNames: [],
    /** 历史上真实见过的 shell 工具名(被我们自己遮挡之后也要记住) */
    seenShells: new Set(),
    /** 我们自己注册过的名字,不能当成「宿主自带」 */
    ownNames: new Set(),
    /** 宿主 shell 的沙箱事实:沙箱在场时绝不接管(我们的工具走 subprocess,会绕过沙箱)。 */
    sandbox: false,
    sandboxMode: '',
    /**
     * 我们自己注册的那一份定义对象(登记身份)。
     * 只按名字判「是我的工具」会被同名工具骗过 —— 登记身份才是归属
     * (dsh-ops 的 publication ownership 就是同一口径:`tools.get(name) === 我注册的那个对象`)。
     */
    ownDefinition: null,
    /**
     * 逐会话的命令工具终局:[{ id, kind, tool, visible, hidden, hidesOwn, confined, mode }]。
     *
     * 全局可见性回答不了「这个会话的模型实际拿到哪个命令工具」—— 同一进程里可以让路、
     * 沙箱、直连接管三种会话同时存在。对账每次把 plan 的终局写进这里,API 原样端出去。
     */
    scopeToolFacts: [],
    /** 运行时学到的宿主命令工具名 → 家族(含 ops_* / 第三方发布名)—— 名字被挡住后仍要记得 */
    learnedShells: new Map(),
    /** 注册失败后的重试原因: 'taken'(同名被占) / 'error'(其它)。tools/change 可提前解除退避 */
    retryReason: '',
    /** 事件驱动对账要求跳过 30s 退避 */
    retryNow: false,
    /** 上一次真正探测的 at(缓存命中不计数) */
    lastDetectionAt: 0,
    /** 是否真的见过宿主命令工具(见过之后再消失 → 立即兜底注册 envd_shell) */
    everSawHost: false,
    /** 实例启动时刻(用于「首次见到宿主」的宽限期) */
    startedAt: Date.now(),
  }
}

/**
 * 命令工具此刻的真实状态。
 *
 * `isVisible` 是 live 探针(工具注册表里现在真的能不能看到这个名字)。
 * 面板与简报都只用这一份结论:宁可说「见工具表」,也不要谎报「已接管」。
 *
 * `gate` 是**本会话**的沙箱事实(见 sandboxGate):`capable` = 宿主执行器会围栏,
 * `confined` = 本会话真的被围栏(true/false/null=不可知),`mode` = 有效策略。
 * 能力位与有效策略必须分开报:以前把「执行器会围栏」当成「本会话在围栏」,
 * 于是在 danger-full-access 的会话里也谎报 workspace-write、并把接管永久锁死。
 */
function commandToolState(runtime, isVisible, gate, includeScopes = true) {
  const probe = typeof isVisible === 'function' ? isVisible : null
  const denies = Array.isArray(runtime.denyNames) ? runtime.denyNames.slice() : []
  const g = gate && typeof gate === 'object' ? gate : null
  const sandbox = g ? g.capable === true : runtime.sandbox === true
  const sandboxMode = (g && typeof g.mode === 'string' && g.mode) || (typeof runtime.sandboxMode === 'string' ? runtime.sandboxMode : '')
  const common = {
    denies,
    sandbox,
    sandboxMode,
    /**
     * 模型实际能用的宿主命令工具名。
     *
     * 先看逐会话事实:所有会话的 hostTools 并集只有一个名字时,那就是模型手里真正的
     * 宿主命令工具(dsh-ops 的 ops_bash 属于这种);有多个或没有时才退回 shippedName。
     * 以前只报 shippedName,现网就出现过「面板说宿主是 pwsh,模型手里其实是 ops_bash」。
     */
    hostName: (() => {
      const fromFacts = includeScopes && Array.isArray(runtime.scopeToolFacts)
        ? [...new Set(runtime.scopeToolFacts.flatMap((fact) => (Array.isArray(fact.hostTools) ? fact.hostTools : [])).filter(Boolean).map(String))]
        : []
      if (fromFacts.length === 1) return fromFacts[0]
      return runtime.shippedName || fromFacts[0] || null
    })(),
    /** 本会话是否真的被围栏;null = 无法判定(没有会话 / 策略服务缺失) */
    sandboxConfined: g ? (g.confined === true ? true : g.confined === false ? false : null) : null,
    /** 'delegate' = 围栏下委托宿主执行器执行;'refuse' = 不接管 */
    sandboxDelegate: Boolean(g && g.delegate),
    sandboxPolicyKnown: g ? g.policyKnown !== false : false,
    /**
     * 逐会话终局(panel/API 用):哪个会话的模型实际拿到哪个命令工具、为什么。
     * 解析时复制一份,调用方改坏了也不会污染运行态账本。
     */
    scopes: includeScopes && Array.isArray(runtime.scopeToolFacts)
      ? runtime.scopeToolFacts.map((fact) => ({
          id: String(fact.id || ''),
          kind: String(fact.kind || 'host'),
          tool: fact.tool || null,
          hostTool: fact.hostTool || null,
          hostTools: Array.isArray(fact.hostTools) ? fact.hostTools.slice() : [],
          ownVisible: fact.ownVisible === true,
          hideOwnPlanned: fact.hideOwnPlanned === true,
          visible: fact.visible === true,
          hidden: Array.isArray(fact.hidden) ? fact.hidden.slice() : [],
          leaked: Array.isArray(fact.leaked) ? fact.leaked.slice() : [],
          hidesOwn: fact.hidesOwn === true,
          anomaly: fact.anomaly === true,
          // 三态:null = 策略不可知。压成 false 会让面板把「不可知」当「确定无围栏」。
          confined: fact.confined === true ? true : fact.confined === false ? false : null,
          policyKnown: fact.policyKnown === true,
          mode: String(fact.mode || ''),
        }))
      : [],
  }
  if (runtime.toolName) {
    const name = runtime.toolName
    const visible = probe ? Boolean(probe(name)) : Boolean(runtime.toolVisible)
    return { name, takeover: Boolean(runtime.owns), reuse: Boolean(runtime.reuse), visible, ...common }
  }
  const name = runtime.shippedName || null
  return {
    name,
    takeover: false,
    reuse: false,
    visible: name ? (probe ? Boolean(probe(name)) : false) : false,
    ...common,
  }
}

function versionToken(text) {
  if (!text) return ''
  const m = /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?)/.exec(String(text))
  return m ? m[1] : ''
}

function looksLikeStoreStub(p) {
  return /\\WindowsApps\\/i.test(p) || /\\AppData\\Local\\Microsoft\\WindowsApps\\/i.test(p)
}

/** 一次遍历把 PATH 分成「存在 / 不存在」两堆(以前是两趟 filter,各自 get 一遍)。 */
function classifyPath() {
  const entries = pathEntries()
  const existing = []
  const missing = []
  for (const dir of entries) {
    try {
      statSync(dir)
      existing.push(dir)
    } catch {
      missing.push(dir)
    }
  }
  return {
    entries,
    existing,
    missing,
    /** 'system' = 已经按注册表里的系统 PATH 刷新过; 'process' = 只能用 dsh 启动时的快照 */
    source: livePath.dirs && livePath.dirs.length ? 'system' : 'process',
    /** 进程快照和系统 PATH 已经不一致(dsh 启动后用户改过 PATH) */
    staleProcess: processPathDrift(entries),
  }
}

// ─────────────────────────────────────────────── 版本管理器 ──
//
// 只做两件事:确认它真的在场(命令在 PATH 上,或根目录存在),然后让它自己报版本。
// 不做「目录存在就算有」的猜测 —— 那会把 pnpm 的 bin 目录、winget 的 Links 目录
// 也当成版本管理器报出去(误报)。

function splitLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter(Boolean)
}

/** `nvm list` → [{ name, active, note }] */
export function parseNvmList(text) {
  const out = []
  for (const line of splitLines(text)) {
    const m = /^(\s*)(\*?)\s*(\d+\.\d+\.\d+[^\s(]*)\s*(.*)$/.exec(line)
    if (!m) continue
    out.push({ name: m[3], active: m[2] === '*', note: (m[4] || '').trim() })
  }
  return out
}

/** `pyenv versions` → [{ name, active }] */
export function parsePyenvVersions(text) {
  const out = []
  for (const line of splitLines(text)) {
    const m = /^(\s*)(\*?)\s*([A-Za-z0-9._-]+)\s*(?:\((.*)\))?$/.exec(line)
    if (!m) continue
    out.push({ name: m[3], active: m[2] === '*', note: (m[4] || '').trim() })
  }
  return out
}

/**
 * `pyenv version` → '3.12.4'。
 * pyenv-win 的 `versions` 用 `*` 标激活项,但 Windows 上这个星号经常不刷新;
 * `pyenv version` 才是环境自己认的答案(输出形如 `3.12.4 (set by C:\...\.python-version)`)。
 */
export function parsePyenvVersion(text) {
  const line = splitLines(text)[0] || ''
  // 正常输出是 `3.12.4 (set by ...)`;个别版本/别名会在前面带 `*`,顺手容忍。
  const m = /^\s*\*?\s*([A-Za-z0-9._-]+)/.exec(line)
  return m ? m[1] : ''
}

/** `conda env list` → [{ name, active, path }] */
export function parseCondaEnvs(text) {
  const out = []
  for (const line of splitLines(text)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    // conda create -p 的「无名字前缀环境」在 env list 里只有一列路径:整行就是绝对路径。
    // 路径里可以有空格(`C:\Users\My Name\miniconda3`)也可以以 \\server\share 开头,
    // 所以不能按「有没有空白」判断,否则含空格的那条会被拆成 name=`C:\Users\My` 的垃圾行。
    if (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(trimmed)) {
      out.push({ name: basename(trimmed.replace(/[\\/]+$/, '')), active: false, path: trimmed })
      continue
    }
    const m = /^(\S+)\s+(\*)?\s*(.*)$/.exec(trimmed)
    if (!m) continue
    const path = (m[3] || '').trim()
    if (!path) continue
    out.push({ name: m[1], active: m[2] === '*', path })
  }
  return out
}

/** `fnm list` → [{ name, active }] */
export function parseFnmList(text) {
  const out = []
  for (const line of splitLines(text)) {
    const m = /^(\s*)(\*?)\s*(v\d+[^\s]*)\s*(.*)$/.exec(line)
    if (!m) continue
    out.push({ name: m[3], active: m[2] === '*', note: (m[4] || '').trim() })
  }
  return out
}

/** `fnm current` → 'v20.19.0'。fnm 的 `list` 只列版本、不标激活项,当前版本只能问 current。 */
export function parseFnmCurrent(text) {
  const line = splitLines(text)[0] || ''
  const m = /^\s*(v?\d+[^\s]*)/.exec(line)
  return m ? m[1] : ''
}

/** `mise ls` → [{ tool, name, active }] */
export function parseMiseLs(text) {
  const out = []
  for (const line of splitLines(text)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // 表头(新版 `Tool  Version  Source` / 旧版 `Plugin  ...`)和分隔线不是数据行:
    // 不剔掉就会多出 tool="Tool"、name="Version" 这种假条目。
    if (/^(?:tool|plugin)\b/i.test(trimmed)) continue
    if (/^[-=]{3,}/.test(trimmed)) continue
    const m = /^\s*([\w-]+)\s+([\w.\-+]+)(.*)$/.exec(line)
    if (!m) continue
    // `missing` 是「声明了但没装」,不是版本号;当版本报出去会让面板显示一个假版本。
    if (/^(?:missing|installed)$/i.test(m[2])) continue
    out.push({ name: m[2], tool: m[1], active: false, note: (m[3] || '').trim() })
  }
  return out
}

const MANAGERS = [
  {
    key: 'nvm',
    label: 'nvm-windows',
    tool: 'node',
    commands: ['nvm'],
    roots: [() => process.env.NVM_HOME, () => join(process.env.APPDATA || '', 'nvm')],
    list: { args: ['list'], parse: parseNvmList },
  },
  {
    key: 'pyenv',
    label: 'pyenv-win',
    tool: 'python',
    commands: ['pyenv'],
    roots: [() => process.env.PYENV_ROOT, () => join(homedir(), '.pyenv')],
    list: { args: ['versions'], parse: parsePyenvVersions },
    // versions 的星号在 pyenv-win 上不可靠,额外问一次 `pyenv version`。
    active: { args: ['version'], parse: parsePyenvVersion },
  },
  {
    key: 'conda',
    label: 'conda',
    tool: 'python',
    commands: ['conda'],
    roots: [() => (process.env.CONDA_PREFIX ? dirname(process.env.CONDA_PREFIX) : null)],
    list: { args: ['env', 'list'], parse: parseCondaEnvs },
  },
  {
    key: 'fnm',
    label: 'fnm',
    tool: 'node',
    commands: ['fnm'],
    roots: [
      () => process.env.FNM_DIR,
      () => join(process.env.APPDATA || '', 'fnm'),
      () => join(process.env.LOCALAPPDATA || '', 'fnm'),
    ],
    list: { args: ['list'], parse: parseFnmList },
    // fnm list 不标激活项(永远没有 `*`),当前版本只能从 `fnm current` 拿。
    active: { args: ['current'], parse: parseFnmCurrent },
  },
  {
    key: 'volta',
    label: 'Volta',
    tool: 'node',
    commands: ['volta'],
    roots: [() => process.env.VOLTA_HOME, () => join(process.env.LOCALAPPDATA || '', 'Volta')],
    list: { args: ['list'], parse: null },
  },
  {
    key: 'mise',
    label: 'mise',
    tool: 'node',
    commands: ['mise'],
    roots: [() => process.env.MISE_DATA_DIR],
    list: { args: ['ls'], parse: parseMiseLs },
  },
  {
    key: 'asdf',
    label: 'asdf',
    tool: 'node',
    commands: ['asdf'],
    roots: [() => process.env.ASDF_DIR],
    list: { args: ['list'], parse: null },
  },
]

const MANAGER_CACHE_TTL_MS = 10 * 60_000
const MANAGER_CACHE_MAX = 8
let managerCacheSeq = 0
const managerCaches = new Map()

async function detectVersionManagers(runner, force) {
  const present = []
  for (const spec of MANAGERS) {
    let commandPath = null
    for (const cmd of spec.commands) {
      commandPath = firstHit(cmd)
      if (commandPath) break
    }
    const roots = spec.roots
      .map((fn) => {
        try {
          return fn()
        } catch {
          return null
        }
      })
      .filter((p) => typeof p === 'string' && p.length > 2 && existsSync(p))
      .map((p) => canonicalPath(p))
    if (!commandPath && !roots.length) continue
    present.push({
      spec,
      entry: { key: spec.key, label: spec.label, tool: spec.tool, command: commandPath, roots, versions: [], active: null, listed: false },
    })
  }
  // 版本管理器的 list 是这里最贵的部分(装了 nvm/conda/pyenv 时单条可到秒级)。
  // 用「可执行文件 + 根目录 + mtime/size」当签名缓存 10 分钟:面板 45s 一次探测不会再把它们全部重跑。
  const signature = present
    .map(({ entry }) => String(entry.command || '') + '|' + entry.roots.join(';') + '|' + (entry.command ? statSignature(entry.command) : ''))
    .join('\n')
  // 缓存按 runner 实例隔离:同一进程里测试夹具/多代插件各有自己的执行器,
  // 只按机器 PATH 缓存会让「无 subprocess」的夹具读到上一代的结果。
  if (runner && !runner.__envdockCacheId) runner.__envdockCacheId = ++managerCacheSeq
  const cacheId = runner ? runner.__envdockCacheId : 0
  const cached = managerCaches.get(cacheId)
  if (!force && cached && cached.key === signature && Date.now() - cached.at < MANAGER_CACHE_TTL_MS) {
    return JSON.parse(JSON.stringify(cached.value))
  }
  // 并行跑各自的 list(+ active):串行在装了 nvm+conda+pyenv 的机器上会拖到十几秒
  await Promise.all(
    present.map(async ({ spec, entry }) => {
      if (!runner || !entry.command) return
      const run = (args) => (args ? runner.runPath(entry.command, args, 8000).catch(() => null) : Promise.resolve(null))
      try {
        const [listRes, activeRes] = await Promise.all([
          run(spec.list && spec.list.args),
          run(spec.active && spec.active.args),
        ])
        if (listRes && listRes.ok && spec.list) {
          const parsed = spec.list.parse ? spec.list.parse(listRes.text) : []
          entry.versions = parsed.slice(0, 12)
          entry.listed = parsed.length > 0
          const fromStar = entry.versions.find((v) => v.active)
          if (fromStar) entry.active = fromStar.name
        }
        // 管理器自己认的激活版本优先于 list 里的星号(pyenv-win / fnm 的 list 都不可靠)
        if (activeRes && activeRes.ok && spec.active) {
          const name = spec.active.parse ? spec.active.parse(activeRes.text) : ''
          if (name) {
            const bare = (value) => String(value).replace(/^v(?=\d)/i, '')
            const row = entry.versions.find((v) => bare(v.name) === bare(name))
            if (row) row.active = true
            entry.active = row ? row.name : name
          }
        }
      } catch {
        /* 命令跑不起来就只报「在场」 */
      }
    }),
  )
  const result = present.map((p) => p.entry)
  managerCaches.set(cacheId, { key: signature, at: Date.now(), value: JSON.parse(JSON.stringify(result)) })
  if (managerCaches.size > MANAGER_CACHE_MAX) managerCaches.delete(managerCaches.keys().next().value)
  return result
}

/** 多版本候选:同一个工具在磁盘上找到的所有可执行文件。 */
function multiVersionCandidates(key, primary) {
  const out = []
  const push = (raw) => {
    const p = canonicalPath(raw)
    if (p && !out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p)
  }
  push(primary)
  if (key === 'node') {
    const roots = []
    const env = process.env
    if (env.NVM_HOME) roots.push(env.NVM_HOME)
    if (env.APPDATA) roots.push(join(env.APPDATA, 'nvm'))
    // fnm 的数据目录随平台/安装方式变化:显式 FNM_DIR、Windows 的 Roaming(%APPDATA%\fnm)
    // 与部分版本用的 Local(%LOCALAPPDATA%\fnm) 都要看 —— 只看一处会漏掉真实安装。
    const fnmBases = []
    if (env.FNM_DIR) fnmBases.push(env.FNM_DIR)
    if (env.APPDATA) fnmBases.push(join(env.APPDATA, 'fnm'))
    if (env.LOCALAPPDATA) fnmBases.push(join(env.LOCALAPPDATA, 'fnm'))
    for (const base of fnmBases) roots.push(join(base, 'node-versions'))
    for (const root of roots) {
      for (const entry of listDir(root)) {
        if (!entry.isDirectory() || !/^v\d+/i.test(entry.name)) continue
        push(join(root, entry.name, 'node.exe'))
        push(join(root, entry.name, 'installation', 'node.exe'))
      }
    }
    if (env.ProgramFiles) push(join(env.ProgramFiles, 'nodejs', 'node.exe'))
    push('C:\\Program Files\\nodejs\\node.exe')
    if (env.LOCALAPPDATA) push(join(env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe'))
    // Volta 的工具链镜像:~/.volta/tools/image/node/<version>/node.exe
    const voltaRoots = [env.VOLTA_HOME, env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Volta')].filter(Boolean)
    for (const root of voltaRoots) {
      for (const entry of listDir(join(root, 'tools', 'image', 'node'))) {
        if (!entry.isDirectory()) continue
        push(join(root, 'tools', 'image', 'node', entry.name, 'node.exe'))
      }
    }
    // pyenv-win 不管 node;fnm 走上面的 node-versions
  }
  if (key === 'python') {
    const roots = []
    if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'Programs', 'Python'))
    if (process.env.ProgramFiles) roots.push(join(process.env.ProgramFiles, 'Python'))
    if (process.env.CONDA_PREFIX) roots.push(dirname(process.env.CONDA_PREFIX))
    for (const root of roots) {
      for (const entry of listDir(root)) {
        if (!entry.isDirectory()) continue
        push(join(root, entry.name, 'python.exe'))
      }
    }
    // pyenv-win / conda envs:每个版本/环境各有一个解释器
    const pyenvRoots = [process.env.PYENV_ROOT, join(homedir(), '.pyenv')].filter(Boolean)
    const pyenvVersionDirs = []
    for (const root of pyenvRoots) {
      pyenvVersionDirs.push(join(root, 'versions'))
      // pyenv-win 的源码检出/官方安装器布局是 <root>\pyenv-win\versions
      pyenvVersionDirs.push(join(root, 'pyenv-win', 'versions'))
    }
    for (const versionsDir of pyenvVersionDirs) {
      for (const entry of listDir(versionsDir)) {
        if (!entry.isDirectory()) continue
        push(join(versionsDir, entry.name, 'python.exe'))
      }
    }
    const condaRoots = [process.env.CONDA_PREFIX && dirname(process.env.CONDA_PREFIX), join(homedir(), 'miniconda3', 'envs'), join(homedir(), 'anaconda3', 'envs')].filter(Boolean)
    for (const root of condaRoots) {
      for (const entry of listDir(root)) {
        if (!entry.isDirectory() || !existsSync(join(root, entry.name))) continue
        push(join(root, entry.name, 'python.exe'))
      }
    }
    if (process.env.USERPROFILE) push(join(process.env.USERPROFILE, 'miniconda3', 'python.exe'))
    if (process.env.USERPROFILE) push(join(process.env.USERPROFILE, 'anaconda3', 'python.exe'))
  }
  if (key === 'git') {
    // PATH 上所有 git 都要收:用户可把第二份 Git 装在任意盘(例如 F:\Git2),
    // 只认三个固定路径会让「多版本并存」永远只报一条。
    for (const hit of findAll('git')) push(hit)
    push('C:\\Program Files\\Git\\cmd\\git.exe')
    push('C:\\Program Files (x86)\\Git\\cmd\\git.exe')
    if (process.env.LOCALAPPDATA) push(join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'))
  }
  return out.filter((p) => (typeof p === 'string' ? existsSync(p) : false))
}

async function detect(ctx, runner, state, force) {
  const now = Date.now()
  if (force) {
    // 「重新探测」不再信旧版本号:同一路径的二进制可能被垫片/软链换掉而 mtime 不变
    // (nvm / fnm 切 current、商店别名都是这种)。mtime+size 只是常规 miss 的快路径。
    versionCache.clear()
  }
  if (!force && cache.value && now - cache.at < CACHE_TTL_MS) return cache.value
  // 同一时刻只跑一份探测:force 也先等在场的那次,避免连点「重新探测」并发起两倍的子进程。
  if (cache.inflight) {
    let pending = null
    try {
      pending = await cache.inflight
    } catch (error) {
      // 共享的这次探测失败了:显式抛给调用方,而不是返回 null 让上层「当成成功但没数据」。
      throw new Error('探测失败: ' + String((error && error.message) || error))
    }
    if (!force) return pending
    if (cache.value && Date.now() - cache.at < 400) return cache.value
  }

  // 探测期间任何状态写入(invalidateDetection)都会让这份结果过期:可以返回给本次调用方,
  // 但绝不能覆盖 cache —— 否则「刚改完设置」的下一趟还会读到改之前的快照。
  const generation = detectGeneration
  const job = (async () => {
    // 「重新探测」要拿到系统**现在**的 PATH:process.env.PATH 是 dsh 启动那一刻的快照,
    // 用户之后删掉的失效目录 / 新加的工具目录都不在里面 —— 只重扫它,结果当然「没更新」。
    await ensureLivePath(runner, force)
    // 每次探测都重新 readdir 一遍 PATH(装了新工具要能看见),但一次探测内部只读一次
    clearDirIndex()
    const customTools = Array.isArray(state.customTools) ? state.customTools : []
    const entries = []
    for (const spec of CATALOG) {
      let primary = null
      let matchedName = null
      for (const name of spec.names) {
        primary = firstHit(name)
        if (primary) {
          matchedName = name
          break
        }
      }
      if (!primary) continue
      entries.push({
        key: spec.key,
        label: spec.label,
        group: spec.group,
        names: spec.names,
        path: primary,
        versionArgs: spec.versionArgs,
        matchedName,
        candidates: multiVersionCandidates(spec.key, primary),
      })
    }
    for (const custom of customTools) {
      if (!custom || !custom.path) continue
      entries.push({
        key: String(custom.key || custom.label || basename(custom.path)),
        label: String(custom.label || custom.key || basename(custom.path)),
        group: 'custom',
        names: [basename(custom.path)],
        path: custom.path,
        versionArgs: Array.isArray(custom.versionArgs) ? custom.versionArgs : ['--version'],
        candidates: existsSync(custom.path) ? [custom.path] : [],
        custom: true,
      })
    }

    // Windows 的 py 启动器有两种身份,都要在快照里说清楚:
    //   1. python 的别名 —— 模型 `envd resolve py` 能拿到它,而不是「没探测到 py」;
    //   2. python.exe 不在 PATH 时的唯一入口 —— 这时它既是默认路径,也是 `py -0p` 列全部解释器的来源。
    const pyLauncher = firstHit('py')
    const pythonEntry = entries.find((e) => e.key === 'python')
    if (pythonEntry) {
      if (pyLauncher) pythonEntry.pyLauncher = pyLauncher
      if (pythonEntry.matchedName === 'py') {
        pythonEntry.viaLauncher = true
        pythonEntry.label = 'Python (py 启动器)'
      }
    }

    // 版本:命中缓存就不起子进程(mtime 变了会自动 miss),单条 6s 上限
    const versionOf = async (exe, args) => {
      if (!runner || !exe) return ''
      if (!args || !args.length) return ''
      const key = versionCacheKey(exe, args)
      const hit = versionCache.get(key)
      if (hit && Date.now() - hit.at < VERSION_CACHE_TTL_MS) return hit.version
      const res = await runner.runPath(exe, args, 6000)
      const version = versionToken(res.text)
      rememberVersion(key, version)
      return version
    }

    const tasks = []
    let versionManagers = []

    // Python 多版本:Windows 启动器 `py -0p` 是最全的一份清单。
    // 与其它探测并行跑,python 那一条任务自己负责等它补齐候选。
    const pyTask =
      pythonEntry && runner
        ? (async () => {
            const py = pythonEntry.pyLauncher
            if (!py) return
            const key = versionCacheKey(py, ['-0p'])
            let paths = pyLauncherCache.paths
            // force(用户点了「重新探测」)时重跑:新装一个 Python 不会改 py.exe 的 mtime,
            // 光靠 mtime 判断不出清单变了。
            if (force || pyLauncherCache.key !== key || Date.now() - pyLauncherCache.at > VERSION_CACHE_TTL_MS) {
              const res = await runner.runPath(py, ['-0p'], 8000)
              // 失败(超时 / 被杀 / 被策略拦)不写缓存:一失败就缓存 10 分钟,会让「Python 多版本」
              // 在很久之内永远只报一条,而用户恰恰是刚装完 Python 才点的「重新探测」。
              if (res && res.ok) {
                const found = []
                for (const line of String(res.text || '').split(/\r?\n/)) {
                  const m = /-V:(\S+)\s+\*?\s*([A-Za-z]:\\[^\r\n]+?)\s*$/.exec(line)
                  if (!m) continue
                  const p = m[2].trim()
                  if (existsSync(p) && !found.includes(p)) found.push(p)
                }
                paths = found
                pyLauncherCache.key = key
                pyLauncherCache.at = Date.now()
                pyLauncherCache.paths = paths
              }
            }
            for (const raw of paths) {
              const p = canonicalPath(raw)
              if (!pythonEntry.candidates.some((c) => c.toLowerCase() === p.toLowerCase())) pythonEntry.candidates.push(p)
            }
          })().catch(() => {})
        : Promise.resolve()

    for (const entry of entries) {
      tasks.push(
        (async () => {
          if (entry.key === 'python') await pyTask
          entry.version = await versionOf(entry.path, entry.versionArgs)
          const cands = entry.candidates.slice(0, 6)
          entry.versions = []
          for (const cand of cands) {
            entry.versions.push({ path: cand, version: cand.toLowerCase() === entry.path.toLowerCase() ? entry.version : await versionOf(cand, entry.versionArgs) })
          }
          if (!entry.versions.length) entry.versions = [{ path: entry.path, version: entry.version || '' }]
        })(),
      )
    }

    // 版本管理器:必须在场才算,并让它自己报版本/激活项。
    // 与工具版本并行 —— 装了 nvm+conda+pyenv 的机器上它一条 list 最长 8s,串在后面会把刷新拖成十几秒。
    tasks.push(
      detectVersionManagers(runner, force)
        .then((list) => {
          versionManagers = list
        })
        .catch(() => {}),
    )

    // 终端
    const terminals = []
    for (const spec of TERMINALS) {
      let path = null
      for (const name of spec.names) {
        path = firstHit(name)
        if (path) break
      }
      if (!path) continue
      terminals.push({ key: spec.key, label: spec.label, family: spec.family, path, version: '' })
    }
    const bashFromGit = (() => {
      const git = entries.find((e) => e.key === 'git')
      if (!git) return null
      const root = dirname(dirname(git.path))
      for (const rel of ['bin\\bash.exe', 'usr\\bin\\bash.exe']) {
        const p = join(root, rel)
        if (existsSync(p)) return p
      }
      for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe']) {
        if (existsSync(p)) return p
      }
      return null
    })()
    const bashEntry = terminals.find((t) => t.key === 'bash')
    if (!bashEntry && bashFromGit) {
      terminals.push({ key: 'bash', label: 'Git Bash', family: 'bash', path: bashFromGit, version: '' })
    }

    // 宿主 PTY 的默认终端:仅作展示参考。注意它(本机是 cmd.exe)不等于模型的命令工具,
    // 那个工具叫 pwsh、实际跑 Windows PowerShell,所以接管判定按「PowerShell 家族」做。
    let ptyShell = null
    if (runner) {
      tasks.push(
        (async () => {
          try {
            const env = await runner.terminalEnv()
            if (env && env.defaultShell) ptyShell = String(env.defaultShell)
          } catch {
            /* 没有这个能力就算了 */
          }
        })(),
      )
    }
    for (const term of terminals) {
      if (term.family === 'cmd' || term.family === 'wsl') continue
      const spec = TERMINALS.find((s) => s.key === term.key)
      const args =
        (spec && spec.versionArgs) ||
        (term.family === 'powershell'
          ? /^pwsh/i.test(basename(term.path))
            ? ['--version']
            : ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']
          : term.family === 'bash'
            ? ['--version']
            : null)
      tasks.push(
        (async () => {
          term.version = await versionOf(term.path, args)
        })(),
      )
    }

    await Promise.all(tasks)

    for (const entry of entries) {
      const picked = state.selections && state.selections[entry.key]
      entry.defaultPath = picked && existsSync(picked) ? picked : entry.path
      entry.staleSelection = Boolean(picked && !existsSync(picked))
      const chosen = entry.versions.find((v) => v.path.toLowerCase() === entry.defaultPath.toLowerCase())
      entry.defaultVersion = chosen ? chosen.version : entry.version
    }

    const pathInfo = classifyPath()
    const snapshot = {
      at: Date.now(),
      platform: { os: type(), release: release(), version: osVersion(), arch: arch(), host: hostname() },
      // missing 只留前几项给面板展示,missingCount 才是真实数量(以前误把截断后的长度当总数)
      path: {
        entries: pathInfo.entries.length,
        existing: pathInfo.existing.length,
        missing: pathInfo.missing.slice(0, 12),
        missingCount: pathInfo.missing.length,
        // PATH 是按注册表里的系统值刷新的,还是只能用 dsh 启动时的进程快照
        source: pathInfo.source,
        staleProcess: pathInfo.staleProcess,
      },
      tools: entries,
      terminals,
      ptyShell,
      versionManagers,
      gitBash: bashFromGit,
    }
    return snapshot
  })()

  cache.inflight = job
  try {
    const value = await job
    if (cache.inflight === job) cache.inflight = null
    if (generation === detectGeneration) cache = { at: Date.now(), value, inflight: null }
    return value
  } catch (error) {
    if (cache.inflight === job) cache.inflight = null
    throw error
  }
}

// ──────────────────────────────────────────────────── 默认终端 ──

function resolveShell(state, detection) {
  const terminals = (detection && detection.terminals) || []
  const pick = (key) => terminals.find((t) => t.key === key) || null
  const wanted = state.defaultShell || 'auto'

  if (wanted === 'custom' && state.customShell && state.customShell.path && existsSync(state.customShell.path)) {
    const rawArgs = state.customShell.args
    const args = Array.isArray(rawArgs) ? rawArgs.map(String) : typeof rawArgs === 'string' ? rawArgs.split(' ').filter(Boolean) : []
    return {
      key: 'custom',
      label: state.customShell.label || basename(state.customShell.path),
      family: 'custom',
      path: state.customShell.path,
      args: args.length ? args : ['-c', '{command}'],
    }
  }
  const explicit = wanted !== 'auto' ? pick(wanted) : null
  const preferred = IS_WIN ? ['pwsh', 'powershell', 'cmd'] : ['bash', 'zsh', 'sh']
  let chosen = explicit
  if (!chosen) {
    for (const key of preferred) {
      chosen = pick(key)
      if (chosen) break
    }
  }
  chosen = chosen || terminals[0] || null
  if (!chosen) {
    return { key: 'none', label: '未探测到可用终端', family: 'custom', path: null, args: [] }
  }
  // 刻意不再返回 toolName:命令工具的注册名是固定的 ENVD_SHELL_NAME,不随终端变。
  // 终端变了只是「怎么执行」变(执行侧从 activeShell 读),注册表不需要跟着动。
  return { ...chosen, args: null }
}

function shellInvocation(shell, line) {
  if (!shell || !shell.path) return null
  if (shell.family === 'custom') {
    // 老状态文件/手改过的状态里 args 可能是字符串,也可能忘了写 {command} 占位:
    // 前者按空格拆,后者把命令追加成最后一个参数(总比把命令丢掉好)。
    let tpl = shell.args
    if (typeof tpl === 'string') tpl = tpl.split(' ').filter(Boolean)
    if (!Array.isArray(tpl) || !tpl.length) tpl = ['-c', '{command}']
    const args = tpl.map(String)
    if (args.some((a) => a.includes('{command}'))) {
      return [shell.path, ...args.map((a) => a.replace('{command}', line))]
    }
    return [shell.path, ...args, line]
  }
  if (shell.family === 'cmd') return [shell.path, '/d', '/s', '/c', line]
  if (shell.family === 'bash') return [shell.path, '-lc', line]
  if (shell.family === 'wsl') return [shell.path, 'bash', '-lc', line]
  // powershell / pwsh
  return [shell.path, '-NoLogo', '-NoProfile', '-Command', line]
}

/**
 * 把「目标终端要跑的这一行」包装成**宿主执行器**能直接执行的一条命令。
 *
 * 沙箱下 EnvDock 不能自己 spawn(subprocess 接口没有 sandboxPolicy 入口),但可以委托给
 * 带围栏的 `ctx.shell`:围栏挂在宿主进程上,子终端继承它。命令本身**不拼进字符串**,
 * 而是经环境变量 `ENVD_CMD` 传入 —— 宿主 → 目标终端那两层引号一次都不用写。
 *
 * 返回 null = 宿主族不支持安全委托(调用方据此拒绝,绝不猜语法硬拼)。
 */
function delegatedInvocation(hostFamily, shell, line) {
  if (!shell || !shell.path) return { error: 'unsupported', reason: '没有可用的目标终端' }
  if (hostFamily !== 'powershell' && hostFamily !== 'bash') {
    return { error: 'unsupported', reason: '宿主执行器语法族无法安全包装(cmd/未知)' }
  }
  const quote = (value) => {
    if (hostFamily === 'powershell') return "'" + String(value).replace(/'/g, "''") + "'"
    return "'" + String(value).replace(/'/g, "'\\''") + "'"
  }
  const wrap = (argv) => ({
    command:
      (hostFamily === 'powershell' ? '& ' : '') +
      argv.map((part) => quote(part)).join(' ') +
      // 宿主启动失败时 $LASTEXITCODE 是 null(不是 0):必须显式给 127,
      // 否则「目标终端没跑起来」会被报成 exit 0 的成功。
      (hostFamily === 'powershell'
        ? '; $ec=$LASTEXITCODE; if ($null -eq $ec) { exit 127 } else { exit $ec }'
        : '; exit $?'),
  })
  const family = String(shell.family || '')
  // 命令数据统一走 base64 载荷:命令行里永远没有用户命令,PowerShell 5.1 的引号吞噬无从触发。
  const payload = Buffer.from(String(line), 'utf8').toString('base64')
  if (payload.length > 30000) return { error: 'too-long', reason: '命令太长,超出委托安全上限' }
  if (family === 'bash') {
    // 目标 bash:外层 -lc 已经是登录 shell(与直跑 -lc 的 profile 语义一致),
    // 内层再带 -l 会让 profile 跑第二次(重复的 PATH 拼接、重复的 rc 副作用),所以内层只 -s。
    // ① 载荷缺失时 exit 127:否则 `printf %s "" | base64 -d | bash -s` 静默 exit 0,
    //    插件会把「什么都没跑」报成成功。
    // ② `</dev/null`:不加的话命令里的 read/cat 会吃掉 stdin 上的**脚本本身**,
    //    后面的命令不再执行(实测 read 之后 exit 1);直跑路径的 stdin 是 ignore,语义要一致。
    return {
      ...wrap([shell.path, '-lc', '[ -n "$ENVD_CMD" ] || exit 127; printf %s "$ENVD_CMD" | base64 -d | bash -s < /dev/null']),
      envValue: payload,
    }
  }
  if (family === 'cmd' || family === 'wsl' || family === 'custom') {
    return { error: 'unsupported', reason: '目标终端(' + family + ')不支持安全委托执行' }
  }
  // 目标 powershell:嵌套 PowerShell 从 env 解码并 Invoke-Expression。
  // 这条路径实测在 5.1/7 上都没有 CLIXML 噪音、param() 开头也正常;
  // [Console]::OutputEncoding 固定 UTF-8,避免非 65001 代码页下中文乱码。
  const script =
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " +
    "$c=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ENVD_CMD)); " +
    // 载荷缺失时 exit 127:空脚本 Invoke-Expression 什么都不做,会静默 exit 0。
    "if ([string]::IsNullOrEmpty($c)) { exit 127 }; " +
    "& { Invoke-Expression $c }; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }"
  return { ...wrap([shell.path, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]), envValue: payload }
}

// ─────────────────────────────────────────────────────── 健康检查 ──

function healthIssues(detection, state) {
  const issues = []
  const push = (level, title, detail) => issues.push({ level, title, detail })

  // 状态文件坏了(半截 JSON / 手改成非对象):已回落默认值,但要让面板说清楚,别让用户
  // 明明什么都没改却看到设置全丢。
  const brokenState = stateIssue()
  if (brokenState) issues.push(brokenState)

  for (const tool of detection.tools || []) {
    if (looksLikeStoreStub(tool.path)) {
      push(
        'error',
        tool.label + ' 指向应用商店占位符',
        tool.path + ' 是 Windows 应用商店的转发壳(执行会弹商店或直接失败)。请安装真实版本,或在 EnvDock 里把默认版本改成实体安装路径。',
      )
    }
    if (tool.staleSelection) {
      push('error', tool.label + ' 的默认版本路径已失效', '你之前选的 ' + (state.selections[tool.key] || '') + ' 已不存在,已临时回落到 ' + tool.path)
    }
    const distinct = (tool.versions || []).map((v) => v.path)
    if (distinct.length > 1) {
      push('warn', tool.label + ' 有 ' + distinct.length + ' 个版本并存', distinct.join('  |  '))
    }
    const major = parseInt(String(tool.defaultVersion || '').split('.')[0], 10)
    if (Number.isFinite(major)) {
      if (tool.key === 'node' && major < 18) push('warn', 'Node.js 版本过旧', 'v' + tool.defaultVersion + ' 已 EOL,建议 ≥ 20')
      if (tool.key === 'python' && major === 3) {
        const minor = parseInt(String(tool.defaultVersion || '').split('.')[1] || '0', 10)
        if (minor > 0 && minor < 9) push('warn', 'Python 版本过旧', '3.' + minor + ' 已停止维护,建议 ≥ 3.11')
      }
      if (tool.key === 'python' && major === 2) push('error', '默认 Python 是 2.x', '请把默认版本切到 3.x')
    }
  }
  const node = (detection.tools || []).find((t) => t.key === 'node')
  const npm = (detection.tools || []).find((t) => t.key === 'npm')
  if (node && npm) {
    const major = parseInt(String(node.defaultVersion || '').split('.')[0], 10)
    if (major >= 20 && (() => {
      const npmMajor = parseInt(String(npm.defaultVersion || '').split('.')[0], 10)
      return Number.isFinite(npmMajor) && npmMajor < 10
    })()) push('warn', 'npm 与 Node 不匹配', 'Node v' + node.defaultVersion + ' 通常配 npm ≥ 10,当前 ' + npm.defaultVersion)
  }
  const missingCount = Number.isFinite(detection.path.missingCount) ? detection.path.missingCount : detection.path.missing.length
  if (missingCount) {
    push('warn', 'PATH 里有 ' + missingCount + ' 个失效目录', detection.path.missing.slice(0, 6).join('; '))
  }
  // dsh 启动之后系统 PATH 变过(通常是删了失效目录 / 装了新工具):这条只是说明为什么面板和
  // 「重启 dsh 后」看到的可能不同 —— 探测本身已经按系统当前值刷新过了。
  if (detection.path && detection.path.staleProcess) {
    push(
      'info',
      'dsh 进程里的 PATH 是旧的',
      'dsh 启动之后系统 PATH 被改过。本次探测已按系统当前 PATH 重新扫描,不需要重启 dsh;重启只是让两边彻底一致。',
    )
  }
  // 版本管理器说激活了 vX,但 PATH 上的可执行文件不在它的目录里 —— 这才是真正会咬人的坑
  for (const mgr of detection.versionManagers || []) {
    const tool = (detection.tools || []).find((t) => t.key === mgr.tool)
    if (!mgr.active || !tool || !tool.defaultPath) continue
    const inside = mgr.roots.some((root) => String(tool.defaultPath).toLowerCase().startsWith(String(root).toLowerCase()))
    if (!inside) {
      push(
        'warn',
        mgr.label + ' 激活的版本和 PATH 上的 ' + tool.label + ' 不一致',
        mgr.label + ' 激活 ' + mgr.active + ',但 PATH 上解析到 ' + tool.defaultPath + '(命令里用绝对路径,或先 ' + mgr.key + ' use)',
      )
    }
  }
  const target = resolveShell(state, detection)
  if (target.key !== 'none' && !target.path) push('error', '默认终端不可用', target.label)
  const bash = (detection.terminals || []).find((t) => t.key === 'bash')
  if (state.defaultShell === 'bash' && !bash) push('error', '选了 Git Bash 但没找到 bash.exe', '请先安装 Git for Windows')
  return issues
}

// ─────────────────────────────────────────────────────── 环境简报 ──

function brief(detection, state, probeIn, runtime) {
  if (!detection) return ''
  const shell = resolveShell(state, detection)
  const lines = []
  lines.push('## 本机环境 (EnvDock 实测,优先于猜测)')
  lines.push(
    '- 系统: ' +
      (detection.platform.os || '') +
      ' ' +
      (detection.platform.release || '') +
      ' (' +
      (detection.platform.arch || '') +
      '),用户 ' +
      (detection.platform.host || ''),
  )
  if (shell.key !== 'none') {
    lines.push('- 默认终端: ' + shell.label + (shell.path ? ' → ' + shell.path : '') + (shell.version ? ' (v' + shell.version + ')' : ''))
    // probe 是**按会话**的:visible(name) 走该 agent 作用域,gate() 给本会话沙箱事实。
    // 只拿全局视图判「工具在不在」会稳定误报(agent 作用域私有的 shell 全局查不到),
    // 以前就在这里产出过「pwsh 此刻不在工具表里 / 直接用宿主自带的那个」两句自相矛盾的话。
    const probe = probeIn && typeof probeIn.visible === 'function' ? probeIn : null
    const gate = probe && typeof probe.gate === 'function' ? probe.gate() : null
    const visible = (name) => (probe && typeof probe.visible === 'function' ? Boolean(probe.visible(name)) : false)
    const commandState = commandToolState(runtime, visible, gate, false)
    // API 简报没有 agent:它只能报全局视图,逐会话结论必须指路 scopes。
    const sessionless = Boolean(probeIn && probeIn.sessionless === true)
    // 逐会话事实:这个会话里模型实际拿到哪个宿主工具、终局是什么。
    const scopeFact =
      probeIn && probeIn.agentId && Array.isArray(runtime.scopeToolFacts)
        ? runtime.scopeToolFacts.find((fact) => String(fact.id) === String(probeIn.agentId))
        : null
    const factKind = scopeFact ? String(scopeFact.kind || '') : ''
    const factHosts = scopeFact && Array.isArray(scopeFact.hostTools) ? scopeFact.hostTools.filter(Boolean).map(String) : []
    // facts 最多旧 5s,所以名字再用 live 探针复核一次;看不见就不点名。
    const liveHosts = sessionless ? [] : factHosts.filter((name) => visible(name))
    const sessionHost =
      liveHosts[0] || (scopeFact && scopeFact.hostTool && visible(scopeFact.hostTool) ? String(scopeFact.hostTool) : '')
    // 全局 shippedName 只在「本会话里真的可见」时才允许拿来点名 ——
    // 多宿主 shell 时全局挑出来的可能是别的会话里的那个,点名它会教错语法。
    const globalHost = !sessionless && commandState.hostName && visible(commandState.hostName) ? commandState.hostName : ''
    const hostName = sessionHost || globalHost
    const hostFamily = hostName ? familyOf(runtime, hostName) : ''
    const familyLabel = (f) =>
      ({ bash: 'bash / sh', powershell: 'PowerShell', cmd: 'cmd', wsl: 'WSL', custom: '自定义终端' })[f] || ''
    const pushSyntax = (family) => {
      for (const note of (SYNTAX_NOTES[family] || []).slice(0, 3)) lines.push('  · ' + note)
    }
    // 宿主工具的「名字 + 语法」必须同源;家族认不出就说「用其自身语法」,绝不按默认终端瞎教。
    const hostLabel = (name) =>
      '`' + name + '`(宿主自带' + (familyOf(runtime, name) ? ',用 ' + familyLabel(familyOf(runtime, name)) + ' 语法' : ',用其自身语法(见工具表)') + ')'
    const scopeHint = sessionless ? '(全局视图;逐会话终局见 `commandTool.scopes`)' : ''
    // 沙箱要分两层说:能力位(执行器会不会围栏)与本会话有效策略(这一单受不受围栏)。
    // 只报能力位就是这次修的谎 —— 会把 danger-full-access 的会话说成 workspace-write。
    // 策略不可知时也绝不拿部署默认档冒充本会话结论(两个方向都会说谎)。
    const sandboxLine = !commandState.sandbox
      ? ''
      : commandState.sandboxConfined === true
        ? ';本会话被沙箱围栏(' + (commandState.sandboxPolicyKnown === false ? '策略未知' : commandState.sandboxMode || '策略未知') + ')'
        : commandState.sandboxConfined === false
          ? ';沙箱能力在,本会话策略 ' + (commandState.sandboxMode || 'danger-full-access') + '(无围栏)'
          : sessionless
            ? ';宿主执行器带沙箱能力(部署默认 ' + (commandState.sandboxMode || '未知') + '),各会话有效策略见 scopes'
            : ';宿主执行器带沙箱能力(部署默认 ' + (commandState.sandboxMode || '未知') + '),本会话策略未知(以工具表为准)'
    // 同名工具不一定是我们的:名字可见但登记身份不对时,不能说「EnvDock 已接管」。
    const scopeOwnOurs = !scopeFact || scopeFact.ownOurs !== false
    const ownVisible = Boolean(commandState.takeover && commandState.visible && scopeOwnOurs)
    const usableHost = hostName && visible(hostName) ? hostName : ''
    if (commandState.sandbox && commandState.sandboxConfined === true) {
      // 本会话真被围栏:模型唯一能用的是宿主工具 —— 语法也必须按宿主工具教,
      // 继续教「默认终端」的语法就是让它拿 bash 语法去打 pwsh。
      lines.push(
        '  · 命令工具: ' +
          (usableHost ? hostLabel(usableHost) : '见工具表') +
          (usableHost ? sandboxLine : '') +
          ':EnvDock 不接管(接管会绕过沙箱),以工具表里那个工具为准' +
          (usableHost && familyOf(runtime, usableHost) ? '' : '(它的语法见工具表,不要按默认终端写)') +
          (usableHost
            ? ''
            : ';若工具表里此刻只有 `' +
              ENVD_SHELL_NAME +
              '`,它在这个围栏会话里会拒绝或委托执行(不会绕过沙箱),下一轮对账会把宿主工具换回来'),
      )
      if (usableHost) pushSyntax(familyOf(runtime, usableHost))
    } else if (ownVisible && (!factKind || factKind === 'takeover')) {
      // 无会话视图(API 简报):envd_shell 注册成功 ≠ 每个会话都接管成功。
      // 有会话因宿主 shell 挡不掉而让路时,这里再宣称「已接管」就是撒谎 —— 说清是哪一种。
      const yieldCount =
        sessionless && Array.isArray(runtime.scopeToolFacts) ? runtime.scopeToolFacts.filter((fact) => fact.kind === 'yield').length : 0
      if (sessionless && yieldCount > 0) {
        lines.push(
          '  · 命令工具: `' +
            ENVD_SHELL_NAME +
            '` 已注册,但 ' +
            yieldCount +
            ' 个会话里宿主命令工具挡不掉、EnvDock 已让路(那些会话用宿主工具);以本会话工具表为准,逐会话终局见 `commandTool.scopes`' +
            sandboxLine,
        )
        if (hostName) pushSyntax(familyOf(runtime, hostName) || shell.family)
      } else {
        lines.push('  · 命令工具: `' + ENVD_SHELL_NAME + '`(EnvDock 已接管),里面只能写 ' + shell.label + ' 语法' + sandboxLine + scopeHint)
        // 挡不掉的宿主 shell(作用域私有 / 别的插件后注册)会和我们并列:说真话,别让模型以为只有一个。
        // 逐会话看**这个会话里仍然可见**的宿主工具;sessionless(API)不下会话结论。
        const leakHosts = liveHosts.filter((name) => name !== ENVD_SHELL_NAME)
        if (leakHosts.length) {
          lines.push(
            '  · 注意:宿主 ' +
              leakHosts.map((name) => '`' + name + '`').join('、') +
              ' 在这个会话里没被挡住,仍然可用;两条命令工具都在时优先用 `' +
              ENVD_SHELL_NAME +
              '`(语法见下面几行)',
          )
        }
        pushSyntax(shell.family)
      }
    } else if (factKind === 'host' && !ownVisible) {
      // 本会话没有接管(注册失败 / 被占用 / 无需接管 / 我们的工具被折叠或遮挡):
      // 模型用的是宿主工具 —— 名字与语法都按它来;若 envd_shell 已注册却在本会话不可用,明说别直呼。
      lines.push(
        '  · 命令工具: ' +
          (usableHost ? hostLabel(usableHost) : '见工具表') +
          (usableHost ? sandboxLine : '') +
          ';EnvDock 没有接管这个会话' +
          (commandState.takeover
            ? '(`' +
              ENVD_SHELL_NAME +
              '` 在本会话不可用:被工具折叠、遮挡,或不是 EnvDock 登记的那一份同名工具;不要直呼它)'
            : ''),
      )
      if (usableHost) pushSyntax(familyOf(runtime, usableHost))
    } else if (factKind === 'yield' && !ownVisible) {
      // 宿主 shell 挡不掉 / 认不出家族:EnvDock 把自己的工具让路,这个会话用宿主的那个
      lines.push(
        '  · 命令工具: ' +
          (usableHost ? hostLabel(usableHost) : '见工具表') +
          ';' +
          (usableHost
            ? '宿主 shell 在这个会话里挡不掉或无法替代,EnvDock 已让路,直接用这个'
            : 'EnvDock 已让路,但替代工具暂时无法判定;以工具表为准'),
      )
      if (usableHost) pushSyntax(familyOf(runtime, usableHost))
    } else if (factKind === 'sandbox-host' && !ownVisible) {
      lines.push(
        '  · 命令工具: ' + (usableHost ? hostLabel(usableHost) : '见工具表') + (usableHost ? sandboxLine : '') + ':EnvDock 不接管(接管会绕过沙箱)',
      )
      if (usableHost) pushSyntax(familyOf(runtime, usableHost))
    } else if (commandState.takeover) {
      // 接管了但工具此刻不在工具表里(刚重载 / 注册失败):别谎报「已接管」让模型去撞 unknown tool。
      lines.push(
        '  · 命令工具: `' +
          ENVD_SHELL_NAME +
          '` 刚被 EnvDock 接管但此刻不在工具表里;先用工具表里其它的命令工具(按它自己的语法),若一个都没有就下一步再试,别硬调这个名字',
      )
    } else if (!commandState.name) {
      lines.push('  · 命令工具: 见工具表' + sandboxLine)
      pushSyntax(shell.family)
    } else if (commandState.visible) {
      lines.push('  · 命令工具: ' + hostLabel(commandState.name) + sandboxLine)
      pushSyntax(familyOf(runtime, commandState.name))
    } else {
      // 可见性探针没拿到(例如 agent 作用域还没登记):断言「在不在」就会撒谎,
      // 只说名字与语法,让模型以工具表为准。
      lines.push(
        '  · 命令工具: `' +
          commandState.name +
          '`(宿主自带' +
          (familyOf(runtime, commandState.name) ? ',用 ' + familyLabel(familyOf(runtime, commandState.name)) + ' 语法' : '') +
          ';能不能调以工具表为准)' +
          sandboxLine,
      )
    }
  }
  const tools = (detection.tools || []).slice(0, 14)
  if (tools.length) {
    lines.push('- 工具(绝对路径,直接用,不必再 where/which):')
    for (const tool of tools) {
      const others = (tool.versions || []).filter((v) => v.path.toLowerCase() !== String(tool.defaultPath).toLowerCase())
      const extra = others.length ? ' [另有 ' + others.map((v) => 'v' + (v.version || '?') + ' ' + v.path).join('; ') + ']' : ''
      // py 启动器不是解释器,但模型要知道它在:只有它能枚举「机器上有几套 Python」。
      const launcher = tool.pyLauncher || ''
      const pyTag = launcher
        ? launcher.toLowerCase() === String(tool.defaultPath).toLowerCase()
          ? ' [py 启动器,可用 py -3.10 选版本]'
          : ' [py 启动器 ' + launcher + ',可用 py -3.10 选版本]'
        : ''
      lines.push('  · ' + tool.label + ' ' + (tool.defaultVersion ? 'v' + tool.defaultVersion : '(版本未知)') + ' → ' + tool.defaultPath + extra + pyTag)
    }
  } else {
    lines.push('- 工具: PATH 上没扫到 node/python/git,需要时先确认安装位置')
  }
  if (detection.versionManagers.length) {
    lines.push(
      '- 版本管理器: ' +
        detection.versionManagers
          .map((m) => {
            const where = m.command || m.roots[0] || ''
            const vers = m.versions.length ? ' [' + m.versions.length + ' 个版本' + (m.active ? ',激活 ' + m.active : '') + ']' : ''
            return m.label + '(' + where + ')' + vers
          })
          .join(', '),
    )
  }
  // 简报只报 error:多版本并存之类的 warn 对模型是噪音(还会因为「PATH 上是 v24、管理器激活 v20」
  // 这类正常共存产生歧义)。面板/健康检查仍然完整显示。
  const issues = healthIssues(detection, state).filter((i) => i.level === 'error')
  if (issues.length) {
    lines.push('- 注意:')
    for (const issue of issues.slice(0, 3)) lines.push('  · [' + issue.level + '] ' + issue.title + ' — ' + String(issue.detail).slice(0, 160))
  }
  lines.push('- `envd` 工具只能解析上面已探测到的工具;没列出的不在探测范围内(需要时用 `command -v` / `Get-Command` 自行确认,别用 `envd` 试探)。')
  return lines.join('\n')
}

// ───────────────────────────────────────────────────────── 工具 ──

function textBlock(text) {
  return [{ type: 'text', text }]
}

/** 严格判断一个主机名/IP 字面量是不是回环(不做前缀匹配:`127.0.0.1.evil` 不算)。 */
function isLoopbackHost(host) {
  const value = String(host || '')
    .toLowerCase()
    .trim()
    .replace(/^\[|\]$/g, '')
    // DNS 名字允许带尾点(localhost. 等价 localhost),浏览器地址栏也可能留下它。
    .replace(/\.$/, '')
    // IPv4-mapped IPv6(::ffff:127.0.0.1)在某些双栈监听上就是回环地址。
    .replace(/^::ffff:/, '')
  if (!value) return false
  if (value === '::1' || value === 'localhost') return true
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (!m) return false
  return m.slice(1).every((part) => Number(part) <= 255)
}

/** 请求是否来自本机。空地址按**非**本机处理(拿不到来源就不该放行)。 */
function isLoopback(req) {
  // 只认 socket.remoteAddress:拿不到来源就按「非本机」处理(以前会回落 socket.address(),
  // 在代理/非 socket 分发时把本地端点误判成本机)。
  const raw = String((req && req.socket && req.socket.remoteAddress) || '')
  const addr = raw.startsWith('::ffff:') ? raw.slice(7) : raw
  return isLoopbackHost(addr)
}

function envdTool(ctx, getDetection, getState, forceRefresh, isVisible, runtime, gateFor, hasToolFor) {
  /**
   * 按调用方会话求值的探针。
   *
   * 以前 envd 工具固定走全局视图:会话里被藏掉的 envd_shell 会被说成「已接管」,
   * 同一会话里系统简报说「无围栏」而 envd summary 说「本会话策略未知」——
   * 模型两面读到的口径相反。tool execute 拿得到 exec.agent,就该按它求真话。
   */
  const probeFor = (exec) => {
    const agent = exec && exec.agent ? exec.agent : null
    return {
      visible: (name) => {
        if (agent && typeof hasToolFor === 'function') {
          try {
            return Boolean(hasToolFor(agent, name))
          } catch {}
        }
        return typeof isVisible === 'function' ? Boolean(isVisible(name)) : false
      },
      gate: () => (typeof gateFor === 'function' ? gateFor(agent) : null),
      agentId: agent ? String(agent.id) : '',
      // 没有 agent 就没有「本会话」这个概念:和 /envdock-api 一样只报全局视图并指路 scopes
      sessionless: !agent,
    }
  }
  const definition = {
    name: 'envd',
    description:
      '查本机工具链与终端。resolve: 按名字拿绝对路径、版本和该终端下的正确命令写法;summary: 拿完整环境简报;check: 拿健康问题清单;set_default: 把某个工具切到指定版本的路径作为默认。' +
      '已经注入过环境简报时,通常只有需要精确路径或复查时才调用,不要用它试探不存在的工具。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['summary', 'resolve', 'check', 'set_default'],
          description: '默认 summary。resolve 需要 name;set_default 需要 name 和 path。',
        },
        name: { type: 'string', description: '工具名或别名,如 node / python / py(py 是 Windows 的 Python 启动器,与 python 同义)/ git / npm / bash。set_default 时必填。' },
        path: { type: 'string', description: 'set_default 时的绝对路径,必须是 resolve 返回的候选之一。' },
        refresh: { type: 'boolean', description: 'true 时忽略缓存重新探测(刚装完东西再用)。' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        const v = value || {}
        return textBlock(typeof v.text === 'string' ? v.text : JSON.stringify(v, null, 2))
      },
    },
    async execute(args, exec) {
      const a = args || {}
      const action = a.action || 'summary'
      // 按**调用方会话**求值:summary / set_default 里的简报必须与系统提示词里的简报同口径
      const probe = probeFor(exec)
      const state = getState()
      let detection = null
      try {
        detection = await getDetection(Boolean(a.refresh) || Boolean(forceRefresh))
      } catch (error) {
        return { ok: false, text: '环境探测失败: ' + String((error && error.message) || error) }
      }
      if (action === 'summary') {
        return { ok: true, text: brief(detection, state, probe, runtime) }
      }
      if (action === 'check') {
        const issues = healthIssues(detection, state)
        if (!issues.length) return { ok: true, text: 'EnvDock 健康检查:没发现问题。' }
        const text = ['EnvDock 健康检查 (' + issues.length + ' 项):']
          .concat(issues.map((i) => '- [' + i.level + '] ' + i.title + ' — ' + i.detail))
          .join('\n')
        return { ok: true, text }
      }
      if (action === 'set_default') {
        const name = String(a.name || '').trim()
        const target = String(a.path || '').trim()
        if (!name || !target) return { ok: false, text: 'set_default 需要 name 和 path。' }
        const entry = (detection.tools || []).find(
          (t) => t.key === name || t.label.toLowerCase() === name.toLowerCase() || (t.names || []).includes(name),
        )
        if (!entry) return { ok: false, text: '没探测到工具 "' + name + '"。可用: ' + (detection.tools || []).map((t) => t.key).join(', ') }
        const ok = (entry.versions || []).some((v) => v.path.toLowerCase() === target.toLowerCase())
        if (!ok) return { ok: false, text: '路径不在 ' + entry.label + ' 的候选里,可选: ' + (entry.versions || []).map((v) => v.path).join(' | ') }
        const next = writeState({ selections: { ...getState().selections, [entry.key]: target } })
        const refreshed = await getDetection(true)
        return { ok: true, text: '已把 ' + entry.label + ' 的默认版本切到 ' + target + '。\n\n' + brief(refreshed, next, probe, runtime) }
      }
      const name = String(a.name || '').trim()
      if (!name) return { ok: false, text: 'resolve 需要 name,比如 node / python / git。可用: ' + detection.tools.map((t) => t.key).join(', ') }
      const lower = name.toLowerCase()
      const entry = (detection.tools || []).find(
        (t) => t.key.toLowerCase() === lower || t.label.toLowerCase() === lower || (t.names || []).some((n) => n.toLowerCase() === lower),
      )
      if (!entry) {
        const terminal = (detection.terminals || []).find((t) => t.key.toLowerCase() === lower)
        if (terminal) {
          const invocation = shellInvocation(terminal, 'echo hi')
          return { ok: true, text: terminal.label + ' → ' + terminal.path + (terminal.version ? ' (v' + terminal.version + ')' : '') + '\n启动: ' + (invocation ? invocation.join(' ') : terminal.path) }
        }
        return {
          ok: false,
          text: '没探测到 "' + name + '"。已探测: ' + (detection.tools || []).map((t) => t.key + (t.defaultVersion ? '@' + t.defaultVersion : '')).join(', '),
        }
      }
      const shell = resolveShell(state, detection)
      const lines = []
      lines.push(entry.label + ' 默认: ' + entry.defaultPath + (entry.defaultVersion ? ' (' + entry.defaultVersion + ')' : ''))
      // `envd resolve py` 走到这里:命中 python,但要把启动器本身讲明白,不能只报解释器就完事。
      if (entry.pyLauncher) {
        lines.push(
          'py 启动器: ' +
            entry.pyLauncher +
            (entry.viaLauncher
              ? '(python.exe 不在 PATH,当前默认就是它;可用 py -3.10 指定版本,py -0p 列全部)'
              : '(可用 py -3.10 指定版本,py -0p 列全部)'),
        )
      }
      if ((entry.versions || []).length > 1) {
        lines.push('全部候选:')
        for (const v of entry.versions) {
          lines.push('  · ' + (v.version || '版本未知') + ' → ' + v.path + (v.path.toLowerCase() === String(entry.defaultPath).toLowerCase() ? '  ← 当前默认' : ''))
        }
      }
      lines.push('终端: ' + shell.label + (shell.path ? ' (' + shell.path + ')' : ''))
      return { ok: true, text: lines.join('\n') }
    },
  }
  return definition
}

// ────────────────────────────────────────────── 命令执行工具(接管) ──

/**
 * 接管的命令工具。
 *
 * 两个刻意的设计,都是为了「切终端时不产生工具表空窗」:
 *   · name 固定成 ENVD_SHELL_NAME,不跟终端走 —— 名字一变,DSH 就得先拆后建;
 *   · 终端从 activeShell 这个可变 ref 里读 —— 切终端只改「怎么执行」,不用重新注册。
 *
 * 代价是描述里不能写死某个终端的语法(注册时就固化了,之后不会跟着变),
 * 所以语法一律以每步重新求值的环境简报为准 —— 那边永远是当前终端。
 */
function commandTool(ctx, activeShell, gateFor, hostFamilyOf, stats) {
  /** 本会话的沙箱事实。取不到就按「有围栏」保守处理,绝不猜成无围栏。 */
  const gateAt = (agent) => {
    // 取不到本会话策略时按「有围栏」处理(confined=true):宁可拒绝,也不开无围栏旁路。
    const fallback = { capable: false, confined: true, mode: '', policyKnown: false, delegate: false }
    let gate = fallback
    try {
      if (typeof gateFor === 'function') gate = gateFor(agent) || fallback
    } catch {
      gate = { capable: true, confined: true, mode: '', policyKnown: false, delegate: false }
    }
    // 能力位在、却判不出本会话策略(没有会话 / 策略服务缺失)时,按「有围栏」处理:
    // 这一刻直接 spawn 就可能是绕过沙箱,宁可拒绝也不开旁路。
    return { ...gate, confined: gate.confined !== false }
  }

  /**
   * 围栏下委托宿主执行器执行。
   *
   * 为什么这样是安全的:`ctx.shell` 是带围栏的执行器,围栏挂在它启动的进程上,
   * 我们把目标终端当子进程拉起来,子进程继承同一份围栏。命令经 env 传入,
   * 不拼字符串,也不需要 EnvDock 自己 spawn 一条没有 sandboxPolicy 的命令。
   *
   * 返回 null = 这个部署没法安全委托(宿主执行器族未知 / 缺 resolve+execute):
   * 调用方据此拒绝,而不是退回无围栏 spawn。
   */
  const runDelegated = async (exec, gate, line, shell, cwd, timeoutMs) => {
    // 进入委托路径就记一次尝试:即使随后拒绝,面板也要能区分「根本没走到」与「被拒」。
    if (stats && typeof stats === 'object') stats.delegateTries = (Number(stats.delegateTries) || 0) + 1
    const refuse = (reason) => {
      if (stats && typeof stats === 'object') stats.delegateRefusals = (Number(stats.delegateRefusals) || 0) + 1
      // 把「为什么不能用 envd_shell」说清楚:只说拒绝,模型会以为工具坏了或者命令写错了。
      const facts = []
      if (gate && typeof gate.mode === 'string' && gate.mode) facts.push('本会话策略 ' + gate.mode)
      if (gate && gate.confined === true) facts.push('本会话被沙箱围栏')
      else if (gate && gate.confined === null) facts.push('本会话沙箱策略不可知')
      const hint = facts.length ? '(' + facts.join(' · ') + ')' : ''
      return { ok: false, text: '[sandbox] ' + reason + hint + ';EnvDock 没有执行这条命令,请改用宿主自带的命令工具' }
    }
    const host = ctx.get('shell')
    if (!host || typeof host.resolve !== 'function' || typeof host.execute !== 'function') {
      return refuse('宿主没有可委托的执行器(resolve/execute 缺失)')
    }
    const agent = exec && exec.agent ? exec.agent : null
    // 没有会话就没有「本会话策略」可交给宿主执行器:这样的委托可能按部署默认档跑,拒绝。
    if (!agent) return refuse('本会话信息缺失,无法把本会话沙箱策略交给宿主执行器')
    // 能力位不在(执行器根本不会围栏)时委托没有意义,也不该由这里兜底
    if (gate && gate.capable === false) return refuse('宿主执行器自称不围栏,委托无法保证围栏生效')
    const hostFamily = typeof hostFamilyOf === 'function' ? String(hostFamilyOf(agent) || '') : ''
    // 只认能确定包装语法的两种宿主执行器;别的(cmd/wsl/未知)拒绝,绝不猜。
    if (hostFamily !== 'powershell' && hostFamily !== 'bash') {
      return refuse('宿主执行器的语法族无法安全包装(cmd/未知),EnvDock 拒绝委托执行')
    }
    const invocation = delegatedInvocation(hostFamily, shell, line)
    if (!invocation || invocation.error) {
      if (invocation && invocation.error === 'too-long') {
        return refuse('命令太长(' + String(line).length + ' 字符),超出委托的安全上限')
      }
      return refuse(
        '目标终端(' +
          String((shell && shell.family) || 'unknown') +
          ')不支持安全委托执行(只支持 bash / PowerShell 目标;cmd/WSL/自定义终端请用宿主工具)',
      )
    }
    const command = invocation.command
    const policies = ctx.get('sandboxPolicy')
    const session = agent.session
    let policy = null
    try {
      if (policies && typeof policies.resolve === 'function') policy = policies.resolve(session ? { session } : {})
    } catch {
      policy = null
    }
    if (!policy || !SANDBOX_MODES.has(String(policy.mode || ''))) {
      // 拿不到/拿到非法 policy 时不能委托:那等于用部署默认档执行,可能绕过本会话围栏。
      // 这属于「拒绝」(没执行),不是「失败」(执行阶段出错)。
      return refuse('本会话沙箱策略不可得或非法,拒绝委托执行(不拿部署默认档冒充)')
    }
    const env = invocation.envValue ? { ENVD_CMD: invocation.envValue } : {}
    // 和官方 shell 工具一致:带上受管的 DSH_* 快照(subprocess 会剥掉父进程的 DSH_*)。
    // 它必须走 dshEnv 而不是普通 env:普通 env 会被登记为可被覆盖的普通变量。
    let dshEnv = null
    try {
      const shellEnv = ctx.get('shellEnv')
      dshEnv = shellEnv && typeof shellEnv.collect === 'function' ? shellEnv.collect(exec) : null
    } catch {
      dshEnv = null
    }
    const request = {
      command,
      workdir: cwd,
      timeoutMs,
      signal: exec && exec.signal,
      // 命令走环境变量:宿主 → 目标终端两层引号都不用拼
      env,
    }
    if (dshEnv && typeof dshEnv === 'object') request.dshEnv = dshEnv
    request.sandboxPolicy = policy
    const fail = (stage, error) => {
      if (stats && typeof stats === 'object') stats.delegateFailures = (Number(stats.delegateFailures) || 0) + 1
      const message = String((error && (error.message || error.name)) || error)
      // 执行器在 runner 不可用时是**抛错**(SandboxUnavailableError),不是返回 runnerFailed;
      // 单列一句,别把「命令根本没跑」伪装成普通命令失败。
      if (/sandboxunavailable/i.test(String((error && error.name) || '')) || /sandbox|runner/i.test(message)) {
        return { ok: false, text: '[sandbox] 委托宿主执行器失败(' + stage + '):围栏 runner 不可用,这条命令没有执行 —— ' + message }
      }
      return { ok: false, text: '[sandbox] 委托宿主执行器失败(' + stage + '): ' + message }
    }
    let spec = null
    try {
      spec = host.resolve(request)
    } catch (error) {
      return fail('解析', error)
    }
    let execution = null
    try {
      execution = await host.execute(spec)
    } catch (error) {
      return fail('启动', error)
    }
    let result = null
    try {
      result = await execution.result()
    } catch (error) {
      return fail('执行', error)
    }
    // result 必须是对象:空/非对象说明执行器坏了,不能当成一次「成功执行」计数
    if (!result || typeof result !== 'object') {
      return fail('结果', new Error('宿主执行器返回了空结果'))
    }
    const runnerFailed = Boolean(result.sandbox && result.sandbox.runnerFailed)
    const aborted = result.aborted === true
    // 三种结局分开记账,任何真实发生过的路径都留痕:
    //   · delegateCalls        拿到了结果且命令真的执行了;
    //   · delegateRunnerFailures 执行器接了活但围栏 runner 坏了(命令没执行);
    //   · delegateAborts       命令被取消。
    // 以前 runnerFailed / aborted 在四个计数里都不留痕 → 面板分不清「没走过委托」和「runner 坏了」。
    if (stats && typeof stats === 'object') {
      if (runnerFailed) stats.delegateRunnerFailures = (Number(stats.delegateRunnerFailures) || 0) + 1
      else if (aborted) stats.delegateAborts = (Number(stats.delegateAborts) || 0) + 1
      else stats.delegateCalls = (Number(stats.delegateCalls) || 0) + 1
    }
    const LIMIT = 16000
    const clip = (text) => (text.length > LIMIT ? text.slice(0, LIMIT) + '\n…(已截断,原长 ' + text.length + ' 字符)' : text)
    const mode = (policy && policy.mode) || gate.mode || '宿主的围栏'
    const parts = [
      result.sandbox
        ? '[sandbox] 委托宿主执行器执行(' + ((result.sandbox && result.sandbox.mode) || mode) + ')'
        : '[sandbox] 委托宿主执行器执行(策略 ' + mode + ';执行器未报告围栏事实)',
    ]
    if (result.sandbox) {
      if (result.sandbox.runnerFailed) parts.push('[sandbox: 围栏 runner 失败,这条命令没有执行]')
      if (result.sandbox.denied) parts.push('[sandbox: 文件操作被沙箱拒绝 —— 这是策略拒绝,不要换旁路重试]')
    }
    if (result.timedOut) parts.push('[timeout]')
    if (result.aborted) parts.push('[aborted]')
    const stdout = result.stdout && typeof result.stdout.text === 'string' ? result.stdout.text : ''
    const stderr = result.stderr && typeof result.stderr.text === 'string' ? result.stderr.text : ''
    if (stdout) parts.push(clip(stdout))
    if (stderr) parts.push('[stderr]\n' + clip(stderr))
    const exit = result.timedOut ? 'timeout' : result.exitCode !== null && result.exitCode !== undefined ? String(result.exitCode) : '?'
    parts.push('[exit ' + exit + ']')
    // runner 失败时命令根本没执行;aborted 是取消 —— 两者都不能回 ok:true。
    return { ok: !runnerFailed && !aborted, text: parts.join('\n') }
  }

  return {
    name: ENVD_SHELL_NAME,
    description:
      '在本机默认终端里执行一条命令并返回输出。终端是哪一个、必须用哪套语法,以「本机环境 (EnvDock)」简报里' +
      '「默认终端 / 命令工具」那几行为准(默认终端可以随时切换,所以这里不写死某个终端的语法)。' +
      'cwd 省略时用当前会话的工作目录;长输出会被截断。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令行,单条,可用该终端的串联语法。' },
        description: { type: 'string', description: '这条命令在做什么,一句话(可选,仅供界面展示)。' },
        cwd: { type: 'string', description: '工作目录绝对路径;省略用当前会话的工作目录。' },
        timeoutMs: { type: 'integer', description: '超时毫秒,默认 120000,最大 600000。' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        return textBlock(typeof value.text === 'string' ? value.text : JSON.stringify(value, null, 2))
      },
    },
    async execute(args, exec) {
      // 每一单都复检沙箱:对账是 5 秒一次,沙箱完全可能在两次对账之间出现/收紧。
      // 这一刻再 spawn 就是绕过沙箱 —— 宁可拒绝,也不开旁路(下一轮对账会摘掉 envd_shell)。
      // 终端永远读**当前**值:切终端只是换了这里的 shell,工具本身没被重建。
      // 必须现算而不能直接用 activeShell.current —— 后者要到下一轮对账才更新(最多 5 秒),
      // 这期间简报已经写的是新终端,命令却还按旧终端跑(实测 setShell 后 200ms 内仍用旧 shell)。
      const stateNow = readState()
      const shell = (cache.value && resolveShell(stateNow, cache.value)) || activeShell.current || resolveShell(stateNow, null)
      const line = String((args && args.command) || '')
      if (!line.trim()) return { ok: false, text: 'command 不能为空。' }
      const argv = shellInvocation(shell, line)
      if (!argv) return { ok: false, text: '默认终端不可用: ' + shell.label }
      let cwd = args && args.cwd ? String(args.cwd) : ''
      if (!cwd) {
        // 会话的工作目录,不是 dsh 进程的 cwd:命令必须落在用户正在干活的那个目录里
        const wd = ctx.get('workingDirectory')
        if (wd && typeof wd.ensure === 'function' && exec && exec.agent) {
          try {
            cwd = await wd.ensure(exec.agent, exec.signal)
          } catch {
            cwd = ''
          }
        }
        if (!cwd && wd && typeof wd.defaultDirectory === 'string') cwd = wd.defaultDirectory
        if (!cwd) cwd = process.cwd()
      }
      let isDir = false
      try {
        isDir = statSync(cwd).isDirectory()
      } catch {}
      if (!isDir) return { ok: false, text: '工作目录不存在: ' + cwd }
      const timeoutMs = Math.min(Math.max(Number(args && args.timeoutMs) || 120000, 1000), 600000)
      // 沙箱闸门:每一单都按**本会话**的有效策略复检。
      // 对账是 5 秒一次,策略完全可能在两次之间变严 —— 这一刻直接 spawn 就是绕过沙箱。
      const gate = gateAt(exec && exec.agent ? exec.agent : null)
      if (gate.confined) {
        const options = readState().options
        // 委托:围栏挂在宿主执行器上,子终端继承;EnvDock 自己不 spawn,沙箱不被绕过。
        if (options.sandboxTakeover !== 'refuse') {
          const delegated = await runDelegated(exec, gate, line, shell, cwd, timeoutMs)
          if (delegated) return delegated
        }
        return {
          ok: false,
          text:
            '本会话的命令执行受宿主沙箱围栏' +
            (gate.mode ? '(' + gate.mode + ')' : '') +
            ',EnvDock 不接管;请改用宿主自带的命令工具' +
            (options.sandboxTakeover === 'refuse'
              ? '(面板里把「沙箱下接管」切到「委托执行」可以恢复这个工具)'
              : '(当前执行器/终端组合无法安全委托,详见本条拒绝原因)'),
        }
      }
      const service = ctx.get('subprocess')
      if (!service || typeof service.spawn !== 'function') return { ok: false, text: '宿主没有可用的 subprocess 服务' }
      let handle
      try {
        handle = service.spawn({
          argv,
          cwd,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 262144 }, stderr: { maxBytes: 65536 } },
          graceMs: 3000,
          signal: exec && exec.signal,
        })
      } catch (error) {
        // spawn 会同步抛(cwd/argv/grace 非法、已取消),不接住就变成一条没头没尾的工具异常
        return { ok: false, text: '启动命令失败: ' + String((error && error.message) || error) }
      }
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try {
          handle.terminate()
        } catch {}
      }, timeoutMs)
      let outcome = null
      let failure = null
      try {
        outcome = await handle.done
      } catch (error) {
        failure = error
      } finally {
        clearTimeout(timer)
      }
      const read = (reader) => {
        if (!reader) return ''
        try {
          const r = reader.readFrom(0)
          return r.text || ''
        } catch {
          return ''
        }
      }
      const stdout = read(handle.collected && handle.collected.stdout)
      const stderr = read(handle.collected && handle.collected.stderr)
      const LIMIT = 16000
      const clip = (text) => (text.length > LIMIT ? text.slice(0, LIMIT) + '\n…(已截断,原长 ' + text.length + ' 字符)' : text)
      const parts = []
      if (failure) parts.push('[error] ' + String((failure && failure.message) || failure))
      if (stdout) parts.push(clip(stdout))
      if (stderr) parts.push('[stderr]\n' + clip(stderr))
      parts.push('[exit ' + (timedOut ? 'timeout' : outcome && outcome.exitCode !== null ? String(outcome.exitCode) : '?') + ']')
      return { ok: !failure, text: parts.join('\n') }
    },
  }
}

// ───────────────────────────────────────────────────────── apply ──

/** tools 必须 inject(Cordis 不允许未声明就取服务属性);其余走 ctx.get 可选访问。 */
export const inject = ['tools']

export function apply(ctx, config) {
  const settings = { ...(config || {}) }
  const runner = createRunner(ctx)

  const getState = () => readState()
  const getDetection = async (force) => {
    const started = Date.now()
    const value = await detect(ctx, runner, getState(), Boolean(force))
    syncStats.lastDetectMs = Date.now() - started
    if (!rt.lastDetectionAt || (value && value.at && value.at !== rt.lastDetectionAt)) {
      syncStats.detections++
      rt.lastDetectionAt = value && value.at ? value.at : Date.now()
    }
    return value
  }

  /**
   * 对账统计:`/envdock-api` 直接端出去,面板显示「真的在动还是假装在动」。
   * 稳态 tick 的 registers / disposes / denyApplies 必须**完全不涨** ——
   * 涨了就是又在 5 秒一次地拆建工具,模型迟早撞上 unknown tool。
   */
  const syncStats = {
    ticks: 0,
    registers: 0,
    disposes: 0,
    denyApplies: 0,
    denyDrops: 0,
    steadyTicks: 0,
    lastSig: '',
    lastError: null,
    lastChosenName: null,
    lastAt: 0,
    intervalMs: 5000,
    /** 围栏会话里真正委托给宿主执行器执行的次数(0 = 委托路径没被走过) */
    delegateCalls: 0,
    /** 拒绝守卫命中次数(被藏掉的全局 shell 名被直呼时记一次) */
    guardDenials: 0,
    /** plan 里含「让路」作用域的 tick 数(稳态时它跟着 ticks 涨、注册表动作不涨才是对的) */
    yieldTicks: 0,
    /** 连 restrict 都挡不掉的宿主 shell 名(挡不了就会一直并列可见,面板据此能解释) */
    unrestrictable: [],
    /** 因为看不到 envd_shell 而没遮挡的作用域(空 = 全都对完账了) */
    blockedScopes: [],
    /** 宿主 shell 是作用域私有、挡不掉的会话:EnvDock 让路,该会话用宿主工具 */
    hostOnlyScopes: [],
    /** 宿主执行器会围栏(能力位)。注意它**不等于**本会话被围栏 —— 见 sandboxScopes */
    sandboxCapable: false,
    /** 部署默认档(执行器公布的 sandboxMode),不是本会话有效策略 */
    sandboxDefault: '',
    /** 本会话被围栏 → 这个会话改用宿主工具(没有任何会话被挡时为空) */
    sandboxBlocked: false,
    /** kind=sandbox-host 的会话数(逐会话事实推导;初始 0,别让字段在首个 tick 前消失) */
    sandboxHiddenScopes: 0,
    /** 每个作用域的沙箱事实:[{ id, mode, confined }],面板据此说「哪个会话为什么」 */
    sandboxScopes: [],
    /** 本 tick 结束时是否**此刻**处于稳态;累计量 steadyTicks 不能当状态用(一旦稳态过就永远为真) */
    steadyNow: false,
    /** 最近一次进入稳态的时刻(ms);0 = 从未 */
    steadySinceAt: 0,
    /** 上一轮是否稳态(内部用,判断「刚进入稳态」) */
    steadyPrev: false,
    /** lastError 的写入时刻(ms);lastError 为 null 时无意义 —— 面板据此显示「多久前」 */
    lastErrorAt: 0,
    /** ctx.tools.register 的**尝试**次数(含失败/被校验拒绝):和 registers 一起才能抓「建了又拆」 */
    registerTries: 0,
    /** 围栏会话里发起委托的次数(含失败);delegateCalls 只计真正跑完的 */
    delegateTries: 0,
    /** 委托在 resolve/启动/结果三个阶段抛错的次数 */
    delegateFailures: 0,
    /** 因「目标终端/执行器不支持安全委托」而直接拒绝的次数(与失败区分) */
    delegateRefusals: 0,
    /** 宿主执行器接了活、但 runner 自己失败(命令根本没执行)的次数;与 delegateFailures 分开 */
    delegateRunnerFailures: 0,
    /** 命令被取消(aborted)的次数:取消不是失败,也不是执行 */
    delegateAborts: 0,
    /** 藏我们自己的 envd_shell 的 restrict 次数(与「挡宿主」分开记账) */
    ownHides: 0,
    /** 挡宿主 shell 的 restrict 次数 */
    hostDenyApplies: 0,
    /** restrict 返回成功、复读却仍可见的次数(agent 层同名工具挡不住) */
    denyNoops: 0,
    /** 过渡性缺名(restrict 说 unknown、但此刻也看不见)的次数:不进 badNames,给重试窗口 */
    transientMisses: 0,
    /** 无主 deny:restrict 先落地再抛错,deny 生效但撤销句柄丢了(重启 dsh 才能清) */
    lostDenies: [],
    /** 拒绝守卫是否注册成功;失败原因在 guardError */
    guardReady: false,
    guardError: null,
    /** 运行时识别到的宿主命令工具:[{ name, family, learned }] */
    runtimeShellTools: [],
    /** 逐会话事实里「实际拿不到命令工具 / 接管下宿主仍可见 / 挡了却仍可见」的会话 id */
    scopeAnomalies: [],
    /** 宿主执行器(ctx.shell)的语法族与判定来源:委托包装器必须跟它一致,不是跟宿主工具名一致 */
    executorFamily: '',
    executorFamilySource: 'unknown',
    /** 宿主是否提供 tools.executable(没有时只能按可见性判，「可执行面」并不存在) */
    hasExecutableApi: false,
    /** 探测次数(真正的探测,不是缓存命中)与最近一次耗时(ms) */
    detections: 0,
    lastDetectMs: 0,
  }
  /** 对账周期(默认 5s;测试夹具用它把 20 个 tick 压进几百毫秒) */
  const syncIntervalMs = Math.min(Math.max(Number(settings.syncIntervalMs) || 5000, 20), 600000)
  /** 本代实例的接管运行态:brief 与 API 都读它,不跨实例共享 */
  const rt = createRuntime()

  /**
   * 错误记账:lastError 只代表「本 tick 的对账错误」,每轮对账开始清空。
   * 以前只在完整对账入口清,而稳态分支根本不经过那里 —— 一次瞬时「探测失败」会常驻面板。
   */
  const setLastError = (message) => {
    syncStats.lastError = message ? String(message) : null
    syncStats.lastErrorAt = message ? Date.now() : 0
  }
  /** 稳态记账:steadyNow 是**状态**,steadyTicks 是**累计量**,两者不能混用。 */
  const markSteady = () => {
    // steadyNow 每轮开始会置 false,所以用 steadyPrev 记住「上一轮是否稳态」:
    // 只有从「非稳态」进入「稳态」的那一刻才刷新 steadySinceAt,否则它每 tick 被重置,
    // 消费者永远算不出「已经稳态多久」。
    if (!syncStats.steadyNow) {
      syncStats.steadyNow = true
      if (!syncStats.steadyPrev) syncStats.steadySinceAt = Date.now()
    }
    syncStats.steadyTicks++
  }

  /**
   * 宿主执行器的语法族。委托时包装串是交给 `ctx.shell` 执行的,所以必须跟**执行器**
   * 的 shell 一致,不能跟「宿主命令工具名」一致 —— Windows 官方 base 挂的是 pwsh-sandbox
   * (PowerShell),而模型手里的工具可能是 dsh-ops 的 `ops_bash`(bash);按工具名选 bash 包装器
   * 交给 PowerShell 执行必然 ParserError,命令根本没跑。
   * 判定顺序:执行器对象名/类名里的线索 → 平台默认(官方 base:win32=pwsh-sandbox,其余=bash-sandbox)。
   */
  const executorFamily = () => {
    const shell = readService('shell')
    if (!shell) return { family: '', source: 'absent' }
    const probes = []
    const push = (value) => {
      const text = String(value || '')
      if (text && !probes.includes(text)) probes.push(text)
    }
    try { push(shell.name) } catch {}
    try { push(shell.id) } catch {}
    try { push(shell.constructor && shell.constructor.name) } catch {}
    try { push(shell.constructor && shell.constructor.id) } catch {}
    // CamelCase 也要能分:`CmdSandboxExecutor` 先拆成 `Cmd Sandbox Executor` 再小写
    const text = probes
      .join(' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
    if (/pwsh|powershell/.test(text)) return { family: 'powershell', source: 'executor' }
    if (/gitbash|msys|bash/.test(text)) return { family: 'bash', source: 'executor' }
    if (/\bcmd\b/.test(text)) return { family: 'cmd', source: 'executor' }
    // 官方 base 的默认布局:win32 只挂 pwsh-sandbox,其余平台只挂 bash-sandbox。
    return { family: IS_WIN ? 'powershell' : 'bash', source: 'platform' }
  }

  /**
   * 宿主执行器的**围栏能力**:只回答「它会不会围栏」。
   *
   * `shell.sandboxMode` 是执行器公布的**部署默认档**(dsh-pwsh-sandbox 的实现就是
   * `ctx.sandboxPolicy.defaultMode`),它**不是**本会话的有效策略。拿它当事实,就会在
   * danger-full-access 的会话里谎报 workspace-write,并把接管永久锁死。
   * 有效策略必须逐会话问 `ctx.sandboxPolicy.resolve({ session })`(见 sandboxGate)。
   */
  const readService = (name) => {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }
  const shellCapability = () => {
    const shell = readService('shell')
    if (!shell) return { present: false, capable: false, defaultMode: '' }
    let mode = ''
    try {
      if (typeof shell.sandboxMode === 'string') mode = shell.sandboxMode
    } catch {}
    let ownPolicy = null
    try {
      ownPolicy = shell.sandboxPolicy
    } catch {}
    const ownMode = ownPolicy && typeof ownPolicy.mode === 'string' ? ownPolicy.mode : ''
    return { present: true, capable: Boolean(ownMode) || Boolean(mode), defaultMode: mode || ownMode }
  }

  /**
   * 本会话的沙箱事实(每次现算 —— 策略会变,不能缓存成全局布尔)。
   *
   *   capable  = 宿主执行器会围栏(能力位)
   *   confined = 本会话**真的**被围栏:true/false 来自 sandboxPolicy.resolve;
   *              null = 没有会话 / 策略服务缺失 → 按「有围栏」保守处理,绝不猜成无围栏
   *   mode     = 有效策略(danger-full-access = 这一单不受围栏约束)
   *
   * 只有 `confined === true` 才会拦住 EnvDock 自己的 spawn;`capable` 单独拿出来,
   * 只用于「面板要不要提沙箱」「委托执行可不可用」这类判断。
   */
  const resolveSessionMode = (agent) => {
    const policy = readService('sandboxPolicy')
    const session = agent && agent.session
    let mode = ''
    let policyKnown = false
    if (policy && typeof policy.resolve === 'function') {
      policyKnown = true
      try {
        mode = String((policy.resolve(session ? { session } : {}) || {}).mode || '')
      } catch {
        mode = ''
        policyKnown = false
      }
      // 成功返回但 mode 不在闭集里 = 策略服务异常:按「不可知」保守处理,绝不回落到部署默认档
      // (回落到默认档会让围栏会话被 EnvDock 当无围栏直接 spawn,绕过沙箱)。
      if (policyKnown && !SANDBOX_MODES.has(mode)) {
        mode = ''
        policyKnown = false
      }
    }
    return { mode, policyKnown, policyService: Boolean(policy) }
  }
  const sandboxGate = (agent, options) => {
    const cap = shellCapability()
    const opts = options || getState().options
    const delegate = opts.sandboxTakeover !== 'refuse'
    const resolved = resolveSessionMode(agent)
    if (!cap.capable) {
      // 没有 ctx.shell 或没有 sandboxPolicy 服务:这个部署没有可解析的围栏策略,
      // 才能安全地说 confined:false;有策略服务但解析失败时保持 null(保守)。
      if (!cap.present) return { capable: false, confined: false, mode: '', policyKnown: resolved.policyKnown, delegate }
      if (!resolved.policyService) return { capable: false, confined: false, mode: '', policyKnown: false, delegate }
      // 有执行器、有策略服务但没公布能力位:策略可知时按策略;不可知时保持 null,
      // 以前这里压成 false → 策略不可知的会话会直接 spawn,绕过可能存在的围栏。
      if (!resolved.policyKnown) return { capable: false, confined: null, mode: '', policyKnown: false, delegate }
      if (resolved.mode && resolved.mode !== 'danger-full-access') {
        return { capable: false, confined: true, mode: resolved.mode, policyKnown: true, delegate }
      }
      return { capable: false, confined: false, mode: resolved.mode, policyKnown: true, delegate }
    }
    // 策略不可知时绝不拿部署默认档冒充本会话结论(两个方向都危险)。
    if (!resolved.policyKnown) return { capable: true, confined: null, mode: '', policyKnown: false, delegate }
    const mode = resolved.mode
    const confined = agent ? mode !== 'danger-full-access' : null
    return { capable: true, confined, mode, policyKnown: true, delegate }
  }
  /**
   * 作用域 → agent 的索引。systemPrompt.context 早于接管 effect 注册,而简报要按会话
   * 说真话(这个会话有没有围栏、宿主工具是不是它实际能用的那个),所以索引放在 apply 层,
   * 由接管 effect 在 addScope/dropScope 里维护。查不到就返回 null —— 简报降级成
   * 「能不能调以工具表为准」,绝不猜。
   */
  const scopeAgents = new Map()
  const agentOfScope = (scope) => (scope && scopeAgents.get(scope)) || null
  /** 全局可见性探针(与 hasTool 同一个口径,不带作用域):API 路径用它 */
  const probeVisible = (name) => {
    try {
      const tools = readService('tools')
      return Boolean(tools && typeof tools.get === 'function' && tools.get(name))
    } catch {
      return false
    }
  }

  // 1) 环境简报作为运行上下文(每步重新求值,环境变了立即生效)
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt && typeof systemPrompt.context === 'function') {
    ctx.effect(
      () =>
        systemPrompt.context({
          name: 'envdock',
          order: 900,
          // 按**本会话**求值:同一台机器上,一个会话可能 danger-full-access(EnvDock 接管),
          // 另一个会话 workspace-write(保留宿主工具)。简报必须说这个会话的实话。
          text: (context) => {
            if (settings.injectBrief === false) return ''
            const state = getState()
            // 归一化之后只会是布尔:消费端一律 === true(以前 Boolean("false") 之类的值会把简报悄悄打开)
            if (state.options.injectBrief !== true) return ''
            if (cache.value) {
              const agent = agentOfScope(context && context.scope)
              return brief(
                cache.value,
                state,
                {
                  visible: (name) => hasTool(agent ? agent.ctx : ctx, name, agent || undefined),
                  gate: () => sandboxGate(agent, state.options),
                  // 简报要按**这个会话**报「模型手里是哪个宿主工具」:router 把 agent id 带进去,
                  // brief 再查 scopeToolFacts(同一台机器上可以同时挂着 pwsh 和 ops_bash)。
                  agentId: agent ? String(agent.id) : '',
                },
                rt,
              )
            }
            // 首次尚未探测:后台预热,本次给一句占位
            getDetection(false).catch(() => {})
            return '## 本机环境 (EnvDock)\n- 正在探测本机工具链,首次几秒内完成;需要精确路径时调用 envd 工具(不要用 where/which 反复试探)。'
          },
        }),
      'envdock brief',
    )
  }

  // 2) envd 工具
  if (ctx.get('tools')) {
    ctx.effect(
      () =>
        ctx.tools.register(
          envdTool(
            ctx,
            getDetection,
            getState,
            false,
            probeVisible,
            rt,
            (agent) => sandboxGate(agent),
            (agent, name) => hasTool(agent ? agent.ctx : ctx, name, agent),
          ),
          'envdock tool',
        ),
      'envdock tool',
    )
  }

  // 3) 默认终端接管。
  //
  // 通用的关键:不假设「宿主自带的命令工具叫 pwsh」。在运行时把 [pwsh, powershell, cmd,
  // bash, sh, zsh, fish] 挨个查一遍,谁在(含 agent 作用域里的),宿主就是哪个家族。
  //   · 默认终端与宿主同族 → 什么都不做(不重复造工具、不遮挡)
  //   · 不同族 / 总是接管 → 注册一个**固定名字**的 envd_shell,再遮挡宿主自带的那些 shell
  //   · 注册失败 → 绝不遮挡(否则模型一个命令工具都不剩)
  //
  // 两个不变量(这个插件最贵的教训):
  //   A. 任何时刻都至少有一个命令工具可见 —— 先建后拆,失败就保留旧的。
  //   B. 稳态 tick 对注册表零动作 —— 签名一致就直接返回,连 register / restrict 都不碰。
  const toolsOf = (context) => {
    try {
      return context && typeof context.get === 'function' ? context.get('tools') : undefined
    } catch {
      return undefined
    }
  }
  /**
   * 某个作用域里有没有这个工具。
   * 注意 `tools.get(name)` 是**全局视图**:preset 把 shell 工具注册在 agent 作用域里,
   * 不传 agent 当 scope 就永远查不到(会误判成「宿主没有命令工具」)。
   *
   * 有 agent 作用域时优先问 `tools.executable(name, agent)`(dsh-ops 的口径):
   * 「注册了」不等于「这一单能调」—— ptc 模式下模型直呼只允许 run_code,
   * 拿 get 判会把一个调不了的替代工具当成就绪,于是把真正能用的宿主工具藏掉。
   * 旧宿主没有 executable → 回落 get;全局视图(agent 省略)也走 get。
   */
  const hasTool = (context, name, agent) => {
    const tools = toolsOf(context)
    if (!tools) return false
    if (agent && typeof tools.executable === 'function') {
      try {
        return Boolean(tools.executable(name, agent))
      } catch {}
    }
    if (typeof tools.get !== 'function') return false
    try {
      return Boolean(tools.get(name, agent))
    } catch {
      return false
    }
  }
  /** 这个作用域里登记的对象是不是**我们亲手注册**的那一份(登记身份,不是名字)。 */
  const isOwnDefinition = (context, agent) => {
    const tools = toolsOf(context)
    if (!tools || typeof tools.get !== 'function') return false
    try {
      const current = tools.get(ENVD_SHELL_NAME, agent)
      if (!current) return false
      // 没有登记身份时不能「信名字」:agent 层同名工具会被误当成我们的 → 去挡宿主 → 零工具。
      return rt.ownDefinition ? current === rt.ownDefinition : false
    } catch {
      return false
    }
  }

  /** 接管的命令工具执行时读这个 ref:切终端只换它,注册表一个字节都不动。 */
  const activeShell = { current: null }

  ctx.effect(() => {
    let disposeTool = null
    /**
     * disposeTool 是不是**我们自己** register 出来的。
     * 注册表里出现同名工具不代表是我们的 —— 别的插件也可能叫 envd_shell,
     * 那种情况下绝不能当成「已接管」去遮挡宿主:那会把模型唯一的命令工具挂在别人的生命周期上。
     */
    let ownRegistered = false
    /**
     * 我们这份注册的「代次」:每次注册 / 拆掉自己的工具都 +1。
     * ownProbeOf 的缓存带着它,注册表被我们动过之后缓存自动失效 —— 否则
     * 「先建后拆」那一轮里,建之前探到的「看不见」会被同 tick 晚些的 publishScopeFacts 复用,
     * 面板就会晚一个 tick 才说「已接管」。
     */
    let ownEpoch = 0
    /**
     * 「已应用状态」的签名。稳态 tick 靠它一眼判定「什么都没变」→ 零 register / 零 dispose / 零 deny。
     * 注意它必须和记账字段(名字 / 归属 / 遮挡掩码)**分开**存:以前把
     * `sigBase + '|' + chosenName + '|own'` 存进 appliedSig、却拿裸 sigBase 去比,
     * 于是永远不相等 → 每 5 秒拆一次建一次 → 模型正好落在空窗里就是 unknown tool。
     */
    let appliedSig = ''
    let appliedDenyKey = ''
    let appliedOwned = false
    /** 失败后的重试门槛:名字被占这类问题不会下一个 tick 就好,别每 5 秒刷一遍同样的日志 */
    let retryAt = 0
    /** 正在等新探测落地(避免 sync → 刷新 → sync 自己咬自己) */
    let refreshing = false
    /** 本代实例是否已卸载:卸载之后任何回调都不许再动注册表(否则会留下「幽灵工具」,
     *  它占着固定名,下一次启用永远被判成「已被其它插件占用」,接管再也起不来)。 */
    let stopped = false
    /**
     * 正在动注册表(register / restrict)。这期间宿主会同步派发 `tools/change`,
     * 我们不希望自己的变更再触发一轮对账 —— dsh-ops 用 withToolChange 做同样的归属,
     * 这里用同步标志实现:对账本身是同步的,窗口足够。
     */
    let mutating = false
    /** 事件驱动对账的合并定时器(宿主一次注册会连发多枚 tools/change) */
    let pendingSync = null
    /** 对账进行中收到的外部 tools/change:结束后补排一次,不能丢 */
    let pendingAfterMutate = false
    /** sync 定义完成之前,agent/created 用这个立即补账;定义完成之后走同步补账,不再等 250ms */
    let kickSync = null
    /** agent 补账的定时器:卸载时必须一起清掉 */
    const scopeTimers = new Set()
    const scopes = new Map() // agentId -> { agent, actx, denyKey, denyBlockedKey, disposers }
    const cleanups = []

    const addScope = (agent) => {
      if (stopped) return
      if (!agent || !agent.id || !agent.ctx) return
      if (scopes.has(agent.id)) return
      // badNames 是**作用域私有**的:一个作用域挡不掉的名字(作用域私有 shell),
      // 在别的作用域里往往挡得掉 —— 记到全局就等于让那边永久漏挡。
      scopes.set(agent.id, {
        agent,
        actx: agent.ctx,
        denyKey: '',
        denyBlockedKey: '',
        disposers: [],
        /** 挡不掉的宿主 shell:name → 到期重试时刻(不是永久判死) */
        badNames: new Map(),
        /**
         * **结构性**挡不掉的名字:restrict 的 restrictableNames 只有继承面,作用域私有注册
         * 永远挡不掉。这类名字重试也没用,给长 TTL(10 分钟)且**不写 lastError** ——
         * 以前 30 秒重试一次、每次失败写一条红色「遮挡失败」,面板就每 30 秒闪一次红。
         */
        hardNames: new Map(),
        hostSeen: new Set(),
        /** 过渡性缺名:name → 允许重试的时刻(不进 badNames,不给名字「永久判死」) */
        missNames: new Map(),
        /** restrict 先落地再抛错 → deny 生效但撤销句柄丢失(无主 deny,撤不掉) */
        lostDenies: new Set(),
        /** 计划要藏自己、restrict 也推了却仍可见(agent 层同名)时记的 planKey,避免每 tick 重试 */
        ownHideFailedKey: '',
        /**
         * 同一 tick 内「envd_shell 可见吗 / 是不是我们登记的那一份」的探针缓存(见 ownProbeOf)。
         * 计划、遮挡、事实三处以前各探一遍,现在同 tick 只问一次。
         */
        ownProbe: null,
        /** 本 tick 的 definitions 快照(= 该作用域此刻可见的工具名),liveHostNames / 事实复用 */
        defsSet: null,
        defsStamp: -1,
        /**
         * 遮挡账本在本 tick **真的动过**(denyScopes 推了 restrict / 放开了遮挡)。
         * 它同时是 defsSet 复用与 ownProbe 缓存的失效口径:动过就当快照作废,重新探。
         */
        visDirty: -1,
      })
      // 简报按 scope 查 agent(见 agentOfScope):scope key 就是 agent 本身,查不到就降级说真话。
      try {
        scopeAgents.set(agent, agent)
      } catch {}
      // 新 agent 的第一步可能早于下一个 tick,补一次尽快对上(对账本身是幂等的)。
      // 必须包一层箭头:`sync` 是后面才初始化的 const,直接传它的值会踩 TDZ ——
      // 以前就是这么写的:`setTimeout(sync, 250)` 抛 ReferenceError,
      // 被外层的 try/catch 吞掉,于是 `agents.list()` 循环只加了第一个 agent 就中断,
      // 后面每个 agent 都拿不到遮挡(在模型眼里就是同时有两个命令工具)。
      // 定时器还要登记下来:卸载时不清掉,它会在卸载之后把工具重新注册回来(幽灵工具)。
      if (kickSync) {
        // 新 agent 的第一条请求可能早于下一个 tick:补账必须尽快,不能固定等 250ms
        kickSync()
      } else {
        const timer = setTimeout(() => {
          scopeTimers.delete(timer)
          try {
            sync()
          } catch {}
        }, 250)
        scopeTimers.add(timer)
      }
    }
    const dropScope = (id) => {
      const cur = scopes.get(id)
      if (!cur) return
      dropDenies(cur)
      try {
        scopeAgents.delete(cur.agent)
      } catch {}
      scopes.delete(id)
      // 已经销毁的作用域别再挂在诊断里(否则面板会显示一个早就不存在的 agent 或幽灵事实);
      // 不等到下一 tick,免得会话刚关掉面板还显示「它在让路」。
      const gone = String(id)
      const keep = (list) => (Array.isArray(list) ? list.filter((x) => String(x) !== gone) : list)
      syncStats.blockedScopes = keep(syncStats.blockedScopes)
      syncStats.hostOnlyScopes = keep(syncStats.hostOnlyScopes)
      syncStats.scopeAnomalies = keep(syncStats.scopeAnomalies)
      syncStats.sandboxScopes = Array.isArray(syncStats.sandboxScopes)
        ? syncStats.sandboxScopes.filter((scope) => String(scope && scope.id) !== gone)
        : syncStats.sandboxScopes
      if (Array.isArray(rt.scopeToolFacts)) rt.scopeToolFacts = rt.scopeToolFacts.filter((fact) => String(fact.id) !== gone)
    }

    try {
      cleanups.push(ctx.on('agent/created', (payload) => addScope(payload && payload.agent)))
      cleanups.push(
        ctx.on('agent/disposed', (payload) => {
          const agent = payload && payload.agent
          if (agent && agent.id) dropScope(agent.id)
        }),
      )
    } catch (error) {
      console.error('[envdock] 监听 agent 生命周期失败:', error && error.message)
    }
    const agents = ctx.get('agents')
    if (agents && typeof agents.list === 'function') {
      try {
        for (const agent of agents.list()) addScope(agent)
      } catch {}
    }

    /**
     * 遮挡宿主自带的 shell(只挡名字,不删工具)。
     *
     * 三条规则都是踩过的坑:
     *   1. **幂等** —— 掩码没变就什么都不做。以前每 tick 都 drop 再 restrict 一遍,
     *      工具表跟着抖,和「每 5 秒拆一次」是同一个病。
     *   2. **掩码不用「此刻查得到」来算** —— 宿主 shell 是注册在 **agent 作用域**里的,
     *      `tools.get(name)`(全局视图)本来就查不到;而且被我们挡住之后连作用域视图也查不到。
     *      拿它过滤会让掩码忽有忽无 → 5 秒一抖。所以掩码来自「历史上真的见过」的记忆
     *      (rt.seenShells);名字真的没了就让 restrict 自己失败,见下面的降级。
     *   3. **只在自己的工具已经可见之后才挡**(见 reconcile),绝不先挡后建。
     */
    const dropDenies = (cur) => {
      if (cur.disposers && cur.disposers.length) {
        for (const dispose of cur.disposers) {
          try {
            dispose()
          } catch {}
        }
        syncStats.denyDrops += cur.disposers.length
      }
      cur.disposers = []
      cur.denyKey = ''
      cur.denyBlockedKey = ''
    }
    /**
     * 这个作用域实际能挡的掩码:剔掉它自己挡不掉的名字(别的作用域多半挡得掉)。
     * 「挡不掉」只从**实测失败**里认(`restrict` 抛错的那些进 cur.badNames),
     * 不用全局视图去猜 —— 预设在 agent 祖先层注册的 shell 在全局视图里也查不到,
     * 但在 agent 作用域里**挡得掉**(restrict 过滤的是继承面)。
     */
    /** 运行时候选宿主命令工具名:内置名单 + 学到的第三方发布名 + 各作用域见过/运行时记得的。 */
    const shellCandidates = () => {
      const names = new Set(SHELL_TOOL_NAMES)
      for (const name of rt.learnedShells.keys()) names.add(name)
      for (const name of rt.seenShells) names.add(name)
      for (const cur of scopes.values()) for (const name of cur.hostSeen) names.add(name)
      return names
    }

    /**
     * 同一 tick 内「envd_shell 在这个作用域可不可见 / 是不是我们登记的那一份」只问一次。
     *
     * 计划(决定挡不挡宿主)、遮挡对账(scopesSettled)、事实(publishScopeFacts)三处都要问,
     * 以前每处各探一遍(`hasTool` 走 executable,身份走 get)= 每 tick 每作用域 5 次探针。
     * 失效口径:
     *   · `visDirty === 本 tick` —— 本 tick 里遮挡账本真的动过(denyScopes 置位),重新探;
     *   · `ownEpoch` 变了 —— 我们自己的工具被注册 / 拆掉过,重新探。
     * 因此缓存值只可能在「本 tick 什么都没动」时被复用,和现测同义。
     */
    const ownProbeOf = (cur) => {
      const cached = cur.ownProbe
      const fresh = Boolean(cached) && cached.tick === syncStats.ticks && cached.epoch === ownEpoch && cur.visDirty !== syncStats.ticks
      if (fresh) return cached
      const visible = hasTool(cur.actx, ENVD_SHELL_NAME, cur.agent)
      const ours = visible ? isOwnDefinition(cur.actx, cur.agent) : false
      // 探到的值总是落缓存(哪怕本 tick 的遮挡动过):否则脏标记会一直挡住缓存写入,
      // 下一次本 tick 的调用又看到「缓存是上个 tick 的」→ 每 tick 永久重探。
      const value = { tick: syncStats.ticks, epoch: ownEpoch, visible, ours }
      cur.ownProbe = value
      return value
    }

    const maskFor = (cur, names) =>
      names.filter((name) => {
        const now = Date.now()
        // 结构性挡不掉(作用域私有注册):10 分钟内别再试 —— 重试必失败,只会刷红字。
        const hardUntil = cur.hardNames.get(name)
        if (hardUntil !== undefined) {
          if (hardUntil > now) return false
          cur.hardNames.delete(name)
        }
        const until = cur.badNames.get(name)
        if (until !== undefined) {
          // 挡不掉不是「永久判死」:30 秒后重试一次(publication reentry / 临时拒绝会自愈)
          if (until > now) return false
          cur.badNames.delete(name)
        }
        const retryAt = cur.missNames.get(name)
        if (retryAt !== undefined) {
          if (retryAt > now) return false
          cur.missNames.delete(name)
        }
        return true
      })
    /** 一份作用域计划的幂等键:宿主掩码 + 是否藏我们自己的工具。 */
    const planKey = (entry) => (entry.hideOwn ? 'own|' : '') + entry.mask.join(',')

    /**
     * 把每个作用域的命令工具终局写进运行态,供 /envdock-api 的 commandTool.scopes 端出去。
     *
     * 为什么必须在**作用域**这一层回答:同一进程里可以同时有
     *   · danger-full-access 会话 → EnvDock 直连接管(模型用 envd_shell);
     *   · 宿主 shell 作用域私有的会话 → 让路(模型用宿主的 shell);
     *   · workspace-write 围栏会话 → 沙箱让路(模型用宿主带围栏的 shell)。
     * 面板头部只看全局 commandTool.visible,就会同时说「已接管」和「有个会话在用宿主工具」。
     *
     * 终局以**实际生效的账本**为准(cur.denyKey 记的是 restrict 真成功了什么):
     * plan 只是意图,restrict 失败时不能拿意图充数,否则面板会谎报「已挡住」。
     * 四种 kind:
     *   · takeover     藏了宿主 shell、留着 envd_shell;
     *   · yield        宿主 shell 作用域私有挡不掉,EnvDock 藏自己的、让路;
     *   · sandbox-host 本会话被围栏,EnvDock 藏自己的、用宿主带围栏的 shell;
     *   · host         没有接管(关闭 / 无需接管 / 注册失败),模型用宿主工具。
     */
    const publishScopeFacts = (plan) => {
      const entries = Array.isArray(plan) ? plan : []
      const byId = new Map()
      for (const entry of entries) byId.set(String(entry.cur.agent.id), entry)
      const candidates = shellCandidates()
      const facts = []
      for (const cur of scopes.values()) {
        const id = String(cur.agent.id)
        const entry = byId.get(id) || null
        const gate = (entry && entry.gate) || sandboxGate(cur.agent)
        const hideOwnPlanned = Boolean(entry && entry.hideOwn)
        const yieldHost = Boolean(entry && entry.yieldHost)
        const appliedMask = String(cur.denyKey || '').replace(/^own\|/, '').split(',').filter(Boolean)
        // ── 可见性一律现测:计划与账本都可能与工具表不一致 ──
        // (自己本来就不可见 / restrict 返回成功但 agent 层同名仍可见 / 别的插件短暂遮住)
        // 名字可见 ≠ 是我们的:同名工具被别的层盖住时,不能对自己说「已接管」。
        // 同 tick 内这三件事只问一次(见 ownProbeOf):遮挡动过 / 我们的工具注册过就自动重探。
        const own = ownProbeOf(cur)
        const ownNameVisible = own.visible
        const ownOurs = own.ours
        const ownVisible = ownOurs
        const visibleHosts = []
        const reuseSnapshot =
          cur.defsSet instanceof Set && cur.defsStamp === syncStats.ticks && cur.visDirty !== syncStats.ticks
        if (reuseSnapshot) {
          for (const name of candidates) {
            if (name !== ENVD_SHELL_NAME && cur.defsSet.has(name)) visibleHosts.push(name)
          }
        } else {
          for (const name of candidates) {
            if (name === ENVD_SHELL_NAME) continue
            try {
              if (hasTool(cur.actx, name, cur.agent)) visibleHosts.push(name)
            } catch {}
          }
        }
        visibleHosts.sort()
        // 终局按「此刻实际能不能用」推导,不按 denyKey 的意图推导:
        // 真机上出现过「事实说 host,模型手里却是 envd_shell」—— 账本里没有 deny,
        // 但 envd_shell 明明可见,而宿主 shell 其实调不到。
        const kind = ownVisible ? 'takeover' : hideOwnPlanned ? (yieldHost ? 'yield' : 'sandbox-host') : 'host'
        const hidden = appliedMask.filter((name) => cur.hostSeen.has(name) && !visibleHosts.includes(name))
        const leaked = appliedMask.filter((name) => visibleHosts.includes(name))
        const hostTool = visibleHosts[0] || null
        const tool = kind === 'takeover' ? ENVD_SHELL_NAME : hostTool
        // 异常 = 这个会话实际拿不到命令工具 / 拿到两个 / 挡了却仍可见 / 名字在但不是我们的。
        const anomaly =
          (!ownVisible && !hostTool) ||
          (ownVisible && visibleHosts.length > 0) ||
          leaked.length > 0 ||
          (ownNameVisible && !ownOurs)
        facts.push({
          id,
          kind,
          tool,
          // 逐会话的宿主工具:简报按它说语法、面板按它说「模型实际拿到的是谁」。
          // 不能用全局 shippedName —— 同一台机器可能同时挂着官方 pwsh 和 dsh-ops 的 ops_bash。
          hostTool,
          hostTools: visibleHosts,
          ownVisible,
          ownNameVisible,
          ownOurs,
          hideOwnPlanned,
          visible: kind === 'takeover' ? ownVisible : Boolean(hostTool),
          hidden,
          leaked,
          hidesOwn: hideOwnPlanned && !ownVisible,
          // 三态:true=确定围栏 / false=确定无围栏 / null=策略不可知。压成 false 会让面板
          // 把「不可知」说成「确定无围栏」,把保守隐藏说成设计底态。
          confined: gate.confined === true ? true : gate.confined === false ? false : null,
          policyKnown: gate.policyKnown === true,
          mode: String(gate.mode || ''),
          anomaly,
        })
      }
      rt.scopeToolFacts = facts
      // ── 诊断字段从实际事实推导,不用计划意图 ──
      // 计划说「藏了」但 restrict 没生效(或自己本来就不可见)时,不能把这些会话算成沙箱让路。
      syncStats.hostOnlyScopes = facts.filter((fact) => fact.kind === 'yield').map((fact) => fact.id)
      syncStats.sandboxHiddenScopes = facts.filter((fact) => fact.kind === 'sandbox-host').length
      syncStats.scopeAnomalies = facts.filter((fact) => fact.anomaly).map((fact) => fact.id)
      // 面板上的「已遮挡」只报**所有会话都看不见**的名字:
      // 一个作用域挡不掉(bash 仍可见)时,不能对面板谎称「已挡住 bash」。
      const knownHosts = new Set()
      const visibleHosts = new Set()
      for (const fact of facts) {
        for (const name of fact.hostTools) {
          knownHosts.add(name)
          visibleHosts.add(name)
        }
        for (const name of fact.hidden) knownHosts.add(name)
      }
      rt.denyNames = [...knownHosts].filter((name) => !visibleHosts.has(name)).sort()
    }

    /**
     * 按**每个作用域**自己的计划遮挡。
     *
     * 任何作用域都不会落到「零命令工具」:
     *   · 本会话没有围栏 → 藏宿主的 shell,留 envd_shell;
     *   · 本会话被围栏   → 藏 envd_shell,留宿主的 shell(模型用带围栏的那个);
     *   · 宿主的某个 shell 挡不掉 → 藏 envd_shell,同时挡住本作用域挡得掉的其它宿主 shell,
     *     留那个挡不掉的(让路)。
     *
     * 规则照旧三条(幂等 / 掩码不按「此刻查得到」算 / 先建后挡),再加一条:
     * 藏自己之前必须先确认自己真的在,藏别人之前必须先确认自己真的可见。
     */
    const denyScopes = (plan) => {
      const entries = Array.isArray(plan) ? plan : []
      const byId = new Map()
      for (const entry of entries) byId.set(String(entry.cur.agent.id), entry)
      for (const cur of scopes.values()) {
        // 计划里没有这个作用域 = 它不该有任何遮挡(teardown / liftDenies 走这条),
        // 所以这里必须遍历**全部作用域**,不能只遍历 plan —— 否则放开遮挡会变成空操作。
        const entry = byId.get(String(cur.agent.id)) || { cur, mask: [], hideOwn: false }
        const mask = entry.mask
        const hideOwn = Boolean(entry.hideOwn)
        const key = planKey(entry)
        if (cur.denyKey === key) {
          if (!mask.length && !hideOwn) cur.denyBlockedKey = ''
          continue
        }
        dropDenies(cur)
        cur.visDirty = syncStats.ticks
        if (!mask.length && !hideOwn) continue
        const tools = toolsOf(cur.actx)
        if (!tools || typeof tools.restrict !== 'function') continue
        const visibleOwn = hasTool(cur.actx, ENVD_SHELL_NAME, cur.agent)
        if (visibleOwn && cur.ownHideFailedKey) cur.ownHideFailedKey = ''
        let ownHidden = false
        if (hideOwn) {
          // 沙箱/让路会话:把我们的工具从模型视野里拿掉。
          // **只有真的推了 restrict 且复读确认看不见**,才记「已藏」。
          // 以前「本来就看不见」也记成已藏 → 别人一放开,围栏会话里 envd_shell 复活(绕过沙箱),
          // 而且 scopesSettled 跳过 hideOwn 复检,永远不自愈。
          if (!visibleOwn) {
            ownHidden = false
          } else {
            try {
              cur.disposers.push(tools.restrict({ deny: [ENVD_SHELL_NAME] }))
              syncStats.denyApplies++
              syncStats.ownHides++
              ownHidden = !hasTool(cur.actx, ENVD_SHELL_NAME, cur.agent)
              if (!ownHidden) syncStats.denyNoops++
            } catch {
              ownHidden = false
            }
            if (!ownHidden) cur.ownHideFailedKey = key
          }
        }
        let appliedMask = []
        if (mask.length) {
          // 自己不可见、且没有让路(藏自己)计划时才绝不挡宿主:
          // 那一步会变成「宿主的被挡住、我们的又看不见」= 零命令工具。
          // 让路计划里挡的是「能挡的其它宿主 shell」,本来就要留挡不掉的那个,不存在零工具。
          if (!ownHidden && !visibleOwn && !hideOwn) {
            cur.denyBlockedKey = key
            cur.denyKey = ''
            continue
          }
          const stillVisible = (name) => {
            try {
              return Boolean(hasTool(cur.actx, name, cur.agent))
            } catch {
              return false
            }
          }
          // **永远逐个名字 restrict**:批量调用不是原子的 —— 真机上 restrict 会「边加边抛」
          // (dsh-ops 的 publication reentry),中途抛错时已生效的名字连同 disposer 一起丢失,
          // 变成无主 deny:关掉接管/卸载后宿主工具永久隐藏。
          for (const name of mask) {
            // 调用前先记一次可见性:restrict 有可能**先落地再抛错**(dsh-ops 的 publication reentry),
            // 那种情况下 deny 已经生效、disposer 却丢了。用它区分「暂时缺名」与「无主 deny」。
            const wasVisible = stillVisible(name)
            try {
              const disposer = tools.restrict({ deny: [name] })
              // 返回的不是函数 = 拿不到撤销手段,记成无主 deny(不能 push 假 disposer 让 teardown 炸)。
              if (typeof disposer === 'function') cur.disposers.push(disposer)
              syncStats.denyApplies++
              syncStats.hostDenyApplies++
              // restrict 只过滤**继承面**:agent 自己层注册的同名工具挡不掉,restrict 也不报错。
              // 成功返回后复读;仍可见 = 结构性挡不掉(作用域私有注册),记长 TTL、不刷红字。
              if (stillVisible(name)) {
                syncStats.denyNoops++
                cur.hardNames.set(name, Date.now() + HARD_UNRESTRICTABLE_MS)
              } else {
                appliedMask.push(name)
              }
            } catch (error) {
              const message = String((error && error.message) || error)
              // restrict 直接说「不认识这个全局工具」= 它根本不在继承面(作用域私有注册):
              // 结构性挡不掉,重试无意义。
              if (/unknown global tool/i.test(message)) {
                cur.hardNames.set(name, Date.now() + HARD_UNRESTRICTABLE_MS)
              } else if (hasTool(cur.actx, name, cur.agent)) {
                // 别的抛错(publication reentry / 临时拒绝):30 秒后重试,如实记一次错误。
                cur.badNames.set(name, Date.now() + 30000)
                setLastError('遮挡 ' + key + ' 失败: ' + message)
              } else if (wasVisible) {
                // 调用前可见、调用后不可见,但调用抛错了 → deny 已生效、disposer 丢失。
                // 这正是「无主 deny」:关掉接管/卸载也撤不掉,宿主工具会永久隐藏。
                // 现在没法回滚(宿主没给撤销句柄),只能记账 + 上屏,别让面板以为一切正常。
                cur.lostDenies.add(name)
                syncStats.lostDenies = [...new Set([].concat(syncStats.lostDenies, name))].sort()
                setLastError('遮挡 ' + name + ' 已生效但撤销句柄丢失(无主 deny): ' + message)
              } else {
                // 名字只是暂时不在(热重载空窗)→ missNames 窗口,别锁死。
                cur.missNames.set(name, Date.now() + 30000)
                syncStats.transientMisses++
                setLastError('遮挡 ' + key + ' 失败: ' + message)
              }
            }
          }
          appliedMask = appliedMask.filter((name) => !cur.badNames.has(name) && !cur.hardNames.has(name))
        }
        // 记的是「这个作用域真正生效的」计划:稳态判定要和它对得上,否则每 tick 重试。
        // hideOwn 计划下「本来就不见」也记 own|:现在 scopesSettled 会复检「又可见了就重挂」,
        // 记账不再有「永久漏藏」风险;不记反而会让账本每 tick 对不上(每 tick 完整对账/重挂掩码)。
        cur.denyKey = (hideOwn && (ownHidden || !visibleOwn) ? 'own|' : '') + appliedMask.join(',')
        cur.visDirty = syncStats.ticks
      }
      const scopeList = [...scopes.values()]
      // 挡不掉的按作用域记,诊断只做并集(别当成全局黑名单用)。
      // badNames = 临时挡不掉(30 秒重试);hardNames = 结构性挡不掉(10 分钟重试)。
      // 两者都算「挡不掉」:模型手里的命令工具会与 envd_shell 并存,面板要能解释。
      const bad = new Set()
      const nowBad = Date.now()
      for (const cur of scopeList) {
        for (const [name, until] of cur.badNames) {
          if (until > nowBad) bad.add(name)
          else cur.badNames.delete(name)
        }
        for (const [name, until] of cur.hardNames) {
          if (until > nowBad) bad.add(name)
          else cur.hardNames.delete(name)
        }
        for (const [name, until] of cur.missNames) {
          if (until <= nowBad) cur.missNames.delete(name)
        }
      }
      syncStats.unrestrictable = [...bad].sort()
      // 「哪些作用域因为看不到我们自己的工具而没遮挡」单独记账:
      // 放 lastError 里会永远粘着(稳态 tick 不会再算一次),面板就会一直报红。
      const blockedNow = []
      for (const cur of scopeList) {
        if (cur.denyBlockedKey) blockedNow.push(String(cur.agent.id))
      }
      syncStats.blockedScopes = blockedNow
      // hostOnlyScopes / sandboxHiddenScopes / denyNames 由 publishScopeFacts 从**实际事实**推导:
      // 计划说让路不等于真的让路了(restrict 可能失败),拿意图当事实会谎报。
    }
    const liftDenies = () => denyScopes([])
    /** 每个作用域都按当前计划对完账了吗(含「已判定挡不了」的作用域) */
    const scopesSettled = (plan) => {
      for (const entry of Array.isArray(plan) ? plan : []) {
        const cur = entry.cur
        const mask = entry.mask
        const key = planKey(entry)
        // 同 tick 内可见性只探一次:计划里已经问过,这里复用(遮挡动过会自动重探)
        const visible = ownProbeOf(cur).visible
        // hideOwn 的作用域必须复检「藏还在不在」:
        //   · 计划要藏、此刻却可见 → 账本作废,下一轮重挂(否则围栏会话里我们的工具复活 = 绕过沙箱);
        //   · restrict 推了仍可见(agent 层同名) → 记 ownHideFailedKey,别每 tick 重试(防抖)。
        if (entry.hideOwn) {
          if (!visible) {
            if (cur.ownHideFailedKey === key) cur.ownHideFailedKey = ''
            continue
          }
          if (cur.denyKey === key && cur.denyKey.startsWith('own|')) {
            dropDenies(cur)
            return false
          }
          if (cur.ownHideFailedKey === key) continue
          return false
        }
        // 已遮挡的作用域也要复检「我们的工具还在不在」:它一旦不可见,这个作用域就是
        // 「宿主的被挡住 + 我们的看不见」= 零命令工具。立刻把宿主的还回去,记进 blockedScopes。
        if (mask.length && !visible && cur.denyKey === key) {
          dropDenies(cur)
          cur.denyBlockedKey = key
          return false
        }
        if (cur.denyKey === key) continue
        // 「已判定挡不了」的作用域要复探一次:别的插件/preset 可能只是短暂遮了 envd_shell,
        // 直接按结论永久跳过的话,这个作用域就永久漏挡 —— 症状和「新 agent 不被遮挡」一模一样。
        // 复探成本只有一个作用域一次 hasTool;真的一直看不见也不会去 restrict(不会抖)。
        if (cur.denyBlockedKey === key && !visible) continue
        return false
      }
      return true
    }

    /**
     * 拆掉接管。
     *
     * 顺序是「先放开宿主自带的 shell,再拆我们自己的工具」——
     * 反过来的话中间会有一瞬间「我们的工具已经没了、宿主的还被遮挡」,
     * 那一瞬间模型一个命令工具都没有,正好落进去的步骤只能收到 UNKNOWN_TOOL。
     */
    const teardown = () => {
      liftDenies()
      if (disposeTool) {
        try {
          disposeTool()
        } catch {}
        disposeTool = null
        syncStats.disposes++
        ownEpoch++
      }
      ownRegistered = false
      appliedOwned = false
      appliedSig = ''
      appliedDenyKey = ''
      // 运行态是本实例独占的(见 createRuntime):这里照清不误,不必担心踩到别的实例
      rt.toolName = null
      rt.owns = false
      rt.reuse = false
      rt.denyName = null
      rt.denyNames = []
      rt.toolVisible = false
      // 逐会话终局一起清:卸载/teardown 之后还挂着「某会话用 envd_shell」就是幽灵事实
      rt.scopeToolFacts = []
    }

    /**
     * 我们自己的固定名工具此刻是否真的在工具表里。
     * 本地还留着 disposer 但注册表里查不到时(热重载 / 被别的插件顶掉),作废本地句柄重来。
     */
    const ownToolReady = () => {
      if (!ownRegistered) return false
      // 登记身份,不只是名字:同名工具被别人顶掉时,「名字还在」不代表「还是我们那一份」。
      if (isOwnDefinition(ctx, undefined)) return true
      if (disposeTool) {
        try {
          disposeTool()
        } catch {}
        disposeTool = null
        syncStats.disposes++
        ownEpoch++
      }
      ownRegistered = false
      appliedOwned = false
      rt.ownDefinition = null
      return false
    }

    /**
     * 注册固定名工具并**验证它真的可见**。失败返回 false(调用方据此绝不遮挡宿主的那个)。
     *
     * 顺序也重要:已注册且可见时直接返回 true,稳态 tick 连 ctx.tools.register 都不碰。
     */
    const ensureOwnTool = () => {
      if (ownToolReady()) return true
      // 工具表里已经有同名工具,但不是我们注册的:不认领、也不遮挡宿主(认领了就等于把
      // 模型唯一的命令工具挂在别人的生命周期上)
      if (hasTool(ctx, ENVD_SHELL_NAME)) {
        rt.retryReason = 'taken'
        setLastError(ENVD_SHELL_NAME + ' 已被其它插件占用,EnvDock 不接管命令工具')
        return false
      }
      let dispose = null
      const definition = commandTool(
        ctx,
        activeShell,
        // 每一单都按**本会话**有效策略复检(不缓存全局布尔)
        (agent) => sandboxGate(agent),
        // 委托执行要知道**宿主执行器**(ctx.shell)的语法族,它决定包装串怎么写。
        // 绝不能按「宿主命令工具名」猜:Windows 官方 base 挂的是 pwsh-sandbox(PowerShell),
        // 而模型手里的工具可能是 dsh-ops 的 ops_bash(bash)—— 用 bash 包装器交给 PowerShell
        // 执行必然 ParserError,命令根本没跑。族未知时返回 '' → 拒绝委托,不冒险。
        () => {
          const executor = executorFamily()
          if (!executor.family) return ''
          if (executor.family !== 'powershell' && executor.family !== 'bash') return ''
          return executor.family
        },
        // 诊断计数(委托次数等):commandTool 在模块级,拿不到 syncStats,这里显式传进去
        syncStats,
      )
      syncStats.registerTries++
      try {
        dispose = ctx.tools.register(definition)
      } catch (error) {
        // 同层重名 / 保留名:注册不上就只能让宿主自带的继续干活
        setLastError('注册 ' + ENVD_SHELL_NAME + ' 失败: ' + ((error && error.message) || error))
        console.error('[envdock] 注册命令工具 ' + ENVD_SHELL_NAME + ' 失败:', error && error.message)
        return false
      }
      if (typeof dispose !== 'function') {
        setLastError('注册 ' + ENVD_SHELL_NAME + ' 没有返回 disposer')
        return false
      }
      // 「注册成功」不等于「模型看得见」:注册完立刻验一次 —— 但**只按全局可见性**判定。
      // 以前拿「每个 agent 作用域都看得见」当门槛:一个作用域看不到就把刚注册的工具拆掉,
      // 结果是本来正常的作用域也跟着失去命令工具(而且那个作用域本来就不该被遮挡)。
      // 各作用域的可见性由 denyScopes 逐个处理,这里只回答「工具注册上了没有」。
      // 再验一次**登记身份**(dsh-ops 的 publication ownership):名字对、对象不对,
      // 说明它已被别的层盖住,那就不是我们的工具,不能去挡宿主。
      let registered = null
      try {
        const tools = toolsOf(ctx)
        registered = tools && typeof tools.get === 'function' ? tools.get(ENVD_SHELL_NAME) : null
      } catch {}
      if (!registered) {
        try {
          dispose()
        } catch {}
        syncStats.disposes++
        setLastError(ENVD_SHELL_NAME + ' 注册成功但工具表里查不到')
        return false
      }
      if (registered !== definition) {
        try {
          dispose()
        } catch {}
        syncStats.disposes++
        setLastError(ENVD_SHELL_NAME + ' 同名工具被别的层盖住(登记的已不是我们这一份),EnvDock 不接管')
        return false
      }
      disposeTool = dispose
      ownRegistered = true
      rt.ownDefinition = definition
      rt.ownNames.add(ENVD_SHELL_NAME)
      // 注册表刚变过:同 tick 里之前缓存的「envd_shell 看不见」立刻作废
      ownEpoch++
      syncStats.registers++
      syncStats.lastChosenName = ENVD_SHELL_NAME
      return true
    }

    /**
     * 探测缓存刚被作废(切终端 / 改选项 / 写状态)时,**先等新探测落地再对账**。
     *
     * 以前 writeState 里 invalidateDetection() 之后立刻 sync(),而 sync 读的是旧 cache.value:
     * 先按旧终端算一次账、探测回来又按新终端算一次 —— 一次操作拆建两回。
     */
    const refreshThenSync = () => {
      if (stopped || refreshing) return
      refreshing = true
      // 注意:这里**不能**清 cur.badNames。清掉之后 seenShells 会重新收进那个挡不掉的名字,
      // 而 cur.denyKey 仍然记着「这一串挡过了」→ 守卫直接 continue → 面板显示全挡、实际漏挡。
      // badNames 随作用域/实例生命周期存在,插件重载/重启自然重试。
      getDetection(false).then(
        (value) => {
          refreshing = false
          if (stopped) return
          // detect() 失败会抛错、成功一定返回快照;拿到空值说明调用链被改坏了,别当成功继续对账。
          if (!value) {
            setLastError('探测返回空快照,跳过本轮对账')
            return
          }
          try {
            sync()
          } catch {}
        },
        (error) => {
          refreshing = false
          if (stopped) return
          // 显式记账(而不是静默吞掉):面板要能看出「探测失败」,而不是「没接管」。
          setLastError('探测失败: ' + String((error && error.message) || error))
          // 只有旧快照还在(没被 invalidateDetection 作废,at>0)时才拿它继续对账:
          // at===0 时继续 sync 会立刻再触发一次探测,失败时就是死循环。
          if (cache.value && cache.at > 0) {
            try {
              sync()
            } catch {}
          }
        },
      )
    }

    /**
     * 对账:把「设置 + 当前终端 + 宿主自带 shell」算成一个签名,和已应用状态比。
     * 签名一致 = 稳态 = 一个注册表动作都不做。
     */
    const reconcile = () => {
      syncStats.steadyPrev = syncStats.steadyNow
      // 本轮是否产生了新错误:完整对账成功时,只清「上一轮遗留」的错误,不吞本轮 denyScopes 刚记的。
      const errorAtStart = syncStats.lastErrorAt
      // steadyNow 只代表「本 tick 的结果」;lastError 不在这里清 ——
      // 「名字被占用」这类持续故障每 tick 都会重报,而恢复成功时由下面的稳态分支清掉。
      syncStats.steadyNow = false
      const state = getState()
      const options = state.options || {}
      const mode = TAKEOVER_MODES.includes(options.shellTakeover) ? options.shellTakeover : 'auto'

      // ── 沙箱:能力位 ≠ 本会话有效策略 ──
      // 能力位(capable)回答「这台执行器会不会围栏」;有效策略要逐会话问 sandboxPolicy.resolve。
      // 以前拿部署默认档(shell.sandboxMode)当事实,于是:
      //   · danger-full-access 的会话被谎报成 workspace-write,接管被永久锁死(假阳性);
      //   · 一个会话的策略错误地约束了所有会话(粒度错)。
      const cap = shellCapability()
      rt.sandbox = cap.capable
      rt.sandboxMode = cap.defaultMode
      syncStats.sandboxCapable = cap.capable
      syncStats.sandboxDefault = cap.defaultMode
      const scopeFacts = [...scopes.values()].map((cur) => ({ cur, gate: sandboxGate(cur.agent, options) }))
      syncStats.sandboxScopes = scopeFacts.map(({ cur, gate }) => ({
        id: String(cur.agent.id),
        mode: gate.mode,
        // 三态:null = 策略不可知(不要压成「确定无围栏」)
        confined: gate.confined === true ? true : gate.confined === false ? false : null,
        policyKnown: gate.policyKnown === true,
      }))
      // 只有在没有任何会话**确定无围栏**时,才算「沙箱挡掉了接管」。
      // 不可知(null)不算无围栏 —— 与执行层 gateAt 的保守方向保持一致。
      const anyConfirmedUnconfined = scopeFacts.some(({ gate }) => gate.confined === false)
      // 从事实推导:只有「确实有执行器」且「没有任何会话被证明无围栏」才算沙箱挡住了接管。
      syncStats.sandboxBlocked = cap.present && scopes.size > 0 && !anyConfirmedUnconfined
      const executor = executorFamily()
      syncStats.executorFamily = executor.family
      syncStats.executorFamilySource = executor.source
      const toolsService = readService('tools')
      syncStats.hasExecutableApi = Boolean(toolsService && typeof toolsService.executable === 'function')

      // 只给简报:必须立刻放开,不等探测(GUI 上点了就得马上生效)
      if (mode === 'off') {
        if (appliedSig || disposeTool || rt.owns || appliedDenyKey) {
          teardown()
          syncStats.lastSig = ''
        } else {
          markSteady()
        }
        setLastError(null)
        // 关闭接管之后每个会话都用宿主工具:面板按会话说真话,别留着上一轮「已接管」的终局
        syncStats.unrestrictable = []
        publishScopeFacts([])
        return
      }
      if (!cache.value || cache.at === 0) {
        refreshThenSync()
        return
      }

      const detection = cache.value
      // 执行侧永远读最新终端:切终端到这里就够,工具本身不用重建
      activeShell.current = resolveShell(state, detection)
      const shell = activeShell.current
      rt.family = shell.family

      // 宿主自带的 shell 名字要「记住」:被我们自己遮挡之后 tools.get 就查不到了,
      // 每次重算会得到 null → 放开遮挡 → 又查到 → 再遮挡,5 秒一次来回抖。
      // 但记忆必须**按作用域**:全局记忆会把「只在别的会话里注册的 pwsh」带进这个会话,
      // mask 一旦非空,下面的让路分支就被跳过 → envd_shell 和挡不掉的 ops_bash 同时可见。
      // 所以每个作用域记它自己真的见过的宿主 shell(cur.hostSeen):被挡住之后记忆仍在,
      // 掩码不会忽有忽无;而「没见过」的名字也不会被拿到这里来挡。
      // ── 认宿主命令工具:定义面枚举(能认第三方发布名)+ 按名字探可见性(挡住后靠记忆) ──
      // 候选名单本 tick 只算一次(以前在作用域循环里重建:4 个作用域就是 4 次 new Set() + 4 次全量遍历)。
      // 本 tick 里刚学到的名字按原顺序追加,保持「同一 tick 内后面的作用域也能探到」的旧语义。
      const candidates = [...shellCandidates()]
      const candidateSet = new Set(candidates)
      const addCandidate = (name) => {
        if (!name || candidateSet.has(name)) return
        candidateSet.add(name)
        candidates.push(name)
      }
      // 本 tick 真的看见过的宿主工具名:取代以前 collectShellNames() 的
      // 「全局按名探 8 次 + 每个作用域再按名探 8 次」—— 那是同一批数据探两遍。
      const seenThisTick = new Set()
      // 补丁 B 的兜底节奏:每 12 个 tick 强制逐名现探一轮(同步间隔默认 5s → 60s)。
      // 平时信任本 tick 的 definitions 快照;兜底是为了「定义了但这一单不可执行」这类
      // 快照覆盖不到的边角不会长期漏判(和 dsh-ops 的 ptc 折叠是同一类坑)。
      const forceNameProbe = syncStats.ticks % 12 === 0
      // 全局注册面本 tick 只问一次 definitions(),老宿主(没有这个方法)才回退成按名字探。
      const globalToolsView = toolsOf(ctx)
      let globalDefs = null
      if (globalToolsView && typeof globalToolsView.definitions === 'function') {
        try {
          globalDefs = globalToolsView.definitions() || []
        } catch {
          globalDefs = null
        }
      }
      for (const cur of scopes.values()) {
        const scopeTools = toolsOf(cur.actx)
        if (scopeTools && typeof scopeTools.definitions === 'function') {
          let defs = []
          let defsOk = false
          try {
            defs = scopeTools.definitions(cur.agent) || []
            defsOk = true
          } catch {
            defs = []
          }
          // 本 tick 的可见定义快照:后面 publishScopeFacts / liveHostNames 在同 tick 未被遮挡
          // 改动时直接复用它,避免每 tick 每个会话 ~10 次单点 probe(真实宿主每次 probe 都要重建 view 集合)。
          // 调用抛错的 tick 不落快照(空集合会让依赖它的判断误判「什么都没有」)。
          cur.defsSet = defsOk ? new Set(defs.map((def) => (def && def.name ? String(def.name) : '')).filter(Boolean)) : null
          cur.defsStamp = defsOk ? syncStats.ticks : -1
          for (const def of defs) {
            const name = def && def.name ? String(def.name) : ''
            if (!name) continue
            const family = shellFamilyFromDefinition(def)
            if (!family) continue
            rt.learnedShells.set(name, family)
            rt.seenShells.add(name)
            cur.hostSeen.add(name)
            addCandidate(name)
          }
        }
        // 定义面只看得到「当前可见」的工具(挡住之后就没了),所以再按名字探一遍:
        // 见过的名字留在 hostSeen 里,掩码不会忽有忽无。
        //
        // 补丁 B:本 tick 已经拿到的 definitions 快照就是「此刻可见面」,直接拿它算可见名 ——
        // 真实宿主每次 executable / definitions 都要重建 view 集合,4 个作用域时逐名探是最大的
        // 剩余开销。老宿主(没有 definitions)和每 60s 的兜底轮才退回逐名现探。
        const trustSnapshot = !forceNameProbe && cur.defsSet instanceof Set && cur.defsStamp === syncStats.ticks
        if (trustSnapshot) {
          for (const name of candidates) {
            if (name === ENVD_SHELL_NAME || !cur.defsSet.has(name)) continue
            cur.hostSeen.add(name)
            rt.seenShells.add(name)
            seenThisTick.add(name)
          }
        } else {
          for (const name of candidates) {
            if (name === ENVD_SHELL_NAME) continue
            try {
              if (hasTool(cur.actx, name, cur.agent)) {
                cur.hostSeen.add(name)
                rt.seenShells.add(name)
                seenThisTick.add(name)
              }
            } catch {}
          }
        }
        // 过渡性缺名一旦重新出现就解除重试窗口
        if (cur.missNames.size) {
          for (const name of [...cur.missNames.keys()]) {
            if (hasTool(cur.actx, name, cur.agent)) cur.missNames.delete(name)
          }
        }
      }
      if (globalDefs) {
        for (const def of globalDefs) {
          const name = def && def.name ? String(def.name) : ''
          if (name && candidateSet.has(name)) seenThisTick.add(name)
        }
      } else {
        for (const name of candidates) {
          if (name === ENVD_SHELL_NAME) continue
          try {
            if (hasTool(ctx, name)) seenThisTick.add(name)
          } catch {}
        }
      }
      for (const name of seenThisTick) {
        if (rt.ownNames.has(name)) continue
        rt.seenShells.add(name)
      }
      // 名字集合有界:插件/预设的名字会轮换,只增不减会让每 tick 的候选遍历与 GET 载荷线性膨胀。
      const trimSet = (set) => {
        while (set.size > 64) set.delete(set.values().next().value)
      }
      const trimMap = (map) => {
        while (map.size > 64) map.delete(map.keys().next().value)
      }
      trimSet(rt.seenShells)
      trimMap(rt.learnedShells)
      for (const cur of scopes.values()) trimSet(cur.hostSeen)
      const allHostNames = new Set()
      for (const cur of scopes.values()) for (const name of cur.hostSeen) allHostNames.add(name)
      // 只报「真的见过」的名字(learned / seenShells / 某会话 hostSeen):
      // 从全部内置名起步会把 8 个根本不存在的 shell 说成「已识别」。
      const knownShells = new Set()
      for (const name of rt.learnedShells.keys()) knownShells.add(name)
      for (const name of rt.seenShells) knownShells.add(name)
      for (const cur of scopes.values()) for (const name of cur.hostSeen) knownShells.add(name)
      syncStats.runtimeShellTools = [...knownShells]
        .filter((name) => name !== ENVD_SHELL_NAME)
        .map((name) => ({ name, family: familyOf(rt, name) || 'unknown', learned: rt.learnedShells.has(name) }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      const hostNamesAt = (cur) => [...cur.hostSeen].filter((name) => name !== ENVD_SHELL_NAME).sort()
      // 宿主的「主 shell」按已知顺序优先,再按家族;别拿全局 seenShells 的顺序当事实。
      const shellRank = (name) => {
        const known = SHELL_TOOL_ORDER.indexOf(name)
        if (known >= 0) return known
        return SHELL_TOOL_ORDER.length + (familyOf(rt, name) === 'bash' ? 0 : 1)
      }
      // 「活证」:宿主 shell 必须**此刻真的可见**,或者仍在我们自己的掩码里,才算存在。
      // 只凭记忆(hostSeen/seenShells 只增不减)会让「宿主工具后来消失了」的机器永远判定
      // 「与宿主同族 → 不接管」,最后零命令工具且永不恢复。
      //
      // 本 tick 已经拿到 definitions 快照时就拿它当「此刻可见面」(与 publishScopeFacts 的
      // defsSet 复用同一条口径),不再对 hostSeen / seenShells 逐名现探:
      // 一个作用域 10 个名字就是 10 次 view 重建,而快照是同一份事实。
      const defsCurrent = (cur) => cur.defsSet instanceof Set && cur.defsStamp === syncStats.ticks && cur.visDirty !== syncStats.ticks
      const globalNameSet = globalDefs
        ? new Set(globalDefs.map((def) => (def && def.name ? String(def.name) : '')).filter(Boolean))
        : null
      const liveHostNames = new Set()
      for (const cur of scopes.values()) {
        const known = defsCurrent(cur)
        for (const name of cur.hostSeen) {
          try {
            if (known ? cur.defsSet.has(name) : hasTool(cur.actx, name, cur.agent)) liveHostNames.add(name)
          } catch {}
        }
        const masked = String(cur.denyKey || '').replace(/^own\|/, '')
        if (masked) for (const name of masked.split(',')) if (name) liveHostNames.add(name)
      }
      for (const name of rt.seenShells) {
        try {
          if (globalNameSet ? globalNameSet.has(name) : hasTool(ctx, name)) liveHostNames.add(name)
        } catch {}
      }
      const shippedName =
        [...allHostNames].filter((name) => liveHostNames.has(name)).sort((a, b) => shellRank(a) - shellRank(b))[0] ||
        [...rt.seenShells].filter((name) => liveHostNames.has(name)).sort((a, b) => shellRank(a) - shellRank(b))[0] ||
        null
      rt.shippedName = shippedName
      if (shippedName) rt.everSawHost = true
      const shippedFamily = shippedName ? familyOf(rt, shippedName) : null
      const familyMatches = Boolean(shippedFamily) && shippedFamily === shell.family
      // 等待时机:
      //   · 一个会话都没有 → 注册了也没人用,等;
      //   · 还没**第一次**见过宿主 shell → 给 60s 宽限,别和晚注册的宿主插件抢(抢了会先建后拆);
      //   · 见过之后又消失 → 立刻兜底注册 envd_shell,否则模型零命令工具且永不恢复。
      const waitingFirstSighting =
        !rt.everSawHost && Date.now() - (rt.startedAt || Date.now()) < 60_000
      if (!shippedName && mode !== 'takeover' && (scopes.size === 0 || waitingFirstSighting)) {
        if (appliedSig || disposeTool || rt.owns || appliedDenyKey) teardown()
        else markSteady()
        setLastError(null)
        publishScopeFacts([])
        return
      }

      const wants = Boolean(shell.path) && (mode === 'takeover' || !familyMatches)
      // 沙箱会话不接管:只有「至少一个会话**证明**没有围栏」才值得注册 envd_shell。
      //   · 执行器没有围栏能力(本地执行器)→ 照旧立刻接管;
      //   · 有围栏能力 → 必须先有一个会话 resolve 出 danger-full-access 才接管;
      //     一个会话都没有 / 策略服务缺失时不猜(注册了也是被自己藏起来,还多一次拆建)。
      // 没有执行器(非沙箱部署)才无条件信任无围栏;有执行器时必须先有会话**证明**无围栏。
      const trustedUnconfined = cap.present ? scopeFacts.some(({ gate }) => gate.confined === false) : true
      const takeoverWanted = wants && trustedUnconfined
      // 每个作用域一份计划:
      //   · 有围栏 → 藏我们的、留宿主的;
      //   · 无围栏 → 藏宿主的、留我们的;
      //   · 宿主 shell 在这个作用域**挡不掉**(作用域私有,restrict 实测失败)而且此刻真的还在
      //     → 让路:藏我们自己的、留宿主的(学 dsh-ops:它的 session-shells 按会话挂 ops_bash)。
      // 让路时仍然挡住「本作用域里挡得掉的其它宿主 shell」,模型手里只会剩那个挡不掉的宿主工具。
      // 判据必须是「此刻可见」而不是 badNames 历史:宿主后来撤回了工具,就不能再让路 ——
      // 否则会把模型唯一的命令工具一起藏掉(零命令工具)。
      const plan = scopeFacts.map(({ cur, gate }) => {
        if (!takeoverWanted) return { cur, gate, mask: [], hideOwn: false }
        // 只有**确定无围栏**才去遮宿主。confined=true(确定围栏)当然藏自己;
        // confined=null(策略不可知)同样藏自己 —— 执行层 gateAt 会拒绝我们的工具,
        // 这时再把宿主遮掉就是「零命令工具」。宁可让路,不可两边都不可用。
        if (gate.confined !== false) return { cur, gate, mask: [], hideOwn: true, confinedUnknown: gate.confined === null }
        // 这个作用域里 envd_shell 不是我们登记的那一份(agent 层同名 / 被别的插件顶掉):
        // 绝不去挡宿主 —— 遮掉的是真工具,留下的却可能是别人的同名工具,等于造零工具。
        const ownHere = ownProbeOf(cur)
        if (ownHere.visible && !ownHere.ours) return { cur, gate, mask: [], hideOwn: false }
        const hosts = hostNamesAt(cur)
        const mask = maskFor(cur, hosts)
        // 挡不掉(restrict 实测失败)或认不出家族的宿主工具只要此刻还在,就必须让路:
        // 认不出家族既教不了语法,也保证不了「我们的工具能替代它」。
        const now = Date.now()
        const stuck = hosts.filter((name) => {
          const until = cur.badNames.get(name)
          const locked = until !== undefined && until > now
          return (locked || !familyOf(rt, name)) && hasTool(cur.actx, name, cur.agent)
        })
        if (stuck.length) return { cur, gate, mask, hideOwn: true, yieldHost: true, stuck }
        return { cur, gate, mask, hideOwn: false }
      })
      // 让路 tick 单独计数:稳态时它应该跟着 ticks 涨,而 registers/disposes/denyApplies 一动不动。
      // 一旦这两个数一起涨,就是让路分支在 5 秒一次地拆建工具(模型会撞上 unknown tool 空窗)。
      if (plan.some((entry) => entry.yieldHost)) syncStats.yieldTicks++
      const denyKey = plan.map((entry) => String(entry.cur.agent.id) + ':' + planKey(entry)).sort().join(';')
      const sig = [mode, takeoverWanted ? 'takeover' : 'idle', shell.family, shippedName || ''].join('|')

      // ── 稳态:签名一致 + 账本一致 + 工具还在(每 tick 真查一次工具表) ──
      // 还要保证「每个 agent 作用域都按当前计划对完账」:接管建立之后才出现的会话/子 agent
      // 在 addScope 里是空计划,只看全局签名会把它永远漏掉 —— 那个作用域里模型会同时看到
      // 两个命令工具(宿主的 shell 没被挡 + 我们的 envd_shell),brief 却只说一个。
      const steady = sig === appliedSig && denyKey === appliedDenyKey && rt.owns === appliedOwned
      if (steady) {
        // 走到稳态说明上一轮的问题没有再现(注册成功 / 探测成功 / 遮挡已对账):清掉陈年错误
        setLastError(null)
        if (!appliedOwned) {
          markSteady()
          publishScopeFacts(plan)
          return
        }
        if (hasTool(ctx, ENVD_SHELL_NAME)) {
          rt.toolVisible = true
          if (!scopesSettled(plan)) {
            // 只有遮挡这一步要补:注册表一个字节都不动
            denyScopes(plan)
          }
          markSteady()
          publishScopeFacts(plan)
          return
        }
        // 账本说有、工具表里没有 → 掉下去走完整对账(下面 ensureOwnTool 会补注册)
      }

      if (!takeoverWanted) {
        setLastError(null)
        syncStats.unrestrictable = []
        if (appliedSig || disposeTool || rt.owns || appliedDenyKey) {
          teardown()
          syncStats.lastSig = sig
        } else {
          markSteady()
        }
        publishScopeFacts(plan)
        return
      }

      // 上一次失败还没到重试时间:保持「没有自己的工具」,宿主自带的继续干活。
      // 但两种情况下要立刻重试,不能被固定 30s 锁住:
      //   · 占名的那个工具已经消失(tools/change 会触发对账);
      //   · 本轮对账是 tools/change 事件驱动的(别的插件刚撤销/发布,状态已变)。
      if (retryAt && Date.now() < retryAt) {
        const takenFreed = rt.retryReason === 'taken' && !hasTool(ctx, ENVD_SHELL_NAME)
        if (!takenFreed && !rt.retryNow) {
          markSteady()
          publishScopeFacts(plan)
          return
        }
      }
      retryAt = 0
      rt.retryNow = false
      rt.retryReason = ''
      // lastError 已在 reconcile 开头统一清空(本 tick 的错误本 tick 报,不跨 tick 粘着)

      // ── 先建后拆:新工具没就位(且可见)之前,一个东西都不拆 ──
      if (!ensureOwnTool()) {
        // 注册不上自己的工具,就绝不遮挡宿主的:宿主的那个是模型唯一还能用的命令工具
        liftDenies()
        appliedOwned = false
        appliedSig = ''
        appliedDenyKey = ''
        // 运行态是本实例独占的,直接清;不会影响别的实例(热重载时的新一代有自己的 rt)
        rt.toolName = null
        rt.owns = false
        rt.reuse = false
        rt.denyName = null
        rt.denyNames = []
        rt.toolVisible = false
        syncStats.lastSig = sig
        retryAt = Date.now() + 30000
        // 没接管成功:每个会话都用宿主工具,终局要如实写(不能留上一轮的「已接管」)
        publishScopeFacts(plan)
        return
      }

      // 自己的工具已经在工具表里了 → 现在才可以遮挡宿主的那个
      rt.toolName = ENVD_SHELL_NAME
      rt.owns = true
      rt.reuse = false
      rt.toolVisible = true
      rt.denyName = shippedName && shippedName !== ENVD_SHELL_NAME ? shippedName : null
      // 真正生效的掩码由 denyScopes 按作用域算(它才剔得掉各作用域挡不掉的名字)。
      denyScopes(plan)
      // 遮挡已经落地,现在才把逐会话终局端给面板/API(早一步就是谎报)
      publishScopeFacts(plan)
      // 完整对账成功:上一轮遗留的错误已经恢复,清掉;本轮 denyScopes 刚记的错误保留。
      if (syncStats.lastErrorAt === errorAtStart) setLastError(null)
      appliedOwned = true
      appliedSig = sig
      appliedDenyKey = denyKey
      syncStats.lastSig = sig
      // 注意:这里不再无条件清 lastError —— 上面 denyScopes 可能刚记下「某作用域挡不了」,
      // 清掉就等于把降级诊断吞了。完整对账入口处已经清过一次。
    }

    const sync = () => {
      // 卸载之后任何回调(残留的 agent 补账定时器、探测回调)都不许再动注册表
      if (stopped) return
      syncStats.ticks++
      // 对账期间宿主会同步派发 tools/change:自己的变更不触发新一轮对账(dsh-ops 的归属口径)
      mutating = true
      try {
        reconcile()
      } catch (error) {
        setLastError(String((error && error.message) || error))
        console.error('[envdock] 终端接管对账失败:', error && error.message)
      } finally {
        mutating = false
        syncStats.lastAt = Date.now()
        if (pendingAfterMutate) {
          pendingAfterMutate = false
          scheduleSync()
        }
      }
    }

    /**
     * 工具表变了就立刻对账(合并同一轮变更),不等下一个 5 秒 tick。
     *
     * 这是从 dsh-ops 学的:它监听 `tools/change`(并把自家变更归属到具体作用域),
     * 于是别的插件晚一步发布命令工具时,遮挡不是「最多晚 5 秒」而是立即收敛。
     * 5 秒 tick 仍然保留:它是兜底,也是「宿主的 tools/change 不完整」时的安全网。
     */
    // sync 已就绪:此后 agent/created 立刻补账(排到微任务,避免在事件回调里重入宿主注册流程)
    kickSync = () => {
      queueMicrotask(() => {
        try {
          sync()
        } catch {}
      })
    }
    const scheduleSync = () => {
      if (stopped || pendingSync) return
      // 对账期间宿主会同步派发 tools/change:别丢弃 —— 丢弃意味着别人晚一步的发布
      // 要等最多 5s 的兜底 tick 才收敛。记一个「待补跑」,对账结束后立刻排一次。
      if (mutating) {
        pendingAfterMutate = true
        return
      }
      const timer = setTimeout(() => {
        scopeTimers.delete(timer)
        pendingSync = null
        // 事件驱动的对账允许跳过注册失败退避(别的插件可能刚释放了名字)
        rt.retryNow = true
        try {
          sync()
        } finally {
          rt.retryNow = false
        }
      }, 40)
      pendingSync = timer
      scopeTimers.add(timer)
    }
    try {
      cleanups.push(ctx.on('tools/change', scheduleSync))
    } catch (error) {
      // 没有这个事件(旧宿主)也不致命:5 秒轮询兜底
      console.error('[envdock] 监听 tools/change 失败:', error && error.message)
    }

    /**
     * 被藏掉的命令工具仍有一步之遥能被调到(模型按上一步的工具表直呼),
     * 这时给它一条**可操作**的拒绝,而不是 UNKNOWN_TOOL。
     *
     * 两个方向都要管:
     *   · 宿主 shell 被我们藏掉(直连接管会话)→ 让它改用 `envd_shell`;
     *   · 我们自己的 `envd_shell` 被藏掉(让路 / 沙箱会话)→ 让它改用宿主工具。
     * dsh-ops 用 tools.guard 做同一件事(refusal 与 mask 同权);这边再加两条保险:
     *   · 只拒绝「确实被藏掉、而且替代工具此刻可执行」的名字 —— 否则宁可放行,
     *     绝不制造「两个都调不到」;
     *   · 只认自己登记的那一份定义,防止同名工具被别人接管后我们还去挡。
     */
    const shellRefusal = (exec) => {
      if (!rt.owns) return undefined
      const name = String((exec && exec.name) || '')
      if (!name) return undefined
      const agent = exec && exec.agent ? exec.agent : null
      if (!agent) return undefined
      const scopeCtx = agent.ctx || ctx

      const fact = Array.isArray(rt.scopeToolFacts) ? rt.scopeToolFacts.find((f) => String(f.id) === String(agent.id)) : null

      // 方向一:模型直呼我们自己的固定名,但它在**这个作用域**里已经被藏掉。
      // 替代品必须是**这个会话里真的可见**的宿主工具,不能用全局 shippedName ——
      // 多宿主 shell 时全局挑出来的可能是别的会话里的那个,hasTool 不通过就静默放行(裸 UNKNOWN_TOOL)。
      // (归属用全局视图判:作用域视图里它被 restrict 藏了,查不到自己。)
      if (name === ENVD_SHELL_NAME) {
        if (hasTool(scopeCtx, ENVD_SHELL_NAME, agent)) return undefined
        if (!isOwnDefinition(ctx, undefined)) return undefined
        const hostName =
          (fact && fact.hostTool) || (fact && Array.isArray(fact.hostTools) ? fact.hostTools[0] : '') || ''
        if (!hostName || !isShellToolName(rt, hostName) || !hasTool(scopeCtx, hostName, agent)) {
          // fact 还没生成(新 agent 首步)或替代品此刻不可见:仍给可操作拒绝,但不编造工具名。
          syncStats.guardDenials++
          return (
            '`' + ENVD_SHELL_NAME + '` 在本会话不可用(EnvDock 已让路,或没有接管这个会话);' +
            '本会话的替代命令工具暂时无法判定,请使用工具表里可用的命令工具,终端语法以「本机环境 (EnvDock)」简报为准'
          )
        }
        const kind = fact ? String(fact.kind || '') : ''
        syncStats.guardDenials++
        const why =
          kind === 'sandbox-host'
            ? '本会话被宿主沙箱围栏(' + ((fact && fact.mode) || '策略未知') + '),EnvDock 不接管'
            : kind === 'yield'
              ? '宿主 `' + hostName + '` 在这个会话里挡不掉,EnvDock 已让路'
              : 'EnvDock 没有接管这个会话'
        return (
          '`' + ENVD_SHELL_NAME + '` 在本会话不可用:' + why + ';请改用宿主自带的 `' + hostName + '`,终端语法以「本机环境 (EnvDock)」简报为准'
        )
      }

      if (!isShellToolName(rt, name)) return undefined
      // 方向二:宿主 shell 被我们藏掉。只拒绝「这个作用域里确实被我们藏掉」的:
      // 见过它(或本会话事实里记着挡了它)、现在看不见、而我们的工具在这一作用域可见。
      const seenHere = rt.seenShells.has(name) || Boolean(fact && Array.isArray(fact.hidden) && fact.hidden.includes(name))
      if (!seenHere || hasTool(scopeCtx, name, agent)) return undefined
      if (!isOwnDefinition(scopeCtx, agent) || !hasTool(scopeCtx, ENVD_SHELL_NAME, agent)) return undefined
      // 守卫真的命中一次就记一次:诊断条要能证明「拒绝路径被走过」,而不是只看静态配置猜。
      syncStats.guardDenials++
      return (
        '`' +
        name +
        '` 已被 EnvDock 接管(`' +
        ENVD_SHELL_NAME +
        '` 代替):改用 `' +
        ENVD_SHELL_NAME +
        '`,终端是哪一个、用哪套语法以「本机环境 (EnvDock)」简报为准'
      )
    }
    try {
      const tools = toolsOf(ctx)
      if (tools && typeof tools.guard === 'function') {
        const disposeGuard = tools.guard(shellRefusal)
        if (typeof disposeGuard === 'function') {
          cleanups.push(disposeGuard)
          syncStats.guardReady = true
          syncStats.guardError = null
        } else {
          syncStats.guardReady = false
          syncStats.guardError = 'tools.guard 没有返回 disposer'
        }
      } else {
        syncStats.guardReady = false
        syncStats.guardError = '宿主没有 tools.guard 能力'
      }
    } catch (error) {
      syncStats.guardReady = false
      syncStats.guardError = String((error && error.message) || error)
      console.error('[envdock] 注册命令工具守卫失败:', error && error.message)
    }

    const onStateChange = () => {
      if (stopped) return
      try {
        sync()
      } catch (error) {
        console.error('[envdock] 状态变更后重新对账失败:', error && error.message)
      }
    }
    notifyStateChange = onStateChange
    syncStats.intervalMs = syncIntervalMs
    const timer = setInterval(sync, syncIntervalMs)
    const kick = setTimeout(sync, 1200)
    return () => {
      // 先立 stopped 哨兵,再清定时器:否则「正在跑的回调」还能在卸载之后把工具注册回来,
      // 留下一个占着 envd_shell 的幽灵,下一次启用会被永久判成「已被其它插件占用」。
      stopped = true
      clearInterval(timer)
      clearTimeout(kick)
      for (const pending of scopeTimers) clearTimeout(pending)
      scopeTimers.clear()
      // 插件热重载时别把下一代的钩子置空
      if (notifyStateChange === onStateChange) notifyStateChange = null
      for (const off of cleanups) {
        try {
          if (typeof off === 'function') off()
        } catch {}
      }
      teardown()
      for (const id of [...scopes.keys()]) dropScope(id)
    }
  }, 'envdock shell takeover')

  // 4) 面板 API
  //
  // webServer 由 base 的 web-runtime/webserver 行提供,其就绪时机不保证早于本插件。
  // 在 apply 这一刻用 ctx.get('webServer') 取,拿到的往往是 undefined —— 旧的 if 守卫
  // 会静默跳过,路由从不注册,面板就永远 HTTP 404。必须用 ctx.inject 等它到位
  // (服务晚到时 Cordis 会重新跑这个回调;服务消失时自动 dispose 路由)。
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    if (!webServer || typeof webServer.register !== 'function') return
    const TOO_LARGE = Symbol('too-large')
    const readBody = (req) =>
      new Promise((resolve) => {
        const chunks = []
        let size = 0
        let tooLarge = false
        req.on('data', (chunk) => {
          size += chunk.length
          if (size > 1_000_000) {
            // 超限:**先把请求体读完再回 413**。直接 destroy 会让客户端看到 ECONNRESET,
            // 既不是 413 也不是可诊断的错误。
            tooLarge = true
            chunks.length = 0
            return
          }
          if (!tooLarge) chunks.push(chunk)
        })
        req.on('end', () => resolve(tooLarge ? TOO_LARGE : Buffer.concat(chunks).toString('utf8')))
        req.on('error', () => resolve(tooLarge ? TOO_LARGE : ''))
      })
    const json = (res, obj, status = 200) => {
      const body = JSON.stringify(obj)
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(body)
    }

    webCtx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: API_PATH,
          async handler(req, res) {
            try {
              // 面板数据含本机绝对路径与默认终端:默认只放行 loopback。
              const loopback = isLoopback(req)
              // 只认面板写入的 state:以前 config(settings.allowLan)会永久盖住面板开关,
              // 用户在面板里关掉后局域网仍然可读。
              const allowLan = () => Boolean(getState().options && getState().options.allowLan === true)
              // ── DNS rebinding 防护 ──
              // 攻击者页面把自己的域名重新解析到 127.0.0.1 之后,浏览器发来的请求源地址是回环,
              // 但 Host 仍是攻击者域名 —— 只比较「Origin 与 Host 一致」会放行这种请求
              // (实测可改自定义终端 argv ≈ 本机代码执行)。所以:回环来源必须配回环 Host。
              const hostHostname = (() => {
                const raw = String((req.headers && req.headers.host) || '').toLowerCase()
                if (!raw) return ''
                if (raw.startsWith('[')) {
                  const end = raw.indexOf(']')
                  return end > 0 ? raw.slice(1, end) : ''
                }
                const colon = raw.lastIndexOf(':')
                // 只有一个冒号 = host:port;裸 IPv6(多个冒号)或畸形值一律拒绝。
                return colon > -1 ? (raw.indexOf(':') === colon ? raw.slice(0, colon) : '') : raw
              })()
              if (loopback && !isLoopbackHost(hostHostname)) {
                json(res, { ok: false, error: '非回环 Host 请求被拒绝(面板 API 只接受 127.0.0.1 / localhost)' }, 403)
                return
              }
              if (req.method === 'GET') {
                if (!loopback && !allowLan()) {
                  json(res, { ok: false, error: '非本机请求被拒绝(请在运行 dsh 的这台机器上的 EnvDock 面板打开「允许局域网访问」)' }, 403)
                  return
                }
                const state = getState()
                let detection = null
                // 只是「过了 45s TTL」而不曾被显式作废(cache.at === 0)时:先端上一份快照,
                // 后台再刷新。面板每 15s 轮询一次 → 每第 3 次都会正好撞上过期,让它干等一次
                // 全量探测(PATH 重扫 + reg.exe)没有意义,下一次轮询就会拿到新快照。
                // 显式作废(改终端 / 改选项 / refresh)仍然同步等新数据,语义不变。
                const staleOnly = Boolean(cache.value) && cache.at > 0 && Date.now() - cache.at >= CACHE_TTL_MS
                if (staleOnly) {
                  detection = cache.value
                  Promise.resolve()
                    .then(() => getDetection(false))
                    .catch(() => {})
                } else {
                  try {
                    detection = await getDetection(false)
                  } catch (error) {
                    json(res, { ok: false, error: '环境探测失败: ' + String((error && error.message) || error) }, 500)
                    return
                  }
                }
                const shell = resolveShell(state, detection)
                // 真实可见性:直接问工具表这一个名字此刻在不在,而不是只信 runtime 记账。
                // (注册成功 ≠ 模型看得见;面板显示「已接管」而模型收到 unknown tool 就是这么说谎的。)
                // 注意 API 没有会话:可见性用全局视图,沙箱事实用部署默认档;
                // 「本会话有效策略」在 syncStats.sandboxScopes 里逐个作用域给出。
                const apiGate = sandboxGate(null, state.options)
                const commandTool = commandToolState(rt, (name) => hasTool(ctx, name), apiGate)
                json(res, {
                  ok: true,
                  state,
                  shell: { key: shell.key, label: shell.label, family: shell.family, path: shell.path, version: shell.version || '' },
                  commandTool,
                  // 沙箱分两层给面板:能力位(执行器会不会围栏)/ 部署默认档 / 逐会话有效策略
                  sandbox: {
                    capable: apiGate.capable,
                    // 部署默认档来自执行器能力位,不是「本会话策略」(策略不可知时 apiGate.mode 为空)
                    defaultMode: syncStats.sandboxDefault || apiGate.mode,
                    policyKnown: apiGate.policyKnown !== false,
                    delegate: apiGate.delegate === true,
                    scopes: Array.isArray(syncStats.sandboxScopes) ? syncStats.sandboxScopes : [],
                  },
                  syncStats: { ...syncStats },
                  shippedShell: rt.shippedName,
                  ptyShell: detection.ptyShell,
                  platform: detection.platform,
                  pathInfo: detection.path,
                  tools: (detection.tools || []).map((t) => ({
                    key: t.key,
                    label: t.label,
                    group: t.group,
                    path: t.path,
                    defaultPath: t.defaultPath,
                    defaultVersion: t.defaultVersion || '',
                    version: t.version || '',
                    versions: t.versions || [],
                    names: t.names || [],
                    // Windows py 启动器:面板/夹具据此判断「这条 Python 是经启动器解析的」
                    pyLauncher: t.pyLauncher || '',
                    viaLauncher: Boolean(t.viaLauncher),
                    custom: Boolean(t.custom),
                  })),
                  terminals: detection.terminals,
                  versionManagers: detection.versionManagers,
                  issues: healthIssues(detection, state),
                  brief: brief(
                    detection,
                    state,
                    {
                      visible: (name) => hasTool(ctx, name),
                      gate: () => sandboxGate(null, state.options),
                      // API 没有 agent:简报不能给「本会话」结论,逐会话事实由 commandTool.scopes 给
                      sessionless: true,
                    },
                    rt,
                  ),
                  detectedAt: detection.at,
                  hasSubprocess: Boolean(runner),
                })
                return
              }
              if (req.method !== 'POST') {
                json(res, { ok: false, error: 'method not allowed' }, 405)
                return
              }
              // ── 写操作鉴权 ──
              const reqHeaders = req.headers || {}
              const remoteLoopback = isLoopback(req)
              const lanAllowed = allowLan()
              // 未授权的非本机请求:在**读 body 之前**就拒绝,别替任何人读完大上传。
              if (!remoteLoopback && !lanAllowed) {
                json(res, { ok: false, error: '非本机请求被拒绝(请在运行 dsh 的这台机器上的 EnvDock 面板打开「允许局域网访问」)' }, 403)
                return
              }
              const declaredLength = Number(reqHeaders['content-length'] || 0)
              if (Number.isFinite(declaredLength) && declaredLength > 1_000_000) {
                json(res, { ok: false, error: '请求体过大' }, 413)
                return
              }
              const raw = await readBody(req)
              if (raw === TOO_LARGE) {
                json(res, { ok: false, error: '请求体过大' }, 413)
                return
              }
              let body = {}
              try {
                body = JSON.parse(raw || '{}')
              } catch {
                json(res, { ok: false, error: 'bad json' }, 400)
                return
              }
              if (!body || typeof body !== 'object' || Array.isArray(body)) {
                json(res, { ok: false, error: 'bad json' }, 400)
                return
              }
              const op = String(body.op || '')
              const bodyKeys = Object.keys(body)
              // 唯一允许非本机发起的写:把「允许局域网访问」**关掉**。
              // 打开它、以及其它任何写(终端/版本/自定义工具/自定义终端 argv)都只许本机 ——
              // 否则局域网里就能改默认终端参数,等同把命令注入面开到局域网。
              const allowLanToggleOff =
                op === 'setOption' && body.allowLan === false && bodyKeys.every((key) => key === 'op' || key === 'allowLan')
              const secFetchSite = String(reqHeaders['sec-fetch-site'] || '').toLowerCase()
              if (secFetchSite === 'cross-site') {
                json(res, { ok: false, error: '跨站请求被拒绝(面板 API 只接受本机同源调用)' }, 403)
                return
              }
              const originHost = (() => {
                const rawOrigin = String(reqHeaders.origin || '')
                if (!rawOrigin) return ''
                try {
                  return new URL(rawOrigin).hostname.toLowerCase()
                } catch {
                  return 'invalid'
                }
              })()
              if (!remoteLoopback) {
                if (!allowLanToggleOff) {
                  json(
                    res,
                    {
                      ok: false,
                      error: lanAllowed
                        ? '局域网只能读面板;写操作请在本机进行'
                        : '非本机请求被拒绝(请在运行 dsh 的这台机器上的 EnvDock 面板打开「允许局域网访问」)',
                    },
                    403,
                  )
                  return
                }
                // 关闭开关本身必须同源:Origin 的 host:port 要与 Host 完全一致,
                // 否则任意网页(或同主机别的端口)都能替用户关掉这个开关。
                const originAuthority = (() => {
                  try {
                    return new URL(String(reqHeaders.origin || '')).host.toLowerCase()
                  } catch {
                    return ''
                  }
                })()
                const reqAuthority = String(reqHeaders.host || '').toLowerCase()
                if (!originAuthority || originAuthority !== reqAuthority) {
                  json(res, { ok: false, error: '跨站请求被拒绝(面板 API 只接受同源调用)' }, 403)
                  return
                }
              } else {
                // 本机来源也必须同源:任意 127.0.0.1/localhost 端口上的网页都能发
                // text/plain 简单 POST(免预检)。只判「Origin 是回环字面量」不够 ——
                // other-port.localhost 就能改默认终端 argv(= 命令注入)。
                const reqHost = String(reqHeaders.host || '').toLowerCase()
                if (originHost) {
                  let originHostPort = ''
                  try {
                    originHostPort = new URL(String(reqHeaders.origin)).host.toLowerCase()
                  } catch {}
                  if (!originHostPort || originHostPort !== reqHost) {
                    json(res, { ok: false, error: '跨站请求被拒绝(面板 API 只接受同源调用)' }, 403)
                    return
                  }
                  // 只认媒体类型本身:子串匹配会把 `text/plain;application/json` 也放行。
                  const contentType = String(reqHeaders['content-type'] || '').toLowerCase().split(';')[0].trim()
                  if (contentType !== 'application/json') {
                    json(res, { ok: false, error: '请求必须是 application/json(浏览器跨源请求要预检)' }, 403)
                    return
                  }
                } else if (secFetchSite && secFetchSite !== 'none') {
                  // 浏览器一定会带 Origin;没有 Origin 却带 Sec-Fetch-Site 的不是我们的面板
                  json(res, { ok: false, error: '跨站请求被拒绝(面板 API 只接受同源调用)' }, 403)
                  return
                }
              }
              if (op === 'refresh') {
                const detection = await getDetection(true)
                json(res, { ok: true, detectedAt: detection.at })
                return
              }
              if (op === 'setShell') {
                const key = String(body.key || 'auto')
                const detection = await getDetection(false)
                // 只认探测到的终端:否则一个手滑的 key 会永久写进状态文件,
                // 面板上所有 chip 都点不亮,而解析时又悄悄回落到别的终端。
                const allowed = ['auto', ...(detection.terminals || []).map((t) => t.key)]
                if (key === 'custom') {
                  const custom = getState().customShell
                  if (!custom || !custom.path || !existsSync(custom.path)) {
                    json(res, { ok: false, error: '还没有可用的自定义终端,请先填路径点「添加」' }, 400)
                    return
                  }
                } else if (!allowed.includes(key)) {
                  json(res, { ok: false, error: '未知终端: ' + key + '(可用: ' + allowed.join(', ') + ')' }, 400)
                  return
                }
                const next = writeState({ defaultShell: key })
                json(res, { ok: true, state: next })
                return
              }
              if (op === 'setCustomShell') {
                const path = String(body.path || '').trim()
                let isFile = false
                try {
                  isFile = Boolean(path) && statSync(path).isFile()
                } catch {}
                if (!isFile) {
                  json(res, { ok: false, error: '终端路径不存在或不是文件: ' + path }, 400)
                  return
                }
                let rawArgs = body.args
                if (typeof rawArgs === 'string') rawArgs = rawArgs.split(' ').filter(Boolean)
                const args = Array.isArray(rawArgs) && rawArgs.length ? rawArgs.map(String) : ['-c', '{command}']
                if (!args.some((a) => a.includes('{command}'))) {
                  json(res, { ok: false, error: '参数模板里必须有一个 {command} 占位,例如 ["-c","{command}"]' }, 400)
                  return
                }
                const next = writeState({ defaultShell: 'custom', customShell: { label: String(body.label || basename(path)), path, args } })
                json(res, { ok: true, state: next })
                return
              }
              if (op === 'setTool') {
                const state = getState()
                const key = String(body.key || '')
                const target = String(body.path || '')
                const detection = await getDetection(false)
                const entry = (detection.tools || []).find((t) => t.key === key)
                if (!entry) {
                  json(res, { ok: false, error: '未知工具: ' + key }, 400)
                  return
                }
                if (target && !entry.versions.some((v) => v.path.toLowerCase() === target.toLowerCase())) {
                  json(res, { ok: false, error: '路径不在候选里: ' + target }, 400)
                  return
                }
                // await 期间别的写可能已经落地:必须用**最新** state 的 selections 合并,
                // 否则两次并发 setTool 后写者会覆盖先写者(丢更新)。
                const fresh = getState()
                const selections = { ...fresh.selections }
                if (target) selections[key] = target
                else delete selections[key]
                const next = writeState({ selections })
                json(res, { ok: true, state: next })
                return
              }
              if (op === 'addCustomTool') {
                const state = getState()
                const path = String(body.path || '').trim()
                const label = String(body.label || '').trim() || (path ? basename(path) : '')
                if (!path || !existsSync(path)) {
                  json(res, { ok: false, error: '路径不存在: ' + path }, 400)
                  return
                }
                // key 会进状态文件、又按 key 做过滤/查找:保留名(__proto__/constructor/prototype)
                // 不能被当成普通字段名,长度也要有上限(状态文件里塞一兆的名字没有意义)。
                const rawKey = String(body.key || '').trim()
                if (/^(__proto__|constructor|prototype)$/i.test(rawKey)) {
                  json(res, { ok: false, error: 'key 不能是保留名: ' + rawKey }, 400)
                  return
                }
                const key = (rawKey || label.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'tool').slice(0, 64)
                const customTools = state.customTools.filter((t) => t.key !== key)
                customTools.push({ key, label, path, versionArgs: ['--version'] })
                const next = writeState({ customTools })
                json(res, { ok: true, state: next })
                return
              }
              if (op === 'removeCustomTool') {
                const state = getState()
                const key = String(body.key || '')
                const next = writeState({ customTools: state.customTools.filter((t) => t.key !== key) })
                json(res, { ok: true, state: next })
                return
              }
              if (op === 'setOption') {
                const state = getState()
                const options = { ...state.options }
                const has = (key) => Object.prototype.hasOwnProperty.call(body, key)
                let touched = false
                // 白名单 + 归一化:布尔只收 true/false(其它值按 false),枚举只收三个合法值。
                // 以前把 body 里的值原样写进状态文件:一个 "yes" 就能让面板和接管逻辑各理解一次。
                if (has('injectBrief')) {
                  options.injectBrief = body.injectBrief === true
                  touched = true
                }
                if (has('allowLan')) {
                  options.allowLan = body.allowLan === true
                  touched = true
                }
                if (has('shellTakeover')) {
                  const value = String(body.shellTakeover || '')
                  if (!TAKEOVER_MODES.includes(value)) {
                    json(res, { ok: false, error: 'shellTakeover 只能是 auto / takeover / off' }, 400)
                    return
                  }
                  options.shellTakeover = value
                  touched = true
                }
                if (has('sandboxTakeover')) {
                  const value = String(body.sandboxTakeover || '')
                  if (!SANDBOX_TAKEOVER_MODES.includes(value)) {
                    json(res, { ok: false, error: 'sandboxTakeover 只能是 delegate / refuse' }, 400)
                    return
                  }
                  options.sandboxTakeover = value
                  touched = true
                }
                if (!touched) {
                  json(res, { ok: false, error: '没有可设置的选项(可用: injectBrief / shellTakeover / sandboxTakeover / allowLan)' }, 400)
                  return
                }
                const next = writeState({ options })
                json(res, { ok: true, state: next })
                return
              }
              json(res, { ok: false, error: '未知操作: ' + op }, 400)
            } catch (error) {
              json(res, { ok: false, error: String((error && error.message) || error) }, 500)
            }
          },
        }),
      'envdock api',
    )
  })

  // 预热:不阻塞宿主启动。定时器挂到 effect 上,卸载时清掉(以前裸 setTimeout 会在卸载后跑一次)。
  ctx.effect(
    () => {
      const warm = setTimeout(() => {
        getDetection(false).catch((error) => console.error('[envdock] 首次探测失败:', error && error.message))
      }, 300)
      return () => clearTimeout(warm)
    },
    'envdock warmup',
  )
}
