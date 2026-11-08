/**
 * EnvDock 模拟器:用共享夹具(test/fixture/host.mjs)起一个假 Cordis 宿主,
 * 把**真实的 index.js** 跑起来,然后把 /envdock-api 的完整 JSON 与关键事实打印出来。
 *
 * 0.6 起是「两族」模型:按会话选语法族(bash / powershell),bash 族会话遮挡 PowerShell 族
 * 内置命令工具(pwsh / powershell),开关 `blockOtherFamily` 可关。所以这里除了注册条件
 * (终端 / 沙箱 / 占名)、围栏拒绝、宿主命令工具识别,还打印族判定与遮挡结果。
 *
 * 跑法:
 *   node test/simulate.mjs                                        # 1 个围栏会话 + 宿主 bash
 *   node test/simulate.mjs --mode danger-full-access --executor none  # 无执行器 → 注册
 *   node test/simulate.mjs --host-tools ops_bash,pwsh --mode danger-full-access
 *   node test/simulate.mjs --host-tools ops_bash,pwsh --shell-family bash   # 手动 bash 族
 *   node test/simulate.mjs --host-tools ops_bash,pwsh --block-other-family off  # 不遮挡
 *   node test/simulate.mjs --sessions 3 --mode danger-full-access,workspace-write
 *   node test/simulate.mjs --brief                                 # 额外打印简报全文
 *   node test/simulate.mjs --json | node -e '...'                  # 只出一份 JSON
 *
 * 参数:
 *   --mode <m[,m2,…]>        每会话策略(默认 workspace-write;逗号按会话轮排)
 *   --sessions <n>           会话数(默认 1)
 *   --host-tools <a,b>       宿主已注册的命令工具(默认 bash;空串=没有)
 *   --executor <family>      宿主执行器族 bash|powershell|cmd|none(默认 bash;none=没有 ctx.shell)
 *   --shell-sandbox <mode>   shell.sandboxMode 能力位(默认 workspace-write;none=不公布)
 *   --policy <on|off>        sandboxPolicy 服务(默认 on)
 *   --shell <auto|终端名>    面板里的默认终端(默认 auto;例如 bash / pwsh / cmd)
 *   --shell-family <bash|powershell>
 *                            手动选该族的第一个可用终端(等价于 --shell 成该族终端;
 *                            两族模型下它会变成 familySource=manual)
 *   --block-other-family [on|off]
 *                            两族遮挡开关(默认 on;off = 两族同时可见,简报只警告)
 *   --no-block-other-family  同上,显式关掉
 *   --brief                  额外打印模型看到的简报全文
 *   --pretty                 人读输出(默认)
 *   --json                   **单行**机器可读 JSON({"scenario","snapshot"}),便于管道处理
 *   --wait <ms>              等 tick 落地的上限(默认 5000)
 *   --help                   打印本说明
 */
import {
  buildHost,
  fakeSandboxPolicy,
  fakeSandboxedShell,
  cleanupTemp,
  pollSnapshot,
  requestApi,
} from './fixture/host.mjs'

const argv = process.argv.slice(2)

function usage() {
  const text = [
    '用法: node test/simulate.mjs [参数]',
    '',
    '  --mode <m[,m2,…]>        每会话策略(默认 workspace-write;逗号按会话轮排)',
    '  --sessions <n>           会话数(默认 1)',
    '  --host-tools <a,b>       宿主命令工具(默认 bash;空串=没有)',
    '  --executor <family>      bash|powershell|cmd|none(默认 bash)',
    '  --shell-sandbox <mode>   shell.sandboxMode 能力位(默认 workspace-write;none=不公布)',
    '  --policy <on|off>        sandboxPolicy 服务(默认 on)',
    '  --shell <auto|key>       默认终端(默认 auto)',
    '  --shell-family <bash|powershell>  手动选该族的第一个可用终端',
    '  --block-other-family [on|off]     两族遮挡开关(默认 on)',
    '  --no-block-other-family           显式关掉两族遮挡',
    '  --brief                  打印简报全文',
    '  --pretty                 人读输出(默认)',
    '  --json                   单行机器可读 JSON',
    '  --wait <ms>              等 tick 的上限(默认 5000)',
  ]
  return text.join('\n')
}

/** 布尔参数:裸旗标 = true;后面跟 on/off/true/false/1/0 时按值吃。 */
const BOOL_WORDS = { on: true, true: true, '1': true, yes: true, off: false, false: false, '0': false, no: false }

