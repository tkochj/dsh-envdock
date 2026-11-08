/**
 * EnvDock 0.6「两族」纯函数自测(零依赖)。
 *
 * 0.6 推翻 0.5 的「永不遮挡」硬不变量:按会话选语法族,bash 族会话遮挡 PowerShell 族内置命令工具。
 * 判定逻辑被抽成 index.js 里 8 个纯函数(签名冻结),这里逐条钉它们的语义:
 *
 *   FAMILY_GRACE_MS / POWER_SHELL_BUILTIN_NAMES   常量
 *   shellToolGroup(name)                          名字 → 'bash'|'powershell'|'cmd'|'wsl'|''
 *   manualFamilyOf(defaultShell)                  手动终端 → 族('cmd'/'custom' → '' 不遮挡)
 *   autoFamilyOf(hostTools)                       自动:有 bash 族工具 → bash,否则 powershell
 *   resolveSessionFamily({manual,auto,record,now}) 首次判定 / 锁定 / 10s 内升级一次
 *   familyMask({group,blockOtherFamily,hostTools,known,restrictable})  遮挡/拒绝/只展示目标
 *   familyBriefLine(spec)                         简报「命令工具」行(文案子串在这里钉死)
 *
 * 跑法: node test/family.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// index.js 在 import 时会读 DSH_HOME 等状态路径:指到临时目录,绝不碰真实 ~/.dsh。
//(纯函数不写盘,但同一个模块被 host-harness 复用时口径要一致。)
const tempHome = mkdtempSync(join(tmpdir(), 'envdock-family-home-'))
process.env.DSH_HOME = tempHome
process.on('exit', () => {
  try {
    rmSync(tempHome, { recursive: true, force: true })
  } catch {}
})

const failures = []
let checks = 0
/** 与 host-harness 一致的 ok/FAIL 口径。 */
function check(name, cond, detail) {
  checks++
  if (cond) {
    console.log('ok   ' + name)
  } else {
    failures.push(name + (detail ? ' → ' + detail : ''))
    console.log('FAIL ' + name + (detail ? ' → ' + detail : ''))
  }
}
const has = (text, sub) => String(text).includes(sub)

const mod = await import('../index.js')
const REQUIRED = [
  'FAMILY_GRACE_MS',
  'POWER_SHELL_BUILTIN_NAMES',
  'shellToolGroup',
  'manualFamilyOf',
  'autoFamilyOf',
  'resolveSessionFamily',
  'familyMask',
  'familyBriefLine',
]
const missing = REQUIRED.filter((name) => mod[name] === undefined)
for (const name of REQUIRED) check('export: ' + name, mod[name] !== undefined, 'index.js 没有导出 ' + name)
if (missing.length) {
  console.log('')
  console.log('index.js 还没实现 0.6 的纯函数(' + missing.join(', ') + '),等 Lead 落地后再跑。')
  process.exit(1)
}
const {
  FAMILY_GRACE_MS,
  POWER_SHELL_BUILTIN_NAMES,
  shellToolGroup,
  manualFamilyOf,
  autoFamilyOf,
  resolveSessionFamily,
  familyMask,
  familyBriefLine,
} = mod

// ═══════════════════════════════════════════════ 常量 ──
console.log('\n── 常量 ──')
check('FAMILY_GRACE_MS 是 10 秒', FAMILY_GRACE_MS === 10000, String(FAMILY_GRACE_MS))
check(
  'POWER_SHELL_BUILTIN_NAMES 只有 pwsh / powershell(冻结)',
  Array.isArray(POWER_SHELL_BUILTIN_NAMES) &&
    POWER_SHELL_BUILTIN_NAMES.join(',') === 'pwsh,powershell' &&
    Object.isFrozen(POWER_SHELL_BUILTIN_NAMES),
  JSON.stringify(POWER_SHELL_BUILTIN_NAMES),
)

