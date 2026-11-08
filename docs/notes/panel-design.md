# EnvDock 面板重做规格：一屏说完「这台机器 / 命令工具能不能用 / 有什么问题」

> 状态：**只读设计规格（未改代码）**。本文件是给实现者的施工图，不是实现本身。
> 作用域：`client.js` 的 `EnvDockPanel` + 内联 `CSS` + `DICT`；不在本规格内的事项（Host 探测、API 字段、接管算法）一律不动。
> 依据：`client.js` 1627 行全文、`docs/DESIGN.md`、`test/panel-render.mjs` 22 组回归、`docs/panel.png`（旧版布局截图）。
> 用户原话：**「面板优化，主要注重简洁」**。本规格所有取舍以「少即是多」为唯一裁判。

---

## 0. 现状读数（为什么要重做）

| 事实 | 数字 | 来源 |
| --- | --- | --- |
| 面板总高 | **1191px** | 实测（1280×720 视口要滚动） |
| 视口可用高度 | ≈ 600–640px | 720 − 顶部栏 |
| 常显块 | 头部 + 接管卡片 + 工具链 + 健康 + 简报 + 底部 = 6 块 | `client.js:1235-1597` |
| 常显胶囊 | 头部 1 badge + 卡片状态 chip = 2 | `client.js:877,1351` |
| 卡片内容 | 终端 chips（5+1）、状态行（状态词+工具名+执行器+3 chips+2 chips）、逐会话（≤5 行）、已识别宿主工具、诊断摘要+折叠计数 = **7 段 11 行** | `client.js:1348-1469` |
| 常显计数 | 诊断摘要 + `diagTitle` 一长串（registers/disposes/denyApplies/ticks/delegate×3/guard/yield/denyDrops/executor/detections/steady…≈18 项） | `client.js:1056-1084` |
| 工具链行高 | 每个工具 **2 行**（名称行 + 路径行），本机 5 工具 + 2 管理器 = 14 行 | `client.js:890-965` |
| 死词条 | 155 键中 18 键无人引用 | `t.` 静态扫描 |

**结论：不是「信息不够」，是「信息全部常显」。** 重做的核心动作只有三个：

1. **收屏**：常显只剩 4 块（头部 / 问题行 / 接管卡 / 工具链），其余全部折进 3 个触发器 + 底部一行。
2. **收胶囊**：全面板只留 **1 个** 胶囊（头部 badge）；卡片里的状态改成「点 + 文字」。
3. **冲突/异常一行说完**：所有「坏了」的结论压进 1 行 `.envd-alert`，点开才是清单。

---

## 1. 目标与验收标准

### 1.1 三个问题必须一眼可答

| 问题 | 承载 | 位置 |
| --- | --- | --- |
| 这是哪台机器 | 系统 + 架构 + 默认终端 + 版本 | 头部件 2 行内 |
| 命令工具能不能用 | 一个状态 badge（红/黄/绿/灰） + 卡片状态词 + 会话点带 | 头部 + 卡片 |
| 有什么问题 | 一行 `.envd-alert`（N 条 + 最重那条短句） | 头部与卡片之间 |

### 1.2 硬验收

1. **1280×720 不出现纵向滚动条**：健康机器常规内容 ≤ **500px**；有问题机器 ≤ **540px**（多 1 行 alert）。按可用 600px 计，余量 ≥ 60px。
2. **健康机器默认 DOM**：无 `.envd-srow`、无 `.envd-issue`、无 `.envd-pre`、无 `.envd-vrow`、无终端 chips、无接管设置 chips、无诊断计数。
3. **胶囊总数 = 1**（`.envd-badge`，只在头部）。
4. **任何折叠区默认不吃用户点击**：所有折叠默认关闭；**有问题也不自动展开**（自动展开会让「收起」假死，且高度不可预测）。折叠态由用户点击决定，且 `useState` 保存、不随 15s 轮询重置。
5. **五态可辨**（§4）：接管 / 宿主工具 / 让路 / 沙箱围栏 / 冲突，`danger-full-access` 与 `workspace-write` 两种模式下结论都正确。
6. **零硬编码颜色**：只用 §7 白名单里的 `--dsw-*` token（含基于 token 的 `color-mix`）。
7. **零新增依赖、零新增文件、零外部资源**（图标继续内联 SVG / 文字）。
8. **中英成对**：`DICT.zh` 与 `DICT.en` 键集合完全一致、占位符一致、EN 块内无中文（由 `test/i18n-check.mjs` 强约束）。

---

## 2. 信息架构

### 2.1 健康机器（默认视图，从上到下）

```
┌ 头部一行 ────────────────────────────────────────────────┐
│ ⌂ EnvDock   Windows_NT 10.0.26300 · x64 · Git Bash v5.3.15   [● 接管]   [重新探测] │
├ 接管卡 ──────────────────────────────────────────────────┤
│ 命令工具 · 接管                                        [接管设置 ▸] │
│ ● 接管中   envd_shell   执行器 powershell（平台默认）                  │
│ 3 个会话  ● ● ●   3 接管                                  [逐会话 ▸] │
│ 默认终端  Git Bash v5.3.15                                 [切换 ▸] │
├ 工具链 ──────────────────────────────────────────────────┤
│ 5 个 · 版本管理器 2                                   [＋ 自定义工具] │
│ 运行时                                                              │
│ ● Node.js  v24.18.0  C:\Program Files\nodejs\node.exe   2 个版本    │
│ ● Python   v3.12.10  D:\python\python.exe               3 个版本    │
│ 包管理                                                              │
│ ● npm      v11.16.0  C:\Program Files\nodejs\npm.cmd              │
│ 版本控制                                                            │
│ ● Git      v2.55.0   E:\Git\cmd\git.exe                           │
│ 版本管理器                                                          │
│ fnm  激活 v20.19.0  1 个版本   E:\tools\fnm\fnm.exe                 │
│ pyenv  激活 3.12.10  2 个版本  E:\tools\pyenv\pyenv-win\bin\pyenv.bat │
├ 底部一行 ────────────────────────────────────────────────┤
│ [开关] 简报注入   [开关] 允许局域网访问     简报 ▸   诊断 ▸   （复制反馈）│
└──────────────────────────────────────────────────────────┘
```

### 2.2 有问题机器（与健康视图的差量 = **1 行**）

只多这一行（在头部与卡片之间），默认收起：

```
⚠ 3 条 · 1 个会话命令工具异常 · 1 个 PATH 目录不存在            [展开 ▾]
```

点开后**原地**展开问题清单（健康 issue 行 + 冲突会话行 + 最近错误），不跳区、不弹窗、不新增区块标题。其余布局与健康视图**逐像素一致**。

为什么把「问题」放头部与卡片之间：它同时解释「badge 为什么是红的」和「卡片为什么有冲突点」，是两者之间的因果位置。

### 2.3 折叠点总表（触发词 / 默认 / 高度代价）

| 折叠点 | 触发器（class） | 默认 | 展开后新增高度 | 触发词 zh / en |
| --- | --- | --- | --- | --- |
| 问题清单 | `.envd-alert-btn` | 收起 | 24px/条，最多 6 条 + 「还有 N 条」 | 展开 / 收起（Expand / Collapse） |
| 接管设置 | `.envd-gear` | 收起 | ≈ 56px（2 组 chips 各一行） | 接管设置 / Takeover settings |
| 逐会话 | `.envd-morebtn` | 收起 | 22px/行，最多 5 行 + 「还有 N 个」 | 逐会话 · {n} / Per session · {n} |
| 终端切换 | `.envd-termtoggle` | 收起 | ≈ 34px（chips 一行，可换行） | 切换 / Switch |
| 多版本 | `.envd-versionchip` | 收起 | 22px/版本 | {n} 个版本 / {n} versions |
| 自定义终端 / 自定义工具 | ghost `＋` | 收起 | ≈ 80px 表单 | 自定义终端 / Custom terminal |
| 环境简报 | `.envd-fold-brief` | 收起 | ≤ 260px（`pre` 内滚动） | 环境简报 / Environment brief |
| 诊断 | `.envd-fold-diag` | 收起 | ≈ 60–120px（chips + 计数） | 诊断 / Diagnostics |

**删掉的常显**（相对现状）：终端 chips、接管模式 3 chips、沙箱下接管 2 chips、逐会话 5 行、已识别宿主工具行、诊断摘要行、健康检查 section、环境简报 section、头部 `⚠ N 条`、卡片内「旧版构建」橙段，共 **9 处**。

### 2.4 高度预算表（1280×720 视口，可排版目标）

| 块 | 高度 | 说明 |
| --- | --- | --- |
| `.envd-scroll` padding | 16 + 16 | 上下各 16（现状 22/64，底部 64 是滚动余量，常显不需要） |
| `.envd-head` | 28 | 单行；标题 + 机器行 + badge + 按钮 |
| gap | 14 | 块间距统一 14（现状 26） |
| `.envd-alert` | 0 / 24 | 仅问题机器 |
| `.envd-card` | 134 | 24 padding + 4 行（20/22/20/24）+ 3×8 gap |
| gap | 14 | |
| `.envd-sec`（工具链） | 231 | 20 标题 + 11 分隔 + 4 组（组标题 17 + 行 22） |
| gap | 14 | |
| `.envd-foot` | 28 | 单行：2 开关 + 2 ghost + 复制反馈 |
| **合计** | **≈ 495 / 533** | 健康 / 有问题；可用按 600 计，余量 ≥ 67px |

工具行从 2 行压成 1 行（`名称 版本 路径 版本数`），工具链从 ≈ 330px → 231px，是最大的一笔收益。

---

## 3. 逐块规格

约定：`data` 为 `/envdock-api` 载荷；`ct = data.commandTool`；`scopes = ct.scopes`（数组字段存在即新服务端）；`stats = data.syncStats`。所有「显示条件」都写成可直接翻译成 JS 的谓词。

### 3.1 头部 `.envd-head`

