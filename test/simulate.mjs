/**
 * EnvDock 模拟器:用共享夹具(test/fixture/host.mjs)起一个假 Cordis 宿主,
 * 把**真实的 index.js** 跑起来,然后把 /envdock-api 的完整 JSON 与关键事实打印出来。
 *
 * 用途:面板渲染 / 终端接管 / 逐会话终局 的人工与脚本验证 —— 不联网、不碰真实 ~/.dsh、
 * 不依赖本机装了哪个工具链(探测走夹具的固定输出)。
 *
 * 跑法:
 *   node test/simulate.mjs                                     # 1 个 workspace-write 会话 + 宿主 bash
 *   node test/simulate.mjs --mode danger-full-access            # 无围栏会话 → 应看到 takeover
 *   node test/simulate.mjs --sessions 4 --mode workspace-write,danger-full-access
 *   node test/simulate.mjs --host-tools ops_bash,pwsh --unrestrictable ops_bash   # dsh-ops 让路场景
 *   node test/simulate.mjs --executor none                      # 非沙箱部署(没有 ctx.shell)
 *   node test/simulate.mjs --executor powershell --mode danger-full-access --delegate "echo hi"
 *   node test/simulate.mjs --json | node -e '...'               # 只出一份 JSON,便于管道处理
 *
 * 参数:
 *   --mode <m[,m2,…]>        每会话的本会话策略(逗号按会话轮排);默认 workspace-write
 *   --sessions <n>           会话数(默认 1);会话 key 依次是 sim-1…sim-n
 *   --host-tools <a,b>       宿主已注册的命令工具(默认 bash;传空串 = 一个都没有)
 *   --unrestrictable <a,b>   这些宿主工具挡不掉(作用域私有,模拟 dsh-ops 的 session-shells)
 *   --executor <family>      宿主执行器族 bash|powershell|cmd|none(默认 bash;none = 没有 ctx.shell)
 *   --shell-sandbox <mode>   shell.sandboxMode 能力位(默认 workspace-write;none = 不公布)
 *   --policy <on|off>        sandboxPolicy 服务(默认 on)
 *   --takeover <auto|takeover|off>   shellTakeover 选项(默认 takeover;想复现默认部署就用 auto)
 *   --delegate <command>     让 envd_shell 走一次委托执行(围栏会话的那条路径)
 *   --delegate-session <n|id>  --delegate 用哪个会话(默认 1)
 *   --brief                  额外打印模型看到的简报全文
 *   --pretty                 人读输出(默认):场景/事实/syncStats 摘要 + 完整 JSON
 *   --json                   **单行**机器可读 JSON({"scenario","snapshot","delegated"}),便于管道处理
 *   --wait <ms>              等对账 tick 落地的上限(默认 5000)
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
    '  --mode <m[,m2,…]>        每会话策略(默认 workspace-write;可用逗号按会话轮排)',
    '  --sessions <n>           会话数(默认 1)',
    '  --host-tools <a,b>       宿主命令工具(默认 bash;空串=没有)',
    '  --unrestrictable <a,b>   挡不掉的宿主工具(作用域私有)',
    '  --executor <family>      bash|powershell|cmd|none(默认 bash)',
    '  --shell-sandbox <mode>   shell.sandboxMode 能力位(默认 workspace-write;none=不公布)',
    '  --policy <on|off>        sandboxPolicy 服务(默认 on)',
    '  --takeover <mode>        auto|takeover|off(默认 takeover)',
    '  --delegate <command>     走一次委托执行',
    '  --delegate-session <n>   委托用哪个会话(默认 1)',
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
  unrestrictable: [],
  executor: 'bash',
  shellSandbox: 'workspace-write',
  policy: 'on',
  takeover: 'takeover',
  delegate: '',
  delegateSession: '',
  brief: false,
  jsonOnly: false,
  pretty: true,
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
      opts.hostTools = eat().split(',').map((s) => s.trim()).filter(Boolean)
      break
    case '--unrestrictable':
      opts.unrestrictable = eat().split(',').map((s) => s.trim()).filter(Boolean)
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
    case '--takeover':
      opts.takeover = eat()
      break
    case '--delegate':
      opts.delegate = eat()
      break
    case '--delegate-session':
      opts.delegateSession = eat()
      break
    case '--brief':
      opts.brief = true
      break
    case '--json':
      opts.jsonOnly = true
      opts.pretty = false
      break
    case '--pretty':
      opts.jsonOnly = false
      opts.pretty = true
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
const modes = opts.mode.split(',').map((s) => s.trim()).filter(Boolean)
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
  unrestrictable: opts.unrestrictable,
  shellEnv: { collect: () => ({ DSH_SESSION: 'simulate', DSH_AGENT: 'agent-1' }) },
})

const { apply } = await import('../index.js')
apply(host.ctx, { syncIntervalMs: 25 })

const postJson = async (body) => requestApi(host, '/envdock-api', { method: 'POST', body })
const getJson = async () => requestApi(host, '/envdock-api')

await postJson({ op: 'setOption', shellTakeover: opts.takeover })
// 等对账 tick 真跑过几轮(接管/让路/遮挡都在 tick 里落地):
// 4 个 tick 只能保证首轮接管建立;让路/遮挡的收敛往往在后续 tick,所以等 10 个,
// 否则打印出来的可能是一个中间态快照(和稳态不符)。
const TICKS_TARGET = 10
const waited = await pollSnapshot(
  host,
  (snap) => Boolean(snap && snap.syncStats) && Number(snap.syncStats.ticks) >= TICKS_TARGET,
  opts.wait,
)
if (!waited || !waited.ok) {
  console.error('模拟失败:/envdock-api 没有在 ' + opts.wait + ' ms 内给出快照')
  cleanupTemp()
  process.exit(1)
}

// 委托执行(可选):让真实 commandTool 走一次「围栏会话 → 宿主执行器」路径
let delegated = null
if (opts.delegate) {
  const tool = host.state.toolDefs.get('envd_shell')
  let agent = null
  if (opts.delegateSession === '') {
    // 默认挑一个**有围栏**的会话:只有它会走「委托宿主执行器」那条路径。
    // (无围栏会话调用 envd_shell 是直接 spawn,测不到委托。)
    agent = host.state.agents.find((a) => modeBySession[a.session && a.session.key] !== 'danger-full-access') || host.state.agents[0] || null
  } else {
    const byIndex = host.state.agents[Number(opts.delegateSession) - 1]
    agent = byIndex || host.state.agents.find((a) => a.id === opts.delegateSession) || null
  }
  if (!tool) {
    delegated = { skipped: true, reason: 'envd_shell 没有注册(当前场景下 EnvDock 不接管)' }
  } else if (!agent) {
    delegated = { skipped: true, reason: '找不到委托用的会话: ' + opts.delegateSession }
  } else {
    const result = await tool.execute({ command: opts.delegate, cwd: process.cwd() }, { signal: null, agent })
    delegated = { skipped: false, agent: agent.id, result }
  }
}

const snap = (await getJson()).json
const stats = (await getJson()).json.syncStats || {}

const scenario = {
  mode: opts.mode,
  sessions: opts.sessions,
  hostTools: opts.hostTools,
  unrestrictable: opts.unrestrictable,
  executor: opts.executor,
  shellSandbox: opts.shellSandbox,
  policy: opts.policy,
  takeover: opts.takeover,
  delegate: opts.delegate,
}

// 收尾:先摘掉 effect(interval / 定时器)再清临时 DSH_HOME,最后显式 exit ——
// 插件的对账 interval 会一直吊住事件循环,不 exit 脚本就不会结束。
const finish = (code = 0) => {
  try {
    host.dispose()
  } catch {}
  cleanupTemp()
  process.exit(code)
}

if (opts.jsonOnly) {
  // 单行机器可读:一行 JSON,无任何额外输出(供面板/脚本直接消费)
  console.log(JSON.stringify({ scenario, snapshot: snap, delegated }))
  finish(0)
}

// ── 人读摘要 ──
const show = (value) => (value === undefined ? 'undefined' : JSON.stringify(value))
const line = (label, value) => console.log('  ' + String(label).padEnd(26, ' ') + ' ' + value)

console.log('══ EnvDock 模拟场景 ══')
line('mode(s)', opts.mode)
line('sessions', String(opts.sessions) + ' → ' + host.state.agents.map((a) => a.id).join(', '))
line('host-tools', opts.hostTools.length ? opts.hostTools.join(', ') : '(none)')
line('unrestrictable', opts.unrestrictable.length ? opts.unrestrictable.join(', ') : '(none)')
line('executor', opts.executor + (opts.executor === 'none' ? '' : ' (sandboxMode=' + opts.shellSandbox + ')'))
line('policy service', opts.policy)
line('shellTakeover', opts.takeover)
console.log('')

console.log('══ shell / sandbox ══')
if (snap.shell) line('shell', show({ key: snap.shell.key, family: snap.shell.family, label: snap.shell.label, path: snap.shell.path }))
if (snap.sandbox) {
  line('sandbox.capable', show(snap.sandbox.capable))
  line('sandbox.defaultMode', show(snap.sandbox.defaultMode))
  for (const scope of snap.sandbox.scopes || []) {
    line('sandbox.scope ' + scope.id, show({ confined: scope.confined, mode: scope.mode, policyKnown: scope.policyKnown }))
  }
}
console.log('')

const commandTool = snap.commandTool || {}
console.log('══ commandTool ══')
line('name', show(commandTool.name))
line('takeover', show(commandTool.takeover))
line('visible', show(commandTool.visible))
line('sandbox', show(commandTool.sandbox))
line('sandboxMode', show(commandTool.sandboxMode))
line('sandboxConfined', show(commandTool.sandboxConfined))
line('sandboxPolicyKnown', show(commandTool.sandboxPolicyKnown))
line('shippedShell', show(snap.shippedShell))
line('denies', show(commandTool.denies))
const scopes = commandTool.scopes || []
if (scopes.length) {
  console.log('')
  console.log('  commandTool.scopes:')
  const columns = ['id', 'kind', 'tool', 'hostTool', 'confined', 'mode', 'visible', 'ownVisible', 'hidesOwn', 'hidden', 'hostTools', 'anomaly']
  console.log('    ' + columns.map((c) => c.padEnd(12)).join(''))
  for (const scope of scopes) {
    console.log(
      '    ' +
        columns
          .map((c) => {
            const value = scope[c]
            const text = Array.isArray(value) ? (value.length ? value.join('|') : '-') : value === undefined ? '-' : String(value)
            return text.length > 11 ? text.slice(0, 11) : text.padEnd(12)
          })
          .join(''),
    )
  }
}
console.log('')

console.log('══ syncStats ══')
const statFields = [
  'ticks',
  'steadyNow',
  'steadyTicks',
  'yieldTicks',
  'registers',
  'disposes',
  'registerTries',
  'denyApplies',
  'ownHides',
  'hostDenyApplies',
  'sandboxBlocked',
  'blockedScopes',
  'hostOnlyScopes',
  'unrestrictable',
  'scopeAnomalies',
  'executorFamily',
  'executorFamilySource',
  'guardReady',
  'guardDenials',
  'delegateTries',
  'delegateRefusals',
  'delegateFailures',
  'delegateCalls',
  'detections',
  'lastError',
]
for (const field of statFields) line(field, show(stats[field]))

if (opts.brief) {
  console.log('')
  console.log('══ brief(模型看到的那份) ══')
  const scope = host.state.agents[0]
  console.log(scope ? host.state.brief.text({ scope }) : host.state.brief.text())
}

if (delegated) {
  console.log('')
  console.log('══ 委托执行 ══')
  if (delegated.skipped) {
    line('skipped', delegated.reason)
  } else {
    const agentEntry = host.state.agents.find((a) => a.id === delegated.agent) || {}
    const agentMode = modeBySession[(agentEntry.session && agentEntry.session.key) || ''] || defaultMode
    line('agent', delegated.agent)
    line('session mode', agentMode)
    line('path', agentMode === 'danger-full-access' ? '直接 spawn(无围栏会话,不走委托)' : '委托宿主执行器(围栏会话)')
    line('ok', show(delegated.result.ok))
    console.log('  text:')
    console.log(
      String(delegated.result.text || '')
        .split('\n')
        .map((l) => '    ' + l)
        .join('\n'),
    )
    const spec = (host.services.shell && host.services.shell.calls && host.services.shell.calls.executed) || []
    const lastSpec = spec[spec.length - 1]
    if (lastSpec) {
      line('executor command', JSON.stringify(lastSpec.command))
      line('executor env', JSON.stringify(lastSpec.env || {}))
      line('executor policy', JSON.stringify(lastSpec.sandboxPolicy || null))
      line('executor dshEnv', JSON.stringify(lastSpec.dshEnv || null))
    }
    const after = (await getJson()).json.syncStats || {}
    line('stats after delegate', show({ tries: after.delegateTries, refusals: after.delegateRefusals, failures: after.delegateFailures, calls: after.delegateCalls }))
  }
}

console.log('')
console.log('══ /envdock-api 完整 JSON ══')
console.log(JSON.stringify(snap, null, 2))
finish(0)
