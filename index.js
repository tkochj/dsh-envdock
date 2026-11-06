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
    /** 允许非 loopback 请求访问 /envdock-api(默认关:面板数据含本机路径与终端) */
    allowLan: false,
  },
}

const TAKEOVER_MODES = ['auto', 'takeover', 'off']
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

function readState() {
  let raw = null
  try {
    raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('状态文件不是 JSON 对象')
  } catch (error) {
    // ENOENT = 首次运行(正常);其余(坏 JSON / 不是对象)才算损坏:留 .corrupt 并给面板一条 issue。
    if (error && error.code !== 'ENOENT') noteStateCorrupt(error)
    raw = null
  }
  return {
    ...DEFAULT_STATE,
    ...(raw || {}),
    options: normalizeOptions(raw && raw.options),
    selections: normalizeSelections(raw && raw.selections),
    customTools: Array.isArray(raw && raw.customTools) ? raw.customTools.map(normalizeCustomTool).filter(Boolean) : [],
  }
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
}

/** 发现顺序:先看宿主最可能自带的那个。 */
const SHELL_TOOL_ORDER = IS_WIN ? ['pwsh', 'powershell', 'cmd', 'bash'] : ['bash', 'zsh', 'sh']

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
  }
}

/**
 * 命令工具此刻的真实状态。
 *
 * `isVisible` 是 live 探针(工具注册表里现在真的能不能看到这个名字)。
 * 面板与简报都只用这一份结论:宁可说「见工具表」,也不要谎报「已接管」。
 */