| 项 | 规格 |
| --- | --- |
| 显示条件 | 永远（含 `data === null` 加载态） |
| 字段 | ① `.envd-h1`：图标（19px）+ `EnvDock`；② `.envd-sys`：`{platform.os} {platform.release} · {arch}`，缺字段时 `平台未知`；③ `.envd-headline`：`<b>{shell.label}</b> v{shell.version}`（**只放终端，不放系统**，保留现有语义与断言）；④ `.envd-badge`（**唯一胶囊**，规则见 §4.4，`title` = 逐会话行 + 计数，仅供补充阅读）；⑤ `.envd-grow`；⑥ `.envd-btn.primary`「重新探测 / 探测中…」，`disabled={busy}` |
| 空态 | `data === null` → ③ 位置显示 `正在读取本机环境…`；①③ 照常，badge 不渲染 |
| 异常态 | 不单独表达异常（异常在 `.envd-alert`）；`busy` 时按钮文案切 `探测中…` 并 disabled |
| 点击 | 仅「重新探测」→ `post({op:'refresh'})`。badge **不可点**（非按钮不绑 onClick） |
| a11y | `h1` 真实标题；badge 为 `span`，`title` 仅作补充（关键信息必须在可见文本里，见 §8）；按钮保持 `<button>` |

**排版**：`flex-wrap:wrap`，单行放不下时换行（不截断标题）。不做 sticky 头部。

### 3.2 问题行 `.envd-alert`

| 项 | 规格 |
| --- | --- |
| 显示条件 | `problems.length > 0`，其中 `problems = healthIssues ∪ conflictSessions ∪ (stats.lastError ? [lastError] : [])`。健康机器整行不渲染（不是空态，是「无此元素」） |
| 字段 | ① `.envd-alert-dot`（level 点：error/warn）；② `.envd-alert-sum` = `⚠ {issueCount} 条` + ` · ` + 至多 2 条短句（`{n} 个会话命令工具异常` / `最近错误` / 最重 issue 标题，按严重度排序，超出的不写）；③ `.envd-grow`；④ `.envd-alert-more`：`展开 / 收起` |
| 展开内容 `#envd-problems.envd-problems` | 健康 issue 行 `.envd-issue.error/warn/info`（标题 + 明细）、冲突会话行 `.envd-prow`（`{id8} · 冲突 · {原因}`）、最近错误行（`.envd-issue.error`，`lastError` 截 160 字 + 龄期） |
| 空态 | 不适用（无问题不渲染） |
| 异常态 | 该行整体用 error token 染色（`.danger`）、`aria-live="polite"`；`error` 级 ≥ 1 条即为 danger，否则 warn 色 |
| 点击 | 整行是 `<button class="envd-alert-btn">`，`aria-expanded` / `aria-controls="envd-problems"`；展开后最多 6 条，余下「还有 N 条」 |
| a11y | 外层 `role="group" aria-live="polite"`；`aria-expanded` 反映状态；不用 `role=alert`（会打断读屏） |

**替换关系**：这一行同时取代现状的 ① 头部 `⚠ N 条` ② 健康检查 section ③ 诊断自动展开 ④ 卡片「旧版构建」橙段。

### 3.3 接管卡 `.envd-card`

全面板**唯一带边框的块**。四行：卡头、状态行、会话行、终端行。

#### 3.3.1 卡头 `.envd-card-h`

| 项 | 规格 |
| --- | --- |
| 字段 | `h2` = `命令工具 · 接管`；`.envd-grow`；`.envd-btn.ghost.envd-gear` = `接管设置` |
| 点击 | `envd-gear` → 展开 `#envd-settings`：① `.envd-mini-label` `接管模式` + `.envd-chips.envd-chips-sm`（自动 / 总是接管 / 只给简报，`aria-pressed`）；② 当 `data.sandbox.capable === true` 时：`.envd-mini-label` `沙箱下接管` + `.envd-chips.envd-chips-sm`（委托执行 / 直接拒绝，`aria-pressed`，`title=sandboxDelegateHint`） |
| 空态 | 无（卡片只在 `data` 存在时渲染） |
| 异常态 | 无 |
| a11y | 每组 chips 外层 `role="group" aria-label={组名}`；每个 chip 必须有同组 `.envd-mini-label`（视觉可见标签，不许只靠 `aria-label`） |

#### 3.3.2 状态行 `.envd-statusline`

一行说清「模型手里此刻是什么工具」：

| 元素 | 内容 | 条件 |
| --- | --- | --- |
| `.envd-state.{tone}` | `● {状态词}`，状态词见 §4.2（**点 + 文字，不是胶囊**） | 永远 |
| `.envd-tool.envd-mono` | 当前命令工具名：`ct.name`；冲突时 `envd_shell + ops_bash`；无工具时 `没探测到宿主命令工具` | 永远 |
| `.envd-exec.envd-muted` | `执行器 {executorFamily}`（`executorFamilySource === 'platform'` 时补 `（平台默认）`） | `stats.executorFamily` 非空 **且**（`data.sandbox.capable` 或存在围栏会话）——即「委托可能发生」时才有信息量 |
| `.envd-legacy` | `旧版服务端：仅汇总` | `scopes` 字段不存在（旧 API） |
| `.envd-grow` | 占位，把长文本推左 | 永远 |

空态：`scopes: []`（新服务端无会话）→ 状态行不报错，由会话行写「当前无会话」。
异常态：冲突时 `.envd-state.bad`，工具名位置写两个名字加 ` + `（**这就是「冲突并存」的可视化**）。

#### 3.3.3 会话行 `.envd-sessions`

| 项 | 规格 |
| --- | --- |
| 字段 | ① `.envd-mini-label` = `{n} 个会话`；② `.envd-strip`（`aria-hidden`，仅 `n ≥ 2`）：每会话一个 6px 点，**按状态优先级排序**（冲突 → 沙箱 → 让路 → 未接管 → 接管），最多 12 个点，超出用 `.envd-more` 写 `+{k}`；③ `.envd-mix`（仅 `n ≥ 2`）：`{a} 接管 · {b} 让路 · {c} 沙箱 · {d} 未接管 · {e} 冲突`，只写非零项，纯文本无胶囊；④ `.envd-grow`；⑤ `.envd-btn.ghost.envd-morebtn`：`逐会话 · {n}`，有冲突时 `逐会话 · {n}（{a} 冲突）` |
| 空态 | `n === 0` 且新服务端 → `.envd-muted` `当前无会话`，不渲染 strip/mix/morebtn；旧服务端 → `.envd-legacy` 一行说明 + 允许展开 fallback 行（`hostOnlyScopes` + `sandboxHiddenScopes` 相加，文案带「约」） |
| 异常态 | 有冲突会话时：`.envd-morebtn` 文案带「（A 冲突）」；`.envd-mix` 里 `{e} 冲突` 用 error token；**不整形变高**（仍是 1 行） |
| 点击 | `.envd-morebtn` → 展开 `#envd-scope-rows`：每个会话一行 `.envd-srow.st-{state}`，冲突行排最前；默认最多 5 行，余下 `.envd-more-scopes`「还有 N 个」；再点收起 |
| a11y | strip 是装饰（`aria-hidden`），状态信息由 `.envd-mix` 文本承载（**不许只靠点色**）；`.envd-morebtn` 带 `aria-expanded` / `aria-controls` |

逐会话行规格（`.envd-srow`）：

```
[点.st-{state}] {id8} · {状态词} · {工具名}                    {原因，仅需要的行}
```

- `st-takeover` / `st-host` / `st-yield` / `st-sandbox` / `st-conflict`（同时给点上色）。
- 工具名：接管 → `envd_shell`；冲突 → `envd_shell + ops_bash` / `无命令工具`；其余 → `sc.tool`。
- 原因（`.envd-sreason`，右侧，可省略）：**只有**冲突 / 沙箱 / 让路三种行给原因，且从固定的 9 个短词里选（§5 `why*`），不拼用户可见的实现细节。
- 文字颜色：行文本保持 `label-primary`/`label-secondary`，只有「点 + 状态词」用状态色（现状是整行红字，对比度与语义都糊）。

#### 3.3.4 终端行 `.envd-termline`

| 项 | 规格 |
| --- | --- |
| 字段 | `.envd-mini-label` `默认终端`；`.envd-term` 终端名（`state.defaultShell === 'auto'` 时显示 `自动`）；`.envd-ver` 版本；`.envd-grow`；`.envd-btn.ghost.envd-termtoggle` `切换` |
| 展开 | `#envd-termchips`：`.envd-chips[role=group][aria-label=默认终端]` = `自动` + 终端（**chip 只写名字，版本进 `title`**，与 `.envd-termline` 里的版本不重复）+ `＋ 自定义终端` ghost；点 `＋` 展开表单 `.envd-fields`（路径 / 名称 / 参数模板 + 添加 / 收起） |
| 空态 | 无终端 → `.envd-muted` `未探测到终端`（新键 `noTerminals`） |
| 异常态 | 当前终端不可用（终端列表里没有 `state.defaultShell`）→ `.envd-term` 后追加 `.envd-warn` 文本 `已失效`（新键 `shellGone`），不整行变红 |
| 点击 | chip → `post({op:'setShell', key})`；`aria-pressed` 反映当前项；表单添加成功自动收起 |
| a11y | chips 组 `role=group` + 可见 label；chip 为 `<button aria-pressed>`；表单 `<label>` 包裹输入框 |

#### 3.3.5 卡内不再有的东西

`已识别宿主命令工具` chips → 移入 §3.6「诊断」；`诊断摘要 + 计数` → 移入「诊断」；接管模式 / 沙箱下接管 chips → 移入「接管设置」。

### 3.4 工具链 `.envd-sec`