const opts = {
  mode: 'workspace-write',
  sessions: 1,
  hostTools: ['bash'],
  executor: 'bash',
  shellSandbox: 'workspace-write',
  policy: 'on',
  shell: 'auto',
  shellFamily: '',
  blockOtherFamily: true,
  brief: false,
  jsonOnly: false,
  wait: 5000,
}

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  const eat = () => {
    const value = argv[i + 1]
    if (value === undefined || String(value).startsWith('--')) throw new Error(arg + ' 需要一个值')
    i++
    return value
  }
  const eatBool = (fallback) => {
    const value = argv[i + 1]
    if (value === undefined || String(value).startsWith('--')) return fallback
    if (!Object.prototype.hasOwnProperty.call(BOOL_WORDS, String(value).toLowerCase())) return fallback
    i++
    return BOOL_WORDS[String(value).toLowerCase()]
  }
  switch (arg) {
    case '--help':
    case '-h':
      console.log(usage())
      process.exit(0)
      break
    case '--mode':
      opts.mode = eat()
      break
    case '--sessions':
      opts.sessions = Math.max(1, Number(eat()) || 1)
      break
    case '--host-tools':
      opts.hostTools = eat()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      break
    case '--executor':
      opts.executor = eat()
      break
    case '--shell-sandbox':
      opts.shellSandbox = eat()
      break
    case '--policy':
      opts.policy = eat()
      break
    case '--shell':
      opts.shell = eat()
      break
    case '--shell-family': {
      const value = eat().toLowerCase()
      if (value !== 'bash' && value !== 'powershell') throw new Error('--shell-family 只接受 bash|powershell')
      opts.shellFamily = value
      break
    }
    case '--block-other-family':
      opts.blockOtherFamily = eatBool(true)
      break
    case '--no-block-other-family':
      opts.blockOtherFamily = false
      break
    case '--brief':
      opts.brief = true
      break
    case '--json':
      opts.jsonOnly = true
      break
    case '--pretty':
      opts.jsonOnly = false
      break
    case '--wait':
      opts.wait = Math.max(50, Number(eat()) || 5000)
      break
    default:
      console.error('不认识的参数: ' + arg + '\n\n' + usage())
      process.exit(2)
  }
}

const EXECUTOR_CLASS = {
  bash: 'BashSandboxExecutor',
  powershell: 'PwshSandboxExecutor',
  cmd: 'CmdSandboxExecutor',
}

// ── 场景 → 夹具配置 ──
const modes = opts.mode
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const agentIds = Array.from({ length: opts.sessions }, (_, i) => ({ id: 'agent-' + (i + 1), session: { key: 'sim-' + (i + 1) } }))
const modeBySession = {}
agentIds.forEach((entry, i) => {
  modeBySession[entry.session.key] = modes[i % modes.length]
})
const defaultMode = modes[0]

let shell = undefined
if (opts.executor !== 'none') {
  shell = fakeSandboxedShell({ className: EXECUTOR_CLASS[opts.executor] || '', mode: defaultMode })
  if (opts.shellSandbox !== 'none') shell.sandboxMode = opts.shellSandbox
}

// `--host-tools` 是「宿主已注册的命令工具」:两族演示要同时给 ops_bash 与 pwsh。
const host = buildHost({
  shippedTools: opts.hostTools,
  agentIds,
  shell,
  sandboxPolicy: opts.policy === 'on' ? fakeSandboxPolicy(defaultMode, modeBySession) : undefined,
  shellEnv: { collect: () => ({ DSH_SESSION: 'simulate', DSH_AGENT: 'agent-1' }) },
})

const scenario = {
  mode: opts.mode,
  sessions: opts.sessions,
  hostTools: opts.hostTools,
  executor: opts.executor,
  shellSandbox: opts.shellSandbox,
  policy: opts.policy,
  shell: opts.shell,
  shellFamily: opts.shellFamily,
  blockOtherFamily: opts.blockOtherFamily,
}