// ═══════════════════════════════════════════════ shellToolGroup ──
console.log('\n── shellToolGroup(内置名单优先,其次名字 token) ──')
for (const [name, want] of [
  ['bash', 'bash'],
  ['sh', 'bash'],
  ['zsh', 'bash'],
  ['fish', 'bash'],
  // dsh-ops 在 cordis 模式用 ops_bash 顶替官方 pwsh/bash(同一套 bash 语法)
  ['ops_bash', 'bash'],
  // 第三方发布名:按 token 认(ops_ + raw 的发布规则会变,名单认不全)
  ['tenant_bash', 'bash'],
  ['gitbash', 'bash'],
  ['pwsh', 'powershell'],
  ['powershell', 'powershell'],
  ['pwsh_persistent', 'powershell'],
  ['tenant_pwsh', 'powershell'],
  ['cmd', 'cmd'],
  ['wsl', 'wsl'],
  // 本插件自己的工具不是「宿主命令工具」
  ['envd_shell', ''],
  ['ops_read_files', ''],
  ['', ''],
]) {
  const got = shellToolGroup(name)
  check('shellToolGroup(' + JSON.stringify(name) + ') = ' + JSON.stringify(want), got === want, JSON.stringify(got))
}
check('shellToolGroup(undefined) = \'\'(不抛)', shellToolGroup(undefined) === '')

// ═══════════════════════════════════════════════ manualFamilyOf ──
console.log('\n── manualFamilyOf(手动选终端 → 族) ──')
for (const [key, want] of [
  ['pwsh', 'powershell'],
  ['powershell', 'powershell'],
  ['bash', 'bash'],
  // WSL 手动选时按 bash 语法计(进去之后跑的就是 bash)
  ['wsl', 'bash'],
  // cmd / 自定义终端不参与两族,也永不遮挡
  ['cmd', ''],
  ['custom', ''],
  ['auto', ''],
  ['', ''],
  [undefined, ''],
]) {
  const got = manualFamilyOf(key)
  check('manualFamilyOf(' + JSON.stringify(key) + ') = ' + JSON.stringify(want), got === want, JSON.stringify(got))
}

// ═══════════════════════════════════════════════ autoFamilyOf ──
console.log('\n── autoFamilyOf(会话能看到 bash 族工具 → bash) ──')
const bt = (name, family, learned = false) => ({ name, family, learned })
check('autoFamilyOf([]) = powershell', autoFamilyOf([]) === 'powershell')
check('autoFamilyOf(undefined) = powershell', autoFamilyOf(undefined) === 'powershell')
check('只有 pwsh → powershell', autoFamilyOf([bt('pwsh', 'powershell')]) === 'powershell')
check('只有 ops_bash → bash', autoFamilyOf([bt('ops_bash', 'bash')]) === 'bash')
check('启发式认出的 bash 也算', autoFamilyOf([bt('tenant_bash', 'bash', true)]) === 'bash')
check(
  '两族都在 → bash(自动选族的优先级)',
  autoFamilyOf([bt('pwsh', 'powershell'), bt('ops_bash', 'bash')]) === 'bash',
)
check(
  'cmd / wsl 不算 bash 族工具',
  autoFamilyOf([bt('cmd', 'cmd'), bt('wsl', 'wsl'), bt('pwsh', 'powershell')]) === 'powershell',
)
check('脏数组项被跳过', autoFamilyOf([null, undefined, {}, bt('ops_bash', 'bash')]) === 'bash')

// ═══════════════════════════════════════════════ resolveSessionFamily ──
console.log('\n── resolveSessionFamily(首次判定 / 锁定 / 10s 内升级一次) ──')
const first = resolveSessionFamily({ manual: '', auto: 'powershell', record: null, now: 1000 })
check(
  '首次判定 auto powershell:changed=true,记录带 at/upgraded=false',
  first.group === 'powershell' &&
    first.source === 'auto' &&
    first.changed === true &&
    first.record.source === 'auto' &&
    first.record.group === 'powershell' &&
    first.record.at === 1000 &&
    first.record.upgraded === false,
  JSON.stringify(first),
)
const firstBash = resolveSessionFamily({ manual: '', auto: 'bash', record: null, now: 2000 })
check(
  '首次判定 auto bash',
  firstBash.group === 'bash' && firstBash.changed === true && firstBash.record.at === 2000,
  JSON.stringify(firstBash),
)