| 项 | 规格 |
| --- | --- |
| 显示条件 | `data` 存在即渲染（空态见下） |
| 节头 `.envd-sec-h` | `h2` `工具链`；`.n` 尾注 = `{toolCount} 个` + ` · 版本管理器 {n}`（有才写）+ ` · {n} 个 PATH 目录不存在`（缺失 > 0 才写）；`.tail` 里 `.envd-btn.ghost` `＋ 自定义工具` |
| 工具行 `.envd-trow`（**1 行**） | `.envd-dot`（有默认版本→success，否则 idle）+ `.envd-name` + `.envd-ver`（`v{defaultVersion}` / `未知版本`）+ `.envd-pathbtn`（路径，单行 ellipsis，`title=完整路径`，**点即复制**，复制成功原地变 `✓ 已复制` 1.4s）+ `.envd-btn.ghost.envd-versionchip`（仅 `versions.length > 1`，`{n} 个版本`，`aria-expanded`）+ `.envd-btn.ghost` `移除`（仅自定义工具） |
| 版本展开 | `.envd-vlist`（缩进 12px）每行 `.envd-vrow`：版本 / 路径（ellipsis）/ 动作（`当前` 或 ghost `设为默认`）；最多 8 行，超出「还有 N 个」（版本通常 ≤ 4，可省略但实现要防） |
| 版本管理器行 `.envd-trow.envd-manager` | 名称 + `激活 {active}` + `{n} 个版本`（有才写）+ 命令路径（muted mono，不复制不点击）；`listed === false` 时行尾 `.envd-muted` `在场，但没能列出已装版本`；版本名列表只在 hover `title` 里给（不再常显一行 meta） |
| 分组 | `.envd-group` + `.envd-group-h`（运行时 / 包管理 / 版本控制 / 环境管理 / 自定义 / 版本管理器），`padding: 4px 0 2px`，11px muted |
| 空态 | `tools.length === 0 && managers.length === 0` → `.envd-empty` `PATH 上没扫到 node / python / git。装好后点「重新探测」。` |
| 异常态 | `hasSubprocess === false` → 节头下方一行 `.envd-note`（warn 色，单行）`宿主没有 subprocess 服务，版本探测会缺失`；**不再用红框**。失效路径不在这里逐个报（进 `.envd-alert`） |
| 点击 | 路径→复制；版本 chip→展开候选；设为默认→`post({op:'setTool'})`；移除→`post({op:'removeCustomTool'})`；`＋ 自定义工具`→表单 |
| a11y | 路径按钮要有 `aria-label={复制路径: 完整路径}`；`.envd-versionchip` 带 `aria-expanded`；复制结果在 `.envd-copy-note`（`role=status aria-live=polite`）播报 |

### 3.5 环境简报（底部 ghost 展开）

| 项 | 规格 |
| --- | --- |
| 显示条件 | `data` 存在（403 无数据时不渲染，避免显示假的「已关闭」） |
| 触发器 | 底部 `.envd-btn.ghost.envd-fold-brief` = `环境简报`，`aria-expanded` / `aria-controls="envd-brief"` |
| 展开内容 | `.envd-brief-block`：标题行（`.envd-muted` `已注入` / `简报注入已关闭` + ghost `复制`）+ `pre#envd-brief.envd-pre.envd-mono`（`injectBrief !== true` 时正文写 `简报注入已关闭`；`data.brief` 空写 `尚未探测`）；`max-height:240px; overflow:auto` |
| 空态 | 见上 |
| 异常态 | 无（简报失败不影响面板） |
| 点击 | ghost 展开/收起；复制 → `copy(data.brief,'brief')` |

### 3.6 诊断（底部 ghost 展开）

| 项 | 规格 |
| --- | --- |
| 显示条件 | `data` 存在；触发器 `.envd-btn.ghost.envd-fold-diag` = `诊断`，右侧 tail 文案 `接管正常`（无 warn/error 事实时）或 `{n} 条警告`（有 `unrestrictable`/`blockedScopes`/`lastError` 时），1 行 |
| 展开内容 `#envd-diag` | ① `.envd-diag-line`：`.envd-mini-label` `宿主命令工具` + `.envd-shellchip`（`名字 · 家族`，`learned` 加 `✦` 与 `title=自动识别`；空则 `.envd-muted` `未识别到`）；② `.envd-issue`/`.envd-w` 条目：`挡不住的宿主 shell: {names}`、`有作用域没遮挡: {ids8}`、`最近错误({age}s): {text}`、沙箱事实行（`宿主执行器会围栏 · 部署默认 workspace-write · 有围栏的会话 N 个` / `本会话策略未知`）；③ `.envd-diag-detail`：一行计数（`registers/disposes/denyApplies/ticks/delegate/delegateFailures/delegateRefusals/guard/yield/denyDrops/executor/detections/steady`，` · ` 连写，超长自动换行、**不换行成多块**） |
| 空态 | 全空 → `接管正常` |
| 异常态 | error 级条目用 `.e`（error token），warn 用 `.w`（warn token）；**不自动展开、不顶开面板** |
| 点击 | ghost 展开/收起 |
| a11y | `aria-expanded` / `aria-controls="envd-diag"`；诊断文本允许长，但每条必须是「标签 + 值」而非散文 |

### 3.7 底部一行 `.envd-foot`

| 项 | 规格 |
| --- | --- |
| 字段 | ① `.envd-foot-item` + `.envd-switch`（简报注入，`aria-pressed` / `aria-label`）；② `.envd-foot-item` + `.envd-switch`（允许局域网访问）；③ `.envd-grow`；④ `.envd-btn.ghost.envd-fold-brief`；⑤ `.envd-btn.ghost.envd-fold-diag`；⑥ `.envd-copy-note`（`role=status aria-live=polite`，复制反馈） |
| 显示条件 | 开关①仅在 `data` 存在时渲染；开关②**永远渲染**（403 被挡在门外时它是唯一解法）；④⑤仅在 `data` 存在时渲染；⑥永远 |
| 异常态 | 无数据（403）：只剩开关② + 复制反馈，**不许出现假的「简报注入：关」** |
| a11y | 开关是 `<button aria-pressed>`（不是 checkbox）：语义上用 `role="switch"` 或 `aria-pressed` 二者取一，`aria-checked` 只在真 switch 上用；标签与控件在同一 `.envd-foot-item` 里，`aria-label` 与可见标签同文 |

### 3.8 加载 / 错误 / 操作失败（不占常显）

| 状态 | 表现 |
| --- | --- |
| `data === null`（首次加载） | 头部照常 + 3 条 `.envd-skel` 骨架（42% / 72% / 58%），`prefers-reduced-motion` 下不动画 |
| `error && !data` | `.envd-err[role=alert]`：`读取失败: {error}` + `读取失败提示` + ghost `重新探测`。**唯一允许的整块错误框**（此时面板本来就没有内容） |
| `opError` | `.envd-err[role=alert]`：`操作失败: {error}` + ghost `知道了`，可关闭，不绑 `data` |
| `hasSubprocess === false` | 一行 `.envd-note`（§3.4 异常态），不是红框 |

---

## 4. 接管可视化（重点）

### 4.1 五态的定义（逐会话推导，优先级从上到下）

```js
function sessionState(sc) {
  // ① 冲突并存 —— 「这个会话出了问题」优先于一切
  if (sc.anomaly === true) return 'conflict'
  if (!sc.tool) return 'conflict'                                   // 零命令工具
  if (sc.visible === false) return 'conflict'                       // 该会话拿不到工具
  if (sc.ownNameVisible === true && sc.ownOurs === false) return 'conflict' // 同名工具不是我们登记的
  if (Array.isArray(sc.leaked) && sc.leaked.length) return 'conflict'       // 挡了却仍可见
  if (sc.kind === 'takeover' && Array.isArray(sc.hostTools) && sc.hostTools.length) return 'conflict' // 接管下宿主仍可见
  // ② 沙箱围栏 —— confined 是「确定无围栏(false)」之外的一切（true / null）
  if (sc.kind === 'sandbox-host' || sc.confined !== false) return 'sandbox'
  // ③ 让路
  if (sc.kind === 'yield') return 'yield'
  // ④ 直连接管
  if (sc.kind === 'takeover') return 'takeover'
  // ⑤ 未接管
  return 'host'
}
```

三处必须写对的判据：

1. **`confined` 是三态**（`true` / `false` / `null`）。`null = 策略不可知`，执行层按「有围栏」保守处理 → 视觉上归入 `sandbox`，原因写 `策略未知`。**绝不能把 `null` 当 `false`**（那会把围栏会话画成「未接管」）。
2. **`kind === 'host'` + `confined === true` 就是沙箱围栏**（`workspace-write` 单会话 / 全部会话被围栏时服务端不注册 `envd_shell`，`kind` 落在 `host`）。只看 `kind` 会把这一整类画成「未接管」，用户看不到「为什么没接管」。
3. **冲突必须由客户端也能判定**，不能只信服务端 `anomaly`：`!tool` / `visible === false` / `leaked` / 接管下 `hostTools` 非空，客户端都能从字段推出来（旧服务端可能没算 `anomaly`）。

### 4.2 五态视觉方案（一行状态词 + 工具名 + 点带）

| 状态 | 卡片状态词 | 点色 / tone | 点 class | 工具名格 | 原因（逐会话行） | 典型 payload |
| --- | --- | --- | --- | --- | --- | --- |
| **EnvDock 接管** | `接管中` | 绿 `state-success-primary` | `.ok` | `envd_shell` | 无（正常不给原因） | `kind:'takeover'`、`anomaly:false` |
| **宿主工具接管(ops_bash)** | `未接管` | 灰蓝 `state-idle-primary` | `.idle` | `ops_bash` | `只给简报`（option=off）/ `由其它插件提供`（reuse）/ 无 | `kind:'host'`、`confined:false` |
| **让路** | `让路` | 黄 `state-warn-primary` | `.warn` | `ops_bash` | `宿主工具作用域私有`（`hidesOwn` 且 `hostTool` 在） | `kind:'yield'`、`hidesOwn:true` |
| **沙箱围栏** | `沙箱` | 蓝 `state-business-primary` | `.info` | 宿主工具名 | `围栏 · workspace-write` / `策略未知` | `confined:true`（kind 任意）或 `confined:null` |
| **冲突并存** | `冲突` | 红 `state-error-primary` | `.bad` | `envd_shell + ops_bash` 或 `无命令工具` | `宿主工具仍可见` / `无命令工具` / `同名工具非本插件` | `anomaly:true` / `leaked:['bash']` / 接管下 `hostTools:['bash']` / `tool:null` |

- **点带**（`n ≥ 2` 才有）是按状态着色的 6px 点，顺序：冲突 → 沙箱 → 让路 → 未接管 → 接管。点带 `aria-hidden`，语义由同一行的 `.envd-mix` 文本承担（`3 接管 · 1 让路 · 1 冲突`）——**颜色永不单独承载语义**。
- **状态词不是胶囊**：`● 接管中` 用一个点 + 12px 650 字重文字，背景透明。整个面板的唯一胶囊是头部 badge。
- **沙箱蓝的理由**：沙箱是「设计行为」而非故障（用红/黄都会误导），但也不能和「未接管」同灰（否则用户分不出「EnvDock 主动让位给围栏」与「EnvDock 没接管」）。`--dsw-alias-state-business-primary` 是 theme 里现成的中性状态蓝。
- **状态词优先级**（卡片那一个词，从会话分布聚合）：

  ```
  有冲突 → 冲突
  否则 有接管 且 还有非接管 → 混合
  否则 有让路 → 让路
  否则 有沙箱 → 沙箱
  否则 全部接管 → 接管中
  否则 → 未接管
  ```

