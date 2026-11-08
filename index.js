/**
 * EnvDock · Host half.
 *
 * 职责:
 *   1. 探测机器上的工具链(Node/Python/Git/包管理器)、多版本、版本管理器与终端。
 *   2. 把「系统 + 终端 + 工具版本」写成一条运行环境简报,注入给模型。
 *   3. 注册 `envd` 工具:按名字解析绝对路径 / 版本 / 该终端下的正确命令语法。
 *   4. 注册一个**增补**的 `envd_shell`(用你配置的终端与 PATH):围栏会话里直接拒绝执行。
 *      0.6 起按**语法族**工作:每个会话只暴露一族命令工具 —— bash 族会话会遮挡宿主的
 *      PowerShell 族内置名(pwsh/powershell),开关 `blockOtherFamily` 可关闭(见核实后的规则)。
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
  /** 工具默认版本: { node: 'C:\\\\...\\\\node.exe', python: '...' } */
  selections: {},
  /** 用户手工加的工具: [{ key, label, path, versionArgs: string[] }] */
  customTools: [],
  /**
   * 选项开关(面板可改,写进 ~/.dsh/envdock.json)。
   *
   * 0.5.0 起不再有「接管」概念:`shellTakeover` / `sandboxTakeover` 已删除。
   * 旧状态文件里出现这两个字段时**忽略**(不报错、不迁移,下次写回即消失)。
   */
  options: {
    injectBrief: true,
    /** 允许非 loopback 请求访问 /envdock-api(默认关:面板数据含本机路径与终端) */
    allowLan: false,
    /**
     * bash 族会话遮挡 PowerShell 族内置命令工具(pwsh / powershell)。
     * 0.6 默认开;关掉 = 两族同时可见(简报/面板只警告,不遮挡)。
     */
    blockOtherFamily: true,
  },
}

const STATE_BACKUP = STATE_FILE + '.corrupt'

/**
 * options 白名单归一化。
 *
 * 状态文件是**用户可手改**的(也是老版本写的):里面的布尔可能是 "yes"/1。
 * 全部在这里收敛成「布尔只有 true/false」,消费端才能一律用 === true 判断
 * —— 否则 Boolean("false") 为真这类坑会在面板和简报两边各踩一次。
 * 不在白名单里的键(含 0.5.0 删掉的接管开关)一律丢弃。
 */