try {
  const { apply } = await import('../index.js')
  apply(host.ctx, { syncIntervalMs: 25 })

  const postJson = async (body) => requestApi(host, '/envdock-api', { method: 'POST', body })
  const getJson = async () => requestApi(host, '/envdock-api')

  // 等对账 tick 真跑过几轮(注册/重挂/宿主工具识别都在 tick 里落地)。
  const TICKS_TARGET = 8
  await pollSnapshot(host, (snap) => Boolean(snap && snap.syncStats) && Number(snap.syncStats.ticks) >= TICKS_TARGET, opts.wait)

  // 两族开关:先写状态再让它对账(写入立即生效,不等 5s tick)。
  let optionNote = ''
  if (opts.blockOtherFamily !== true) {
    await postJson({ op: 'setOption', blockOtherFamily: false })
    optionNote = 'blockOtherFamily=false'
  }

  // 默认终端:--shell 显式指定,或 --shell-family 取该族第一个可用终端。
  let shellNote = ''
  const firstSnap = (await getJson()).json || {}
  const terminals = Array.isArray(firstSnap.terminals) ? firstSnap.terminals : []
  let shellKey = opts.shell && opts.shell !== 'auto' ? String(opts.shell) : ''
  if (!shellKey && opts.shellFamily) {
    const hit = terminals.find((t) => t.family === opts.shellFamily)
    if (hit) shellKey = hit.key
    else shellNote = '(本机没有 ' + opts.shellFamily + ' 族终端,--shell-family 未生效)'
  }
  if (shellKey && !terminals.some((t) => t.key === shellKey)) {
    shellNote = '(' + shellKey + ' 不在本机已探测终端里,setShell 会失败)'
  }
  if (shellKey) {
    const setShell = await postJson({ op: 'setShell', key: shellKey })
    if (setShell.status !== 200) shellNote = '(' + shellKey + ' setShell 被拒绝:' + String((setShell.json && setShell.json.error) || setShell.status) + ')'
  }
  // 改过状态就再等几轮对账,让族/遮挡/注册都落在新状态上。
  if (shellKey || opts.blockOtherFamily !== true) {
    await pollSnapshot(host, (snap) => Boolean(snap && snap.syncStats) && Number(snap.syncStats.ticks) >= TICKS_TARGET + 4, opts.wait)
  }

  const snap = (await getJson()).json || {}
  const stats = snap.syncStats || {}

  if (opts.jsonOnly) {
    console.log(JSON.stringify({ scenario, snapshot: snap }))
    process.exit(0)
  }

  const show = (value) => (value === undefined ? 'undefined' : JSON.stringify(value))
  const line = (label, value) => console.log('  ' + String(label).padEnd(24, ' ') + ' ' + value)

  console.log('══ EnvDock 模拟场景(两族模型) ══')
  line('mode(s)', opts.mode)
  line('sessions', String(opts.sessions) + ' → ' + host.state.agents.map((a) => a.id).join(', '))
  line('host-tools', opts.hostTools.length ? opts.hostTools.join(', ') : '(none)')
  line('executor', opts.executor + (opts.executor === 'none' ? '' : ' (sandboxMode=' + opts.shellSandbox + ')'))
  line('policy service', opts.policy)
  line('shell 选择', (shellKey || 'auto') + (shellNote ? ' ' + shellNote : ''))
  line('blockOtherFamily', String(opts.blockOtherFamily) + (optionNote ? ' (' + optionNote + ')' : ''))
  console.log('')

  console.log('══ 两族(family) ══')
  line('全局默认族', show(snap.family) + ' / source=' + show(snap.familySource))
  const ct = snap.commandTool || {}
  line('会话族', show(ct.family) + ' / source=' + show(ct.familySource) + ' / fallback=' + show(ct.familyFallback))
  line('blockOtherFamily', show(ct.blockOtherFamily))
  line('sessions', show(ct.sessions))
  line('hidden(已遮挡)', show(ct.hidden))
  line('refuseOnly(只拒绝)', show(ct.refuseOnly))
  line('displayOnly(只展示)', show(ct.displayOnly))
  line('mixed(两族同见)', show(ct.mixed))
  console.log('')

  console.log('══ shell / sandbox ══')
  if (snap.shell) line('shell', show({ family: snap.shell.family, label: snap.shell.label, version: snap.shell.version }))
  if (snap.sandbox) {
    line('present', show(snap.sandbox.present))
    line('capable', show(snap.sandbox.capable))
    line('defaultMode', show(snap.sandbox.defaultMode))
    line('policyKnown', show(snap.sandbox.policyKnown))
    line('sessions', show({ total: snap.sandbox.sessionCount, confined: snap.sandbox.confinedCount, anyFree: snap.sandbox.anyUnconfined }))
  }
  console.log('')

  console.log('══ commandTool ══')
  line('name', show(ct.name))
  line('registered', show(ct.registered))
  line('visible', show(ct.visible))
  line('skipReason', show(ct.skipReason))
  line('shell', show(ct.shell && { label: ct.shell.label, family: ct.shell.family }))
  line('refuseWhenConfined', show(ct.refuseWhenConfined))
  const hosts = Array.isArray(ct.hostTools) ? ct.hostTools : []
  line('hostTools', hosts.length ? hosts.map((item) => item.name + '(' + (item.group || item.family || '?') + (item.learned ? ',learned' : '') + ')').join(' · ') : '(none)')
  console.log('')

  console.log('══ syncStats(白名单 11 字段) ══')
  for (const field of ['ticks', 'lastAt', 'intervalMs', 'detections', 'lastDetectMs', 'hostToolScans', 'registerTries', 'restrictApplied', 'guardRefusals', 'lastError', 'lastErrorAt']) line(field, show(stats[field]))
  console.log('')

  if (opts.brief) {
    console.log('══ brief(模型看到的那份) ══')
    console.log(snap.brief || '(空)')
    console.log('')
  }

  console.log('══ /envdock-api 完整 JSON ══')
  console.log(JSON.stringify(snap, null, 2))
} finally {
  cleanupTemp()
}
// 插件会起 5 秒 tick 定时器(生产里靠 dsh 进程退出回收);模拟器打到这就算跑完,直接退。
process.exit(0)