### 4.3 两种沙箱模式下的正确结论（验收矩阵）

| # | 场景 | API 事实 | 卡片状态词 | 会话点 | 头部 badge | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| A | `danger-full-access`，接管成功 | `ct.sandbox:true`、`ct.sandboxConfined:false`、`scopes[].kind:'takeover'`、`confined:false` | `接管中` | 绿 | ok `模型可见` | 直连接管，路径最短 |
| B | `danger-full-access`，只给简报 | `options.shellTakeover:'off'`、`kind:'host'`、`confined:false` | `未接管` | 灰蓝 | muted `未接管` | 用户主动关掉，不是故障 |
| C | `danger-full-access`，宿主 shell 作用域私有 | `kind:'yield'`、`hidesOwn:true`、`connected` | `让路` | 黄 | warn `N 个会话用宿主工具` | 挡不掉 → 藏自己，保证「一个命令工具」 |
| D | `workspace-write`，**单会话/全部围栏** | `kind:'host'`、`confined:true`、`mode:'workspace-write'`、`ct.name:'ops_bash'`、服务端**根本没注册** `envd_shell` | `沙箱` | 蓝 | muted `未接管` | 必须靠 `confined:true` 认出，不能只看 `kind` |
| E | `workspace-write` + 别的无围栏会话（混合部署） | 本会话 `kind:'sandbox-host'`、`confined:true`；另有 `kind:'takeover'` | `混合` | 蓝 + 绿 | warn `N 个会话用宿主工具` | `sandbox-host` 只在此刻出现 |
| F | 策略不可知 | `confined:null`、`policyKnown:false` | `沙箱` | 蓝 | muted `未接管`（或 bad 若工具不可见） | 原因写 `策略未知`；**不回落部署默认档** |
| G | 冲突：接管下宿主仍可见 | `kind:'takeover'` 且 `hostTools:['bash']`、`leaked:['bash']` | `冲突` | 红（排最前） | bad `N 个会话命令工具异常` | 工具格写 `envd_shell + bash` |
| H | 冲突：零命令工具 | `tool:null`、`visible:false` | `冲突` | 红 | bad `N 个会话命令工具异常` | 工具格写 `无命令工具` |
| I | 冲突：同名工具被别人顶掉 | `ownNameVisible:true`、`ownOurs:false`、`anomaly:true` | `冲突` | 红 | bad | 原因 `同名工具非本插件` |
| J | 旧服务端（无 `scopes` 字段） | 只有 `hostOnlyScopes` / `sandboxHiddenScopes` 计数 | `让路`/`沙箱`（按 fallback） | 无点带 | warn `约 N 个会话用宿主工具` | 会话行写 `旧版服务端：仅汇总`，不伪造逐会话 |

**判定顺序铁律**：`scopes` 是数组字段 → 逐会话事实优先；没有该字段 → 才用 `ct.sandboxConfined` + 旧计数兜底；有字段但 `[]` → 「当前无会话」，此时沙箱词用 `ct.sandboxConfined` 兜底（无逐会话事实可用）。

### 4.4 头部 badge 规则（保持现状，只做减法）

现状规则是对的（`DESIGN.md` 已固化），**不要改**，只把「问题数」移走：

| 顺序 | 条件 | 文案 | tone |
| --- | --- | --- | --- |
| 1 | `!ct` | `没探测到宿主命令工具` | muted |
| 2 | 有冲突会话 | `{n} 个会话命令工具异常` | bad |
| 3 | `ct.reuse` | `由其它插件提供` | muted |
| 4 | 真混合（有接管 + 有非接管，且非全部未接管） | `{n} 个会话用宿主工具` | warn |
| 5 | `ct.visible && ct.takeover` | `模型可见` | ok |
| 6 | `ct.visible && !ct.takeover` | `未接管` | muted |
| 7 | `!ct.visible` | 沙箱能力 → `沙箱`；否则 `不可见：会 UNKNOWN_TOOL` | muted / bad |

`title` 保留：逐会话行 + 逐会话原因 + `旧版服务端` 说明 + 计数（`diagTitle`）。**title 只是补充**：所有结论在可见区域都有等价文本（卡片状态词 + 点带 + 问题行）。

---

## 5. 文案（完整中英词条）

### 5.1 风格硬规则

1. 中文 ≤ 6 字，英文 ≤ 3 词；能名词化就名词化（`接管中` 而非 `已接管成功`）。
2. **不用感叹号、不用问号、不用「请」**；不解释实现（不出现 `restrict` / `scope` / `sandboxPolicy` 这类词）。
3. 数字与单位之间加空格：`3 条`、`5 个`、`v24.18.0`。
4. 英文 sentence case（`Takeover settings`），专有名词保持原样（`EnvDock`、`envd_shell`、`ops_bash`、`workspace-write`）。
5. 一条词条只承担一个意思；不许在代码里拼中文（所有可见文本必须来自 `DICT`）。
6. 占位符统一 `{n}` / `{mode}` / `{names}` / `{tools}` / `{a}` / `{id}` / `{shell}`，中英**逐一对应**（`i18n-check` 会失败）。

### 5.2 新增 / 改写的键（含 zh / en）

| 键 | zh | en | 用在哪 |
| --- | --- | --- | --- |
| `takeoverCard` | 命令工具 · 接管 | Command tool · takeover | 卡头 |
| `takeoverSettings` | 接管设置 | Takeover settings | 卡头 ghost |
| `platformUnknown` | 平台未知 | platform unknown | `.envd-sys` 兜底 |
| `nSessions` | {n} 个会话 | {n} session(s) | 会话行 |
| `sessionsButton` | 逐会话 · {n} | Per session · {n} | 逐会话触发器 |
| `sessionsButtonBad` | 逐会话 · {n}（{a} 冲突） | Per session · {n} ({a} conflicts) | 有冲突时 |
| `moreSessions` | 还有 {n} 个 | {n} more | 逐会话展开后 |
| `emptySessions` | 当前无会话 | no sessions yet | 空态 |
| `legacyNote` | 旧版服务端：仅汇总 | older host: aggregate only | 旧 API 一行 |
| `mixTakeover` | {n} 接管 | {n} taken over | 混排文本 |
| `mixHost` | {n} 未接管 | {n} not taken over | 混排文本 |
| `mixYield` | {n} 让路 | {n} stepped aside | 混排文本 |
| `mixSandbox` | {n} 沙箱 | {n} sandboxed | 混排文本 |
| `mixConflict` | {n} 冲突 | {n} conflict | 混排文本 |
| `statusTakeover` | 接管中 | takeover | 卡片状态词 |
| `statusMixed` | 混合 | mixed | 卡片状态词 |
| `statusYield` | 让路 | stepped aside | 卡片状态词 |
| `statusSandbox` | 沙箱 | sandboxed | 卡片状态词 / badge |
| `statusHost` | 未接管 | not taken over | 卡片状态词 |
| `statusConflict` | 冲突 | conflict | 卡片状态词 |
| `scopeKindTakeover` | 直连接管 | direct takeover | 会话行状态词 |
| `scopeKindHost` | 未接管 | not taken over | 会话行状态词 |
| `scopeKindYield` | 让路 | stepped aside | 会话行状态词 |
| `scopeKindSandbox` | 沙箱围栏 | sandbox-confined | 会话行状态词 |
| `scopeKindConflict` | 冲突 | conflict | 会话行状态词 |
| `whyNoTool` | 无命令工具 | no command tool | 冲突原因 |
| `whyHostVisible` | 宿主工具仍可见 | host tool still visible | 冲突原因 |
| `whyNotOurs` | 同名工具非本插件 | same name, not EnvDock's | 冲突原因 |
| `whyNotVisible` | 对模型不可见 | not visible to the model | 冲突原因 |
| `whyHidden` | 已挡 {names} | hides {names} | 接管行补充（可选） |
| `whyConfined` | 围栏 · {mode} | confined · {mode} | 沙箱原因 |
| `whyConfinedNoMode` | 围栏 | confined | 沙箱原因（mode 空） |
| `whyPolicyUnknown` | 策略未知 | policy unknown | 沙箱原因 |
| `whyScopeLocal` | 宿主工具作用域私有 | host tool is scope-local | 让路原因 |
| `whyBriefOnly` | 只给简报 | brief only | 未接管原因 |
| `issueCount` | {n} 条 | {n} issue(s) | 问题行 |
| `healthTitle` | 健康检查 | Health | 问题清单分组 |
| `alertMore` | 还有 {n} 条 | {n} more | 问题清单 |
| `alertErrorAge` | 最近错误（{n}s） | last error ({n}s) | 问题清单 |
| `noTerminals` | 未探测到终端 | no terminal detected | 终端行空态 |
| `shellGone` | 已失效 | gone | 当前终端不在列表 |
| `diagNote` | 诊断 | Diagnostics | 底部 ghost |
| `diagWarnCount` | {n} 条警告 | {n} warning(s) | 诊断 tail |
| `changeTerminal` | 切换 | Switch | 终端行 ghost |
| `hostTools` | 宿主命令工具 | host command tools | 诊断行 |
| `pathClickHint` | 点击复制路径 | click to copy path | 路径 title |
| `subtitle` | （删除，面板内无处使用） | — | — |

### 5.3 保留（正文不变或只错字级调整）

