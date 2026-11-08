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

const zh = keysOf(sliceLocale('zh'))
const en = keysOf(sliceLocale('en'))
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

// ── 0.6「两族」口径:词条成对存在,0.5 的「同族不重复提供」不许回来 ──
const FAMILY_KEYS = [
  'famBash', 'famPwsh', 'famManual', 'famAuto', 'autoShellHint',
  'noteHiddenPwsh', 'noteMixed', 'noteNotBlocked', 'noteNoBashHost', 'noteFamilyFallback', 'noteConfined',
  'skipNoFamilyTerminal', 'blockOtherFamily', 'blockOtherFamilyHint',
  'dRestrictApplied', 'dGuardRefusals', 'displayOnlyTag', 'hostToolHidden', 'hostToolRefused',
]
const missingFamily = FAMILY_KEYS.filter((key) => !zh.has(key) || !en.has(key))
check('0.6 两族词条中英成对存在', missingFamily.length === 0, missingFamily.join(','))
check('0.5「同族不重复提供」文案已删除', !source.includes('same-family') && !source.includes('skipSameFamily') && !source.includes('不重复提供'))
check('代码里不再引用 t.skipSameFamily', !/\bt\.skipSameFamily\b/.test(source))
check('占位符 {names} 只在隐藏名单那条用', source.includes("{names}") && !source.includes('{tool}'))

console.log('\n' + (failures.length ? failures.length + ' 项失败:' : '全部通过'))
for (const f of failures) console.log('  · ' + f)
process.exit(failures.length ? 1 : 0)