const autoPs = { source: 'auto', group: 'powershell', at: 1000, upgraded: false }
const locked = resolveSessionFamily({ manual: '', auto: 'powershell', record: autoPs, now: 2000 })
check(
  '锁定:powershell 会话再看到 powershell → changed=false、record 原样返回',
  locked.group === 'powershell' && locked.changed === false && locked.record === autoPs,
  JSON.stringify(locked),
)
// 注意 0.6 的锁定口径:锁定的是「族」,不是「永远不再看工具表」——
// 只有首次判成 powershell 且 10 秒内出现 bash 族工具,允许升级**一次**。
const upgraded = resolveSessionFamily({ manual: '', auto: 'bash', record: autoPs, now: 1000 + FAMILY_GRACE_MS })
check(
  '10s 内(含边界)出现 bash 族工具 → 升级成 bash 且只此一次',
  upgraded.group === 'bash' &&
    upgraded.changed === true &&
    upgraded.record.source === 'auto' &&
    upgraded.record.group === 'bash' &&
    upgraded.record.at === 1000 &&
    upgraded.record.upgraded === true,
  JSON.stringify(upgraded),
)
const tooLate = resolveSessionFamily({ manual: '', auto: 'bash', record: autoPs, now: 1000 + FAMILY_GRACE_MS + 1 })
check(
  '超过 10s 才出现 bash 族工具 → 不升级,仍 powershell',
  tooLate.group === 'powershell' && tooLate.changed === false && tooLate.record === autoPs,
  JSON.stringify(tooLate),
)
const alreadyUpgraded = { source: 'auto', group: 'powershell', at: 1000, upgraded: true }
const noSecondUpgrade = resolveSessionFamily({ manual: '', auto: 'bash', record: alreadyUpgraded, now: 1500 })
check(
  '升级只一次(record.upgraded=true 后不再升级)',
  noSecondUpgrade.group === 'powershell' && noSecondUpgrade.changed === false,
  JSON.stringify(noSecondUpgrade),
)
const bashRecord = { source: 'auto', group: 'bash', at: 1000, upgraded: false }
const bashLocked = resolveSessionFamily({ manual: '', auto: 'bash', record: bashRecord, now: 1200 })
check('bash 会话锁定:工具表再变也不回退', bashLocked.group === 'bash' && bashLocked.changed === false, JSON.stringify(bashLocked))
const bashNoDowngrade = resolveSessionFamily({ manual: '', auto: 'powershell', record: bashRecord, now: 1200 })
check(
  'ops_bash 消失(锁定在 bash)→ 仍是 bash(会话结束或重新探测才重判)',
  bashNoDowngrade.group === 'bash' && bashNoDowngrade.changed === false,
  JSON.stringify(bashNoDowngrade),
)