`title` `refresh` `detecting` `loading` `updatedAt` `defaultShell` `customShell` `tools` `noTools` `versionChip` `default` `setDefault` `copy` `copied` `noIssue`→（删）`health`（→`healthTitle`） `brief` `briefHint`（缩短为 `已注入` / `injected`） `briefOff` `injectBrief`（缩短为 `简报注入` / `Inject brief`） `allowLan` `allowLanHint` `takeoverAuto` `takeoverOn` `takeoverOff` `modeLabel` `sandboxTakeover` `sandboxDelegate` `sandboxRefuse` `sandboxDelegateHint`（缩成一句） `cmdVisible` `cmdInvisible` `deniesLabel` `noCommandTool` `byHost` `takenOver` `takenOverHides` `reuseByOther` `managers` `managersActive` `managersVersions` `managersNoList` `pathMissing` `versionUnknown` `expand` `collapse` `dismiss` `actionFailed` `loadFailed` `loadFailedHint` `never` `add` `addFailed` `remove` `name` `labelPath` `labelArgs` `customHint` `customTool` `customShellArgs` `customShellArgsHint` `groupRuntime` `groupPackage` `groupVcs` `groupEnv` `groupCustom` `toolCount` `copyBrief` `copyPathHint` `copyFailed` `subprocessOff` `scopesSummary` `scopesSummaryApprox` `scopesAnomaly` `scopesLegacyNote` `scopesLegacyCount` `scopesHint` `scopeLine` `runtimeShellTools` `runtimeShellToolsNone` `learnedTag` `executorPlatform` `syncExecutorFamily` 以及全部 `sync*` 计数键（进诊断展开区）。

### 5.4 删除（不再引用，避免死键）

`subtitle` `system` `copy`→（保留，路径复制在用） `healthy` `noIssue` `warn` `error` `info` `options` `versions` `managersNone` `stale` `pathEntries` `commandTool` `takeover`（旧的「终端接管」） `sandboxNoTakeover` `sandboxCapable`→（保留在诊断） `sandboxDefault`（保留在诊断） `sandboxFree`（保留在诊断） `sandboxScopeCount`（保留在诊断） `scopeAnomalyInvisible` `scopeAnomalyLeak` `scopeAnomalyFlagged` `scopeConfined` `scopePolicyUnknown` `scopeHidden` `syncHostOnly` `syncHostOnlyHint` `syncUnrestrictable`→（保留） `diagHealthy`（保留） `diagAutoHint` `syncScopeAnomalies` `statusAnomaly`（→`statusConflict`） `cmdNotTakenOver`→（保留，badge 用） `sessionsMore` / `sessionsMoreAnomaly`（→`sessionsButton` / `moreSessions`） `scopesEmpty`（→`emptySessions`） `scopeKindUnknown`（→`scopeKindConflict`） `countItems`（→`issueCount`）。

> 死键清零后 `DICT` 从 **155 键 / 155 键** 收到约 **112 键 / 112 键**（新增 44、删除 31、改写 20 余条文案）。

---

## 6. DOM 结构草案（JSX 伪代码 + class 名）

class 一律 `envd-` 前缀。`{…}` 表示条件渲染。所有可点的都是 `<button>`，所有展开项都带 `aria-expanded` + `aria-controls`。

```jsx
<div className="envd-root">
  <style>{CSS}</style>
  <div className="envd-scroll">

    {/* ── 头部：1 行 ── */}
    <div className="envd-head">
      <h1 className="envd-h1"><EnvDockIcon size={19} />{t.title}</h1>
      <span className="envd-sys">{sysText /* os release · arch，缺失→t.platformUnknown */}</span>
      <span className="envd-headline"><b>{shell.label}</b>{shell.version ? ' v' + shell.version : ''}</span>
      {data ? <span className={'envd-badge ' + badge.tone} title={badge.title}>{<i className="dot" />}{badge.text}</span> : null}
      <span className="envd-grow" />
      <button className="envd-btn primary" disabled={busy} onClick={() => post({ op: 'refresh' })}>
        {busy ? t.detecting : t.refresh}
      </button>
    </div>

    {/* ── 加载骨架：仅首屏 ── */}
    {!data ? <div className="envd-loading">
      <div className="envd-skel" style={{ width: '42%' }} />
      <div className="envd-skel" style={{ width: '72%' }} />
      <div className="envd-skel" style={{ width: '58%' }} />
    </div> : null}

    {/* ── 错误 / 操作失败（唯一允许的整块错误框） ── */}
    {error && !data ? <div className="envd-err" role="alert">…</div> : null}
    {opError ? <div className="envd-err" role="alert">…</div> : null}

    {/* ── 问题行：有问题才有，默认收起 ── */}
    {data && problems.length ? (
      <div className="envd-alert-wrap" role="group" aria-live="polite">
        <button className={'envd-alert-btn' + (problems.danger ? ' danger' : '')}
                aria-expanded={problemsOpen} aria-controls="envd-problems"
                onClick={() => setProblemsOpen(v => !v)}>
          <i className="envd-alert-dot" />
          <span className="envd-alert-sum">{problems.summary /* ⚠ 3 条 · 1 个会话命令工具异常 */}</span>
          <span className="envd-grow" />
          <span className="envd-alert-more">{problemsOpen ? t.collapse : t.expand}</span>
        </button>
        {problemsOpen ? (
          <div className="envd-problems" id="envd-problems">
            {issues.map(issueRow) /* .envd-issue.error|warn|info */}
            {conflictScopes.map(conflictRow) /* .envd-prow */}
            {lastError ? <div className="envd-issue error">…</div> : null}
            {rest > 0 ? <span className="envd-muted">{fmt(t.alertMore, { n: rest })}</span> : null}
          </div>
        ) : null}
      </div>
    ) : null}

    {data ? (
      <>
        {/* ── 接管卡：全面板唯一带边框的块 ── */}
        <section className="envd-card">
          <div className="envd-card-h">
            <h2>{t.takeoverCard}</h2>
            <span className="envd-grow" />
            <button className="envd-btn ghost envd-gear" aria-expanded={settingsOpen}
                    aria-controls="envd-settings" onClick={() => setSettingsOpen(v => !v)}>
              {t.takeoverSettings}
            </button>
          </div>

          {settingsOpen ? (
            <div className="envd-settings" id="envd-settings">
              <span className="envd-mini-label">{t.modeLabel}</span>
              <div className="envd-chips envd-chips-sm" role="group" aria-label={t.modeLabel}>
                {['auto', 'takeover', 'off'].map(k =>
                  <button className={'envd-chip' + (takeoverMode === k ? ' on' : '')}
                          aria-pressed={takeoverMode === k} onClick={…}>{modeLabelOf(k)}</button>)}
              </div>
              {sandbox.capable ? <>
                <span className="envd-mini-label">{t.sandboxTakeover}</span>
                <div className="envd-chips envd-chips-sm" role="group" aria-label={t.sandboxTakeover} title={t.sandboxDelegateHint}>
                  {['delegate', 'refuse'].map(k => <button className="envd-chip …" aria-pressed={…}>{…}</button>)}
                </div>
              </> : null}
            </div>
          ) : null}

          {/* 状态行：点 + 文字（不是胶囊） */}
          <div className="envd-statusline">
            <span className={'envd-state ' + state.tone}><i className="dot" />{state.text}</span>
            <span className="envd-tool envd-mono">{state.toolText /* envd_shell | ops_bash | envd_shell + bash | — */}</span>
            {executorText ? <span className="envd-exec envd-muted">{executorText}</span> : null}
            {!hasScopeField ? <span className="envd-legacy">{t.legacyNote}</span> : null}
            <span className="envd-grow" />
          </div>

          {/* 会话行：点带 + 混排 + 逐会话 */}
          <div className="envd-sessions">
            <span className="envd-mini-label">{fmt(t.nSessions, { n: scopes.length })}</span>
            {scopes.length >= 2 ? <span className="envd-strip" aria-hidden="true">
              {dots.map(d => <i className={'envd-sdot ' + d.tone} title={d.title} />)}
              {extraDots > 0 ? <span className="envd-more">+{extraDots}</span> : null}
            </span> : null}
            {scopes.length >= 2 ? <span className="envd-mix">{mixText}</span> : null}
            {scopes.length === 0 && hasScopeField ? <span className="envd-muted">{t.emptySessions}</span> : null}
            <span className="envd-grow" />
            {scopes.length ? <button className="envd-btn ghost envd-morebtn" aria-expanded={sessionsOpen}
                    aria-controls="envd-scope-rows" onClick={() => setSessionsOpen(v => !v)}>{sessionsLabel}</button> : null}
          </div>
          {sessionsOpen ? <div className="envd-scoperows" id="envd-scope-rows">
            {shownScopes.map(sc => (
              <div className={'envd-srow st-' + sc.state} data-state={sc.state} key={sc.id}>
                <i className={'envd-sdot ' + toneOf(sc.state)} />
                <span className="envd-sid envd-mono">{id8(sc.id)}</span>
                <span className="envd-skind">{kindText(sc.state)}</span>
                <span className="envd-stool envd-mono">{toolText(sc)}</span>
                {reason ? <span className="envd-sreason">{reason}</span> : null}
              </div>
            ))}
            {more > 0 ? <button className="envd-btn ghost envd-more-scopes">{fmt(t.moreSessions, { n: more })}</button> : null}
          </div> : null}

          {/* 终端行 */}
          <div className="envd-termline">
            <span className="envd-mini-label">{t.defaultShell}</span>
            <span className="envd-term">{state.defaultShell === 'auto' ? t.autoShell : shell.label}</span>
            {shell.version ? <span className="envd-ver">v{shell.version}</span> : null}
            {shellGone ? <span className="envd-warn">{t.shellGone}</span> : null}
            <span className="envd-grow" />
            <button className="envd-btn ghost envd-termtoggle" aria-expanded={termOpen}
                    aria-controls="envd-termchips" onClick={() => setTermOpen(v => !v)}>{t.changeTerminal}</button>
          </div>
          {termOpen ? <div className="envd-termchips" id="envd-termchips">
            <div className="envd-chips" role="group" aria-label={t.defaultShell}>
              {chips /* 自动 + 终端，chip 只写名字，版本进 title */}
              <button className="envd-chip envd-customshell" onClick={() => setShellFormOpen(true)}>＋ {t.customShell}</button>
            </div>
            {shellFormOpen ? <div className="envd-fields">…</div> : null}
          </div> : null}
        </section>

        {/* ── 工具链 ── */}
        <section className="envd-sec">
          <div className="envd-sec-h">
            <h2>{t.tools}</h2>
            <span className="n">{toolsTail /* 5 个 · 版本管理器 2 · 1 个 PATH 目录不存在 */}</span>
            <span className="tail"><button className="envd-btn ghost" onClick={() => setToolFormOpen(true)}>＋ {t.customTool}</button></span>
          </div>
          <div className="envd-sec-b">
            {hasSubprocess === false ? <div className="envd-note">{t.subprocessOff}</div> : null}
            {groups.length ? groups.map(g => (
              <div className="envd-group" key={g.group}>
                <div className="envd-group-h">{groupLabel(g.group)}</div>
                {g.items.map(item => g.kind === 'manager' ? managerRow(item) : toolRow(item))}
              </div>
            )) : <div className="envd-empty">{t.noTools}</div>}
            {toolFormOpen ? <div className="envd-fields">…</div> : null}
          </div>
        </section>

        {/* ── 简报展开体（在底部之前） ── */}
        {briefOpen ? <div className="envd-brief-block">
          <div className="envd-brief-h">
            <span className="envd-muted">{options.injectBrief === true ? t.briefHint : t.briefOff}</span>
            <span className="envd-grow" />
            <button className="envd-btn ghost" onClick={() => copy(data.brief || '', 'brief')}>
              {copied === 'brief' ? '✓ ' + t.copied : t.copyBrief}
            </button>
          </div>
          <pre className="envd-pre envd-mono" id="envd-brief">…</pre>
        </div> : null}

        {/* ── 诊断展开体 ── */}
        {diagOpen ? <div className="envd-diag-block" id="envd-diag">
          <div className="envd-diag-line">
            <span className="envd-mini-label">{t.hostTools}</span>
            {runtimeShellTools.length
              ? runtimeShellTools.map(x => <span className="envd-shellchip" title={…}>
                  <span className="envd-mono">{x.name}</span>
                  {x.family ? <span className="envd-muted"> · {x.family}</span> : null}
                  {x.learned ? <span className="envd-learned" title={t.learnedTag}> ✦</span> : null}
                </span>)
              : <span className="envd-muted">{t.runtimeShellToolsNone}</span>}
          </div>
          {diagWarns.map(w => <div className={'envd-issue ' + w.level}>{w.text}</div>)}
          <div className="envd-diag-detail">{diagTitle(stats)}</div>
        </div> : null}
      </>
    ) : null}

    {/* ── 底部一行 ── */}
    <div className="envd-foot">
      {data ? <div className="envd-foot-item">
        <span>{t.injectBrief}</span>
        <button className={'envd-switch' + (options.injectBrief === true ? ' on' : '')}
                aria-pressed={options.injectBrief === true} aria-label={t.injectBrief}
                onClick={() => post({ op: 'setOption', injectBrief: options.injectBrief !== true })} />
      </div> : null}
      <div className="envd-foot-item">
        <span title={t.allowLanHint}>{t.allowLan}</span>
        <button className={'envd-switch' + (options.allowLan === true ? ' on' : '')}
                aria-pressed={options.allowLan === true} aria-label={t.allowLan}
                onClick={() => post({ op: 'setOption', allowLan: options.allowLan !== true })} />
      </div>
      <span className="envd-grow" />
      {data ? <button className="envd-btn ghost envd-fold-brief" aria-expanded={briefOpen}
              aria-controls="envd-brief" onClick={…}>{t.brief}</button> : null}
      {data ? <button className="envd-btn ghost envd-fold-diag" aria-expanded={diagOpen}
              aria-controls="envd-diag" onClick={…}>{t.diagNote}</button> : null}
      <span className="envd-copy-note" role="status" aria-live="polite">{copyNote || (copied ? t.copied : '')}</span>
    </div>

  </div>
</div>
```

