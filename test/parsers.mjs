/**
 * EnvDock 解析器自测。
 *
 * 本机没装 nvm/pyenv/conda,没法拿真命令做回归,所以把各管理器的真实输出
 * 形状固定成用例,直接验解析函数。跑法: node test/parsers.mjs
 */
import assert from 'node:assert/strict'
import { parseNvmList, parsePyenvVersions, parsePyenvVersion, parseCondaEnvs, parseFnmList, parseFnmCurrent, parseMiseLs } from '../index.js'

const cases = [
  [
    'nvm-windows list',
    parseNvmList,
    ['    20.11.1', '  * 22.14.0 (Currently using 64-bit executable)', 'No running instance of Node.js found at C:\\nvm\\nodejs'].join('\r\n'),
    (rows) => {
      assert.equal(rows.length, 2)
      assert.equal(rows[0].name, '20.11.1')
      assert.equal(rows[0].active, false)
      assert.equal(rows[1].name, '22.14.0')
      assert.equal(rows[1].active, true)
      assert.equal(rows[1].note, '(Currently using 64-bit executable)')
    },
  ],
  [
    'pyenv-win versions',
    parsePyenvVersions,
    ['* 3.12.4 (set by C:\\Users\\x\\.python-version)', '  3.11.9', '  system'].join('\n'),
    (rows) => {
      assert.equal(rows.length, 3)
      assert.equal(rows[0].name, '3.12.4')
      assert.equal(rows[0].active, true)
      assert.equal(rows[2].name, 'system')
    },
  ],
  [
    'conda env list',
    parseCondaEnvs,
    ['# conda environments:', '#', 'base                  *  C:\\Users\\x\\miniconda3', 'dev                      C:\\Users\\x\\miniconda3\\envs\\dev'].join('\n'),
    (rows) => {
      assert.equal(rows.length, 2)
      assert.equal(rows[0].name, 'base')
      assert.equal(rows[0].active, true)
      assert.equal(rows[0].path, 'C:\\Users\\x\\miniconda3')
      assert.equal(rows[1].name, 'dev')
      assert.equal(rows[1].active, false)
    },
  ],
  [
    'fnm list',
    parseFnmList,
    ['* v22.14.0 default', '  v20.11.1'].join('\n'),
    (rows) => {
      assert.equal(rows.length, 2)
      assert.equal(rows[0].name, 'v22.14.0')
      assert.equal(rows[0].active, true)
    },
  ],
  [
    'mise ls',
    parseMiseLs,
    ['node   22.14.0  ~/.config/mise/config.toml', 'python 3.12.4  ~/.config/mise/config.toml'].join('\n'),
    (rows) => {
      assert.equal(rows.length, 2)
      assert.equal(rows[0].tool, 'node')
      assert.equal(rows[0].name, '22.14.0')
    },
  ],
  [
    'conda env list(路径含空格)',
    parseCondaEnvs,
    [
      '# conda environments:',
      '#',
      'base                  *  C:\\Users\\My Name\\miniconda3',
      'dev                      C:\\Users\\My Name\\miniconda3\\envs\\dev',
      'C:\\Users\\My Name\\envs\\prefix-only',
    ].join('\n'),
    (rows) => {
      // 三行都是真实环境:名字列 + 含空格路径、含空格路径、只有路径(无名字前缀环境)
      assert.equal(rows.length, 3)
      assert.equal(rows[0].name, 'base')
      assert.equal(rows[0].active, true)
      assert.equal(rows[0].path, 'C:\\Users\\My Name\\miniconda3')
      assert.equal(rows[1].name, 'dev')
      assert.equal(rows[1].path, 'C:\\Users\\My Name\\miniconda3\\envs\\dev')
      assert.equal(rows[2].name, 'prefix-only')
      assert.equal(rows[2].path, 'C:\\Users\\My Name\\envs\\prefix-only')
    },
  ],
  [
    'mise ls(带表头)',
    parseMiseLs,
    [
      'Tool    Version  Source   Requested',
      'node    22.14.0  ~/.config/mise/config.toml  22',
      'python  3.12.4   ~/.config/mise/config.toml',
      'go      missing',
    ].join('\n'),
    (rows) => {
      // 表头不是数据行,missing 也不是版本号
      assert.equal(rows.length, 2)
      assert.equal(rows[0].tool, 'node')
      assert.equal(rows[0].name, '22.14.0')
      assert.equal(rows[1].tool, 'python')
    },
  ],
  [
    'fnm current',
    parseFnmCurrent,
    ['v20.19.0', ''].join('\r\n'),
    (version) => assert.equal(version, 'v20.19.0'),
  ],
  ['fnm current(失败/空输出)', parseFnmCurrent, '', (version) => assert.equal(version, '')],
  [
    'pyenv version',
    parsePyenvVersion,
    '* 3.12.4 (set by C:\\Users\\x\\.python-version)',
    (version) => assert.equal(version, '3.12.4'),
  ],
  ['pyenv version(system)', parsePyenvVersion, 'system (set by C:\\Users\\x\\.python-version)', (version) => assert.equal(version, 'system')],
  ['empty output stays empty', parseNvmList, '', (rows) => assert.equal(rows.length, 0)],
]

let failed = 0
for (const [name, fn, input, check] of cases) {
  try {
    check(fn(input))
    console.log('ok   ' + name)
  } catch (error) {
    failed += 1
    console.log('FAIL ' + name + ' → ' + (error && error.message))
  }
}
console.log(failed === 0 ? '\nall parser cases passed' : '\n' + failed + ' case(s) failed')
process.exit(failed === 0 ? 0 : 1)