function commandToolState(runtime, isVisible) {
  const probe = typeof isVisible === 'function' ? isVisible : null
  const denies = Array.isArray(runtime.denyNames) ? runtime.denyNames.slice() : []
  const sandbox = runtime.sandbox === true
  const sandboxMode = typeof runtime.sandboxMode === 'string' ? runtime.sandboxMode : ''
  if (runtime.toolName) {
    const name = runtime.toolName
    const visible = probe ? Boolean(probe(name)) : Boolean(runtime.toolVisible)
    return { name, takeover: Boolean(runtime.owns), reuse: Boolean(runtime.reuse), visible, denies, sandbox, sandboxMode }
  }
  const name = runtime.shippedName || null
  return {
    name,
    takeover: false,
    reuse: false,
    visible: name ? (probe ? Boolean(probe(name)) : false) : false,
    denies,
    sandbox,
    sandboxMode,
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

function brief(detection, state, isVisible, runtime) {
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
    const notes = SYNTAX_NOTES[shell.family] || []
    for (const note of notes.slice(0, 3)) lines.push('  · ' + note)
    // 命令工具那行只在**真的可见**时才敢说「已接管」。
    // 以前无条件写「EnvDock 已接管」,而工具恰好被拆掉的那个空窗里,模型照着这句话去调就是 unknown tool。
    const commandState = commandToolState(runtime, isVisible)
    if (commandState.name && commandState.takeover && commandState.visible) {
      lines.push('  · 命令工具: `' + commandState.name + '`(EnvDock 已接管),里面只能写 ' + shell.label + ' 语法')
    } else if (commandState.name && commandState.takeover) {
      // 接管了但工具此刻不在工具表里(刚重载 / 注册失败):别谎报「已接管」让模型去撞 unknown tool。
      lines.push(
        '  · 命令工具: `' +
          commandState.name +
          '` 刚被 EnvDock 接管但此刻不在工具表里;先用工具表里其它的命令工具(按它自己的语法),若一个都没有就下一步再试,别硬调这个名字',
      )
    } else {
      // 宿主自带那个 / 还没接管:同样要看「此刻真的可见」,
      // 否则模型会照着一个调不到的名字去调(agent 作用域私有的 shell 就是查不到的那种)。
      // 注:「由其它插件提供(reuse)」这条分支已经不存在了 —— 固定名之后我们从不认领别人的工具,
      // commandTool.reuse 只作为 API 兼容字段恒为 false。
      if (!commandState.name) lines.push('  · 命令工具: 见工具表')
      else if (commandState.visible) {
        lines.push('  · 命令工具: `' + commandState.name + '`(宿主自带),用 ' + (shell.family === 'powershell' ? 'PowerShell' : shell.label) + ' 语法')
      } else {
        lines.push('  · 命令工具: `' + commandState.name + '` 此刻不在工具表里;用工具表里实际存在的那一个,若一个都没有就下一步再试,别硬调这个名字')
      }
    }
    // 沙箱在场:EnvDock 明确不接管,模型必须用宿主那个带沙箱的命令工具 —— 别自己拼 shell 绕过去。
    if (commandState.sandbox) {
      lines.push(
        '  · 命令工具带沙箱' +
          (commandState.sandboxMode ? '(' + commandState.sandboxMode + ')' : '') +
          ':EnvDock 不接管(接管会绕过沙箱),直接用宿主自带的那个命令工具',
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

function envdTool(ctx, getDetection, getState, forceRefresh, isVisible, runtime) {
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
    async execute(args) {
      const a = args || {}
      const action = a.action || 'summary'
      const state = getState()
      let detection = null
      try {
        detection = await getDetection(Boolean(a.refresh) || Boolean(forceRefresh))
      } catch (error) {
        return { ok: false, text: '环境探测失败: ' + String((error && error.message) || error) }
      }
      if (action === 'summary') {
        return { ok: true, text: brief(detection, state, isVisible, runtime) }
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
        return { ok: true, text: '已把 ' + entry.label + ' 的默认版本切到 ' + target + '。\n\n' + brief(refreshed, next, isVisible, runtime) }
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
function commandTool(ctx, activeShell, sandboxFacts) {
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
      if (typeof sandboxFacts === 'function') {
        const facts = sandboxFacts()
        if (facts && facts.sandboxed) {
          return {
            ok: false,
            text:
              '宿主命令工具已进入沙箱' +
              (facts.mode ? '(' + facts.mode + ')' : '') +
              ',EnvDock 不接管;请改用宿主自带的命令工具(EnvDock 会在下一轮对账摘掉 envd_shell)',
          }
        }
      }
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
      const timeoutMs = Math.min(Math.max(Number(args && args.timeoutMs) || 120000, 1000), 600000)
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
    /** 连 restrict 都挡不掉的宿主 shell 名(挡不了就会一直并列可见,面板据此能解释) */
    unrestrictable: [],
    /** 因为看不到 envd_shell 而没遮挡的作用域(空 = 全都对完账了) */
    blockedScopes: [],
    /** 宿主 shell 带沙箱:EnvDock 主动不接管(接管会绕过沙箱,P0) */
    sandboxBlocked: false,
  }
  /** 对账周期(默认 5s;测试夹具用它把 20 个 tick 压进几百毫秒) */
  const syncIntervalMs = Math.min(Math.max(Number(settings.syncIntervalMs) || 5000, 20), 600000)
  /** 本代实例的接管运行态:brief 与 API 都读它,不跨实例共享 */
  const rt = createRuntime()

  /**
   * 宿主 shell 的沙箱事实。
   *
   * dsh 的 `ctx.shell` 是 ShellExecutor:可围栏的实现会公布 `sandboxMode`
   * (read-only / workspace-write / danger-full-access)或自带 `sandboxPolicy`。
   * 这种部署下**绝不能**接管命令工具 —— EnvDock 自己的工具走 ctx.subprocess.spawn,
   * 不带 sandboxPolicy,一接管就是绕过沙箱(P0)。`danger-full-access` 只是执行器的默认值:
   * 逐会话的策略可能更严,所以只要能力位存在就不接管。
   */
  const shellSandbox = () => {
    const facts = { present: false, sandboxed: false, mode: '' }
    const read = (name) => {
      try {
        return ctx.get(name)
      } catch {
        return undefined
      }
    }
    const shell = read('shell')
    if (!shell) return facts
    facts.present = true
    let mode = ''
    try {
      if (typeof shell.sandboxMode === 'string') mode = shell.sandboxMode
    } catch {}
    // 有的实现把本次调用的策略直接挂在服务上(shell.sandboxPolicy),也要认。
    // 刻意不读 ctx.get('sandboxPolicy') 推断 —— 那个服务在「fs 有沙箱、shell 没沙箱」的
    // 部署里同样存在,拿它当依据会把本不该接管的场景误判成沙箱,反而把功能锁死。
    let ownPolicy = null
    try {
      ownPolicy = shell.sandboxPolicy
    } catch {}
    facts.mode = mode
    // 口径按 dsh 的能力位来:执行器只要**公布** sandboxMode(含 danger-full-access),
    // 或自带 sandboxPolicy,就说明它可能是可围栏执行器 —— 逐会话策略可能比默认更严
    // (dsh-tool-pwsh 每次调用都会用 resolve(exec) 传该会话的 policy),而 EnvDock 的
    // subprocess 旁路无法服从它。真正无围栏的 executor(dsh-pwsh-local / dsh-bash-local)
    // 不公布这些字段,接管照常可用。
    facts.sandboxed = Boolean(ownPolicy) || Boolean(mode)
    return facts
  }
  /** 全局可见性探针(与 hasTool 同一个口径,不带作用域):brief 用它说真话 */
  const probeVisible = (name) => {
    try {
      const tools = ctx.get('tools')
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
          text: () => {
            if (settings.injectBrief === false) return ''
            const state = getState()
            // 归一化之后只会是布尔:消费端一律 === true(以前 Boolean("false") 之类的值会把简报悄悄打开)
            if (state.options.injectBrief !== true) return ''
            if (cache.value) return brief(cache.value, state, probeVisible, rt)
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
    ctx.effect(() => ctx.tools.register(envdTool(ctx, getDetection, getState, false, probeVisible, rt)), 'envdock tool')
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
   */
  const hasTool = (context, name, agent) => {
    const tools = toolsOf(context)
    if (!tools || typeof tools.get !== 'function') return false
    try {
      return Boolean(tools.get(name, agent))
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
      scopes.set(agent.id, { agent, actx: agent.ctx, denyKey: '', denyBlockedKey: '', disposers: [], badNames: new Set() })
      // 新 agent 的第一步可能早于下一个 tick,补一次尽快对上(对账本身是幂等的)。
      // 必须包一层箭头:`sync` 是后面才初始化的 const,直接传它的值会踩 TDZ ——
      // 以前就是这么写的:`setTimeout(sync, 250)` 抛 ReferenceError,
      // 被外层的 try/catch 吞掉,于是 `agents.list()` 循环只加了第一个 agent 就中断,
      // 后面每个 agent 都拿不到遮挡(在模型眼里就是同时有两个命令工具)。
      // 定时器还要登记下来:卸载时不清掉,它会在卸载之后把工具重新注册回来(幽灵工具)。
      const timer = setTimeout(() => {
        scopeTimers.delete(timer)
        try {
          sync()
        } catch {}
      }, 250)
      scopeTimers.add(timer)
    }
    const dropScope = (id) => {
      const cur = scopes.get(id)
      if (!cur) return
      dropDenies(cur)
      scopes.delete(id)
      // 已经销毁的作用域别再挂在诊断里(否则面板会显示一个早就不存在的 agent)
      syncStats.blockedScopes = (syncStats.blockedScopes || []).filter((x) => x !== String(id))
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
      const found = new Set()
      for (const name of Object.keys(SHELL_TOOL_FAMILY)) {
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
    /** 这个作用域实际能挡的掩码:剔掉它自己挡不掉的名字(别的作用域多半挡得掉)。 */
    const maskFor = (cur, names) => names.filter((name) => !cur.badNames.has(name))

    const denyScopes = (names) => {
      for (const cur of scopes.values()) {
        const mask = maskFor(cur, names)
        const key = mask.join(',')
        if (cur.denyKey === key) {
          if (!mask.length) cur.denyBlockedKey = ''
          continue
        }
        dropDenies(cur)
        if (!mask.length) continue
        const tools = toolsOf(cur.actx)
        if (!tools || typeof tools.restrict !== 'function') continue
        // 这个作用域里如果看不到**我们自己**的工具,就绝不能在这里遮挡宿主的:
        // 那一步会变成「宿主的被挡住、我们的又不可见」= 零命令工具,正是这次要消灭的空窗。
        // 宁可留着宿主那个(模型看到两个命令工具,不致命),也不制造零工具。
        // 记下「这个掩码在这一作用域已有结论」,否则稳态判定会一直认为它没对完账。
        if (!hasTool(cur.actx, ENVD_SHELL_NAME, cur.agent)) {
          cur.denyBlockedKey = key
          continue
        }
        try {
          cur.disposers = [tools.restrict({ deny: mask })]
          cur.denyKey = key
          syncStats.denyApplies++
        } catch (error) {
          // 整体失败(通常是混进了这个作用域挡不掉的名字):退化成逐个挡,能挡几个挡几个。
          // 挡不掉的名字进 **cur.badNames** —— 它是作用域私有的;别动全局 seenShells,
          // 否则「别的作用域挡得掉」的那个名字会被永久剔除,那边就永久漏挡。
          const failed = []
          for (const name of mask) {
            try {
              cur.disposers.push(tools.restrict({ deny: [name] }))
              syncStats.denyApplies++
            } catch {
              failed.push(name)
            }
          }
          for (const name of failed) cur.badNames.add(name)
          // 记的是「这个作用域真正挡住的」掩码:稳态判定要和它对得上,否则每 tick 重试。
          cur.denyKey = mask.filter((name) => !cur.badNames.has(name)).join(',')
          if (!cur.disposers.length) {
            syncStats.lastError = '遮挡 ' + key + ' 失败: ' + ((error && error.message) || error)
            console.error('[envdock] 遮挡 ' + key + ' 失败:', error && error.message)
          }
        }
      }
      const scopeList = [...scopes.values()]
      // 面板上的「已遮挡」必须是**真的挡住了**的名字:至少要有作用域能挡它。
      // 「已遮挡」取**交集**:只有每个作用域都挡住了,面板才敢说这个名字被藏起来了;
      // 部分作用域挡不掉的,由 syncStats.unrestrictable 单独说明,不在这里谎报。
      rt.denyNames = scopeList.length ? names.filter((name) => scopeList.every((cur) => !cur.badNames.has(name))) : []
      // 挡不掉的按作用域记,诊断只做并集(别当成全局黑名单用)。
      const bad = new Set()
      if (names.length) for (const cur of scopeList) for (const name of cur.badNames) bad.add(name)
      syncStats.unrestrictable = [...bad].sort()
      // 「哪些作用域因为看不到我们自己的工具而没遮挡」单独记账:
      // 放 lastError 里会永远粘着(稳态 tick 不会再算一次),面板就会一直报红。
      const blockedNow = []
      for (const cur of scopeList) {
        if (cur.denyBlockedKey) blockedNow.push(String(cur.agent.id))
      }
      syncStats.blockedScopes = blockedNow
    }
    const liftDenies = () => denyScopes([])
    /** 每个作用域都按当前掩码对完账了吗(含「已判定挡不了」的作用域) */
    const scopesSettled = (names) => {
      for (const cur of scopes.values()) {
        const mask = maskFor(cur, names)
        const key = mask.join(',')
        const visible = hasTool(cur.actx, ENVD_SHELL_NAME, cur.agent)
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
    }

    /**
     * 我们自己的固定名工具此刻是否真的在工具表里。
     * 本地还留着 disposer 但注册表里查不到时(热重载 / 被别的插件顶掉),作废本地句柄重来。
     */
    const ownToolReady = () => {
      if (!ownRegistered) return false
      if (hasTool(ctx, ENVD_SHELL_NAME)) return true
      if (disposeTool) {
        try {
          disposeTool()
        } catch {}
        disposeTool = null
      }
      ownRegistered = false
      appliedOwned = false
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
        syncStats.lastError = ENVD_SHELL_NAME + ' 已被其它插件占用,EnvDock 不接管命令工具'
        return false
      }
      let dispose = null
      try {
        dispose = ctx.tools.register(commandTool(ctx, activeShell, shellSandbox))
      } catch (error) {
        // 同层重名 / 保留名:注册不上就只能让宿主自带的继续干活
        syncStats.lastError = '注册 ' + ENVD_SHELL_NAME + ' 失败: ' + ((error && error.message) || error)
        console.error('[envdock] 注册命令工具 ' + ENVD_SHELL_NAME + ' 失败:', error && error.message)
        return false
      }
      if (typeof dispose !== 'function') {
        syncStats.lastError = '注册 ' + ENVD_SHELL_NAME + ' 没有返回 disposer'
        return false
      }
      // 「注册成功」不等于「模型看得见」:注册完立刻验一次 —— 但**只按全局可见性**判定。
      // 以前拿「每个 agent 作用域都看得见」当门槛:一个作用域看不到就把刚注册的工具拆掉,
      // 结果是本来正常的作用域也跟着失去命令工具(而且那个作用域本来就不该被遮挡)。
      // 各作用域的可见性由 denyScopes 逐个处理,这里只回答「工具注册上了没有」。
      if (!hasTool(ctx, ENVD_SHELL_NAME)) {
        try {
          dispose()
        } catch {}
        syncStats.lastError = ENVD_SHELL_NAME + ' 注册成功但工具表里查不到'
        return false
      }
      disposeTool = dispose
      ownRegistered = true
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
            syncStats.lastError = '探测返回空快照,跳过本轮对账'
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
          syncStats.lastError = '探测失败: ' + String((error && error.message) || error)
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
      const state = getState()
      const options = state.options || {}
      const mode = TAKEOVER_MODES.includes(options.shellTakeover) ? options.shellTakeover : 'auto'

      // 沙箱优先于一切(包括显式 takeover):绕过沙箱是 P0,不能靠面板选项关掉。
      // 沙箱在场时:不注册 envd_shell、不遮挡宿主,让带沙箱的宿主命令工具继续干活。
      const sandbox = shellSandbox()
      rt.sandbox = sandbox.sandboxed
      rt.sandboxMode = sandbox.mode
      syncStats.sandboxBlocked = sandbox.sandboxed
      if (sandbox.sandboxed) {
        // 只认不接管:面板与简报仍要显示「宿主那个命令工具是哪个」,但注册表一个字节都不碰。
        rt.shippedName = SHELL_TOOL_ORDER.find((name) => collectShellNames().has(name)) || null
        rt.denyNames = []
        if (appliedSig || disposeTool || rt.owns || appliedDenyKey) {
          teardown()
          syncStats.lastSig = ''
        } else {
          rt.toolName = null
          rt.owns = false
          rt.reuse = false
          syncStats.steadyTicks++
        }
        return
      }

      // 只给简报:必须立刻放开,不等探测(GUI 上点了就得马上生效)
      if (mode === 'off') {
        if (appliedSig || disposeTool || rt.owns || appliedDenyKey) {
          teardown()
          syncStats.lastSig = ''
        } else {
          syncStats.steadyTicks++
        }
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
      // 见到过就记住(哪怕此刻被我们挡住了查不到)。挡不掉的记忆是**按作用域**的
      // (cur.badNames),不再有全局黑名单:一个作用域挡不掉不代表别的也挡不掉。
      for (const name of collectShellNames()) {
        if (rt.ownNames.has(name)) continue
        rt.seenShells.add(name)
      }
      const shippedName = SHELL_TOOL_ORDER.find((name) => rt.seenShells.has(name)) || null
      rt.shippedName = shippedName
      const shippedFamily = shippedName ? SHELL_TOOL_FAMILY[shippedName] : null
      const familyMatches = Boolean(shippedFamily) && shippedFamily === shell.family
      // 还没看清宿主有什么时先别动,下一 tick 再看(否则会和宿主的命令工具并列,模型看到两个)
      if (!shippedName && mode !== 'takeover') {
        if (appliedSig || disposeTool || rt.owns) teardown()
        else syncStats.steadyTicks++
        return
      }

      const wants = Boolean(shell.path) && (mode === 'takeover' || !familyMatches)
      // 要遮挡的是「历史上真的见过」的宿主 shell 名(不含自己的固定名)。
      // 刻意不用 hasTool 过滤:宿主 shell 注册在 agent 作用域里,全局视图本来就查不到,
      // 被我们挡住之后更是查不到 —— 用它过滤会让掩码忽有忽无,退化成 5 秒一抖。
      const denyNames = wants ? [...rt.seenShells].filter((name) => name !== ENVD_SHELL_NAME).sort() : []
      const denyKey = denyNames.join(',')
      const sig = [mode, wants ? 'takeover' : 'idle', shell.family, shippedName || '', denyKey].join('|')

      // ── 稳态:签名一致 + 账本一致 + 工具还在(每 tick 真查一次工具表) ──
      // 还要保证「每个 agent 作用域都按当前掩码对完账」:接管建立之后才出现的会话/子 agent
      // 在 addScope 里是空掩码,只看全局签名会把它永远漏掉 —— 那个作用域里模型会同时看到
      // 两个命令工具(宿主的 shell 没被挡 + 我们的 envd_shell),brief 却只说一个。
      const steady = sig === appliedSig && denyKey === appliedDenyKey && rt.owns === appliedOwned
      if (steady) {
        if (!appliedOwned) {
          syncStats.steadyTicks++
          return
        }
        if (hasTool(ctx, ENVD_SHELL_NAME)) {
          rt.toolVisible = true
          if (!scopesSettled(denyNames)) {
            // 只有遮挡这一步要补:注册表一个字节都不动
            denyScopes(denyNames)
          }
          syncStats.steadyTicks++
          return
        }
        // 账本说有、工具表里没有 → 掉下去走完整对账(下面 ensureOwnTool 会补注册)
      }

      if (!wants) {
        if (appliedSig || disposeTool || rt.owns) {
          teardown()
          syncStats.lastSig = sig
        } else {
          syncStats.steadyTicks++
        }
        return
      }

      // 上一次失败还没到重试时间:保持「没有自己的工具」,宿主自带的继续干活
      if (retryAt && Date.now() < retryAt) {
        syncStats.steadyTicks++
        return
      }
      retryAt = 0
      // 每一轮完整对账重新算一次诊断,不要留下上一轮的错误(挡不掉的黑名单另算)
      syncStats.lastError = null

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
        return
      }

      // 自己的工具已经在工具表里了 → 现在才可以遮挡宿主的那个
      rt.toolName = ENVD_SHELL_NAME
      rt.owns = true
      rt.reuse = false
      rt.toolVisible = true
      rt.denyName = shippedName && shippedName !== ENVD_SHELL_NAME ? shippedName : null
      // 真正挡住的名单由 denyScopes 按作用域算(它才剔得掉各作用域挡不掉的名字)。
      denyScopes(denyNames)
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
      try {
        reconcile()
      } catch (error) {
        syncStats.lastError = String((error && error.message) || error)
        console.error('[envdock] 终端接管对账失败:', error && error.message)
      } finally {
        syncStats.lastAt = Date.now()
      }
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
                const commandTool = commandToolState(rt, (name) => hasTool(ctx, name))
                json(res, {
                  ok: true,
                  state,
                  shell: { key: shell.key, label: shell.label, family: shell.family, path: shell.path, version: shell.version || '' },
                  commandTool,
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
                  brief: brief(detection, state, (name) => hasTool(ctx, name), rt),
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
                if (!touched) {
                  json(res, { ok: false, error: '没有可设置的选项(可用: injectBrief / shellTakeover / allowLan)' }, 400)
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