### 6.1 class 名清单（新增 / 保留 / 删除）

| 新增 | 用途 |
| --- | --- |
| `.envd-sys` | 机器行（系统 · 架构） |
| `.envd-alert-wrap` / `.envd-alert-btn` / `.envd-alert-dot` / `.envd-alert-sum` / `.envd-alert-more` / `.envd-problems` / `.envd-prow` | 问题行与问题清单 |
| `.envd-state` + `.ok/.warn/.bad/.idle/.info` | 卡片状态词（点 + 文字） |
| `.envd-strip` / `.envd-sdot.info` / `.envd-mix` / `.envd-more` | 会话点带与混排文本 |
| `.envd-scoperows` / `.envd-srow.st-{state}` / `.envd-more-scopes` | 逐会话展开 |
| `.envd-gear` / `.envd-settings` | 接管设置 |
| `.envd-termline` / `.envd-term` / `.envd-termtoggle` / `.envd-termchips` / `.envd-customshell` | 终端行与切换 |
| `.envd-trow` / `.envd-manager` | 一行的工具 / 版本管理器 |
| `.envd-note` / `.envd-warn` | 单行提示 / 单行警告文本 |
| `.envd-brief-block` / `.envd-brief-h` / `.envd-diag-block` / `.envd-diag-line` | 底部两个展开体 |

| 保留（语义不变） | 说明 |
| --- | --- |
| `.envd-root` `.envd-scroll` `.envd-head` `.envd-h1` `.envd-headline` `.envd-grow` `.envd-mono` | 骨架 |
| `.envd-badge` + `.dot/.ok/.warn/.bad/.muted` | 唯一胶囊 |
| `.envd-btn` + `.primary/.ghost` `.envd-chip(.on)` `.envd-chips(.envd-chips-sm)` `.envd-mini-label` | 控件 |
| `.envd-card` `.envd-card-h` `.envd-statusline` `.envd-tool` `.envd-exec` `.envd-muted` | 卡片 |
| `.envd-sessions` `.envd-mini-label` `.envd-srow(.bad)` `.envd-sdot` `.envd-sid` `.envd-skind` `.envd-stool` `.envd-sreason` `.envd-legacy` `.envd-morebtn` | 逐会话 |
| `.envd-sec` `.envd-sec-h` `.n` `.tail` `.envd-sec-b` `.envd-group` `.envd-group-h` `.envd-item` `.envd-line` `.envd-name` `.envd-ver` `.envd-dot` `.envd-path` `.envd-pathbtn` `.envd-versionchip` `.envd-vlist` `.envd-vrow` `.cur` | 工具链 |
| `.envd-shellchip` `.envd-learned` `.envd-diag-detail` | 诊断 |
| `.envd-pre` `.envd-foot` `.envd-foot-item` `.envd-switch` `.envd-copy-note` `.envd-loading` `.envd-skel` `.envd-err` `.envd-empty` `.envd-fields` `.envd-f` `.envd-label` `.envd-input` `.envd-issue` | 其余 |

| 删除 | 原因 |
| --- | --- |
| `.envd-statuschip` | 状态词改「点 + 文字」，胶囊只留 badge |
| `.envd-diag` `.envd-diagbox` `.envd-diagrow` `.envd-diag-sum` | 常显诊断摘要取消 |
| `.envd-attn` | 头部 `⚠ N 条` 移入问题行 |
| `.envd-issues`（section 版） | 由 `.envd-problems` 承载 |

### 6.2 CSS 规格（只给新增 / 变更；颜色全部走 token）

```css
/* 容器：块距 26→14，底部 64→16 */
.envd-scroll{overflow:auto;display:flex;flex-direction:column;gap:14px;padding:16px 28px;max-width:860px;width:100%;margin:0 auto;box-sizing:border-box;min-height:0}
.envd-scroll>*{flex:none}

/* 头部 */
.envd-sys{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none;max-width:220px;overflow:hidden;text-overflow:ellipsis}

/* 状态词：点 + 文字，不是胶囊 */
.envd-state{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:650;flex:none;white-space:nowrap}
.envd-state .dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.envd-state.ok{color:var(--dsw-alias-state-success-primary)}
.envd-state.warn{color:var(--dsw-alias-state-warn-primary)}
.envd-state.info{color:var(--dsw-alias-state-business-primary)}
.envd-state.idle{color:var(--dsw-alias-label-secondary)}
.envd-state.bad{color:var(--dsw-alias-state-error-primary)}

/* 会话点带（装饰，语义在 .envd-mix） */
.envd-strip{display:inline-flex;align-items:center;gap:4px;flex:none}
.envd-sdot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-secondary);flex:none}
.envd-sdot.ok{background:var(--dsw-alias-state-success-primary)}
.envd-sdot.warn{background:var(--dsw-alias-state-warn-primary)}
.envd-sdot.info{background:var(--dsw-alias-state-business-primary)}
.envd-sdot.idle{background:var(--dsw-alias-state-idle-primary)}
.envd-sdot.bad{background:var(--dsw-alias-state-error-primary)}
.envd-mix{font-size:11.5px;color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* 问题行 */
.envd-alert-wrap{display:flex;flex-direction:column;gap:6px;min-width:0}
.envd-alert-btn{display:flex;align-items:center;gap:8px;width:100%;background:transparent;border:none;padding:0;
  font-size:12px;font-family:inherit;color:var(--dsw-alias-state-warn-primary);cursor:pointer;text-align:left;min-width:0;border-radius:6px}
.envd-alert-btn.danger{color:var(--dsw-alias-state-error-primary);font-weight:600}
.envd-alert-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.envd-alert-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.envd-alert-sum{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.envd-alert-more{flex:none;font-weight:500;opacity:.8}
.envd-problems{display:flex;flex-direction:column;gap:7px;padding-left:12px;min-width:0}
.envd-prow{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--dsw-alias-state-error-primary);min-width:0;flex-wrap:wrap}

/* 工具行：一行（名称 版本 路径 版本数） */
.envd-trow{display:flex;align-items:center;gap:8px;min-width:0;height:22px;font-size:12px}
.envd-trow .envd-pathbtn{flex:1 1 auto;min-width:60px}
.envd-trow .envd-versionchip{flex:none}
.envd-group-h{font-size:11px;color:var(--dsw-alias-label-secondary);padding:4px 0 2px}
.envd-note{font-size:11.5px;color:var(--dsw-alias-state-warn-primary);min-width:0;overflow-wrap:anywhere}
.envd-warn{font-size:11.5px;color:var(--dsw-alias-state-warn-primary);font-weight:600;flex:none}

/* 底部两个展开体 */
.envd-brief-block,.envd-diag-block{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;min-width:0}
.envd-brief-h{display:flex;align-items:center;gap:8px;font-size:11.5px;min-width:0}
.envd-diag-line{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
```