const manualWins = resolveSessionFamily({ manual: 'powershell', auto: 'bash', record: null, now: 3000 })
check(
  '手动族优先:auto 是 bash 也按手动 powershell',
  manualWins.group === 'powershell' &&
    manualWins.source === 'manual' &&
    manualWins.changed === true &&
    manualWins.record.source === 'manual' &&
    manualWins.record.group === 'powershell' &&
    manualWins.record.at === 3000 &&
    manualWins.record.upgraded === true,
  JSON.stringify(manualWins),
)
const manualSwitch = resolveSessionFamily({ manual: 'bash', auto: 'bash', record: { source: 'auto', group: 'powershell', at: 1, upgraded: false }, now: 4000 })
check(
  '自动记录 → 手动族切过去:changed=true、source=manual',
  manualSwitch.group === 'bash' && manualSwitch.source === 'manual' && manualSwitch.changed === true,
  JSON.stringify(manualSwitch),
)
const manualIdle = resolveSessionFamily({ manual: 'bash', auto: 'bash', record: { source: 'manual', group: 'bash', at: 4000, upgraded: true }, now: 5000 })
check(
  // 手动族每次都对账:changed=false 表示「族没变」,但记录里的 at 刷新成这次求值时间(契约口径)
  '手动族不变 → changed=false,记录 at 刷成这次求值时间',
  manualIdle.group === 'bash' && manualIdle.changed === false && manualIdle.record.at === 5000 && manualIdle.record.upgraded === true,
  JSON.stringify(manualIdle),
)
const backToAuto = resolveSessionFamily({ manual: '', auto: 'powershell', record: { source: 'manual', group: 'bash', at: 4000, upgraded: true }, now: 6000 })
check(
  '手动 → 自动重判(record.source!=="auto" 不锁定旧手动族)',
  backToAuto.group === 'powershell' &&
    backToAuto.source === 'auto' &&
    backToAuto.changed === true &&
    backToAuto.record.source === 'auto' &&
    backToAuto.record.group === 'powershell' &&
    backToAuto.record.at === 6000 &&
    backToAuto.record.upgraded === false,
  JSON.stringify(backToAuto),
)
const invalidManual = resolveSessionFamily({ manual: 'cmd', auto: 'bash', record: null, now: 7000 })
check(
  'manual 传非法/不参与两族的值(cmd)→ 当自动',
  invalidManual.source === 'auto' && invalidManual.group === 'bash',
  JSON.stringify(invalidManual),
)
const defaultNow = resolveSessionFamily({ manual: '', auto: 'powershell', record: null })
check('now 省略时用 Date.now()', Number.isFinite(defaultNow.record.at) && defaultNow.record.at > 1_600_000_000_000, String(defaultNow.record.at))

// ═══════════════════════════════════════════════ familyMask ──
console.log('\n── familyMask(三条同时成立才遮挡) ──')
const bashTool = bt('ops_bash', 'bash')
const pwshTool = bt('pwsh', 'powershell')
const maskFull = familyMask({
  group: 'bash',
  blockOtherFamily: true,
  hostTools: [bashTool, pwshTool],
  known: new Set(['ops_bash', 'pwsh', 'bash', 'powershell']),
})
check(
  'bash 会话 + 开关开 + 有 bash 族工具 → active,refuse 含 pwsh,powershell',
  maskFull.active === true && maskFull.refuse.join(',') === 'powershell,pwsh',
  JSON.stringify(maskFull),
)
check('restrictable 省略 = 全可 restrict(hide = refuse)', maskFull.hide.join(',') === 'powershell,pwsh', JSON.stringify(maskFull.hide))
check('没有启发式 PowerShell 名 → displayOnly 空', maskFull.displayOnly.length === 0, JSON.stringify(maskFull.displayOnly))
check(
  'bash 族名字永不出现在 hide / refuse(硬不变量)',
  !maskFull.hide.includes('bash') && !maskFull.refuse.includes('bash') && !maskFull.hide.includes('ops_bash'),
  JSON.stringify(maskFull),
)