function normalizeOptions(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    injectBrief: src.injectBrief === false ? false : true,
    allowLan: src.allowLan === true,
    blockOtherFamily: src.blockOtherFamily === false ? false : true,
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
    // 增补工具的状态也要立刻重算:否则面板上点完开关,还要等下一个 5 秒 tick 才生效。
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
  // 这类名字会被误认成宿主 shell → 在 hostTools 里凭空多出一条假命令工具。必须同时有命令参数。
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

// ────────────────────────────────────────────────── 两族(0.6) ──
/**
 * 语法族:一个会话只暴露一个族的命令工具(0.6 的唯一例外,见 docs/DESIGN.md)。
 *
 *   bash 族       宿主 bash / sh / zsh / fish / ops_bash,以及启发式认出的第三方 bash 名
 *   PowerShell 族 宿主 pwsh / powershell(启发式认出的其它 PowerShell 名只展示,不遮挡)
 *
 * cmd 与自定义终端不参与自动选族、也不被遮挡;WSL 手动选时按 bash 语法计(D5)。
 * 只有**内置**的 PowerShell 名会进入遮挡/拒绝名单:启发式认出的名字可能是第三方发布的
 * 普通工具,误伤一次就是「模型手里突然少一个工具」,而且很难向用户解释。
 */
const FAMILY_BASH = 'bash'
const FAMILY_POWERSHELL = 'powershell'

/** 首次判定后允许「powershell → bash」升级的时间窗(兜住 dsh-ops 晚挂载 ops_bash)。 */
export const FAMILY_GRACE_MS = 10_000

/** 会进入遮挡/拒绝名单的内置 PowerShell 族命令工具名(D8:pwsh_persistent 先只展示,不加)。 */
export const POWER_SHELL_BUILTIN_NAMES = Object.freeze(['pwsh', 'powershell'])

/** 内置命令工具名 → 语法族(这是**遮挡**口径;ops_bash 认成 bash,不参与 PowerShell 遮挡)。 */
const BUILTIN_TOOL_GROUP = Object.freeze({
  pwsh: FAMILY_POWERSHELL,
  powershell: FAMILY_POWERSHELL,
  cmd: 'cmd',
  bash: FAMILY_BASH,
  sh: FAMILY_BASH,
  zsh: FAMILY_BASH,
  fish: FAMILY_BASH,
  // dsh-ops 在 cordis 模式用 ops_bash 顶替官方 pwsh/bash(同一套 bash 语法)。
  ops_bash: FAMILY_BASH,
})

/** 名字 → 语法族(内置名单优先,其余按 token 启发式,同 shellFamilyByName)。 */
export function shellToolGroup(name) {
  const lower = String(name || '').toLowerCase()
  if (!lower || lower === ENVD_SHELL_NAME) return ''
  if (BUILTIN_TOOL_GROUP[lower]) return BUILTIN_TOOL_GROUP[lower]
  return shellFamilyByName(lower)
}

/** 手动选择的族。defaultShell 非 auto 时才可能有值;cmd / custom 不参与两族(永不遮挡)。 */
export function manualFamilyOf(defaultShell) {
  const key = String(defaultShell || 'auto').toLowerCase()
  if (key === 'pwsh' || key === 'powershell') return FAMILY_POWERSHELL
  // WSL 手动选时按 bash 语法计:进入 wsl 之后跑的就是 bash。
  if (key === 'bash' || key === 'wsl' || key === 'sh' || key === 'zsh' || key === 'fish') return FAMILY_BASH
  return ''
}

/** 自动选族:会话能看到任何 bash 族宿主工具 → bash,否则 PowerShell。 */
export function autoFamilyOf(hostTools) {
  for (const tool of Array.isArray(hostTools) ? hostTools : []) if (tool && tool.family === FAMILY_BASH) return FAMILY_BASH
  return FAMILY_POWERSHELL
}

/**
 * 会话族判定(锁定 + 10 秒升级宽限)。纯函数,不碰 IO。
 *
 * record: { source:'auto'|'manual', group, at, upgraded } | null
 * 返回  : { group, source:'auto'|'manual', changed, record }
 */
export function resolveSessionFamily(input) {
  const spec = input && typeof input === 'object' ? input : {}
  const now = Number.isFinite(spec.now) ? spec.now : Date.now()
  const manual = spec.manual === FAMILY_BASH || spec.manual === FAMILY_POWERSHELL ? spec.manual : ''
  const auto = spec.auto === FAMILY_BASH ? FAMILY_BASH : FAMILY_POWERSHELL
  const record = spec.record && typeof spec.record === 'object' ? spec.record : null
  if (manual) {
    const changed = !record || record.source !== 'manual' || record.group !== manual
    return { group: manual, source: 'manual', changed, record: { source: 'manual', group: manual, at: now, upgraded: true } }
  }
  if (record && record.source === 'auto') {
    const withinGrace = now - Number(record.at || 0) <= FAMILY_GRACE_MS
    if (record.group === FAMILY_POWERSHELL && auto === FAMILY_BASH && record.upgraded !== true && withinGrace) {
      return {
        group: FAMILY_BASH,
        source: 'auto',
        changed: true,
        record: { source: 'auto', group: FAMILY_BASH, at: record.at, upgraded: true },
      }
    }
    const group = record.group === FAMILY_BASH ? FAMILY_BASH : FAMILY_POWERSHELL
    return { group, source: 'auto', changed: false, record }
  }
  return { group: auto, source: 'auto', changed: true, record: { source: 'auto', group: auto, at: now, upgraded: false } }
}

/**
 * 一个会话的遮挡/拒绝目标集合。纯函数。
 *
 * active = 开关开 + 会话族 bash + (该会话看得到 bash 族宿主工具,或上次已经遮过 —— sticky)。
 * sticky 是「记忆」:op_bash 之类 bash 族工具消失后,已经遮挡的 pwsh 不立刻放回来,
 * 直到主人在面板上「重新探测」(会话族与遮挡一起重判),避免工具表在会话里反复闪。
 *   hide       可见且可 restrict 的内置 PowerShell 名(继承层;tools.restrict 能挡掉)
 *   refuse     可见的内置 PowerShell 名(含 agent 自有层:restrict 挡不掉,只能 guard 拒绝)
 *   displayOnly 启发式认出的 PowerShell 族名字(只展示,永不遮挡/拒绝)
 * 硬不变量:返回的 hide / refuse 里永远不会出现 bash 族名字。
 */
export function familyMask(input) {
  const spec = input && typeof input === 'object' ? input : {}
  const hostTools = Array.isArray(spec.hostTools) ? spec.hostTools : []
  const active =
    spec.blockOtherFamily !== false &&
    spec.group === FAMILY_BASH &&
    (hostTools.some((tool) => tool && tool.family === FAMILY_BASH) || spec.sticky === true)
  const known = new Set()
  if (spec.known && typeof spec.known[Symbol.iterator] === 'function') for (const name of spec.known) known.add(String(name))
  for (const tool of hostTools) if (tool && tool.name) known.add(String(tool.name))
  const restrictable = spec.restrictable && typeof spec.restrictable.has === 'function' ? spec.restrictable : null
  const hide = []
  const refuse = []
  if (active) {
    for (const name of POWER_SHELL_BUILTIN_NAMES) {
      if (!known.has(name)) continue
      refuse.push(name)
      // 省略 restrictable = 全可 restrict(老宿主没有 view 时的保守口径)。
      if (!restrictable || restrictable.has(name)) hide.push(name)
    }
  }
  const displayOnly = active
    ? hostTools
        .filter((tool) => tool && tool.learned === true && tool.family === FAMILY_POWERSHELL)
        .map((tool) => String(tool.name))
        .sort()
    : []
  return { active, hide: hide.sort(), refuse: refuse.sort(), displayOnly }
}

/**
 * 简报里的「命令工具」行(纯函数,按会话族生成)。
 *
 * spec: {
 *   family, familySource, shellLabel, terminalAvailable,
 *   registered, skipReason,
 *   hostTools: [{ name, family, learned }],   // 本会话此刻看得见的宿主命令工具(不含被遮掉的内置名)
 *   hidden, refused, displayOnly,              // familyMask 的结果(或 runtime 快照的并集)
 *   mixed, blockOtherFamily, bashHostAvailable,
 *   confined, delegate, sessionless,
 * }
 */
export function familyBriefLine(spec) {
  const s = spec && typeof spec === 'object' ? spec : {}
  const family = s.family === FAMILY_BASH || s.family === FAMILY_POWERSHELL ? s.family : ''
  const manual = s.familySource === 'manual'
  const envd = ENVD_SHELL_NAME
  const hostTools = Array.isArray(s.hostTools) ? s.hostTools.filter((tool) => tool && tool.name) : []
  const hidden = Array.isArray(s.hidden) ? s.hidden.filter(Boolean) : []
  const refused = Array.isArray(s.refused) ? s.refused.filter(Boolean) : Array.isArray(s.refuseOnly) ? s.refuseOnly.filter(Boolean) : []
  const displayOnly = Array.isArray(s.displayOnly) ? s.displayOnly.filter(Boolean) : []
  const listed = (list) => list.map((name) => '`' + String(name) + '`').join(', ')
  const hostBash = hostTools.filter((tool) => tool.family === FAMILY_BASH).map((tool) => String(tool.name))
  const hostPwsh = hostTools.filter((tool) => tool.family === FAMILY_POWERSHELL).map((tool) => String(tool.name))
  const hostOther = hostTools
    .filter((tool) => tool.family !== FAMILY_BASH && tool.family !== FAMILY_POWERSHELL)
    .map((tool) => String(tool.name))
  const bashHostAvailable = s.bashHostAvailable === true || hostBash.length > 0
  const terminalLabel = String(s.shellLabel || (family === FAMILY_BASH ? 'Git Bash' : 'PowerShell 7'))
  const registered = s.registered === true
  const skipReason = s.skipReason ? String(s.skipReason) : ''
  const blockOtherFamily = s.blockOtherFamily !== false
  let line = '  · 命令工具'
  if (family) line += '(' + (family === FAMILY_BASH ? 'bash 族' : 'PowerShell 族') + (manual ? ',手动选择' : '') + ')'
  line += ': '

  if (family === FAMILY_BASH) {
    const bits = []
    if (hostBash.length) bits.push('宿主 ' + listed(hostBash))
    if (registered) bits.push('`' + envd + '`(EnvDock 增补,' + terminalLabel + ',同语法)')
    else if (skipReason === 'no-family-terminal') bits.push('`' + envd + '` 未注册(' + terminalLabel + ')')
    else if (skipReason === 'taken') bits.push('`' + envd + '` 与其它插件同名,EnvDock 未注册')
    else if (skipReason === 'no-unconfined-session') bits.push('`' + envd + '` 未注册(没有无围栏会话)')
    else if (skipReason) bits.push('`' + envd + '` 未注册(原因见面板详情)')
    line += bits.length ? bits.join(' + ') : '(没有可用的 bash 族命令工具)'
    if (hidden.length) line += ';PowerShell 族宿主工具已隐藏(' + listed(hidden) + '),不要调用 ' + hidden[0]
    else if (refused.length) line += ';PowerShell 族宿主工具(`' + refused[0] + '`)在本会话调用会被拒绝'
    if (!blockOtherFamily && hostPwsh.length) line += ';PowerShell 族宿主工具未隐藏(' + listed(hostPwsh) + '),两族同时可见,各按自己的语法写命令,不要混写'
    if (manual && !bashHostAvailable) line += ';本会话看不到 bash 族宿主工具,EnvDock 未遮挡 PowerShell 族'
    if (displayOnly.length) line += ';另见只展示、未遮挡的 ' + listed(displayOnly)
  } else if (family === FAMILY_POWERSHELL) {
    const bits = []
    if (registered) bits.push('`' + envd + '`(EnvDock 增补,' + terminalLabel + ')')
    else if (skipReason === 'no-family-terminal') bits.push('`' + envd + '` 未注册(' + terminalLabel + ')')
    else if (skipReason === 'taken') bits.push('`' + envd + '` 与其它插件同名,EnvDock 未注册')
    else if (skipReason === 'no-unconfined-session') bits.push('`' + envd + '` 未注册(没有无围栏会话)')
    else if (skipReason) bits.push('`' + envd + '` 未注册(原因见面板详情)')
    if (hostPwsh.length) bits.push('宿主 ' + listed(hostPwsh))
    if (hostBash.length) bits.push('宿主 ' + listed(hostBash) + '(bash 族,未隐藏)')
    if (hostOther.length) bits.push('宿主 ' + listed(hostOther))
    line += bits.length ? bits.join(' + ') : '(没有可用的 PowerShell 族命令工具)'
    if (s.mixed === true || (manual && hostBash.length)) line += ';两族同时可见,各按自己的语法写命令,不要混写'
    else if (!bashHostAvailable) line += ';未检测到 bash 族工具,不需要 bash 语法'
    if (refused.length) line += ';同一族的内置名调用会被拒绝(' + listed(refused) + ')'
    if (displayOnly.length) line += ';另见只展示、未遮挡的 ' + listed(displayOnly)
  } else {
    // 手动 cmd / custom:不参与两族,按原口径描述。
    const bits = []
    if (registered) bits.push('`' + envd + '`(EnvDock 增补,用 ' + terminalLabel + ' 语法)')
    if (hostTools.length) bits.push('宿主 ' + listed(hostTools.map((tool) => String(tool.name))))
    line += bits.length ? bits.join(' + ') : '用宿主的 ' + (hostTools.length ? listed(hostTools.map((t) => String(t.name))) : '(未识别到宿主命令工具)')
  }

  // 手动选的族不可用 → 已回退 auto:必须说清楚,否则面板/简报和模型的命令语法会打架。
  if (s.fallback === true) line += ';手动选择的族不可用(该族既没有终端、也没有按该族发布的宿主工具),已回退自动选族'
  // 沙箱受限:
  //   · 能委托宿主执行器(delegate)= 命令仍会执行,只是跑在沙箱里:说清「会在沙箱内执行」,
  //     并提醒文件写入可能被拒绝,别让模型把策略拒绝当成工具坏了;
  //   · 不能委托(没有沙箱执行器 / 族未知 / 目标终端族不支持)= 沿用拒绝口径并指向宿主工具。
  if (s.confined === true && s.sessionless !== true) {
    if (s.delegate === true) {
      line += ';本会话受沙箱限制:envd_shell 会通过宿主执行器在沙箱内执行(文件写入可能被拒绝)'
    } else if (family === FAMILY_BASH) {
      line += bashHostAvailable
        ? ';本会话受沙箱限制且无法在沙箱内执行:改用 ' + listed(hostBash.slice(0, 1)) + '(同语法)'
        : ';本会话受沙箱限制且无法在沙箱内执行,本会话也没有 bash 族宿主工具可用'
    } else if (family === FAMILY_POWERSHELL) {
      line += ';本会话受沙箱限制且无法在沙箱内执行:改用宿主 ' + (hostPwsh.length ? listed(hostPwsh.slice(0, 1)) : '`pwsh`')
    } else {
      line += ';本会话受沙箱限制且无法在沙箱内执行'
    }
  }
  if (registered && !s.sessionless && family === FAMILY_BASH && bashHostAvailable && s.confined !== true) {
    line += ';使用分工:需要你机器上的版本(node/pnpm/python/git)时用 envd_shell,需要后台作业或沙箱提权参数时用 ops_bash'
  }
  return line
}

// ──────────────────────────────────────────────── 探测 ──

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

/** 状态一变就立刻重新对一次(增补工具的注册条件 / 宿主工具识别)。 */
let notifyStateChange = null

/**
 * 增补命令工具的固定名字。
 *
 * 名字不跟终端走:切终端只改「怎么执行」(执行侧从 activeShell 读),注册表一个字节都不用动,
 * 也就不存在「拆旧名 → 建新名」之间的工具表空窗。刻意取 envd_ 前缀,不和宿主/其它插件的
 * shell 名争抢;同名被占时不认领(见 apply 里的 registerTool)。
 */
const ENVD_SHELL_NAME = 'envd_shell'

/**
 * 增补命令工具与展示用的运行态(每个 apply 一份,由检查周期维护,brief 与 API 读它)。
 *
 * 刻意**不放在模块级**:同一进程里 apply 可能不止一次(插件热重载、测试夹具),
 * 共享一份就会互相清账本。按实例持有之后,谁的状态谁负责。
 */
function createRuntime() {
  return {
    /**
     * 我们自己注册的那一份定义对象(登记身份)。
     * 只按名字判「是我的工具」会被同名工具骗过 —— 登记身份才是归属
     * (dsh-ops 的 publication ownership 就是同一口径:`tools.get(name) === 我注册的那个对象`)。
     */
    ownDefinition: null,
    /** envd_shell 是否由我们注册成功(注册成功且仍是那一份) */
    registered: false,
    /** 未注册的原因:'no-family-terminal' | 'no-unconfined-session' | 'taken' | 'error' | null(§1.4) */
    skipReason: null,
    /** 宿主已识别的命令工具(只用于展示):[{ name, family, learned, group }],排序稳定、名字有界 */
    hostTools: [],
    /** 主终端所在的语法族(全局默认族;cmd/custom 手动选择时为 '') */
    family: '',
    /** 族的来源:'auto' | 'manual' */
    familySource: 'auto',
    /** 手动选的族没有终端也没有对应宿主工具 → 已回退 auto(简报/面板要警告) */
    familyFallback: false,
    /** 逐会话族的聚合计数 */
    sessions: { total: 0, bash: 0, powershell: 0, other: 0 },
    /** 此刻被 restrict 遮挡的内置 PowerShell 名(并集) */
    hidden: [],
    /** 只能在 dispatch 前拒绝、无法 restrict 的内置 PowerShell 名(agent 自有层) */
    refuseOnly: [],
    /** 启发式认出的 PowerShell 族名字:只展示,永不遮挡 */
    displayOnly: [],
    /** 手动 PowerShell + 会话里有 bash 族工具(两族同时可见,未遮挡) */
    mixed: false,
    /** 遮挡开关的当前值(panel 冗余展示) */
    blockOtherFamily: true,
    /** 沙箱聚合事实(§1.4 的形状;逐会话明细不外泄) */
    sandbox: {
      present: false,
      capable: false,
      defaultMode: '',
      policyKnown: false,
      sessionCount: 0,
      confinedCount: 0,
      anyUnconfined: false,
    },
    /** 上一次真正探测的 at(缓存命中不计数) */
    lastDetectionAt: 0,
  }
}

/**
 * `/envdock-api` 与面板的 `commandTool`(§1.4)。
 *
 * 回答:注册了吗(skipReason 说明为什么没注册)、此刻全局可见吗、用哪个终端、
 * 宿主还有哪些命令工具,以及 0.6 的两族状态(family / sessions / hidden / refuseOnly /
 * displayOnly / mixed)。没有 scopes / kind / denies / yield 之类「接管时代」的字段 ——
 * 遮挡是 restrict + guard 的产物,只报**结果**(谁被藏了、谁只能拒绝),不报逐会话账本。
 *
 * `visible` 是一次 hasTool 探针,只用于展示真相:注册成功 ≠ 模型看得见。
 */
function commandToolState(runtime, shell, sandbox, isVisible) {
  const visible = typeof isVisible === 'function' ? Boolean(isVisible(ENVD_SHELL_NAME)) : false
  const registered = runtime.registered === true
  return {
    name: ENVD_SHELL_NAME,
    registered,
    visible,
    skipReason: registered ? null : runtime.skipReason || null,
    shell: {
      label: shell && shell.label ? String(shell.label) : '',
      family: shell && shell.family ? String(shell.family) : '',
      version: shell && shell.version ? String(shell.version) : '',
      path: shell && shell.path ? String(shell.path) : '',
    },
    /** 围栏会话里本工具直接拒绝(§1.2);面板据此解释「只展示」的 badge */
    refuseWhenConfined: true,
    hostTools: (Array.isArray(runtime.hostTools) ? runtime.hostTools : []).map((tool) => ({
      name: String(tool.name || ''),
      family: String(tool.family || ''),
      learned: tool.learned === true,
      // 两族口径:'bash' | 'powershell' | ''(cmd / wsl 等)
      group: tool.group === FAMILY_BASH || tool.group === FAMILY_POWERSHELL ? tool.group : '',
    })),
    /** 0.6 两族:当前会话族(无会话时给全局口径) */
    family: runtime.family === FAMILY_BASH || runtime.family === FAMILY_POWERSHELL ? runtime.family : '',
    familySource: runtime.familySource === 'manual' ? 'manual' : 'auto',
    familyFallback: runtime.familyFallback === true,
    blockOtherFamily: runtime.blockOtherFamily !== false,
    sessions: {
      total: Number(runtime.sessions && runtime.sessions.total) || 0,
      bash: Number(runtime.sessions && runtime.sessions.bash) || 0,
      powershell: Number(runtime.sessions && runtime.sessions.powershell) || 0,
      other: Number(runtime.sessions && runtime.sessions.other) || 0,
    },
    /** 被 restrict 真正遮挡掉的内置 PowerShell 名 */
    hidden: (Array.isArray(runtime.hidden) ? runtime.hidden : []).map(String),
    /** 挡不掉、只能 guard 拒绝的名字 */
    refuseOnly: (Array.isArray(runtime.refuseOnly) ? runtime.refuseOnly : []).map(String),
    /** 启发式认出的 PowerShell 名:只展示 */
    displayOnly: (Array.isArray(runtime.displayOnly) ? runtime.displayOnly : []).map(String),
    /** 两族同时可见(手动 PowerShell + bash 族工具) */
    mixed: runtime.mixed === true,
    sandbox: { ...(sandbox || (runtime && runtime.sandbox) || {}) },
  }
}

/** 取一个可选服务(没有/抛错都当不存在)。 */
function readServiceFrom(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/**
 * 宿主执行器的**围栏能力**(部署事实,不是本会话策略)。
 *
 * `shell.sandboxMode` 是执行器公布的部署默认档,不代表任何会话被围栏。
 * 有效策略必须逐会话问 `sandboxPolicy.resolve({ session })`(见 resolveSessionMode)。
 */
function sandboxCapability(ctx) {
  const shell = readServiceFrom(ctx, 'shell')
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
 * 本会话的有效沙箱策略:policyKnown=false 表示「策略不可得」(服务缺失 / resolve 抛错 /
 * resolve 出的值不在合法闭集里)。不可得时由调用方按「被围栏」保守处理,绝不猜成无围栏。
 */
function resolveSessionMode(ctx, agent) {
  const policy = readServiceFrom(ctx, 'sandboxPolicy')
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
    if (policyKnown && !SANDBOX_MODES.has(mode)) {
      mode = ''
      policyKnown = false
    }
  }
  return { mode, policyKnown }
}

/**
 * 本会话这一刻的执行闸门(§1.2):
 *   confined=true  → 直接拒绝(不 spawn、不委托),文案见 commandTool 的 refuse();
 *   confined=false → 可以直跑。
 * 没有沙箱执行器的部署永不围栏;有执行器但判不出策略时按「有围栏」保守拒绝。
 */
function sessionGate(ctx, agent) {
  const cap = sandboxCapability(ctx)
  const resolved = resolveSessionMode(ctx, agent)
  if (!cap.present) return { capable: false, present: false, confined: false, mode: '', policyKnown: resolved.policyKnown }
  if (!cap.capable) {
    // 执行器自己都没公布围栏能力:策略可知就按策略,不可知时按旧口径放行(没有围栏可绕)。
    if (!resolved.policyKnown) return { capable: false, present: true, confined: false, mode: '', policyKnown: false }
    return { capable: false, present: true, confined: resolved.mode !== 'danger-full-access', mode: resolved.mode, policyKnown: true }
  }
  return {
    capable: true,
    present: true,
    confined: resolved.policyKnown ? resolved.mode !== 'danger-full-access' : true,
    mode: resolved.policyKnown ? resolved.mode : '',
    policyKnown: resolved.policyKnown,
  }
}

/** 宿主 agent 列表(没有 agents 服务时为空)。 */
function listAgents(ctx) {
  const agents = readServiceFrom(ctx, 'agents')
  if (!agents || typeof agents.list !== 'function') return []
  try {
    return (agents.list() || []).filter((agent) => agent && agent.id)
  } catch {
    return []
  }
}

/**
 * 沙箱聚合(§1.4 的 `sandbox` / `commandTool.sandbox`):逐会话 resolve 一次,只留聚合值。
 *
 *   anyUnconfined  = 至少一个会话 resolve 出 danger-full-access(注册条件 §1.1 第 3 条)
 *   confinedCount  = 确定被围栏的会话数
 *   policyKnown    = 所有会话的策略都判得出(任一不可知就为 false:不拿部署默认档冒充)
 */
function sandboxSummary(ctx, agentsList) {
  const cap = sandboxCapability(ctx)
  const policy = readServiceFrom(ctx, 'sandboxPolicy')
  let policyKnown = Boolean(policy && typeof policy.resolve === 'function')
  let sessionCount = 0
  let confinedCount = 0
  let anyUnconfined = false
  for (const agent of Array.isArray(agentsList) ? agentsList : []) {
    sessionCount++
    const resolved = resolveSessionMode(ctx, agent)
    if (!resolved.policyKnown) {
      policyKnown = false
      continue
    }
    if (resolved.mode === 'danger-full-access') anyUnconfined = true
    else confinedCount++
  }
  return {
    present: cap.present,
    capable: cap.capable,
    defaultMode: cap.defaultMode,
    policyKnown,
    sessionCount,
    confinedCount,
    anyUnconfined,
    // 受限会话里 envd_shell 能不能委托宿主执行器在沙箱内执行(而不是拒绝)
    delegatable: canDelegate(ctx),
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
    // 那个工具叫 pwsh、实际跑 Windows PowerShell,所以家族判定按「PowerShell 家族」做。
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

/**
 * 解析默认终端。
 *
 * 0.6 起带 `family` 参数:自动模式下按**族**挑终端(bash 族要 Git Bash,PowerShell 族要
 * pwsh/powershell),不再无条件优先 Windows 的 pwsh —— 否则 bash 族会话会拿到一个
 * 「用 PowerShell 语法」的 envd_shell,简报与执行侧直接自相矛盾。
 * `family` 省略 = 老口径(cmd / 自定义 / 无会话时的全局展示)。
 */
function resolveShell(state, detection, family) {
  const terminals = (detection && detection.terminals) || []
  const pick = (key) => terminals.find((t) => t.key === key) || null
  const wanted = state.defaultShell || 'auto'
  const group = family === FAMILY_BASH || family === FAMILY_POWERSHELL ? family : ''

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
  // 手动选的终端永远第一优先(它已经把语法族讲清楚了)。
  const explicit = wanted !== 'auto' ? pick(wanted) : null
  const preferred =
    group === FAMILY_BASH
      ? ['bash', 'zsh', 'sh']
      : group === FAMILY_POWERSHELL
        ? ['pwsh', 'powershell']
        : IS_WIN
          ? ['pwsh', 'powershell', 'cmd']
          : ['bash', 'zsh', 'sh']
  let chosen = explicit
  if (!chosen) {
    for (const key of preferred) {
      chosen = pick(key)
      if (chosen) break
    }
    // 显式的 preferred 名单没命中时,按族的**全部**终端兜底(比如只有 fish 的机器)。
    if (!chosen && group) chosen = terminals.find((t) => t.family === group) || null
    if (!chosen && !group) chosen = terminals[0] || null
  }
  if (!chosen) {
    return {
      key: 'none',
      label: group === FAMILY_BASH ? '未找到 Git Bash' : group === FAMILY_POWERSHELL ? '未找到 PowerShell' : '未探测到可用终端',
      family: group || 'custom',
      path: null,
      args: [],
    }
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
 * 沙箱受限的会话里 EnvDock 不能自己 spawn(subprocess 接口没有 sandboxPolicy 入口),
 * 但可以委托给带围栏的 `ctx.shell`:围栏挂在宿主进程上,子终端继承它。命令本身**不拼进
 * 字符串**,而是经环境变量 `ENVD_CMD` 传入 —— 宿主 → 目标终端那两层引号一次都不用写。
 *
 * 返回 { error } = 宿主族不支持安全委托(调用方据此拒绝,绝不猜语法硬拼)。
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
    //    后面的命令不再执行;直跑路径的 stdin 是 ignore,语义要一致。
    return {
      ...wrap([shell.path, '-lc', '[ -n "$ENVD_CMD" ] || exit 127; printf %s "$ENVD_CMD" | base64 -d | bash -s < /dev/null']),
      envValue: payload,
    }
  }
  if (family === 'cmd' || family === 'wsl' || family === 'custom') {
    return { error: 'unsupported', reason: '目标终端(' + family + ')不支持安全委托执行' }
  }
  // 目标 powershell:嵌套 PowerShell 从 env 解码并 Invoke-Expression。
  // [Console]::OutputEncoding 固定 UTF-8,避免非 65001 代码页下中文乱码。
  const script =
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " +
    "$c=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ENVD_CMD)); " +
    // 载荷缺失时 exit 127:空脚本 Invoke-Expression 什么都不做,会静默 exit 0。
    "if ([string]::IsNullOrEmpty($c)) { exit 127 }; " +
    "& { Invoke-Expression $c }; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }"
  return { ...wrap([shell.path, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]), envValue: payload }
}

/**
 * 宿主执行器(ctx.shell)的语法族。委托时包装串必须按**执行器**的族写,不能按宿主
 * 命令工具名猜:Windows 官方布局是 pwsh-sandbox(PowerShell),而模型手里的工具可能
 * 是别的插件发布的 bash 工具 —— 拿 bash 包装器交给 PowerShell 执行必然 ParserError。
 * 认不出返回 '' → 调用方拒绝委托,不冒险。
 */
function executorFamilyOf(ctx) {
  const shell = readServiceFrom(ctx, 'shell')
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

/** 这个部署能不能把受限会话的命令委托给宿主沙箱执行器(面板/简报据此决定说什么)。 */
function canDelegate(ctx) {
  const shell = readServiceFrom(ctx, 'shell')
  if (!shell || typeof shell.resolve !== 'function' || typeof shell.execute !== 'function') return false
  const policy = readServiceFrom(ctx, 'sandboxPolicy')
  if (!policy || typeof policy.resolve !== 'function') return false
  const family = executorFamilyOf(ctx).family
  return family === 'bash' || family === 'powershell'
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
  // probe 是**按会话**的:族 / 宿主工具 / 遮挡结果 / gate 全部按这个 agent 求值。
  // sessionless(API 简报)没有「本会话」,用 runtime 的全局快照,不下会话结论。
  const probe = probeIn && typeof probeIn === 'object' ? probeIn : {}
  const family = probe.family === FAMILY_BASH || probe.family === FAMILY_POWERSHELL ? probe.family : ''
  const shell = resolveShell(state, detection, family || undefined)
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
  lines.push(
    '- 默认终端: ' +
      (shell.key === 'none'
        ? shell.label + '(未找到;本机没有该族的可用终端)'
        : shell.label + (shell.path ? ' → ' + shell.path : '') + (shell.version ? ' (v' + shell.version + ')' : '')),
  )
  const gate = typeof probe.gate === 'function' ? probe.gate() : null
  const sessionless = probe.sessionless === true
  const registered = Boolean(runtime && runtime.registered === true)
  const skipReason = runtime && runtime.skipReason ? String(runtime.skipReason) : null
  const fallbackTools = runtime && Array.isArray(runtime.hostTools) ? runtime.hostTools : []
  const commandLine = familyBriefLine({
    family: probe.family !== undefined ? probe.family : family,
    familySource: probe.familySource || (runtime && runtime.familySource) || 'auto',
    shellLabel: shell.label,
    terminalAvailable: Boolean(shell.path),
    registered,
    skipReason,
    hostTools: Array.isArray(probe.hostTools) ? probe.hostTools : fallbackTools,
    hidden: Array.isArray(probe.hidden) ? probe.hidden : runtime && Array.isArray(runtime.hidden) ? runtime.hidden : [],
    refused: Array.isArray(probe.refused)
      ? probe.refused
      : runtime && Array.isArray(runtime.refuseOnly)
        ? runtime.refuseOnly
        : [],
    displayOnly: Array.isArray(probe.displayOnly) ? probe.displayOnly : runtime && Array.isArray(runtime.displayOnly) ? runtime.displayOnly : [],
    mixed: probe.mixed === true || Boolean(runtime && runtime.mixed === true),
    fallback: probe.fallback === true || Boolean(runtime && runtime.familyFallback === true),
    blockOtherFamily: probe.blockOtherFamily !== undefined ? probe.blockOtherFamily : runtime && runtime.blockOtherFamily,
    bashHostAvailable: probe.bashHostAvailable === true || fallbackTools.some((tool) => tool && tool.family === FAMILY_BASH),
    confined: !sessionless && Boolean(gate && gate.confined !== false),
    delegate: probe.delegate === true || Boolean(runtime && runtime.sandbox && runtime.sandbox.delegatable === true),
    sessionless,
  })
  lines.push(commandLine)
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

function envdTool(ctx, getDetection, getState, forceRefresh, runtime, gateFor, hasToolFor, familyFor) {
  /**
   * 按调用方会话求值的探针:简报要按这个会话说真话(有没有被围栏、当前族、该用哪个命令工具)。
   * execute 拿得到 exec.agent 就按它求值;没有 agent = 全局视图,不下会话结论。
   */
  const probeFor = (exec) => {
    const agent = exec && exec.agent ? exec.agent : null
    const facts = typeof familyFor === 'function' ? familyFor(agent) : null
    return {
      visible: (name) => {
        try {
          return Boolean(hasToolFor(agent, name))
        } catch {
          return false
        }
      },
      gate: () => (typeof gateFor === 'function' ? gateFor(agent) : null),
      agentId: agent ? String(agent.id) : '',
      sessionless: !agent,
      ...(facts && typeof facts === 'object' ? facts : {}),
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
        detection = await getDetection(Boolean(a.refresh) || Boolean(forceRefresh), Boolean(a.refresh) === true)
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
      // 终端行按**本会话的族**说(与简报同一口径):bash 族会话里说「终端: PowerShell 7」会自相矛盾。
      const shell = resolveShell(state, detection, probe.family || undefined)
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

// ─────────────────────────────── 命令执行工具(增补,不接管) ──

/**
 * 增补的命令工具 `envd_shell`(§1.2)。
 *
 * 两个刻意的设计,都是为了「切终端时不产生工具表空窗」:
 *   · name 固定成 ENVD_SHELL_NAME,不跟终端走 —— 名字一变,DSH 就得先拆后建;
 *   · 终端从 activeShell / 最新探测里读 —— 切终端只改「怎么执行」,不用重新注册。
 *
 * 它**不隐藏、不禁用**任何别人的工具;围栏会话里直接拒绝(不 spawn、不委托):
 * 拒绝的措辞要能让模型立刻改道去找宿主工具,而不是怀疑工具坏了或命令写错了。
 */
function commandTool(ctx, activeShell, gateFor, familyFor, hostFamilyFor) {
  /**
   * 本会话的执行闸门。取不到就按「有围栏」保守处理,绝不猜成无围栏。
   */
  const gateAt = (agent) => {
    const fallback = { present: false, capable: false, confined: true, mode: '', policyKnown: false }
    let gate = fallback
    try {
      if (typeof gateFor === 'function') gate = gateFor(agent) || fallback
    } catch {
      gate = { present: true, capable: true, confined: true, mode: '', policyKnown: false }
    }
    // 策略不可得(confined 为 null/undefined)一律按「被围栏」处理:宁可拒绝,不开无围栏旁路。
    return { ...gate, confined: gate.confined !== false }
  }

  /**
   * 沙箱受限会话:委托宿主执行器在**沙箱内**执行(0.4 的实现搬回来)。
   *
   * 为什么这样是安全的:`ctx.shell` 是带围栏的执行器,围栏挂在它启动的进程上;我们把
   * 目标终端当子进程拉起来,子进程继承同一份围栏。命令经 env 传入,不拼字符串,也不需要
   * EnvDock 自己 spawn 一条没有 sandboxPolicy 的命令。
   *
   * 返回 null = 这个部署没法安全委托(执行器缺失 / 族未知 / 目标终端族不支持 / 策略不可得):
   * 调用方据此拒绝,而不是退回无围栏 spawn。
   */
  const runDelegated = async (exec, gate, line, shell, cwd, timeoutMs) => {
    const host = ctx.get('shell')
    if (!host || typeof host.resolve !== 'function' || typeof host.execute !== 'function') {
      return { unsupported: true, reason: '宿主没有可委托的沙箱执行器(resolve/execute 缺失)' }
    }
    const agent = exec && exec.agent ? exec.agent : null
    // 没有会话就没有「本会话策略」可交给宿主执行器:这样的委托可能按部署默认档跑,拒绝。
    if (!agent) return { unsupported: true, reason: '本会话信息缺失,无法把本会话沙箱策略交给宿主执行器' }
    const hostFamily = typeof hostFamilyFor === 'function' ? String(hostFamilyFor() || '') : ''
    if (hostFamily !== 'powershell' && hostFamily !== 'bash') {
      return { unsupported: true, reason: '宿主执行器的语法族无法安全包装(cmd/未知),拒绝委托执行' }
    }
    const invocation = delegatedInvocation(hostFamily, shell, line)
    if (!invocation || invocation.error) {
      if (invocation && invocation.error === 'too-long') {
        return { unsupported: true, reason: '命令太长(' + String(line).length + ' 字符),超出委托的安全上限' }
      }
      return {
        unsupported: true,
        reason:
          '目标终端(' +
          String((shell && shell.family) || 'unknown') +
          ')不支持安全委托执行(只支持 bash / PowerShell 目标;cmd/WSL/自定义终端请用宿主工具)',
      }
    }
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
      return { unsupported: true, reason: '本会话沙箱策略不可得或非法,拒绝委托执行(不拿部署默认档冒充)' }
    }
    const env = invocation.envValue ? { ENVD_CMD: invocation.envValue } : {}
    // 和官方 shell 工具一致:带上受管的 DSH_* 快照(subprocess 会剥掉父进程的 DSH_*)。
    let dshEnv = null
    try {
      const shellEnv = ctx.get('shellEnv')
      dshEnv = shellEnv && typeof shellEnv.collect === 'function' ? shellEnv.collect(exec) : null
    } catch {
      dshEnv = null
    }
    const request = {
      command: invocation.command,
      workdir: cwd,
      timeoutMs,
      signal: exec && exec.signal,
      env,
      sandboxPolicy: policy,
    }
    if (dshEnv && typeof dshEnv === 'object') request.dshEnv = dshEnv
    const fail = (stage, error) => {
      const message = String((error && (error.message || error.name)) || error)
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
    if (!result || typeof result !== 'object') return fail('结果', new Error('宿主执行器返回了空结果'))
    const runnerFailed = Boolean(result.sandbox && result.sandbox.runnerFailed)
    const aborted = result.aborted === true
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
  /** 本会话的语法族(取不到就按全局默认,绝不猜成有终端)。 */
  const familyAt = (agent) => {
    let facts = null
    try {
      if (typeof familyFor === 'function') facts = familyFor(agent)
    } catch {
      facts = null
    }
    const family = facts && facts.family === FAMILY_BASH ? FAMILY_BASH : facts && facts.family === FAMILY_POWERSHELL ? FAMILY_POWERSHELL : ''
    return { facts: facts || {}, family }
  }
  return {
    name: ENVD_SHELL_NAME,
    description:
      '在本机默认终端里执行一条命令并返回输出(EnvDock 的增补工具,用**本会话语法族**的终端与 PATH)。' +
      '终端是哪一个、必须用哪套语法,以「本机环境 (EnvDock)」简报里「默认终端 / 命令工具」那几行为准。' +
      'EnvDock 按会话的语法族工作:bash 族会话会隐藏宿主的 PowerShell 族命令工具(pwsh/powershell,面板开关可关);' +
      '若本会话受沙箱限制,命令会**委托宿主沙箱执行器**在沙箱内执行(文件写入可能被拒绝;这个部署没有可委托的执行器时才拒绝)。' +
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
      // 终端永远读**当前**值:切终端只是换了这里的 shell,工具本身没被重建。
      // 不能直接用 activeShell.current —— 它要到下一次检查才更新(最多 5 秒),
      // 这期间简报已经写的是新终端,命令却还按旧终端跑(实测 setShell 后 200ms 内仍用旧 shell)。
      const stateNow = readState()
      const agent = exec && exec.agent ? exec.agent : null
      const at = familyAt(agent)
      const family = at.family
      // 按**调用会话的族**取终端(不是按面板里的全局默认):bash 族会话必须拿到 bash,不能拿到 pwsh。
      // 探测还没落地时退回 activeShell(只在该族匹配时)—— 不要拿另一族的 shell 顶班。
      const shell = family
        ? (cache.value ? resolveShell(stateNow, cache.value, family) : null) ||
          (activeShell.current && activeShell.current.family === family ? activeShell.current : null) ||
          resolveShell(stateNow, null, family)
        : (cache.value && resolveShell(stateNow, cache.value)) || activeShell.current || resolveShell(stateNow, null)
      const line = String((args && args.command) || '')
      if (!line.trim()) return { ok: false, text: 'command 不能为空。' }
      // 该族没有终端:明确拒绝并指路,不要让模型对着「命令没输出」猜。
      if (!shell.path) {
        const host = Array.isArray(at.facts.hostTools) ? at.facts.hostTools : []
        const hostNames = host.map((tool) => String((tool && tool.name) || '')).filter(Boolean)
        return {
          ok: false,
          text:
            '[terminal] 本会话按 ' +
            (family === FAMILY_BASH ? 'bash 族' : 'PowerShell 族') +
            ' 执行,但没有找到对应族的终端(' +
            shell.label +
            ');EnvDock 的 envd_shell 不执行命令。\n' +
            (hostNames.length
              ? '请改用宿主命令工具:' + hostNames.map((name) => '`' + name + '`').join(', ') + '。'
              : '请改用宿主命令工具,或在本机装好该族终端。'),
        }
      }
      // 工作目录 / 超时先算好:委托路径也要用(沙箱执行器自己 spawn,不用我们拼 argv)。
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
      // 沙箱闸门:每一单都按**本会话**的有效策略复检(检查周期是 5 秒,策略可能在两次之间变严)。
      // 受限会话不再直接拒绝:委托宿主执行器在**沙箱内**执行(它自己 spawn 并挂 sandboxPolicy)。
      // 只有这个部署没法安全委托(没有执行器 / 族未知 / 目标终端族不支持 / 策略不可得)才拒绝。
      const gate = gateAt(agent)
      if (gate.confined) {
        const delegated = await runDelegated(exec, gate, line, shell, cwd, timeoutMs)
        if (delegated && !delegated.unsupported) return delegated
        const host = Array.isArray(at.facts.hostTools) ? at.facts.hostTools : []
        const hostNames = host.map((tool) => '`' + String(tool.name) + '`')
        return {
          ok: false,
          text:
            '[sandbox] 本会话受宿主沙箱限制(' +
            (gate.mode || '策略未知') +
            '),EnvDock 无法在沙箱内执行这条命令: ' +
            String((delegated && delegated.reason) || '宿主沙箱执行器不可用') +
            '。\n' +
            '请改用宿主命令工具' +
            (hostNames.length ? '(' + hostNames.join(', ') + ')' : '') +
            ',它自带沙箱执行。',
        }
      }
      const argv = shellInvocation(shell, line)
      if (!argv) return { ok: false, text: '默认终端不可用: ' + shell.label }
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

  /**
   * 运行统计(§1.4 白名单):面板只需要知道「探测 / 识别 / 注册 / 遮挡到底动没动」。
   *
   * 稳态证据:ticks 涨而 registerTries / restrictApplied 不涨,就说明注册表与遮挡
   * 都没在被反复拆建;guardRefusals 只在模型仍去调被藏工具时才涨。
   */
  const syncStats = {
    ticks: 0,
    lastAt: 0,
    intervalMs: 0,
    detections: 0,
    lastDetectMs: 0,
    hostToolScans: 0,
    registerTries: 0,
    /** 累计成功施加的 restrict 次数(稳态时应趋于 0 增长) */
    restrictApplied: 0,
    /** 累计 guard 拒绝次数(模型仍去调被藏工具时才会涨) */
    guardRefusals: 0,
    lastError: null,
    lastErrorAt: 0,
  }
  /** 检查周期(默认 5s):每个 tick 重新识别宿主工具 + 复核注册条件(§1.3 二选一里的 tick 方案) */
  const syncIntervalMs = Math.min(Math.max(Number(settings.syncIntervalMs) || 5000, 20), 600000)
  syncStats.intervalMs = syncIntervalMs
  /** 本代实例的运行态:注册身份 / 宿主工具识别结果 / 沙箱聚合。brief 与 API 都读它 */
  const rt = createRuntime()
  /**
   * 两族运行态:agent → 会话记录(族 / 锁定 / 遮挡目标 / restrict 句柄)。
   *
   * 刻意放在 apply 作用域而不是 effect 里:简报、envd 工具、guard、API 都要读它,
   * 而这些注册都发生在命令工具 effect 之前。effect 只负责在对账时往里写。
   */
  const familyRuntime = {
    sessions: new Map(),
    globalFamily: FAMILY_POWERSHELL,
    globalFamilySource: 'auto',
    /**
     * 「重新探测」代数:显式 refresh 时 +1,下一次对账把所有会话的族锁定与遮挡记忆
     * 全部作废(会话族重判、已遮的 pwsh 放回)。TTL 过期/普通状态写入不涨。
     */
    epoch: 0,
    /** 手动族不可用 → 已回退 auto(brief / API 都要读) */
    fallback: false,
  }

  /** 错误记账:lastError 只代表本 tick 的问题,恢复后由检查周期清掉(不跨 tick 粘着)。 */
  const setLastError = (message) => {
    syncStats.lastError = message ? String(message) : null
    syncStats.lastErrorAt = message ? Date.now() : 0
  }

  /**
   * 跑一次探测。
   *   force      跳过缓存(TTL / 状态写入后需要新快照时用)
   *   resetFamilies 显式「重新探测」——两族重判的边界:作废族锁定与遮挡记忆
   *               (会话族按当下工具表重判,已遮挡的 pwsh 放回)。TTL 过期、切终端、
   *               改选项、`envd set_default` 都只走 force,不涨这个代数。
   */
  const getDetection = async (force, resetFamilies) => {
    const started = Date.now()
    if (force === true && resetFamilies === true) familyRuntime.epoch += 1
    const value = await detect(ctx, runner, getState(), Boolean(force))
    syncStats.lastDetectMs = Date.now() - started
    if (!rt.lastDetectionAt || (value && value.at && value.at !== rt.lastDetectionAt)) {
      syncStats.detections++
      rt.lastDetectionAt = value && value.at ? value.at : Date.now()
    }
    if (resetFamilies === true) {
      // 重判要**立刻**落地(否则面板点了「重新探测」还要等最多 5 秒的对账 tick)。
      // 排到下一轮事件循环:别在探测调用栈里重入 sync。
      setTimeout(() => {
        try {
          if (typeof notifyStateChange === 'function') notifyStateChange()
        } catch {}
      }, 0)
    }
    return value
  }

  const readService = (name) => {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }
  const toolsOf = (context) => {
    try {
      return context && typeof context.get === 'function' ? context.get('tools') : undefined
    } catch {
      return undefined
    }
  }
  /**
   * 某个作用域里有没有这个工具。
   * 注意 `tools.get(name)` 是**全局视图**:preset 把命令工具注册在 agent 作用域里,
   * 不传 agent 当 scope 就查不到。
   * 有 agent 作用域时优先问 `tools.executable(name, agent)`(「注册了」≠「这一单能调」);
   * 老宿主没有 executable → 回落 get;全局视图(agent 省略)也走 get。
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
      return Boolean(current) && current === rt.ownDefinition
    } catch {
      return false
    }
  }

  /**
   * 作用域 → agent 的索引。systemPrompt.context 早于下面那个 effect 注册,而简报要按会话
   * 说「本会话有没有被围栏」;每次检查从 agents.list() 重建,不监听 agent 生命周期,
   * 也就不需要任何逐会话账本(§1.3:不需要 per-session facts)。
   */
  const scopeAgents = new Map()
  // context.scope 一般就是 agent 本身;映射没命中时按「对象自带 id+ctx」兜底 ——
  // 新会话的第一步可能早于下一轮 tick,不能因此把「本会话被围栏」说成「不知道」。
  const agentOfScope = (scope) =>
    (scope && scopeAgents.get(scope)) || (scope && typeof scope === 'object' && scope.id && scope.ctx ? scope : null)
  const gateFor = (agent) => sessionGate(ctx, agent)
  const hasToolFor = (agent, name) => hasTool(agent && agent.ctx ? agent.ctx : ctx, name, agent)

  /**
   * 某个会话的两族事实(brief / envd / 执行侧共用一个口径)。
   * 会话记录还没建立(首次 tick 之前)时回落到 runtime 的全局快照 —— 宁可说全局事实,
   * 不要凭空猜一个族。sessionless(API)也走这条。
   */
  const familyProbeFor = (agent) => {
    const record = agent ? familyRuntime.sessions.get(agent) : null
    if (record) {
      return {
        family: record.group,
        familySource: record.source,
        hostTools: Array.isArray(record.hostTools) ? record.hostTools : rt.hostTools,
        hidden: [...(record.restrictedNames || record.hide || [])],
        refused: [...(record.refuse || [])],
        displayOnly: Array.isArray(record.displayOnly) ? record.displayOnly : [],
        mixed: record.mixed === true,
        blockOtherFamily: record.blockOtherFamily !== false,
        bashHostAvailable: record.bashHostAvailable === true,
        fallback: familyRuntime.fallback === true,
        delegate: canDelegate(ctx),
      }
    }
    // 会话记录还没建立(首次 tick 之前):按手动选择 + 该作用域此刻可见的 bash 族名字
    // 现算一次,**不要**拿全局快照冒充「本会话」——新会话第一步的简报必须说对语法族
    // (dsh-ops 的 ops_bash 可能晚一轮发布,这一步最多错一个 tick)。
    const shellChoice = String(getState().defaultShell || 'auto')
    const manualMode = shellChoice !== 'auto'
    const manual = manualFamilyOf(shellChoice)
    let family = ''
    if (manualMode) family = manual // cmd / custom:不参与两族
    else if (agent) family = ['ops_bash', 'bash', 'sh', 'zsh', 'fish'].some((name) => hasToolFor(agent, name)) ? FAMILY_BASH : FAMILY_POWERSHELL
    else family = familyRuntime.globalFamily
    return {
      family,
      familySource: manualMode ? 'manual' : familyRuntime.globalFamilySource,
      hostTools: rt.hostTools,
      hidden: rt.hidden,
      refused: rt.refuseOnly,
      displayOnly: rt.displayOnly,
      mixed: rt.mixed === true,
      blockOtherFamily: rt.blockOtherFamily !== false,
      bashHostAvailable:
        family === FAMILY_BASH && (agent ? ['ops_bash', 'bash', 'sh', 'zsh', 'fish'].some((name) => hasToolFor(agent, name)) : rt.hostTools.some((tool) => tool && tool.family === FAMILY_BASH)),
      fallback: familyRuntime.fallback === true,
      delegate: canDelegate(ctx),
    }
  }

  /** 增补命令工具执行时读它:切终端只改这里,注册表一个字节都不动。 */
  const activeShell = { current: null }

  // 1) 环境简报(每步重新求值:终端 / 工具表 / 沙箱状态变了立即生效)
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt && typeof systemPrompt.context === 'function') {
    ctx.effect(
      () =>
        systemPrompt.context({
          name: 'envdock',
          order: 900,
          text: (context) => {
            if (settings.injectBrief === false) return ''
            const state = getState()
            // 归一化之后只会是布尔:消费端一律 === true
            if (state.options.injectBrief !== true) return ''
            if (cache.value) {
              const agent = agentOfScope(context && context.scope)
              return brief(
                cache.value,
                state,
                {
                  visible: (name) => hasToolFor(agent, name),
                  gate: () => gateFor(agent),
                  agentId: agent ? String(agent.id) : '',
                  sessionless: !agent,
                  ...familyProbeFor(agent),
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
      () => ctx.tools.register(envdTool(ctx, getDetection, getState, false, rt, gateFor, hasToolFor, familyProbeFor), 'envdock tool'),
      'envdock tool',
    )
  }

  // 2.5) 两族 guard(根层注册一次 → 全局生效;按 exec.agent 的会话记录决定是否拒绝)
  //
  // restrict 只能遮挡**继承层**名字:preset 把 pwsh 注册在 agent 自有层时挡不掉(dsh-ops
  // 的 ops_bash 就是自有层)。那类名字走 guard:dispatch 之前就拒绝,不 spawn、不委托。
  // 契约上 guard 是单调的(只能加否定),所以它只拒绝「本会话族明确要求遮挡」的内置名。
  if (ctx.get('tools')) {
    ctx.effect(
      () =>
        ctx.tools.guard((exec) => {
          const agent = exec && exec.agent
          if (!agent) return undefined
          const record = familyRuntime.sessions.get(agent)
          if (!record || !record.refuse || record.refuse.size === 0) return undefined
          const name = String((exec && exec.name) || '')
          if (!record.refuse.has(name)) return undefined
          syncStats.guardRefusals++
          return (
            name +
            ' 在本会话已被 EnvDock 隐藏(bash 族会话);请改用 ops_bash 或 envd_shell,并按 bash 语法写命令。'
          )
        }),
      'envdock family guard',
    )
  }

  // 3) 增补命令工具 envd_shell + 两族对账(0.6)
  //
  // 两件事落在同一个 effect 里:
  //   · 注册 envd_shell:主族终端可用 + 沙箱允许 + 名字没被占(不再有「同族不重复提供」);
  //   · 逐会话选族 + 遮挡:bash 族会话把内置 PowerShell 名 restrict 掉(继承层),
  //     挡不掉的(agent 自有层)交给根层 guard 在 dispatch 前拒绝。
  // 稳态 tick 不产生注册表动作:只有族/目标集合真的变化时才 restrict 或撤销。
  ctx.effect(() => {
    let disposeTool = null
    /** envd_shell 是否由**我们**注册成功(登记身份见 rt.ownDefinition) */
    let ownRegistered = false
    /** 注册失败后的退避门槛(§1.1 第 4 条:不重试超过既有退避节奏) */
    let retryAt = 0
    /** tools/change 触发的重扫允许跳过退避(别的插件可能刚释放了名字) */
    let retryNow = false
    /** 正在等新探测落地(避免 sync → 刷新 → sync 自己咬自己) */
    let refreshing = false
    /** 本代实例是否已卸载 */
    let stopped = false
    /** 正在扫宿主工具 / 动注册表:这期间宿主同步派发的 tools/change 不能重入 */
    let scanning = false
    /** 事件驱动重扫的合并定时器(宿主一次注册会连发多枚 tools/change) */
    let pendingRescan = null
    /** 重扫进行中收到的 tools/change:结束后补排一次,不能丢 */
    let pendingAfterScan = false
    const timers = new Set()
    const cleanups = []

    /** 一个工具定义 → 宿主命令工具条目(name 为空/不是命令工具返回 null)。 */
    const classifyHostTool = (def) => {
      const name = def && def.name ? String(def.name) : ''
      if (!name || name === ENVD_SHELL_NAME) return null
      const family = shellFamilyFromDefinition(def)
      if (!family) return null
      const learned = !Object.prototype.hasOwnProperty.call(SHELL_TOOL_FAMILY, name.toLowerCase())
      return {
        name,
        family,
        learned,
        group: family === FAMILY_BASH || family === FAMILY_POWERSHELL ? family : '',
      }
    }

    /**
     * 一个会话的两族事实:
     *   hostTools  该作用域此刻看得见的宿主命令工具(definitions 已扣掉遮挡)
     *   known      该作用域登记过的名字(view.knownNames:含 agent 自有层)
     *   restrictable 可被 restrict 的名字(view.restrictableNames:只含继承层)
     * 老宿主没有 view 时退化成「看得见的都当可 restrict」——宁可多挡一次,不要漏挡。
     */
    const sessionFacts = (agent) => {
      const context = agent && agent.ctx ? agent.ctx : ctx
      const tools = toolsOf(context)
      const hostTools = []
      const known = new Set()
      const restrictable = new Set()
      let scanned = false
      if (tools && typeof tools.definitions === 'function') {
        scanned = true
        let defs = []
        try {
          defs = tools.definitions(agent) || []
        } catch {
          defs = []
        }
        for (const def of defs) {
          const item = classifyHostTool(def)
          if (item) hostTools.push(item)
        }
      }
      if (!scanned) {
        for (const name of SHELL_TOOL_NAMES) {
          if (name === ENVD_SHELL_NAME) continue
          if (!hasTool(context, name, agent)) continue
          const family = SHELL_TOOL_FAMILY[name.toLowerCase()]
          if (!family) continue
          hostTools.push({
            name,
            family,
            learned: false,
            group: family === FAMILY_BASH || family === FAMILY_POWERSHELL ? family : '',
          })
        }
      }
      if (tools && typeof tools.view === 'function') {
        try {
          const view = tools.view(agent)
          if (view && view.knownNames && typeof view.knownNames[Symbol.iterator] === 'function') {
            for (const name of view.knownNames) known.add(String(name))
          }
          if (view && view.restrictableNames && typeof view.restrictableNames[Symbol.iterator] === 'function') {
            for (const name of view.restrictableNames) restrictable.add(String(name))
          }
        } catch {}
      }
      if (!known.size) {
        for (const tool of hostTools) {
          known.add(tool.name)
          restrictable.add(tool.name)
        }
      }
      return { hostTools, known, restrictable }
    }

    /** 撤销一个会话的遮挡并把它从记录里移除(agent/disposed、会话消失、卸载都走这里)。 */
    const dropFamilySession = (agent) => {
      const record = familyRuntime.sessions.get(agent)
      if (!record) return
      familyRuntime.sessions.delete(agent)
      if (record.restrictDispose) {
        try {
          record.restrictDispose()
        } catch {}
        record.restrictDispose = null
      }
      record.hide = new Set()
      record.refuse = new Set()
      record.restrictedNames = new Set()
    }

    /**
     * 把 record.hide 施加成该 agent 作用域的 restrict(或撤销)。
     * `tools.restrict` 只能从**有作用域的 ctx** 调:root 调会直接抛错(实测 dsh-tools),
     * 所以这里永远通过 `toolsOf(agent.ctx)` 拿一个绑到该 agent 的 traceable 服务。
     */
    const applyFamilyRestriction = (agent, record) => {
      const next = record.hide instanceof Set ? record.hide : new Set()
      const previous = record.restrictedNames instanceof Set ? record.restrictedNames : new Set()
      const same = next.size === previous.size && [...next].every((name) => previous.has(name))
      if (same && !(next.size > 0 && !record.restrictDispose)) return
      if (record.restrictDispose) {
        try {
          record.restrictDispose()
        } catch {}
        record.restrictDispose = null
      }
      record.restrictedNames = new Set()
      if (!next.size) return
      const tools = toolsOf(agent && agent.ctx ? agent.ctx : ctx)
      if (!tools || typeof tools.restrict !== 'function') return
      try {
        const dispose = tools.restrict({ deny: [...next].sort() })
        record.restrictDispose = typeof dispose === 'function' ? dispose : null
        record.restrictedNames = new Set(next)
        syncStats.restrictApplied++
      } catch (error) {
        // 扫描与施加之间名字消失了 / 老宿主不接受:不崩溃 —— guard 仍会兜住执行侧
        record.restrictDispose = null
        record.restrictedNames = new Set()
        setLastError('遮挡 ' + [...next].join('/') + ' 失败: ' + String((error && error.message) || error))
      }
    }

    /**
     * 逐会话选族 + 遮挡。只看状态与工具表,不依赖探测结果(工具表一变立刻对账)。
     */
    const reconcileFamilies = (state, agentsList, scan) => {
      const now = Date.now()
      const wanted = new Set(agentsList)
      // 会话没了(disposed 事件丢了 / 列表提前移除):立刻撤销残留遮挡
      for (const agent of [...familyRuntime.sessions.keys()]) if (!wanted.has(agent)) dropFamilySession(agent)
      // 「重新探测」之后:族锁定与遮挡记忆一起作废(先撤销 restrict,再按新事实重判)
      for (const agent of agentsList) {
        const stale = familyRuntime.sessions.get(agent)
        if (stale && stale.epoch !== familyRuntime.epoch) dropFamilySession(agent)
      }
      const manualKey = String(state.defaultShell || 'auto')
      const manualMode = manualKey !== 'auto'
      const manualRequested = manualFamilyOf(manualKey)
      const blockOtherFamily = state.options.blockOtherFamily !== false
      const summary = { total: agentsList.length, bash: 0, powershell: 0, other: 0 }
      const hidden = new Set()
      const refuseOnly = new Set()
      const displayOnly = new Set()
      let mixed = false
      // 每个会话的工具表事实只算一次(族判定、遮挡、手动族可用性都用它)
      const factsByAgent = new Map()
      for (const agent of agentsList) factsByAgent.set(agent, sessionFacts(agent))
      const allFacts = agentsList.length ? [...factsByAgent.values()] : [{ hostTools: scan.tools }]
      /**
       * 手动选族但**该族既没有终端、也没有对应宿主工具** → 回退 auto 并警告。
       * 否则面板写着「bash 族」、实际却连一个 bash 都跑不了,模型会照着简报写 bash 命令。
       * 探测还没就绪时不判不可用(避免启动瞬间来回抖)。
       */
      let manual = manualRequested
      let manualFallback = false
      if (manualMode && manualRequested) {
        const terminalAvailable = cache.value ? Boolean((resolveShell(state, cache.value, manualRequested) || {}).path) : true
        const hostAvailable = allFacts.some((facts) => facts.hostTools.some((tool) => tool.family === manualRequested))
        if (!terminalAvailable && !hostAvailable) {
          manual = ''
          manualFallback = true
        }
      }
      const useManual = manualMode && (manualRequested ? manual !== '' : true)
      for (const agent of agentsList) {
        const facts = factsByAgent.get(agent)
        const previous = familyRuntime.sessions.get(agent) || null
        // **记忆**:definitions(agent) 会扣掉我们已经 restrict 掉的名字 —— 只按它判,下一轮
        // 就看不见 pwsh 了,于是「撤销 → 重新看见 → 再遮挡」无限振荡。上一次的目标集合里
        // 仍登记着的名字要补回来;只有确认注册表里已经没有它(全局 get 为空且本会话定义面
        // 也没有)时才遗忘。
        if (previous) {
          const remember = (name, restrictableHint) => {
            const text = String(name || '')
            if (!text || facts.known.has(text)) return
            let alive = false
            try {
              const globalTools = toolsOf(ctx)
              alive = Boolean(globalTools && typeof globalTools.get === 'function' && globalTools.get(text))
            } catch {}
            if (!alive && !facts.hostTools.some((tool) => tool.name === text)) return
            facts.known.add(text)
            if (restrictableHint) facts.restrictable.add(text)
          }
          for (const name of previous.hide || []) remember(name, true)
          for (const name of previous.refuse || []) remember(name, previous.restrictedNames instanceof Set && previous.restrictedNames.has(name))
        }
        let group = ''
        let source = 'auto'
        let at = now
        let upgraded = true
        if (useManual) {
          group = manualRequested ? manual : ''
          source = 'manual'
          if (previous && previous.source === 'manual' && previous.group === group) {
            at = previous.at
            upgraded = previous.upgraded === true
          }
        } else {
          const decided = resolveSessionFamily({
            manual: '',
            auto: autoFamilyOf(facts.hostTools),
            record: previous
              ? { source: previous.source, group: previous.group, at: previous.at, upgraded: previous.upgraded }
              : null,
            now,
          })
          group = decided.group
          source = decided.source
          at = decided.record.at
          upgraded = decided.record.upgraded === true
        }
        // 会话族 bash 且看得到 bash 族宿主工具 → 目标集合;否则为空(不遮挡)。
        // sticky:已经遮过就保持(工具表暂时缺 bash 族工具时不来回闪),直到重新探测/开关关闭。
        const sticky = previous ? previous.masked === true : false
        const mask = familyMask({
          group,
          blockOtherFamily,
          sticky,
          hostTools: facts.hostTools,
          known: facts.known,
          restrictable: facts.restrictable,
        })
        const record = previous || {
          agentId: '',
          hide: new Set(),
          refuse: new Set(),
          restrictedNames: new Set(),
          restrictDispose: null,
        }
        record.agentId = String((agent && agent.id) || '')
        record.group = group
        record.source = source
        record.at = at
        record.upgraded = upgraded
        record.epoch = familyRuntime.epoch
        record.blockOtherFamily = blockOtherFamily
        record.bashHostAvailable = facts.hostTools.some((tool) => tool.family === FAMILY_BASH)
        record.hostTools = facts.hostTools
        record.displayOnly = mask.displayOnly
        record.masked = mask.active
        record.mixed = source === 'manual' && group === FAMILY_POWERSHELL && record.bashHostAvailable
        record.refuse = new Set(mask.refuse)
        record.hide = new Set(mask.hide)
        // 先更新拒绝集合再动 restrict:中间任何失败都不会让执行侧失去兜底。
        applyFamilyRestriction(agent, record)
        familyRuntime.sessions.set(agent, record)

        if (group === FAMILY_BASH) summary.bash++
        else if (group === FAMILY_POWERSHELL) summary.powershell++
        else summary.other++
        const reallyHidden = record.restrictedNames instanceof Set ? record.restrictedNames : record.hide
        for (const name of reallyHidden) hidden.add(name)
        for (const name of record.refuse) if (!reallyHidden.has(name)) refuseOnly.add(name)
        for (const name of record.displayOnly) displayOnly.add(name)
        if (record.mixed) mixed = true
      }
      rt.sessions = summary
      rt.hidden = [...hidden].sort()
      rt.refuseOnly = [...refuseOnly].sort()
      rt.displayOnly = [...displayOnly].sort()
      rt.mixed = mixed
      rt.blockOtherFamily = blockOtherFamily
      rt.familyFallback = manualFallback
      familyRuntime.fallback = manualFallback
      if (useManual) {
        familyRuntime.globalFamily = manualRequested ? manual : ''
        familyRuntime.globalFamilySource = 'manual'
      } else {
        const anyBash = summary.bash > 0 || rt.hostTools.some((tool) => tool && tool.family === FAMILY_BASH)
        familyRuntime.globalFamily = anyBash ? FAMILY_BASH : FAMILY_POWERSHELL
        familyRuntime.globalFamilySource = 'auto'
      }
      rt.family = familyRuntime.globalFamily
      rt.familySource = familyRuntime.globalFamilySource
    }

    /** 拆掉我们自己的工具(只动自己那一份;绝不碰别人的工具)。 */
    const dropTool = () => {
      if (disposeTool) {
        try {
          disposeTool()
        } catch {}
        disposeTool = null
      }
      ownRegistered = false
      rt.ownDefinition = null
    }

    /**
     * 注册 envd_shell。成功返回 null,失败返回原因(直接进 `commandTool.skipReason`)。
     *
     * 「注册成功」≠「模型看得见」:注册后立刻核对登记身份 —— 同名工具被别的层盖住时,
     * 那不是我们的工具,不能认领(认领了就等于去挡别人的发布生命周期)。
     */
    const registerTool = () => {
      if (hasTool(ctx, ENVD_SHELL_NAME)) {
        setLastError(ENVD_SHELL_NAME + ' 已被其它插件占用,EnvDock 不注册')
        return 'taken'
      }
      syncStats.registerTries++
      const definition = commandTool(ctx, activeShell, gateFor, familyProbeFor, () => executorFamilyOf(ctx).family)
      let dispose = null
      try {
        dispose = ctx.tools.register(definition)
      } catch (error) {
        // 同层重名 / 保留名:注册不上就如实记原因,宿主自带的那份继续干活
        setLastError('注册 ' + ENVD_SHELL_NAME + ' 失败: ' + ((error && error.message) || error))
        console.error('[envdock] 注册命令工具 ' + ENVD_SHELL_NAME + ' 失败:', error && error.message)
        return 'error'
      }
      if (typeof dispose !== 'function') {
        setLastError('注册 ' + ENVD_SHELL_NAME + ' 没有返回 disposer')
        return 'error'
      }
      let registered = null
      try {
        const tools = toolsOf(ctx)
        registered = tools && typeof tools.get === 'function' ? tools.get(ENVD_SHELL_NAME) : null
      } catch {}
      if (!registered || registered !== definition) {
        try {
          dispose()
        } catch {}
        setLastError(ENVD_SHELL_NAME + ' 注册成功但工具表里不是我们这一份(被同名工具盖住)')
        return 'taken'
      }
      disposeTool = dispose
      ownRegistered = true
      rt.ownDefinition = definition
      return null
    }

    /**
     * 探测缓存刚被作废(切终端 / 改选项 / 写状态)时,**先等新探测落地再检查**。
     * 否则会先按旧终端算一次、探测回来又按新终端算一次 —— 一次操作拆建两回。
     */
    const refreshThenSync = () => {
      if (stopped || refreshing) return
      refreshing = true
      getDetection(false).then(
        (value) => {
          refreshing = false
          if (stopped) return
          // detect() 失败会抛错、成功一定返回快照;拿到空值说明调用链被改坏了,别当成功继续
          if (!value) {
            setLastError('探测返回空快照,跳过本轮检查')
            return
          }
          try {
            sync()
          } catch {}
        },
        (error) => {
          refreshing = false
          if (stopped) return
          setLastError('探测失败: ' + String((error && error.message) || error))
          // 只有旧快照还在时才拿它继续检查(at===0 时会立刻再触发一次探测,失败就是死循环)
          if (cache.value && cache.at > 0) {
            try {
              sync()
            } catch {}
          }
        },
      )
    }

    /**
     * 宿主命令工具识别(§1.3,**只用于展示**)。
     *
     * 每个 agent 枚举一次 `tools.definitions(agent)` 求并集;家族判定复用
     * shellFamilyFromDefinition / SHELL_TOOL_FAMILY。`learned` 的语义是「按描述/参数启发式
     * 认出来的,不是内置名单里的名字」。老宿主没有 definitions 时退回按内置名字探可见性。
     */
    /**
     * 枚举宿主命令工具:并集(展示) + 逐会话明细(族判定 / 遮挡)。
     * 返回 { tools: 排序后的并集, byAgent: Map(agent → 该会话的条目) }。
     * byAgent 只在有 agent 时有意义;老宿主没有 definitions 时按内置名字逐个探。
     */
    const scanHostTools = (agentsList) => {
      const found = new Map()
      const byAgent = new Map()
      const merge = (item) => {
        const prev = found.get(item.name)
        // 同一个名字既可能被内置名单认到、也可能被启发式认到:内置优先(learned=false)
        if (!prev || (prev.learned === true && !item.learned)) found.set(item.name, item)
      }
      const seen = (list) => {
        const out = []
        const names = new Set()
        for (const item of list) {
          if (!item || names.has(item.name)) continue
          names.add(item.name)
          out.push(item)
        }
        return out
      }
      let scanned = false
      for (const agent of agentsList) {
        const context = agent && agent.ctx ? agent.ctx : ctx
        const tools = toolsOf(context)
        const mine = []
        if (tools && typeof tools.definitions === 'function') {
          scanned = true
          let defs = []
          try {
            defs = tools.definitions(agent) || []
          } catch {
            defs = []
          }
          for (const def of defs) {
            const item = classifyHostTool(def)
            if (!item) continue
            merge(item)
            mine.push(item)
          }
        } else {
          // 老宿主:没有定义面,按内置名字探这个会话的可见性(名字集合有界)
          for (const name of SHELL_TOOL_NAMES) {
            if (name === ENVD_SHELL_NAME) continue
            if (!hasTool(context, name, agent)) continue
            const family = SHELL_TOOL_FAMILY[name.toLowerCase()]
            if (!family) continue
            const item = {
              name,
              family,
              learned: false,
              group: family === FAMILY_BASH || family === FAMILY_POWERSHELL ? family : '',
            }
            merge(item)
            mine.push(item)
          }
        }
        byAgent.set(agent, seen(mine))
      }
      if (!agentsList.length || !scanned) {
        // 没有 agent(或作用域里没有定义面)时问一次全局定义面
        const tools = toolsOf(ctx)
        if (tools && typeof tools.definitions === 'function') {
          let defs = []
          try {
            defs = tools.definitions() || []
          } catch {
            defs = []
          }
          for (const def of defs) {
            const item = classifyHostTool(def)
            if (item) merge(item)
          }
        } else if (!agentsList.length) {
          for (const name of SHELL_TOOL_NAMES) {
            if (name === ENVD_SHELL_NAME) continue
            if (!hasTool(ctx, name)) continue
            const family = SHELL_TOOL_FAMILY[name.toLowerCase()]
            if (!family) continue
            merge({ name, family, learned: false, group: family === FAMILY_BASH || family === FAMILY_POWERSHELL ? family : '' })
          }
        }
      }
      // 名字集合要有界(第三方发布名会轮换,只增不减会让每 tick 的遍历与 GET 载荷线性膨胀)
      while (found.size > 64) found.delete(found.keys().next().value)
      const rank = (name) => {
        const known = SHELL_TOOL_ORDER.indexOf(name)
        return known >= 0 ? known : SHELL_TOOL_ORDER.length
      }
      // 排序稳定:内置顺序优先,其余按名字
      const tools = [...found.values()].sort((a, b) => rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      return { tools, byAgent }
    }

    /**
     * 一次检查(tick):枚举宿主工具 → 聚合沙箱 → 逐会话选族+遮挡 → 按状态差决定注册 / 拆除。
     *
     * 0.6 的注册条件:主族终端有可用 path(主族 = 手动族,否则全局默认族)+ 沙箱允许 +
     * 名字没被占。不再有「同族不重复提供」——bash 族会话本来就要同时看到 ops_bash 与 envd_shell。
     * 稳态 tick 唯一的注册表读操作是「我们自己的工具还在不在」,一次 get。
     */
    const reconcile = () => {
      const state = getState()
      const agentsList = listAgents(ctx)
      scopeAgents.clear()
      for (const agent of agentsList) {
        try {
          scopeAgents.set(agent, agent)
        } catch {}
      }

      // ── 1. 宿主命令工具:并集展示 + 逐会话明细(族判定/遮挡要用) ──
      const scan = scanHostTools(agentsList)
      rt.hostTools = scan.tools
      syncStats.hostToolScans++

      // ── 2. 沙箱聚合(能力位 / 逐会话策略 → 聚合值) ──
      const sandbox = sandboxSummary(ctx, agentsList)
      rt.sandbox = sandbox

      // ── 3. 两族对账(不依赖探测:工具表一变就能立刻选族/遮挡) ──
      reconcileFamilies(state, agentsList, scan)

      // ── 4. 主终端 + 注册条件 ──
      if (!cache.value || cache.at === 0) {
        refreshThenSync()
        return
      }
      const detection = cache.value
      // 主族 = 生效族(reconcileFamilies 已处理「手动族不可用 → 回退 auto」),
      // 不能用 state.defaultShell 直接推:回退之后它还是那个不可用的手动族。
      const primaryFamily = familyRuntime.globalFamily || ''
      const shell = resolveShell(state, detection, primaryFamily || undefined)
      activeShell.current = shell
      let want = true
      let skipReason = null
      if (!shell.path) {
        want = false
        skipReason = 'no-family-terminal'
        setLastError('主族没有可用终端: ' + shell.label)
      } else if (sandbox.capable && !sandbox.anyUnconfined && !sandbox.delegatable) {
        // 有围栏执行器、却没有任何会话 resolve 出 danger-full-access,而且这个部署**不能**
        // 把受限会话的命令委托给宿主沙箱执行器:注册了也只会拒绝,等于死工具 —— 不注册。
        // 能委托时就照常注册:受限会话里通过宿主执行器在沙箱内执行。
        want = false
        skipReason = 'no-unconfined-session'
      }

      // ── 5. 只按状态变化驱动注册 / 拆除 ──
      if (want) {
        // 句柄在、但注册表里已经不是我们那一份(被顶掉 / 热重载):作废重来
        if (ownRegistered && !isOwnDefinition(ctx)) dropTool()
        if (ownRegistered) {
          rt.skipReason = null
          retryAt = 0
        } else {
          const backingOff = retryAt && Date.now() < retryAt && !retryNow
          if (!backingOff) {
            const reason = registerTool()
            retryAt = reason ? Date.now() + 30000 : 0
            if (!reason) setLastError(null)
            rt.skipReason = ownRegistered ? null : reason
          }
        }
      } else {
        if (ownRegistered) dropTool()
        rt.skipReason = skipReason
        retryAt = 0
      }
      retryNow = false
      rt.registered = ownRegistered
      if (ownRegistered) rt.skipReason = null
    }

    const sync = () => {
      // 卸载之后任何回调(残留的定时器、探测回调)都不许再动注册表
      if (stopped) return
      syncStats.ticks++
      scanning = true
      try {
        reconcile()
      } catch (error) {
        setLastError(String((error && error.message) || error))
        console.error('[envdock] 更新增补命令工具失败:', error && error.message)
      } finally {
        scanning = false
        syncStats.lastAt = Date.now()
        if (pendingAfterScan) {
          pendingAfterScan = false
          scheduleSync()
        }
      }
    }

    /**
     * 工具表变了就立刻重新识别宿主工具 + 必要时重挂/拆自己的工具(§1.1 唯一的轻量监听)。
     * 不做逐会话对账、不看别人的可见性:把同一次变更合并成一轮。
     */
    const scheduleSync = () => {
      if (stopped || pendingRescan) return
      // 重扫期间宿主会同步派发 tools/change:别丢弃,记一个「待补跑」,结束后立刻排一次
      if (scanning) {
        pendingAfterScan = true
        return
      }
      const timer = setTimeout(() => {
        timers.delete(timer)
        pendingRescan = null
        // 事件驱动的重扫允许跳过注册失败退避(别的插件可能刚释放了名字)
        retryNow = true
        try {
          sync()
        } finally {
          retryNow = false
        }
      }, 40)
      pendingRescan = timer
      timers.add(timer)
    }
    try {
      const off = ctx.on('tools/change', scheduleSync)
      if (typeof off === 'function') cleanups.push(off)
    } catch (error) {
      // 没有这个事件(旧宿主)也不致命:5 秒 tick 兜底
      console.error('[envdock] 监听 tools/change 失败:', error && error.message)
    }
    // agent 销毁:立刻撤销这个会话的 restrict(真机上 agent 作用域的 effect 也会跟着释放,
    // 但句柄在我们手里,显式撤销才不会留下「撤不掉的残留」)。
    try {
      const offDisposed = ctx.on('agent/disposed', (payload) => {
        const agent = payload && payload.agent ? payload.agent : payload && payload.id ? payload : null
        if (!agent) return
        dropFamilySession(agent)
        scheduleSync()
      })
      if (typeof offDisposed === 'function') cleanups.push(offDisposed)
    } catch {
      // 老宿主没有这个事件:tick 里的「会话消失」分支兜底
    }

    const onStateChange = () => {
      if (stopped) return
      try {
        sync()
      } catch (error) {
        console.error('[envdock] 状态变更后重新检查失败:', error && error.message)
      }
    }
    notifyStateChange = onStateChange
    const timer = setInterval(sync, syncIntervalMs)
    const kick = setTimeout(sync, 1200)
    return () => {
      // 先立 stopped 哨兵,再清定时器:否则「正在跑的回调」还能在卸载之后把工具注册回来,
      // 留下一个占着 envd_shell 的幽灵,下一次启用会被永久判成「已被其它插件占用」。
      stopped = true
      clearInterval(timer)
      clearTimeout(kick)
      for (const pending of timers) clearTimeout(pending)
      timers.clear()
      for (const off of cleanups) {
        try {
          if (typeof off === 'function') off()
        } catch {}
      }
      // 插件热重载时别把下一代的钩子置空
      if (notifyStateChange === onStateChange) notifyStateChange = null
      // 撤销所有逐会话遮挡:插件卸载不允许留下任何 restrict 残留(最危险的一类 bug)
      for (const agent of [...familyRuntime.sessions.keys()]) dropFamilySession(agent)
      familyRuntime.globalFamily = FAMILY_POWERSHELL
      familyRuntime.globalFamilySource = 'auto'
      familyRuntime.fallback = false
      dropTool()
      rt.registered = false
      rt.skipReason = null
      rt.hostTools = []
      rt.family = ''
      rt.familySource = 'auto'
      rt.sessions = { total: 0, bash: 0, powershell: 0, other: 0 }
      rt.hidden = []
      rt.refuseOnly = []
      rt.displayOnly = []
      rt.mixed = false
      rt.familyFallback = false
      scopeAgents.clear()
    }
  }, 'envdock command tool')

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
                // 主终端按全局默认族解析:panel 的 shell 行必须和简报的「默认终端」一致。
                const shell = resolveShell(state, detection, (familyRuntime.globalFamily || undefined))
                // 宿主命令工具识别结果与沙箱聚合:API 每次现算,面板拿到的是「此刻」的事实。
                const agentsList = listAgents(ctx)
                const sandbox = sandboxSummary(ctx, agentsList)
                // visible 只做一次探针:注册成功 ≠ 模型看得见(仅用于展示真相)。
                const commandTool = commandToolState(rt, shell, sandbox, (name) => hasTool(ctx, name))
                json(res, {
                  ok: true,
                  state,
                  shell: { key: shell.key, label: shell.label, family: shell.family, path: shell.path, version: shell.version || '' },
                  // 0.6 两族:全局默认族 + 来源(API 没有 agent,不下「本会话」结论)
                  family: familyRuntime.globalFamily,
                  familySource: familyRuntime.globalFamilySource,
                  familyFallback: familyRuntime.fallback === true,
                  commandTool,
                  // 沙箱:执行器能力位 + 聚合后的逐会话事实(§1.4,不再有 scopes)
                  sandbox,
                  syncStats: {
                    ticks: syncStats.ticks,
                    lastAt: syncStats.lastAt,
                    intervalMs: syncStats.intervalMs,
                    detections: syncStats.detections,
                    lastDetectMs: syncStats.lastDetectMs,
                    hostToolScans: syncStats.hostToolScans,
                    registerTries: syncStats.registerTries,
                    restrictApplied: syncStats.restrictApplied,
                    guardRefusals: syncStats.guardRefusals,
                    lastError: syncStats.lastError,
                    lastErrorAt: syncStats.lastErrorAt,
                  },
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
                      gate: () => sessionGate(ctx, null),
                      // API 没有 agent:简报不下「本会话」结论(sessionless),用全局族快照
                      sessionless: true,
                      ...familyProbeFor(null),
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
                const detection = await getDetection(true, true)
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
                // 白名单 + 归一化:布尔只收 true/false(其它值按 false)。
                // 0.5.0 起删掉了接管开关;0.6.0 新增 blockOtherFamily(遮挡另一族的内置命令工具)。
                if (has('injectBrief')) {
                  options.injectBrief = body.injectBrief === true
                  touched = true
                }
                if (has('allowLan')) {
                  options.allowLan = body.allowLan === true
                  touched = true
                }
                if (has('blockOtherFamily')) {
                  options.blockOtherFamily = body.blockOtherFamily !== false
                  touched = true
                }
                if (!touched) {
                  json(res, { ok: false, error: '没有可设置的选项(可用: injectBrief / allowLan / blockOtherFamily)' }, 400)
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