**不改的既有规则**：`.envd-badge`（唯一胶囊）、`.envd-btn`、`.envd-chip`、`.envd-switch`、`.envd-err`、`.envd-pathbtn`、`.envd-shellchip`、`.envd-diag-detail`、`.envd-vrow`、`.envd-pre`、`.envd-skel` 全部保留（测试 17 的溢出断言依赖 `.envd-headline` / `.envd-err` / `.envd-shellchip` / `.envd-sreason` / `.envd-badge` 的 `text-overflow`/`max-width`/`overflow`，别动这几个声明）。

---

## 7. 主题 token 白名单

只允许这 15 个（均已在本机 `dsh-client-ui-theme` 里确认存在；新的用法必须在此表内）：

| token | 语义 | 用在 |
| --- | --- | --- |
| `--dsw-alias-bg-base` | 面板底色 | `.envd-root`、`.envd-input` |
| `--dsw-alias-bg-layer-1` | 卡片底 | `.envd-card`、`.envd-pre` |
| `--dsw-alias-bg-layer-2` | 次级底 / hover | `.envd-btn:hover`、`.envd-skel`、`.envd-shellchip` |
| `--dsw-alias-border-l1` | 一级描边 / 分隔线 | 卡片边框、`.envd-sec-b` 顶线、`.envd-foot` 顶线 |
| `--dsw-alias-border-l2` | hover 描边 / 关态开关轨 | `.envd-chip:hover`、`.envd-switch` |
| `--dsw-alias-label-primary` | 主文本 | 正文、`.envd-tool` |
| `--dsw-alias-label-secondary` | 次文本 / 空态 | 路径、说明、`.envd-mix` |
| `--dsw-alias-label-tertiary` | 三级文本（点带里「未接管」可用） | `.envd-muted` 的一种加深替代（如需） |
| `--dsw-alias-brand-primary` | 品牌 / 选中 / focus 环 | `.envd-chip.on`、`.envd-btn.primary`、`focus-visible`、版本号 |
| `--dsw-alias-state-success-primary` | 成功（接管） | `.envd-badge.ok`、`.envd-state.ok`、`.envd-sdot.ok` |
| `--dsw-alias-state-warn-primary` | 警告（让路 / 混合） | `.envd-state.warn`、`.envd-alert-btn`、`.envd-note` |
| `--dsw-alias-state-error-primary` | 错误（冲突） | `.envd-state.bad`、`.envd-alert-btn.danger`、`.envd-err`、`.envd-prow` |
| `--dsw-alias-state-idle-primary` | 中性事实（未接管） | `.envd-sdot.idle`、`.envd-dot.idle` |
| `--dsw-alias-state-business-primary` | 沙箱围栏（中性状态蓝） | `.envd-state.info`、`.envd-sdot.info` |
| `--dsw-alias-bg-layer-3` **可选** | 悬浮层底（表单聚焦时不用；**默认不用**） | 仅在 `color-mix` 不可用时的兜底 |

规则：**禁止 `#hex` / `rgb()` / 具名色**；允许 `color-mix(in srgb, var(--dsw-...) N%, transparent)`（现状即此写法，浅深色都由 token 决定）。新增颜色的第一反应是「用现有 token 的哪一档」，不是「调一个新色」。

---

## 8. 可访问性清单

1. **可点即按钮**：所有触发折叠 / 切换 / 复制的元素都是 `<button type="button">`，不用 `div` + `onClick`，不用 `href="#"`。
2. **展开语义**：`aria-expanded`（true/false）+ `aria-controls` 指向被控元素 `id`；`id` 固定（`envd-problems` / `envd-settings` / `envd-scope-rows` / `envd-termchips` / `envd-brief` / `envd-diag`）。
3. **选中语义**：终端 chip / 接管模式 chip / 沙箱 chip → `aria-pressed`；开关 → `aria-pressed` + `aria-label`（与可见标签同文）。
4. **颜色不是唯一通道**：状态三件套（点 / 词 / 数字）总有两个是文本；冲突行有「冲突」字样 + 原因，不只靠红色。
5. **live region 克制**：只有 `.envd-copy-note`（`role=status aria-live=polite`）和问题行外层（`role=group aria-live=polite`）会播报；**不给整面板加 aria-live**（15s 轮询会把读屏刷爆）。数据变化不播报是设计决定：轮询到的变化不是用户动作的结果。
6. **键盘**：Tab 顺序 = 视觉顺序（头部按钮 → 问题行 → 卡片设置 → 逐会话 → 终端 → 工具链 → 底部）；`:focus-visible` 统一 2px `--dsw-alias-brand-primary` 外环（沿用现状）。
7. **title 只做补充**：完整路径 / 完整工具名 / 长计数可以放 `title`；**状态、原因、计数结论必须有可见文本**（hover-only 是反模式）。
8. **对比度**：状态色只用于 ≥ 11.5px 且 ≥ 600 字重的小文本或 6px 色点；正文不使用状态色（现状「整行红字」在浅色主题下对比不足，本次改掉）。
9. **减少动效**：`@media (prefers-reduced-motion:reduce)` 下骨架动画与开关过渡都关掉。
10. **语言**：`lang` 由宿主决定；面板内中文/英文全来自 `DICT`，不混排（EN 界面不许出现中文，由测试强约束）。
11. **屏幕阅读器友好的一行**：会话行整体的可读串 = `{n} 个会话` + `.envd-mix`（例如「3 接管 · 1 让路」）；点带 `aria-hidden`，避免读屏念 12 个空 `i`。
12. **不用 `role=alert`** 做问题行（会打断当前朗读）；只有「读取失败 / 操作失败」两个错误框用 `role=alert`。

---

## 9. `test/panel-render.mjs` 断言变更清单

测试替身没有 CSS 布局，所以「一屏」用**结构断言**代理：折叠态下相关节点必须不存在。下列行号对应当前文件。

### 9.1 必须修改的既有断言（28 条）

| # | 行 | 现断言 | 改成 |
| --- | --- | --- | --- |
| 1 | 406 | `1 混合:逐会话行数 === scopes 长度` | 先 `await mixed.click('envd-morebtn')`，再断言行数 === scopes 长度；**并新增**「点之前 `envd-srow` 为 0」 |
| 2 | 408 | `1 混合:takeover 行标为直连接管` | 展开后断言（前置 click） |
| 3 | 409 | `1 混合:非 takeover 行带实际工具名` | 展开后断言 |
| 4 | 411 | `1 混合:已识别宿主命令工具 chips 数量` | 先 `click('envd-fold-diag')`，再断言 `.envd-shellchip` 数量 === 载荷数量 |
| 5 | 412 | `1 混合:chips 带完整 title` | 同上（展开后） |
| 6 | 415 | `1 混合:状态 chip 是 warn 色` | `.envd-statuschip` → `.envd-state`（`findWithClasses(tree,'envd-state','warn')`） |
| 7 | 418 | `1 混合:每个 chips 组都有可见标签` | 先 `click('envd-gear')`，在 `#envd-settings` 子树里数 `.envd-mini-label` 与 `.envd-chips-sm`（相等） |
| 8 | 420 | 同上（合并检查） | 同上 |
| 9 | 421 | `1 混合:接管模式 + 沙箱下接管 chips 都在` | 展开设置后 `.envd-chips-sm` 数量 === 2（`sandbox.capable:true`） |
| 10 | 428 | `2 会话行数 === scopes 长度` | 先展开「逐会话」 |
| 11 | 441 | `3 会话行数 === 2` | 先展开 |
| 12 | 442 | `3 每行都标直连接管` | 先展开 |
| 13 | 443 | `3 无围栏时不显示沙箱 chips` | 先 `click('envd-gear')`，再断言 `.envd-chips-sm` === 1 |
| 14 | 444 | `3 状态 chip 是 ok 色` | `.envd-state.ok` |
| 15 | 458 | `4 逐会话行全部列出` | 先展开；断言 5 行 |
| 16 | 459 | `4 异常行染红且只红 N 行` | 先展开；断言 `.envd-srow.st-conflict` 数 === N（不再用 `.bad`，或保留 `.bad` 兼容类；推荐用 `data-state="conflict"`） |
| 17 | 460 | `4 异常行尾给原因` | 先展开；断言 conflict 行的 `.envd-sreason` 含「⚠」以外的短词（`无命令工具` / `宿主工具仍可见` / `同名工具非本插件`） |
| 18 | 461 | `4 诊断自动展开` | **反向**：断言默认无 `.envd-issue`（问题行收起），且 `.envd-alert-btn` 的 `aria-expanded === false` |
| 19 | 462 | `4 诊断摘要红字(danger)` | `.envd-alert-btn` 带 `danger` 类 |
| 20 | 463 | `4 诊断详情里有 error 红条目` | `click('envd-alert-btn')` 后，`.envd-problems` 里有 `.envd-issue.error` 或 `.envd-prow` |
| 21 | 473 | `5 默认 5 行全是异常行` | 默认 `envd-srow` === 0；`click('envd-morebtn')` 后前 5 行全是 conflict（`data-state`） |
| 22 | 476 | `5 「还有 N 个(A 个异常)」数字由载荷推导` | 改为按钮文案 `逐会话 · {n}（{a} 冲突）` 的数字推导 + 展开后 `.envd-more-scopes` 文案 |
| 23 | 483 | `6 诊断摘要不是红字` | 健康机器**没有**问题行：`!findOneByClass(tree,'envd-alert-btn')` |
| 24 | 485 | `6 诊断摘要非空(不许红着却空白)` | 健康机器 `.envd-state` 文本非空 |
| 25 | 486 | `6 健康检查整节不出现(无 issues)` | 无 `.envd-alert-wrap`（class 改名） |
| 26 | 499 | `7 fallback 会话按 id 列出` | 先 `click('envd-morebtn')` |
| 27 | 500/501 | `7 状态词按 fallback 走` | `.envd-statuschip` → `.envd-state`，且不含 `接管中` |
| 28 | 518 | `9 状态 chip 也是未接管色` | `.envd-state.muted|idle` |

### 9.2 需要重写整组（3 组）