const maskOff = familyMask({ group: 'bash', blockOtherFamily: false, hostTools: [bashTool, pwshTool], known: new Set(['pwsh', 'ops_bash']) })
check(
  'blockOtherFamily=false → 一条都不挡',
  maskOff.active === false && maskOff.hide.length === 0 && maskOff.refuse.length === 0 && maskOff.displayOnly.length === 0,
  JSON.stringify(maskOff),
)
const maskPs = familyMask({ group: 'powershell', blockOtherFamily: true, hostTools: [pwshTool], known: new Set(['pwsh', 'ops_bash']) })
check('powershell 族会话 → 不挡(只挡 bash 族会话)', maskPs.active === false && maskPs.hide.length === 0, JSON.stringify(maskPs))
const maskNoBash = familyMask({ group: 'bash', blockOtherFamily: true, hostTools: [pwshTool], known: new Set(['pwsh', 'ops_bash']) })
const maskSticky = familyMask({ group: 'bash', blockOtherFamily: true, sticky: true, hostTools: [pwshTool], known: new Set(['pwsh', 'ops_bash']) })
check(
  'sticky=true 且 bash 族宿主工具暂时消失 → 仍然 active(hide [pwsh],遮挡记忆)',
  maskSticky.active === true && maskSticky.hide.join(',') === 'pwsh' && maskSticky.refuse.join(',') === 'pwsh',
  JSON.stringify(maskSticky),
)
check(
  'sticky=false 同一输入 → active=false、hide 空(ops_bash 消失就立刻放开)',
  maskNoBash.active === false && maskNoBash.hide.length === 0,
  JSON.stringify(maskNoBash),
)
check(
  '没有「本会话看得见的 bash 族工具」→ 不挡(否则手动 bash 会误伤)',
  maskNoBash.active === false && maskNoBash.refuse.length === 0,
  JSON.stringify(maskNoBash),
)
const maskOwnLayer = familyMask({
  group: 'bash',
  blockOtherFamily: true,
  hostTools: [bashTool, pwshTool],
  known: new Set(['ops_bash', 'pwsh']),
  // agent 自有层的 pwsh 不在 restrictableNames 里:refuse 有(guard 拒绝),hide 没有(restrict 挡不掉)
  restrictable: new Set(['ops_bash']),
})
check(
  'agent 自有层的 pwsh → 进 refuse、不进 hide',
  maskOwnLayer.refuse.join(',') === 'pwsh' && maskOwnLayer.hide.length === 0,
  JSON.stringify(maskOwnLayer),
)
const maskLearned = familyMask({
  group: 'bash',
  blockOtherFamily: true,
  hostTools: [bashTool, pwshTool, bt('tenant_pwsh', 'powershell', true)],
  known: new Set(['ops_bash', 'pwsh', 'tenant_pwsh']),
})
check(
  '启发式认出的 PowerShell 名只 displayOnly,不 restrict / 不拒绝',
  maskLearned.displayOnly.join(',') === 'tenant_pwsh' && !maskLearned.hide.includes('tenant_pwsh') && !maskLearned.refuse.includes('tenant_pwsh'),
  JSON.stringify(maskLearned),
)
check('内置 pwsh 仍然被挡(displayOnly 不影响内置)', maskLearned.hide.join(',') === 'pwsh' && maskLearned.refuse.join(',') === 'pwsh', JSON.stringify(maskLearned))
const maskNoKnown = familyMask({ group: 'bash', blockOtherFamily: true, hostTools: [bashTool, pwshTool] })
check('known 省略时从 hostTools 名字取候选', maskNoKnown.refuse.join(',') === 'pwsh', JSON.stringify(maskNoKnown))
const maskBashNames = familyMask({
  group: 'bash',
  blockOtherFamily: true,
  hostTools: [bt('bash', 'bash'), bt('sh', 'bash'), bt('zsh', 'bash'), bt('fish', 'bash'), bashTool, bt('tenant_bash', 'bash', true), pwshTool],
  known: new Set(['bash', 'sh', 'zsh', 'fish', 'ops_bash', 'tenant_bash', 'pwsh']),
})
check(
  '各式 bash 名字(含启发式)永远不会进 hide / refuse',
  ['bash', 'sh', 'zsh', 'fish', 'ops_bash', 'tenant_bash'].every((name) => !maskBashNames.hide.includes(name) && !maskBashNames.refuse.includes(name)) &&
    maskBashNames.hide.join(',') === 'pwsh',
  JSON.stringify(maskBashNames),
)
const maskPwshPersistent = familyMask({
  group: 'bash',
  blockOtherFamily: true,
  hostTools: [bashTool, bt('pwsh_persistent', 'powershell', true)],
  known: new Set(['ops_bash', 'pwsh_persistent']),
})
check(
  'pwsh_persistent(启发式)→ 只展示,不进 hide/refuse',
  maskPwshPersistent.hide.length === 0 && maskPwshPersistent.refuse.length === 0 && maskPwshPersistent.displayOnly.join(',') === 'pwsh_persistent',
  JSON.stringify(maskPwshPersistent),
)

