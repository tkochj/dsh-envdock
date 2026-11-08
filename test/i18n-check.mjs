/**
 * client.js 的静态自检(开发用,不随包发布)。
 *
 * client.js 是 `window.__ModuleLoader__.load({...})` 形态的浏览器脚本,不能在 Node 里
 * 直接 import;但它的两类错误可以纯静态抓出来:
 *   1. 中英文 DICT 键不一致 → 切到英文面板时出现 undefined
 *   2. 代码里引用了 DICT 里不存在的 t.xxx → 面板上渲染出空白/undefined
 *
 * 跑法: node test/i18n-check.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(HERE, '..', 'client.js'), 'utf8')

function sliceLocale(name) {
  const start = source.indexOf('      ' + name + ': {')
  if (start < 0) throw new Error('找不到 locale 块: ' + name)
  const end = source.indexOf('\n      },', start)
  if (end < 0) throw new Error('locale 块没有闭合: ' + name)
  return source.slice(start, end)
}

function keysOf(block) {
  const out = new Set()
  for (const m of block.matchAll(/^\s{8}([A-Za-z0-9_]+):/gm)) out.add(m[1])
  return out
}

const zhBlock = sliceLocale('zh')
const enBlock = sliceLocale('en')
const zh = keysOf(zhBlock)
const en = keysOf(enBlock)
const references = new Set()
for (const m of source.matchAll(/\bt\.([A-Za-z0-9_]+)/g)) references.add(m[1])

const failures = []
const check = (name, ok, detail) => {
  if (ok) {
    console.log('ok   ' + name)
  } else {
    failures.push(name + (detail ? ' → ' + detail : ''))
    console.log('FAIL ' + name + (detail ? ' → ' + detail : ''))
  }
}

check('zh 有词条', zh.size > 40, String(zh.size))
check('en 有词条', en.size > 40, String(en.size))

const onlyZh = [...zh].filter((k) => !en.has(k))
const onlyEn = [...en].filter((k) => !zh.has(k))
check('中英词条键一致', onlyZh.length === 0 && onlyEn.length === 0, 'zh 独有: ' + onlyZh.join(',') + ' | en 独有: ' + onlyEn.join(','))

const missingZh = [...references].filter((k) => !zh.has(k))
const missingEn = [...references].filter((k) => !en.has(k))
check('代码里引用的词条都在 zh 里', missingZh.length === 0, missingZh.join(','))
check('代码里引用的词条都在 en 里', missingEn.length === 0, missingEn.join(','))

// 占位符检查:{n} / {shell} 这类占位两边要对得上
const placeholders = (block) => {
  const map = new Map()
  for (const m of block.matchAll(/^\s{8}([A-Za-z0-9_]+):\s*'([^']*)'/gm)) {
    const holes = [...m[2].matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort()
    if (holes.length) map.set(m[1], holes.join(','))
  }
  return map
}
const zhPh = placeholders(sliceLocale('zh'))
const enPh = placeholders(sliceLocale('en'))
const phMismatch = [...zhPh.keys()].filter((k) => enPh.get(k) !== zhPh.get(k))
check('中英占位符一致', phMismatch.length === 0, phMismatch.map((k) => k + ': zh=' + zhPh.get(k) + ' en=' + enPh.get(k)).join(' | '))

// 面板必须仍然注册到两个 slot 上
check('注册了 sidebar.panellist', source.includes("slots.inject('sidebar.panellist'"))
check('注册了 main 面板', source.includes("slots.inject('main'"))
check('ModuleLoader id 与包名一致', source.includes("id: 'dsh-envdock'"))

// ── 0.6/0.6.1 口径:两套语法的词条成对存在,0.5 的「同族不重复提供」不许回来 ──
const FAMILY_KEYS = [
  'famBash', 'famPwsh', 'famManual', 'autoShellHint',
  'noteHiddenPwsh', 'noteMixed', 'noteNotBlocked', 'noteNoBashHost', 'noteFamilyFallback', 'noteConfined',
  'skipNoFamilyTerminal', 'blockOtherFamily', 'blockOtherFamilyHint', 'blockOtherFamilyHintTitle',
  'displayOnlyTag', 'hostToolHidden', 'hostToolRefused',
  // 0.6.1 首屏收敏:一句用途说明 + 高级设置 + 简报关闭时的正文说明
  'subtitle', 'advanced', 'briefOffDetail',
]
const missingFamily = FAMILY_KEYS.filter((key) => !zh.has(key) || !en.has(key))
check('0.6 两套语法词条中英成对存在', missingFamily.length === 0, missingFamily.join(','))
check('0.5「同族不重复提供」文案已删除', !source.includes('same-family') && !source.includes('skipSameFamily') && !source.includes('不重复提供'))
check('代码里不再引用 t.skipSameFamily', !/\bt\.skipSameFamily\b/.test(source))
check('占位符 {names} 只在隐藏名单那条用', source.includes('{names}') && !source.includes('{tool}'))
check('0.6.1 首屏不再出现黑话「宿主 / 围栏 / 增补」(zh)', !zhBlock.includes('宿主') && !zhBlock.includes('围栏') && !zhBlock.includes('增补'), ['宿主', '围栏', '增补'].filter((word) => zhBlock.includes(word)).join(','))
check('0.6.1 首屏 badge 二态是白话(就绪 / 只展示)', zhBlock.includes("statusAdditive: '就绪'") && zhBlock.includes("statusDisplayOnly: '只展示'"))
// 「受限」没有主语,只留备注;累计的隐藏/拒绝次数也不再上面板(API 字段仍保留)
const DEAD_PANEL_KEYS = ['statusConfined', 'envHint', 'dRestrictApplied', 'dGuardRefusals']
const alivePanelKeys = DEAD_PANEL_KEYS.filter((key) => zh.has(key) || en.has(key))
check('0.6.1 已删除 statusConfined / envHint / dRestrictApplied / dGuardRefusals', alivePanelKeys.length === 0, alivePanelKeys.join(','))
check('0.6.1 终端 chip 不再带族小标', !source.includes('envd-chipfam') && !source.includes('envd-chiplabel'))
check('0.6.1 底部的「其它」前缀与语法标签都在', zhBlock.includes("hostPrefix: '其它：'") && zhBlock.includes("famBash: 'bash 语法'") && zhBlock.includes("famPwsh: 'PowerShell 语法'"))
check('0.6.1 注入开关移进简报区(词条仍在,footer 不再重复)', zhBlock.includes("injectBrief:'把环境简报注入给 AI'") || zhBlock.includes("injectBrief: '把环境简报注入给 AI'"))
check('0.6.1 受限备注带主语「另有 N 个会话」', zhBlock.includes('另有 {n} 个会话受沙箱限制') && enBlock.includes('{n} other sessions are sandbox-limited'), 'zh=' + zhBlock.includes('另有 {n} 个会话受沙箱限制') + ' en=' + enBlock.includes('{n} other sessions are sandbox-limited'))

console.log('\n' + (failures.length ? failures.length + ' 项失败:' : '全部通过'))
for (const f of failures) console.log('  · ' + f)
process.exit(failures.length ? 1 : 0)
