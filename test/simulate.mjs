/**
 * EnvDock 模拟器:用共享夹具(test/fixture/host.mjs)起一个假 Cordis 宿主,
 * 把**真实的 index.js** 跑起来,然后把 /envdock-api 的完整 JSON 与关键事实打印出来。
 *
 * 0.5 起是「辅助展示」模型:EnvDock 不再遮挡任何工具,只决定要不要**增补**一个
 * `envd_shell`。所以这里模拟的是:注册条件(终端 / 同族 / 试箱 / 占名)、围栏会话拒
 * 绝执行、宿主命令工具识别、以及 /envdock-api 的新形状。
 *
 * 跑法:
 *   node test/simulate.mjs                                        # 1 个围栏会话 + 宿主 bash → 不注册
 *   node test/simulate.mjs --mode danger-full-access --executor none  # 无执行器 → 注册
 *   node test/simulate.mjs --host-tools ops_bash,pwsh --mode danger-full-access
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
    '  --brief                  打印简报全文',
    '  --pretty                 人读输出(默认)',
    '  --json                   单行机器可读 JSON',
    '  --wait <ms>              等 tick 的上限(默认 5000)',
  ]
  return text.join('\n')
}

const opts = {
  mode: 'workspace-write',
  sessions: 1,
  hostTools: ['bash'],
  executor: 'bash',
  shellSandbox: 'workspace-write',
  policy: 'on',
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
}

try {
  const { apply } = await import('../index.js')
  apply(host.ctx, { syncIntervalMs: 25 })

  const postJson = async (body) => requestApi(host, '/envdock-api', { method: 'POST', body })
  const getJson = async () => requestApi(host, '/envdock-api')

  // 等对账 tick 真跑过几轮(注册/重挂/宿主工具识别都在 tick 里落地)。
  const TICKS_TARGET = 8
  await pollSnapshot(host, (snap) => Boolean(snap && snap.syncStats) && Number(snap.syncStats.ticks) >= TICKS_TARGET, opts.wait)

  const snap = (await getJson()).json || {}
  const stats = snap.syncStats || {}

  if (opts.jsonOnly) {
    console.log(JSON.stringify({ scenario, snapshot: snap }))
    process.exit(0)
  }

  const show = (value) => (value === undefined ? 'undefined' : JSON.stringify(value))
  const line = (label, value) => console.log('  ' + String(label).padEnd(24, ' ') + ' ' + value)

  console.log('══ EnvDock 模拟场景(辅助展示模型) ══')
  line('mode(s)', opts.mode)
  line('sessions', String(opts.sessions) + ' → ' + host.state.agents.map((a) => a.id).join(', '))
  line('host-tools', opts.hostTools.length ? opts.hostTools.join(', ') : '(none)')
  line('executor', opts.executor + (opts.executor === 'none' ? '' : ' (sandboxMode=' + opts.shellSandbox + ')'))
  line('policy service', opts.policy)
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

  const ct = snap.commandTool || {}
  console.log('══ commandTool(只增不减) ══')
  line('name', show(ct.name))
  line('registered', show(ct.registered))
  line('visible', show(ct.visible))
  line('skipReason', show(ct.skipReason))
  line('shell', show(ct.shell && { label: ct.shell.label, family: ct.shell.family }))
  line('refuseWhenConfined', show(ct.refuseWhenConfined))
  const hosts = Array.isArray(ct.hostTools) ? ct.hostTools : []
  line('hostTools', hosts.length ? hosts.map((item) => item.name + '(' + (item.family || '?') + (item.learned ? ',learned' : '') + ')').join(' · ') : '(none)')
  console.log('')

  console.log('══ syncStats(白名单 9 字段) ══')
  for (const field of ['ticks', 'lastAt', 'intervalMs', 'detections', 'lastDetectMs', 'hostToolScans', 'registerTries', 'lastError', 'lastErrorAt']) line(field, show(stats[field]))
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