// ═══════════════════════════════════════════════ familyBriefLine ──
console.log('\n── familyBriefLine(简报「命令工具」行) ──')
const lineBash = familyBriefLine({
  family: 'bash',
  familySource: 'auto',
  shellLabel: 'Git Bash',
  terminalAvailable: true,
  registered: true,
  skipReason: null,
  hostTools: [bashTool, pwshTool],
  hidden: ['pwsh'],
  refused: ['pwsh'],
  displayOnly: [],
  mixed: false,
  blockOtherFamily: true,
  bashHostAvailable: true,
  confined: false,
  sessionless: false,
})
check('简报行以「  · 命令工具」开头且是单行', lineBash.startsWith('  · 命令工具') && !lineBash.includes('\n'), JSON.stringify(lineBash.slice(0, 60)))
check('bash 族 + 已注册 → 含「bash 族」与 envd_shell', has(lineBash, 'bash 族') && has(lineBash, 'envd_shell'), lineBash)
check('有 hidden → 含「已隐藏」与「不要调用 pwsh」', has(lineBash, '已隐藏') && has(lineBash, '不要调用 pwsh'), lineBash)
check('不再出现旧文案「同族,EnvDock 不重复提供」', !has(lineBash, '不重复提供') && !has(lineBash, '优先 `envd_shell`'), lineBash)
check(
  '注册 + 有 bash 宿主工具 → 保留「使用分工」两句(版本用 envd_shell / 后台作业用 ops_bash)',
  has(lineBash, '使用分工') && has(lineBash, 'ops_bash') && has(lineBash, 'node/pnpm/python/git'),
  lineBash,
)

const linePs = familyBriefLine({
  family: 'powershell',
  familySource: 'auto',
  shellLabel: 'PowerShell 7',
  terminalAvailable: true,
  registered: true,
  hostTools: [pwshTool],
  hidden: [],
  refused: [],
  displayOnly: [],
  mixed: false,
  blockOtherFamily: true,
  bashHostAvailable: false,
  confined: false,
})
check(
  'auto PowerShell 族 → 含「PowerShell 族」与「未检测到 bash 族工具」',
  has(linePs, 'PowerShell 族') && has(linePs, '未检测到 bash 族工具'),
  linePs,
)
check('PowerShell 族不出现「bash 族」结论(只描述未检测到)', !has(linePs, 'bash 族):'), linePs)

const lineMixed = familyBriefLine({
  family: 'powershell',
  familySource: 'manual',
  shellLabel: 'PowerShell 7',
  terminalAvailable: true,
  registered: true,
  hostTools: [pwshTool, bashTool],
  hidden: [],
  refused: [],
  displayOnly: [],
  mixed: true,
  blockOtherFamily: true,
  bashHostAvailable: true,
  confined: false,
})
check(
  'mixed(手动 PowerShell + 有 bash 族工具)→「两族同时可见」「不要混写」「手动选择」',
  has(lineMixed, '两族同时可见') && has(lineMixed, '不要混写') && has(lineMixed, '手动选择'),
  lineMixed,
)

const lineNotHidden = familyBriefLine({
  family: 'bash',
  familySource: 'auto',
  shellLabel: 'Git Bash',
  terminalAvailable: true,
  registered: true,
  hostTools: [bashTool, pwshTool],
  hidden: [],
  refused: [],
  displayOnly: [],
  mixed: false,
  blockOtherFamily: false,
  bashHostAvailable: true,
  confined: false,
})
check('blockOtherFamily=false 且仍有 PowerShell 宿主工具 → 含「未隐藏」', has(lineNotHidden, '未隐藏'), lineNotHidden)

const lineManualBashNoHost = familyBriefLine({
  family: 'bash',
  familySource: 'manual',
  shellLabel: 'Git Bash',
  terminalAvailable: true,
  registered: true,
  hostTools: [pwshTool],
  hidden: [],
  refused: [],
  displayOnly: [],
  mixed: false,
  blockOtherFamily: true,
  bashHostAvailable: false,
  confined: false,
})
check('手动 bash 但会话没有 bash 宿主工具 → 含「未遮挡」', has(lineManualBashNoHost, '未遮挡'), lineManualBashNoHost)