| 组 | 现内容 | 改为 |
| --- | --- | --- |
| 10（L532-540） | warn 级诊断自动展开 + 三态不假死 | ① 默认无 `.envd-diag-detail`；② `click('envd-fold-diag')` 后有 `.envd-diag-detail` 且含 warn 条目；③ 再点收起（无 detail）；④ 再点又能展开 |
| 13（L560-569） | 点 diagtoggle 看「策略未知」 | 先 `click('envd-fold-diag')`；断言诊断里有「策略未知」条目；**新增**：该会话点带为 `.info`（沙箱）而不是 `.idle` |
| 20（L658-671） | 健康检查折叠 + 简报 + 底部开关 | 健康：`issues` 存在 → 有 `.envd-alert-btn`、无 `.envd-issue`；`click('envd-alert-btn')` 后 `.envd-issue` 数 === issues 长度。简报：`envd-fold-brief` 保持（在底部），点开出现 `.envd-pre`。开关：`envd-switch` 仍为 2 个 |

### 9.3 需要加前置点击 / 已确认不变（4 条）

| 行 | 断言 |
| --- | --- |
| 582（15 `opError`） | 先 `click('envd-termtoggle')` 再 `click('envd-chip')`（终端 chips 已折叠） |
| 606-607（17 长名字 chip title） | 先 `click('envd-fold-diag')` |
| 442（3 每行标直连接管） | 见 9.1 #12 |
| 661-663（20 工具路径/版本） | **不变**（路径仍常显、`envd-pathbtn` 语义不变） |

### 9.4 新增断言（10 条，撑住本次重做的三个目标）

| # | 新断言 | 类型 |
| --- | --- | --- |
| N1 | 健康机器「一屏」：无 `.envd-srow` / `.envd-issue` / `.envd-pre` / `.envd-vrow` / `.envd-chip` / `.envd-chips-sm` | 结构 |
| N2 | 整个渲染树里 `.envd-badge` 恰 1 个（胶囊预算） | 结构 |
| N3 | 头部 `.envd-sys` 存在且含 `platform.os`；`.envd-headline` 仍只含终端名+版本（不被系统串污染） | 结构 |
| N4 | **五态 A**：`danger-full-access` 载荷（`confined:false` + `kind:'takeover'`）→ `.envd-state.ok` + 文本「接管中」；会话点 `.envd-sdot.ok` | 语义 |
| N5 | **五态 D**：`workspace-write` 单会话载荷（`kind:'host'` + `confined:true` + `mode:'workspace-write'` + `ct.name:'ops_bash'`）→ `.envd-state.info` + 「沙箱」；会话行原因含 `workspace-write`；**不得**出现「未接管」作为状态词 | 语义（两模式对） |
| N6 | **五态 C**：`kind:'yield'` + `hidesOwn:true` → `.envd-state.warn` + 「让路」；原因含「作用域私有」 | 语义 |
| N7 | **五态 E**：混合部署（1 takeover + 1 sandbox-host）→ 状态词「混合」、`.envd-strip .envd-sdot` 同时有 `.ok` 与 `.info` | 语义 |
| N8 | **冲突并存可视化**：`kind:'takeover'` + `hostTools:['bash']` → `.envd-state.bad` + 工具格文本同时含 `envd_shell` 与 `bash`（` + ` 分隔） | 语义 |
| N9 | 冲突会话在逐会话列表里**排最前**：载荷把正常会话放数组前面，展开后首行 `data-state === 'conflict'` | 语义 |
| N10 | 旧服务端（无 `scopes`）→ `.envd-legacy` 一行 + badge 文案含「约」+ 会话行不伪造逐会话点带（`.envd-strip` 不存在） | 兼容 |

### 9.5 不需要改的（确认过）

`headerBadges()` 依赖 `.envd-head` + `.envd-badge`（保留）；测试 4/7/8/9/11/12 的 badge 文案规则不变；18/19 复制兜底（`.envd-pathbtn` 仍常显）；16 英文无中文（新词条全部成对）；17 的 5 条 CSS 溢出规则（class 与声明都保留）；21 轮询与去重（不改数据层）；22 无数据（`.envd-head` 仍在、无 badge、1 个开关）。

**合计：改 28 条既有 check + 重写 3 组（约 10 条）+ 4 处置前置点击 + 新增 10 条 ≈ 38 条断言受影响。**

---

## 10. 实施顺序（建议，供排期）

1. **CSS 与骨架**：容器 gap/padding、`.envd-state`、`.envd-strip`、`.envd-trow`、`.envd-alert-wrap`、`.envd-termline`；先把「常显块变矮」这一步落地（可单独看效果）。
2. **词表**：先加新键、再删死键、最后改文案；每步跑 `node test/i18n-check.mjs`（键/占位符/EN 无中文）。
3. **五态推导**：抽出 `sessionState(sc)` 纯函数（**放 render 之前、不依赖 React state**），配 5 个单元用例（A/C/D/E/G 的载荷片段），先测函数再改视图。
4. **视图替换**：问题行 → 卡片（设置/会话/终端）→ 工具链一行 → 底部两折叠。
5. **测试同步**：按 §9 改断言；每改一块同步跑 `node test/panel-render.mjs`，避免一次性改到全红。
6. **人工验收**：1280×720 截图对比（`docs/panel.png` 是旧版，需要重拍）；103% / 125% DPI 各看一眼；浅色 + 深色主题各看一眼；键盘 Tab 走一遍；`prefers-reduced-motion` 一遍。

---

## 11. 反模式清单（明确不要做）

1. **不要嵌套盒子**：全面板最多 1 个带边框的块（`.envd-card`）；卡片内再套卡片、工具行套卡片、问题行套卡片，一律不做。分隔用留白与 1px 线。
2. **不要超过 1 个胶囊**：`.envd-badge` 只在头部；状态用「点 + 文字」；计数用纯文本，不用 pill。
3. **不要把计数堆进常显区**：`registers / disposes / ticks / denyApplies / delegate*` 只进诊断展开区或 `title`。
4. **不要长段说明文字**：常显区任何单行文案超过 1 行（≈ 40 汉字 / 90 字符）就砍；解释进折叠区。`DESIGN.md` 里那些三行长句不许原样上屏。
5. **不要 hover-only 信息**：`title` 只补全（完整路径 / 完整名字 / 计数），状态与原因必须有可见文本；不许「鼠标放上去才知道红了」。
6. **不要自动展开**：有问题也不自动展开问题行 / 诊断 / 逐会话。自动展开会让「收起」在下一轮 payload 变化时复活，用户会觉得按钮坏了。
7. **不要用颜色单独表意**：不许只有红点没有「冲突」二字；不许只有绿点没有「接管中」。
8. **不要硬编码颜色**：`#hex`、`rgb()`、`red/green` 一律禁止；`color-mix` 必须包着 `var(--dsw-*)`。
9. **不要把「旧版构建」做成橙色警告占位**：兼容分支只给一行 muted 文本（`旧版服务端：仅汇总`），并在 badge `title` 里补一句说明。
10. **不要在常显区展开路径/版本候选**：工具路径只 1 行 ellipsis；候选版本列表只在点「N 个版本」后出现。
11. **不要给 15s 轮询加动画或 aria-live**：轮询刷新静默；只有用户动作的反馈（复制、操作失败）才播报。
12. **不要新增依赖 / 图标库 / 外部字体 / 图片资源**：图标继续内联 SVG 或字符（`⚠` `✓` `✦` `＋`）。
13. **不要弹窗 / toast / 全屏遮罩**：反馈只在 `.envd-copy-note` 与 `.envd-err`。
14. **不要把设置做成常显 chip 组**：接管模式、沙箱下接管进「接管设置」；常显只留「当前生效的是什么」。
15. **不要用 `div`/`span` 当按钮**：可点元素必须是 `<button>`，否则键盘用户用不了。
16. **不要用 emoji 当状态**：只用 `⚠`（问题）/ `✓`（已复制）/ `✦`（自动识别）/ `＋`（新增）四个符号，且每个都有文字伴随。
17. **不要把「模型可见」与「模型用宿主工具」混为一谈**：文案必须按逐会话事实说，不许用全局 `visible` 代替逐会话结论。
18. **不要把逐会话行做成表头 + 多列**（会引入横向滚动与嵌套盒子）；一行一条，超长 ellipsis，原因靠右。
19. **不要为了省高度合并两个语义不同的开关**（简报注入 ≠ 局域网访问）；底部一行排得下就并排。
20. **不要在折叠区里再套折叠区**（问题清单里不再嵌套诊折、诊断里不再嵌套逐会话）。
21. **不要改 `docs/DESIGN.md` 里冻结的 API 语义**：`confined` 三态、`kind` 四种值、`anomaly` 口径都不动；本次只动「怎么显示」。
22. **不要用 `role=alert` 做常驻问题行**：打断朗读；`role=alert` 只留给读取失败与操作失败。

---

## 12. 未决与风险

| 项 | 说明 | 建议 |
| --- | --- | --- |
| 终端切换多一次点击 | 从常显 chips 改为「终端行 + 切换」 | 采纳；若反馈「切终端变麻烦」，再考虑把 chips 放回卡片常显（会 +34px，仍在预算内） |
| 路径常显 vs 折叠 | 保留 1 行路径（点即复制），不折叠 | 采纳；路径是本插件的高频复制对象，且 1 行不占预算 |
| 「混合」状态词的必要性 | 有接管 + 有非接管时，是「混合」还是按多数派说 | 采纳「混合」；badge 那句 `N 个会话用宿主工具` 已经给了具体数 |
| 沙箱蓝的语义新鲜度 | `state-business-primary` 目前主要给业务状态用 | 采纳并在 §7 登记；若设计系统后续改语义，回落到 `state-idle-primary` + 文字「围栏」 |
| 旧版服务端 | 面板不再有醒目告警，可能有人「看不出是旧版」 | `title` + `.envd-legacy` 一行足够；旧版本来也会被新构建替换 |
| 截图 | `docs/panel.png` 是旧版布局，README 自己标注了 | 实现完成后重拍（1280×720，浅色 + 深色各一张），更新 README 与 DESIGN.md 的「面板结构」段 |

---

### 附：一句话总结

> 常显只留**四个块**（头部 / 问题行 / 接管卡 / 工具链）+ **一行底部**；**一个胶囊**；所有诊断、设置、逐会话、简报、终端切换都进**六个折叠点**；「出问题」永远**一行说完**、点开才是清单；五态用「**点 + 状态词 + 数字**」表达，`confined` 三态与 `kind` 四值分别落到正确的那一态。
