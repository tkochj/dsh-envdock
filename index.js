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
    // 状态变了(自定义工具 / 默认版本 / 选项),下一趟探测必须重扫,
    // 不能继续把 45 秒前的旧快照端给面板。
    invalidateDetection()
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
  const named = shellFamilyByName(name)
  if (named) return named
  const props = definition && definition.parameters && definition.parameters.properties
  if (!props || typeof props.command !== 'object') return ''
  const text = String(definition.description || '')
  if (/(?:^|[^a-z])(?:bash|gitbash|msys)(?:[^a-z]|$)/i.test(text) || /\b(?:sh|zsh|fish)\b/i.test(text)) return 'bash'
  if (/pwsh|powershell/i.test(text)) return 'powershell'
  if (/\bcmd(?:\.exe)?\b/i.test(text)) return 'cmd'
  if (/\bwsl\b/i.test(text)) return 'wsl'
  return ''
}

/** 运行态已知的家族:学到的优先,内置表兜底。 */
function familyOf(runtime, name) {
  const key = String(name || '')
  if (!key) return ''
  if (runtime && runtime.learnedShells && runtime.learnedShells.has(key)) return runtime.learnedShells.get(key) || ''
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
    /** 宿主自带的命令工具名:即使我们自己接管了也记着 —— 沙箱会话里它才是模型能用的那个 */
    hostName: runtime.shippedName || null,
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
          confined: fact.confined === true,
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

async function detectVersionManagers(runner) {
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
  return present.map((p) => p.entry)
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
      detectVersionManagers(runner)
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
  if (!shell || !shell.path) return null
  // 宿主语法下「引用整条命令」的写法(展开成一个参数,不会被二次分词)
  const ref = hostFamily === 'powershell' ? '$env:ENVD_CMD' : hostFamily === 'bash' ? '"$ENVD_CMD"' : null
  if (!ref) return null
  let argv = null
  if (shell.family === 'custom') {
    let tpl = shell.args
    if (typeof tpl === 'string') tpl = tpl.split(' ').filter(Boolean)
    const args = Array.isArray(tpl) && tpl.length ? tpl.map(String) : ['-c', '{command}']
    argv = args.some((a) => a.includes('{command}'))
      ? [shell.path, ...args.map((a) => (a.includes('{command}') ? ref : a))]
      : [shell.path, ...args, ref]
  } else if (shell.family === 'cmd') argv = [shell.path, '/d', '/s', '/c', ref]
  else if (shell.family === 'bash') argv = [shell.path, '-lc', ref]
  else if (shell.family === 'wsl') argv = [shell.path, 'bash', '-lc', ref]
  else argv = [shell.path, '-NoLogo', '-NoProfile', '-Command', ref]

  if (hostFamily === 'powershell') {
    // 变量引用必须裸放(否则被当成字面量);其余参数一律单引号,内部单引号翻倍。
    const parts = argv.map((part) => (part === ref ? ref : "'" + String(part).replace(/'/g, "''") + "'"))
    return '& ' + parts.join(' ') + '; exit $LASTEXITCODE'
  }
  // bash 宿主:单引号包裹,内部单引号用 '\'' 断开
  const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
  const parts = argv.map((part) => (part === ref ? ref : shq(part)))
  return parts.join(' ') + '; exit $?'
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
    const ownVisible = Boolean(commandState.takeover && commandState.visible)
    const usableHost = hostName && visible(hostName) ? hostName : ''
    if (commandState.sandbox && commandState.sandboxConfined === true) {
      // 本会话真被围栏:模型唯一能用的是宿主工具 —— 语法也必须按宿主工具教,
      // 继续教「默认终端」的语法就是让它拿 bash 语法去打 pwsh。
      lines.push(
        '  · 命令工具: ' +
          (usableHost ? hostLabel(usableHost) : '见工具表') +
          (usableHost ? sandboxLine : '') +
          ':EnvDock 不接管(接管会绕过沙箱),以工具表里那个工具为准' +
          (usableHost && familyOf(runtime, usableHost) ? '' : '(它的语法见工具表,不要按默认终端写)'),
      )
      if (usableHost) pushSyntax(familyOf(runtime, usableHost))
    } else if (ownVisible && (!factKind || factKind === 'takeover')) {
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
    } else if (factKind === 'host' && !ownVisible) {
      // 本会话没有接管(注册失败 / 被占用 / 无需接管 / 我们的工具被折叠或遮挡):
      // 模型用的是宿主工具 —— 名字与语法都按它来;若 envd_shell 已注册却在本会话不可用,明说别直呼。
      lines.push(
        '  · 命令工具: ' +
          (usableHost ? hostLabel(usableHost) : '见工具表') +
          (usableHost ? sandboxLine : '') +
          ';EnvDock 没有接管这个会话' +
          (commandState.takeover ? '(`' + ENVD_SHELL_NAME + '` 在本会话不可用:被工具折叠或遮挡,不要直呼它)' : ''),
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
  lines.push('- 未列出的工具仍可用 `envd` 工具按名字解析(resolve),不要用 where/which 反复试探。')
  return lines.join('\n')
}

// ───────────────────────────────────────────────────────── 工具 ──

function textBlock(text) {
  return [{ type: 'text', text }]
}

/** 请求是否来自本机。面板会暴露本机绝对路径,默认不外放。 */
function isLoopback(req) {
  const raw = String((req && req.socket && (req.socket.remoteAddress || req.socket.address && req.socket.address().address)) || '')
  const addr = raw.startsWith('::ffff:') ? raw.slice(7) : raw
  return addr === '' || addr === '::1' || addr === '127.0.0.1' || addr.startsWith('127.')
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
    const host = ctx.get('shell')
    if (!host || typeof host.resolve !== 'function' || typeof host.execute !== 'function') return null
    const agent = exec && exec.agent ? exec.agent : null
    // 没有会话就没有「本会话策略」可交给宿主执行器:这样的委托可能按部署默认档跑,拒绝。
    if (!agent) {
      return { ok: false, text: '本会话信息缺失,EnvDock 拒绝委托执行(无法把本会话沙箱策略交给宿主执行器);请改用宿主自带的命令工具' }
    }
    // 能力位不在(执行器根本不会围栏)时委托没有意义,也不该由这里兜底
    if (gate && gate.capable === false) return null
    const hostFamily = typeof hostFamilyOf === 'function' ? String(hostFamilyOf(agent) || '') : ''
    // 只认能确定包装语法的两种宿主执行器;别的(cmd/wsl/未知)拒绝,绝不猜。
    if (hostFamily !== 'powershell' && hostFamily !== 'bash') return null
    const command = delegatedInvocation(hostFamily, shell, line)
    if (!command) return null
    if (stats && typeof stats === 'object') stats.delegateTries = (Number(stats.delegateTries) || 0) + 1
    const policies = ctx.get('sandboxPolicy')
    const session = agent.session
    let policy = null
    try {
      if (policies && typeof policies.resolve === 'function') policy = policies.resolve(session ? { session } : {})
    } catch {
      policy = null
    }
    if (!policy) {
      // 拿不到本会话 policy 时不能委托:那等于用部署默认档执行,可能绕过本会话围栏
      if (stats && typeof stats === 'object') stats.delegateFailures = (Number(stats.delegateFailures) || 0) + 1
      return { ok: false, text: '[sandbox] 本会话沙箱策略不可得,EnvDock 拒绝委托执行(不拿部署默认档冒充);请改用宿主自带的命令工具' }
    }
    const env = { ENVD_CMD: line }
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
    // 「委托路径真的跑起来了」单独记账:诊断条要靠它区分「围栏会话根本没走过委托」
    // 和「走了、但宿主执行器拒绝/失败」—— 只看输出文本分不清这两种。
    if (stats && typeof stats === 'object') stats.delegateCalls = (Number(stats.delegateCalls) || 0) + 1
    const LIMIT = 16000
    const clip = (text) => (text.length > LIMIT ? text.slice(0, LIMIT) + '\n…(已截断,原长 ' + text.length + ' 字符)' : text)
    const mode = (policy && policy.mode) || gate.mode || '宿主的围栏'
    const parts = ['[sandbox] 委托宿主执行器执行(' + mode + ')']
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
    // runner 失败时命令根本没执行:这不是「命令跑完但失败」,不能回 ok:true。
    const runnerFailed = Boolean(result.sandbox && result.sandbox.runnerFailed)
    return { ok: !runnerFailed, text: parts.join('\n') }
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
      // 终端永远读当前值:切终端只是换了这里的 shell,工具本身没被重建。
      const shell = activeShell.current || resolveShell(readState(), cache.value)
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
              : '(委托执行不可用:宿主执行器族未知,不能安全转发)'),
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
  const getDetection = async (force) => detect(ctx, runner, getState(), Boolean(force))

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
    /** 每个作用域的沙箱事实:[{ id, mode, confined }],面板据此说「哪个会话为什么」 */
    sandboxScopes: [],
    /** 本 tick 结束时是否**此刻**处于稳态;累计量 steadyTicks 不能当状态用(一旦稳态过就永远为真) */
    steadyNow: false,
    /** 最近一次进入稳态的时刻(ms);0 = 从未 */
    steadySinceAt: 0,
    /** lastError 的写入时刻(ms);lastError 为 null 时无意义 —— 面板据此显示「多久前」 */
    lastErrorAt: 0,
    /** ctx.tools.register 的**尝试**次数(含失败/被校验拒绝):和 registers 一起才能抓「建了又拆」 */
    registerTries: 0,
    /** 围栏会话里发起委托的次数(含失败);delegateCalls 只计真正跑完的 */
    delegateTries: 0,
    /** 委托在 resolve/启动/结果三个阶段抛错的次数 */
    delegateFailures: 0,
    /** 藏我们自己的 envd_shell 的 restrict 次数(与「挡宿主」分开记账) */
    ownHides: 0,
    /** 挡宿主 shell 的 restrict 次数 */
    hostDenyApplies: 0,
    /** restrict 返回成功、复读却仍可见的次数(agent 层同名工具挡不住) */
    denyNoops: 0,
    /** 过渡性缺名(restrict 说 unknown、但此刻也看不见)的次数:不进 badNames,给重试窗口 */
    transientMisses: 0,
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
    if (!syncStats.steadyNow) {
      syncStats.steadyNow = true
      syncStats.steadySinceAt = Date.now()
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
    const text = probes.join(' ').toLowerCase()
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
  const sandboxGate = (agent, options) => {
    const cap = shellCapability()
    const opts = options || getState().options
    const delegate = opts.sandboxTakeover !== 'refuse'
    if (!cap.capable) return { capable: false, confined: false, mode: '', policyKnown: true, delegate }
    const policy = readService('sandboxPolicy')
    const session = agent && agent.session
    let mode = ''
    let policyKnown = false
    if (policy && typeof policy.resolve === 'function') {
      policyKnown = true
      try {
        mode = String(policy.resolve(session ? { session } : {}).mode || '')
      } catch {
        mode = ''
        // 解析失败 ≠ 策略是默认档:这时说「本会话被围栏(workspace-write)」就是编造。
        policyKnown = false
      }
    }
    // 策略不可知时绝不拿部署默认档冒充本会话结论(两个方向都危险:把无围栏说成围栏、
    // 把围栏当成无围栏)。confined 留 null,由调用方按「未知 = 保守」处理。
    if (!policyKnown) return { capable: true, confined: null, mode: '', policyKnown: false, delegate }
    if (!mode) mode = cap.defaultMode
    const confined = agent ? mode !== 'danger-full-access' : null
    return { capable: true, confined, mode, policyKnown, delegate }
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
        badNames: new Set(),
        hostSeen: new Set(),
        /** 过渡性缺名:name → 允许重试的时刻(不进 badNames,不给名字「永久判死」) */
        missNames: new Map(),
        /** 计划要藏自己、restrict 也推了却仍可见(agent 层同名)时记的 planKey,避免每 tick 重试 */
        ownHideFailedKey: '',
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

    const collectShellNames = () => {
      // 候选集是动态的:内置名单 + tools.definitions 学到的第三方发布名(ops_* / tenant_* 等)
      const found = new Set()
      for (const name of shellCandidates()) {
        if (name === ENVD_SHELL_NAME) continue
        if (hasTool(ctx, name)) found.add(name)
        for (const cur of scopes.values()) {
          if (hasTool(cur.actx, name, cur.agent)) found.add(name)
        }
      }
      return found
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

    const maskFor = (cur, names) =>
      names.filter((name) => {
        if (cur.badNames.has(name)) return false
        const retryAt = cur.missNames.get(name)
        if (retryAt && retryAt > Date.now()) return false
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
        const ownVisible = hasTool(cur.actx, ENVD_SHELL_NAME, cur.agent)
        const visibleHosts = []
        for (const name of candidates) {
          if (name === ENVD_SHELL_NAME) continue
          try {
            if (hasTool(cur.actx, name, cur.agent)) visibleHosts.push(name)
          } catch {}
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
        const anomaly = (!ownVisible && !hostTool) || (ownVisible && visibleHosts.length > 0) || leaked.length > 0
        facts.push({
          id,
          kind,
          tool,
          // 逐会话的宿主工具:简报按它说语法、面板按它说「模型实际拿到的是谁」。
          // 不能用全局 shippedName —— 同一台机器可能同时挂着官方 pwsh 和 dsh-ops 的 ops_bash。
          hostTool,
          hostTools: visibleHosts,
          ownVisible,
          hideOwnPlanned,
          visible: kind === 'takeover' ? ownVisible : Boolean(hostTool),
          hidden,
          leaked,
          hidesOwn: hideOwnPlanned && !ownVisible,
          confined: gate.confined === true,
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
    const denyScopes = (plan, candidates) => {
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
          try {
            cur.disposers.push(tools.restrict({ deny: mask }))
            syncStats.denyApplies++
            syncStats.hostDenyApplies++
            // restrict 只过滤**继承面**:agent 自己层注册的同名工具挡不掉,restrict 也不报错。
            // 所以成功返回后必须复读一次;仍可见的按「挡不掉」处理(下一 tick 让路),不能记成已挡。
            appliedMask = mask.filter((name) => !stillVisible(name))
            for (const name of mask) {
              if (stillVisible(name)) {
                cur.badNames.add(name)
                syncStats.denyNoops++
              }
            }
          } catch (error) {
            // 整体失败(通常是混进了这个作用域挡不掉的名字):退化成逐个挡,能挡几个挡几个。
            // 挡不掉的名字进 **cur.badNames** —— 它是作用域私有的;别动全局 seenShells,
            // 否则「别的作用域挡得掉」的那个名字会被永久剔除,那边就永久漏挡。
            const failed = []
            for (const name of mask) {
              try {
                cur.disposers.push(tools.restrict({ deny: [name] }))
                syncStats.denyApplies++
                syncStats.hostDenyApplies++
                if (stillVisible(name)) {
                  cur.badNames.add(name)
                  syncStats.denyNoops++
                } else {
                  appliedMask.push(name)
                }
              } catch {
                failed.push(name)
              }
            }
            for (const name of failed) {
              if (hasTool(cur.actx, name, cur.agent)) {
                // 真的还在 → 这个作用域确实挡不掉:记进 badNames,下一 tick 走让路
                cur.badNames.add(name)
              } else {
                // 名字只是暂时不在(插件热重载空窗):restrict 报 unknown 不代表「挡不掉」。
                // 锁进 badNames 会让这个作用域永久让路、并永久谎报挡不掉;给 30s 重试窗口。
                cur.missNames.set(name, Date.now() + 30000)
                syncStats.transientMisses++
              }
            }
            appliedMask = appliedMask.filter((name) => !cur.badNames.has(name))
            if (!cur.disposers.length) {
              setLastError('遮挡 ' + key + ' 失败: ' + ((error && error.message) || error))
              console.error('[envdock] 遮挡 ' + key + ' 失败:', error && error.message)
            }
          }
        }
        // 记的是「这个作用域真正生效的」计划:稳态判定要和它对得上,否则每 tick 重试。
        // hideOwn 计划下「本来就不见」也记 own|:现在 scopesSettled 会复检「又可见了就重挂」,
        // 记账不再有「永久漏藏」风险;不记反而会让账本每 tick 对不上(每 tick 完整对账/重挂掩码)。
        cur.denyKey = (hideOwn && (ownHidden || !visibleOwn) ? 'own|' : '') + appliedMask.join(',')
      }
      const scopeList = [...scopes.values()]
      // 挡不掉的按作用域记,诊断只做并集(别当成全局黑名单用)。
      // 只收「真挡不掉」的名字(badNames);过渡性缺名在 missNames 里等重试,不算挡不掉。
      const bad = new Set()
      for (const cur of scopeList) for (const name of cur.badNames) bad.add(name)
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
    const liftDenies = () => denyScopes([], [])
    /** 每个作用域都按当前计划对完账了吗(含「已判定挡不了」的作用域) */
    const scopesSettled = (plan) => {
      for (const entry of Array.isArray(plan) ? plan : []) {
        const cur = entry.cur
        const mask = entry.mask
        const key = planKey(entry)
        const visible = hasTool(cur.actx, ENVD_SHELL_NAME, cur.agent)
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
        confined: gate.confined === true,
      }))
      const unconfined = scopeFacts.filter(({ gate }) => gate.confined !== true).length
      syncStats.sandboxBlocked = cap.capable && scopes.size > 0 && unconfined === 0
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
      for (const cur of scopes.values()) {
        const scopeTools = toolsOf(cur.actx)
        if (scopeTools && typeof scopeTools.definitions === 'function') {
          let defs = []
          try {
            defs = scopeTools.definitions(cur.agent) || []
          } catch {
            defs = []
          }
          for (const def of defs) {
            const name = def && def.name ? String(def.name) : ''
            if (!name) continue
            const family = shellFamilyFromDefinition(def)
            if (!family) continue
            rt.learnedShells.set(name, family)
            rt.seenShells.add(name)
            cur.hostSeen.add(name)
          }
        }
        // 定义面只看得到「当前可见」的工具(挡住之后就没了),所以再按名字探一遍:
        // 见过的名字留在 hostSeen 里,掩码不会忽有忽无。
        for (const name of shellCandidates()) {
          if (name === ENVD_SHELL_NAME) continue
          try {
            if (hasTool(cur.actx, name, cur.agent)) {
              cur.hostSeen.add(name)
              rt.seenShells.add(name)
            }
          } catch {}
        }
        // 过渡性缺名一旦重新出现就解除重试窗口
        if (cur.missNames.size) {
          for (const name of [...cur.missNames.keys()]) {
            if (hasTool(cur.actx, name, cur.agent)) cur.missNames.delete(name)
          }
        }
      }
      for (const name of collectShellNames()) {
        if (rt.ownNames.has(name)) continue
        rt.seenShells.add(name)
      }
      const allHostNames = new Set()
      for (const cur of scopes.values()) for (const name of cur.hostSeen) allHostNames.add(name)
      syncStats.runtimeShellTools = [...shellCandidates()]
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
      const shippedName = [...allHostNames].sort((a, b) => shellRank(a) - shellRank(b))[0] || [...rt.seenShells].sort((a, b) => shellRank(a) - shellRank(b))[0] || null
      rt.shippedName = shippedName
      const shippedFamily = shippedName ? familyOf(rt, shippedName) : null
      const familyMatches = Boolean(shippedFamily) && shippedFamily === shell.family
      // 还没看清宿主有什么时先别动,下一 tick 再看(否则会和宿主的命令工具并列,模型看到两个)
      if (!shippedName && mode !== 'takeover') {
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
      const trustedUnconfined = cap.capable ? scopeFacts.some(({ gate }) => gate.confined === false) : true
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
        if (gate.confined === true) return { cur, gate, mask: [], hideOwn: true }
        // 这个作用域里 envd_shell 不是我们登记的那一份(agent 层同名 / 被别的插件顶掉):
        // 绝不去挡宿主 —— 遮掉的是真工具,留下的却可能是别人的同名工具,等于造零工具。
        const ownHere = hasTool(cur.actx, ENVD_SHELL_NAME, cur.agent)
        if (ownHere && !isOwnDefinition(cur.actx, cur.agent)) return { cur, gate, mask: [], hideOwn: false }
        const hosts = hostNamesAt(cur)
        const mask = maskFor(cur, hosts)
        // 挡不掉(restrict 实测失败)或认不出家族的宿主工具只要此刻还在,就必须让路:
        // 认不出家族既教不了语法,也保证不了「我们的工具能替代它」。
        const stuck = hosts.filter((name) => (cur.badNames.has(name) || !familyOf(rt, name)) && hasTool(cur.actx, name, cur.agent))
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
            denyScopes(plan, [...allHostNames])
          }
          markSteady()
          publishScopeFacts(plan)
          return
        }
        // 账本说有、工具表里没有 → 掉下去走完整对账(下面 ensureOwnTool 会补注册)
      }

      if (!takeoverWanted) {
        setLastError(null)
        if (appliedSig || disposeTool || rt.owns || appliedDenyKey) {
          teardown()
          syncStats.lastSig = sig
        } else {
          markSteady()
        }
        publishScopeFacts(plan)
        return
      }

      // 上一次失败还没到重试时间:保持「没有自己的工具」,宿主自带的继续干活
      if (retryAt && Date.now() < retryAt) {
        markSteady()
        publishScopeFacts(plan)
        return
      }
      retryAt = 0
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
      denyScopes(plan, [...allHostNames])
      // 遮挡已经落地,现在才把逐会话终局端给面板/API(早一步就是谎报)
      publishScopeFacts(plan)
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
        try {
          sync()
        } catch {}
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
    const readBody = (req) =>
      new Promise((resolve) => {
        const chunks = []
        let size = 0
        req.on('data', (chunk) => {
          size += chunk.length
          if (size > 1_000_000) {
            try {
              req.destroy()
            } catch {}
            resolve('')
            return
          }
          chunks.push(chunk)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', () => resolve(''))
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
              const allowLan = () => settings.allowLan === true || (getState().options && getState().options.allowLan === true)
              if (req.method === 'GET') {
                if (!loopback && !allowLan()) {
                  json(res, { ok: false, error: '非本机请求被拒绝(请在运行 dsh 的这台机器上的 EnvDock 面板打开「允许局域网访问」)' }, 403)
                  return
                }
                const state = getState()
                let detection = null
                try {
                  detection = await getDetection(false)
                } catch (error) {
                  json(res, { ok: false, error: '环境探测失败: ' + String((error && error.message) || error) }, 500)
                  return
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
                    defaultMode: apiGate.mode,
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
              // 跨站写入防护:面板 API 只应接受本机同源调用。
              // 任意网页都能发 text/plain 的简单 POST(不触发 CORS 预检),其 Origin 是外部站点;
              // 只靠 remoteAddress 会把这类请求当成 loopback。这里再按 Origin / Sec-Fetch-Site 兜一层。
              const reqHeaders = req.headers || {}
              if (String(reqHeaders['sec-fetch-site'] || '') === 'cross-site') {
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
              const originOk =
                !originHost ||
                originHost === '127.0.0.1' ||
                originHost === 'localhost' ||
                originHost === '::1' ||
                originHost.startsWith('127.')
              if (!originOk && !allowLan()) {
                json(res, { ok: false, error: '跨站请求被拒绝(面板 API 只接受本机同源调用)' }, 403)
                return
              }
              const raw = await readBody(req)
              let body = {}
              try {
                body = JSON.parse(raw || '{}')
              } catch {
                json(res, { ok: false, error: 'bad json' }, 400)
                return
              }
              const op = String(body.op || '')
              if (!loopback && !allowLan()) {
                // 只放行「打开局域网访问」这一个动作:否则从局域网打开面板的人永远点不动这个开关
                // (面板提示去打开它,而请求本身被 403 掉,死循环)。
                const keys = Object.keys(body)
                const toggleOnly = op === 'setOption' && keys.every((k) => k === 'op' || k === 'allowLan')
                if (!toggleOnly) {
                  json(res, { ok: false, error: '非本机请求被拒绝(请在运行 dsh 的这台机器上的 EnvDock 面板打开「允许局域网访问」)' }, 403)
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
                const selections = { ...state.selections }
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
                const key = String(body.key || '').trim() || (label.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'tool')
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

  // 预热:不阻塞宿主启动
  setTimeout(() => {
    getDetection(false).catch((error) => console.error('[envdock] 首次探测失败:', error && error.message))
  }, 300)
}