const lineConfinedBash = familyBriefLine({
  family: 'bash',
  familySource: 'auto',
  shellLabel: 'Git Bash',
  terminalAvailable: true,
  registered: false,
  skipReason: 'no-unconfined-session',
  hostTools: [bashTool],
  hidden: ['pwsh'],
  refused: ['pwsh'],
  displayOnly: [],
  mixed: false,
  blockOtherFamily: true,
  bashHostAvailable: true,
  confined: true,
})
check(
  '围栏 bash 族会话:简报只讲 ops_bash(含「本会话被围栏」「ops_bash」,不含旧「优先 envd_shell」)',
  has(lineConfinedBash, '本会话被围栏') && has(lineConfinedBash, 'ops_bash') && !has(lineConfinedBash, '优先 `envd_shell`'),
  lineConfinedBash,
)

const lineNoTerminal = familyBriefLine({
  family: 'bash',
  familySource: 'auto',
  shellLabel: '未找到 Git Bash',
  terminalAvailable: false,
  registered: false,
  skipReason: 'no-family-terminal',
  hostTools: [bashTool],
  hidden: [],
  refused: [],
  displayOnly: [],
  mixed: false,
  blockOtherFamily: true,
  bashHostAvailable: true,
  confined: false,
})
check('该族没有终端 → 含「未找到」且 envd_shell 未注册', has(lineNoTerminal, '未找到') && has(lineNoTerminal, 'envd_shell'), lineNoTerminal)

const lineConfinedPs = familyBriefLine({
  family: 'powershell',
  familySource: 'auto',
  shellLabel: 'PowerShell 7',
  terminalAvailable: true,
  registered: false,
  skipReason: 'no-unconfined-session',
  hostTools: [pwshTool],
  hidden: [],
  refused: [],
  displayOnly: [],
  mixed: false,
  blockOtherFamily: true,
  bashHostAvailable: false,
  confined: true,
})
check(
  'PowerShell 族围栏 → 含「改用宿主」(不再让人去找 ops_bash)',
  has(lineConfinedPs, '改用宿主') && !has(lineConfinedPs, 'ops_bash'),
  lineConfinedPs,
)

const lineDisplayOnly = familyBriefLine({
  family: 'bash',
  familySource: 'auto',
  shellLabel: 'Git Bash',
  terminalAvailable: true,
  registered: true,
  hostTools: [bashTool, pwshTool],
  hidden: ['pwsh'],
  refused: ['pwsh'],
  displayOnly: ['tenant_pwsh'],
  mixed: false,
  blockOtherFamily: true,
  bashHostAvailable: true,
  confined: false,
})
check('displayOnly 名字在简报里标成「只展示、未遮挡」', has(lineDisplayOnly, 'tenant_pwsh') && has(lineDisplayOnly, '只展示'), lineDisplayOnly)

const lineFallback = familyBriefLine({
  family: 'powershell',
  familySource: 'auto',
  shellLabel: 'PowerShell 7',
  terminalAvailable: true,
  registered: true,
  hostTools: [pwshTool],
  hidden: [],
  refused: [],
  displayOnly: [],
  mixed: false,
  blockOtherFamily: true,
  bashHostAvailable: false,
  fallback: true,
  confined: false,
})
check(
  '手动族不可用回退 auto → 含「手动选择的族不可用」与「已回退自动选族」',
  has(lineFallback, '手动选择的族不可用') && has(lineFallback, '已回退自动选族'),
  lineFallback,
)
check('没有 fallback 时不出现回退文案', !has(linePs, '已回退自动选族'), linePs)

// familyBriefLine 必须能吃到空 spec(首次 tick 之前 / 老宿主)而不抛
let emptyLine = ''
try {
  emptyLine = familyBriefLine({})
} catch (error) {
  emptyLine = 'THREW: ' + (error && error.message)
}
check('familyBriefLine({}) 不抛且返回字符串', typeof emptyLine === 'string' && !emptyLine.startsWith('THREW'), emptyLine)

// ───────────────────────────────────────────── 收尾 ──
console.log('')
console.log('断言 ' + checks + ' 条:通过 ' + (checks - failures.length) + ' 条')
if (failures.length) {
  console.log('')
  for (const failure of failures) console.log('FAIL ' + failure)
  process.exitCode = 1
}
