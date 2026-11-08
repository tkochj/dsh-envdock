/**
 * EnvDock · Client half.
 *
 * 两个注册点:
 *   - sidebar.panellist / id=envdock → 侧边栏图标
 *   - main / key=envdock             → 中央面板
 * 数据全部来自 Host 的 /envdock-api。
 *
 * 注意:ModuleLoader 的 id 必须等于 package name,否则加载器报
 * "loaded without registering dsh-envdock"。
 *
 * 设计取向:**一屏说四件事**。
 *   1. 这台机器默认用哪个终端(可直接切换);
 *   2. 模型手里的命令工具是什么(EnvDock 增补 / 宿主 / 本会话的语法族),一句话 + 最多两行备注;
 *   3. 装了哪些工具链(每个工具一行,点路径即复制);
 *   4. 有没有问题(没问题只说一句「通过」,有问题一行摘要可展开)。
 *
 * 0.6.1「首屏收敏」:陌生人打开面板 5 秒要看懂三件事 —— 这是什么插件 / AI 现在用什么
 * 命令环境 / 去哪里改。做法是「一句人话 + 四块常显 + 高级收进折叠」:
 *   · 头部下一行常显一句用途说明(.envd-subtitle);badge 只有两态:就绪 / 只展示
 *     (「有会话被沙箱限制」只进备注,不上面板级 badge);
 *   · 终端 chip 不再挂语法族小标(「pwsh」挂在每个 PowerShell 终端上既重复又误导),
 *     语法只说一次:命令行 .envd-fam 写「bash 语法 / PowerShell 语法」,手动选才带「· 手动」;
 *   · 备注全部改人话(已隐藏 / 另有 N 个会话受沙箱限制 / 别混用 / 已自动改回),仍最多两行;
 *     环境差异那句挪进「其它」段的 title,普通状态备注最多只有一行;
 *   · 底部 footer 只留复制反馈 + 环境脚注;注入开关放在「环境简报」区那一行,
 *     「隐藏另一族命令工具 / 允许局域网访问」收进默认折叠的「高级设置」;
 *   · 详情计数只留扫描 / 最近 / 注册尝试(隐藏/拒绝是历史累计,API 仍给但面板不摆);
 *   · 拿不到数据(403)时简报区不存在,allowLan 开关仍留在 footer(唯一入口)。
 *
 * 三条硬规则:
 *   · 常显区不放计数:计数只在「详情」里出现,常显区只留一句人话;
 *   · 只有「状态」配胶囊:终端选择用 chip,状态用 badge(二态);
 *   · 异常必须一行说完并说清原因:不许出现「⚠ 出错了」然后让用户去别处找。
 * 样式只用 --dsw-* theme token,浅色/深色都由 token 决定,不硬编码颜色。
 */
window.__ModuleLoader__.load({
  id: 'dsh-envdock',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    // ───────────────────────────────────── 文案 ──
    const DICT = {
      zh: {
        title: 'EnvDock',
        refresh: '重新探测',
        detecting: '探测中…',
        loading: '正在读取本机环境…',
        loadFailed: '读取失败',
        loadFailedHint: '/envdock-api 没响应，试试重启 dsh 或重装 EnvDock。',
        updatedAt: '更新于',
        retry: '重试',
        // ── 头部 / 命令工具 ──
        terminal: '终端',
        subtitle: '告诉 AI 你的工具装在哪、用哪个版本、命令该写哪套语法。',
        autoShell: '自动',
        autoShellHint: '按会话自动选语法族（推荐）',
        // 两套语法:首屏只说「语法」,「族」这种内部说法不进首屏
        famBash: 'bash 语法',
        famPwsh: 'PowerShell 语法',
        famManual: '手动',
        customShell: '自定义终端',
        customHint: '可执行文件绝对路径，如 C:\\\\tools\\\\rg.exe',
        customShellArgs: '终端参数模板',
        customShellArgsHint: '用 {command} 占位，留空默认 -c {command}',
        labelPath: '路径',
        labelArgs: '参数',
        name: '名称',
        add: '添加',
        addFailed: '添加失败',
        collapse: '收起',
        expand: '展开',
        dismiss: '知道了',
        actionFailed: '操作失败',
        command: '命令',
        // badge 二态:整个面板唯一的状态结论(白话,没有主语的状态词不上 badge)
        statusAdditive: '就绪',
        statusDisplayOnly: '只展示',
        // 命令行
        hostPrefix: '其它：',
        hostToolsNone: '没有其它命令工具',
        noteLegacyApi: '界面拿到的还是旧版数据，重启 dsh 后就能看到命令环境',
        cmdHintEnvDock: 'EnvDock 提供的命令工具：用你的终端和 PATH',
        // 「其它」段一句话说清它跟你终端的关系(原来备注里那条长解释挪到这里,悬停可见)
        cmdHintHost: '其它命令工具：由 dsh 提供，环境和 PATH 跟你的终端可能不一样；要用你自己的工具时用 envd_shell',
        // 未提供命令工具的原因(skipReason)
        skipNoFamilyTerminal: '没找到可用的终端（bash 语法需要 Git Bash，PowerShell 语法需要 pwsh）',
        skipNoUnconfined: '没有不受沙箱限制的会话，暂时不会提供 envd_shell',
        skipTaken: '和别的插件重名了，暂时不提供 envd_shell',
        skipError: '没能提供命令工具（注册失败）',
        // 备注:隐藏/混用 / 未提供原因 / 沙箱限制 / 环境差异(最多两行)
        noteHiddenPwsh: '已隐藏 {names}（避免两套语法混用）',
        noteNotBlocked: 'PowerShell 的命令工具没有隐藏（开关已关）',
        noteNoBashHost: '这个会话没有 bash 命令工具，未隐藏 PowerShell 工具',
        noteFamilyFallback: '手动选的语法不可用（没有对应终端，也没有对应命令工具），已自动改回按会话选择',
        noteMixed: '手动选了 PowerShell 语法：PowerShell 与 bash 工具都在，各按自己的语法写，别混用',
        noteConfined: '另有 {n} 个会话受沙箱限制：envd_shell 在那些会话里不会执行命令，请改用其它命令工具',
        // 详情
        diag: '详情',
        hostTools: '命令工具',
        learnedTag: '自动识别',
        noteLastError: '最近错误',
        dScan: '扫描 {n} 次',
        dLastScan: '最近 {n}ms',
        dRegisterTries: '注册尝试 {n}',
        hostToolHidden: '已隐藏',
        hostToolRefused: '调用会被拒绝',
        displayOnlyTag: '只展示（没有隐藏）',
        // ── 工具链 ──
        tools: '工具链',
        toolCount: '{n} 个工具',
        noTools: 'PATH 上没扫到 node / python / git。装好后点「重新探测」。',
        versionChip: '{n} 个版本',
        default: '当前',
        setDefault: '设为默认',
        remove: '移除',
        copyPathHint: '点击复制路径',
        copied: '已复制',
        copyFailed: '复制失败：浏览器不允许剪贴板，请手动选中复制',
        versionUnknown: '未知版本',
        pathMissing: '{n} 个 PATH 目录不存在',
        groupRuntime: '运行时',
        groupPackage: '包管理',
        groupVcs: '版本控制',
        groupEnv: '环境管理',
        groupCustom: '自定义',
        groupManagers: '版本管理器',
        managers: '版本管理器',
        managersActive: '激活',
        managersNoList: '在场，但没能列出已装版本',
        customTool: '自定义工具',
        // ── 环境检查 / 简报 / 开关 ──
        health: '环境检查',
        healthy: '通过',
        countItems: '{n} 项',
        brief: '环境简报',
        briefHint: '已注入给 AI',
        briefOff: '未注入',
        briefOffDetail: '简报注入已关闭',
        never: '尚未探测',
        copyBrief: '复制',
        injectBrief: '把环境简报注入给 AI',
        advanced: '高级设置',
        blockOtherFamily: '隐藏另一族命令工具',
        // 可见说明只留一行;「关掉会怎样」挪进开关的 title(长长的第二句会把开关挤成两行)
        blockOtherFamilyHint: 'bash 会话里隐藏 PowerShell 的 pwsh / powershell',
        blockOtherFamilyHintTitle: 'bash 会话里隐藏 PowerShell 的 pwsh / powershell；关掉则两族同时可见',
        allowLan: '允许局域网访问面板 API',
        allowLanHint: '只放行读取面板数据',
        subprocessOff: '拿不到 dsh 的子进程能力，版本探测会缺失',
      },
      en: {
        title: 'EnvDock',
        refresh: 'Rescan',
        detecting: 'Scanning…',
        loading: 'Reading the local environment…',
        loadFailed: 'Load failed',
        loadFailedHint: 'No answer from /envdock-api. Restart dsh or reinstall EnvDock.',
        updatedAt: 'updated',
        retry: 'Retry',
        terminal: 'Terminal',
        subtitle: 'Tells the agent where your tools live, which version to use, and which shell syntax to write.',
        autoShell: 'Auto',
        autoShellHint: 'Picks the shell syntax per session (recommended)',
        // Two syntaxes: the panel says "syntax" on the first screen
        famBash: 'bash syntax',
        famPwsh: 'PowerShell syntax',
        famManual: 'manual',
        customShell: 'Custom terminal',
        customHint: 'Absolute path to an executable, e.g. C:\\\\tools\\\\rg.exe',
        customShellArgs: 'Argument template',
        customShellArgsHint: 'Use {command} as the placeholder; empty means -c {command}',
        labelPath: 'Path',
        labelArgs: 'Args',
        name: 'Name',
        add: 'Add',
        addFailed: 'Add failed',
        collapse: 'Collapse',
        expand: 'Expand',
        dismiss: 'Dismiss',
        actionFailed: 'Action failed',
        command: 'Command',
        // badge: the panel's single status conclusion (plain words, two states)
        statusAdditive: 'Ready',
        statusDisplayOnly: 'Display only',
        hostPrefix: 'Other: ',
        hostToolsNone: 'No other command tools',
        noteLegacyApi: 'The panel is reading data from an older build; restart dsh to see the command environment',
        cmdHintEnvDock: 'Command tool provided by EnvDock: runs with your terminal and PATH',
        // One sentence on the "Other" group; the long note that used to sit in the panel lives here.
        cmdHintHost: 'Other command tools: provided by dsh; their environment and PATH may differ from your terminal - use envd_shell when you need your own tools',
        skipNoFamilyTerminal: 'No usable terminal found (bash syntax needs Git Bash, PowerShell syntax needs pwsh)',
        skipNoUnconfined: 'No session outside the sandbox yet; envd_shell is not provided for now',
        skipTaken: 'Name is taken by another plugin; envd_shell is not provided',
        skipError: 'Could not provide the command tool (registration failed)',
        noteHiddenPwsh: 'Hid {names} (to avoid mixing the two syntaxes)',
        noteNotBlocked: 'PowerShell command tools are not hidden (the switch is off)',
        noteNoBashHost: 'This session has no bash command tool, so PowerShell tools were not hidden',
        noteFamilyFallback: 'The manually picked syntax is unavailable (no matching terminal or command tool); switched back to per-session selection',
        noteMixed: 'PowerShell syntax was picked manually: both PowerShell and bash tools are available; write each command in its own syntax, do not mix them',
        noteConfined: '{n} other sessions are sandbox-limited: envd_shell will not run there; use another command tool',
        diag: 'Details',
        hostTools: 'Command tools',
        learnedTag: 'auto-detected',
        noteLastError: 'Last error',
        dScan: 'scans: {n}',
        dLastScan: 'last: {n}ms',
        dRegisterTries: 'register tries: {n}',
        hostToolHidden: 'hidden',
        hostToolRefused: 'calls are refused',
        displayOnlyTag: 'display only (not hidden)',
        tools: 'Toolchains',
        toolCount: '{n} tools',
        noTools: 'No node / python / git on PATH. Install one, then rescan.',
        versionChip: '{n} versions',
        default: 'current',
        setDefault: 'Set default',
        remove: 'Remove',
        copyPathHint: 'Click to copy the path',
        copied: 'Copied',
        copyFailed: 'Copy failed: the browser blocks the clipboard; select the text and copy manually',
        versionUnknown: 'unknown',
        pathMissing: '{n} PATH entries missing',
        groupRuntime: 'Runtime',
        groupPackage: 'Packages',
        groupVcs: 'VCS',
        groupEnv: 'Env mgr',
        groupCustom: 'Custom',
        groupManagers: 'Managers',
        managers: 'Version managers',
        managersActive: 'active',
        managersNoList: 'present, but versions could not be listed',
        customTool: 'Custom tool',
        health: 'Environment',
        healthy: 'OK',
        countItems: '{n} issues',
        brief: 'Agent brief',
        briefHint: 'Injected into the agent',
        briefOff: 'Not injected',
        briefOffDetail: 'Brief injection is turned off',
        never: 'Not scanned yet',
        copyBrief: 'Copy',
        injectBrief: 'Inject the environment brief into the agent',
        advanced: 'Advanced',
        blockOtherFamily: 'Hide the other family command tools',
        // Visible hint stays one line; "what happens when off" moves to the switch title.
        blockOtherFamilyHint: "Hides PowerShell's pwsh / powershell in bash sessions",
        blockOtherFamilyHintTitle: "Hides PowerShell's pwsh / powershell in bash sessions; turn off to keep both families visible",
        allowLan: 'Allow LAN access to the panel API',
        allowLanHint: 'Read-only access to panel data',
        subprocessOff: 'No subprocess capability from dsh; version detection is incomplete',
      },
    }

    // ───────────────────────────────────── 样式 ──
    // 只用 --dsw-* theme token;分节靠一条细线,只有命令卡带边框。
    const CSS = `
.envd-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:13px;line-height:1.5}
.envd-scroll{overflow:auto;display:flex;flex-direction:column;gap:18px;padding:18px 24px 34px;max-width:820px;width:100%;margin:0 auto;box-sizing:border-box;min-height:0}
.envd-scroll>*{flex:none}
.envd-grow{flex:1;min-width:8px}
.envd-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Mono",monospace}
.envd-muted{color:var(--dsw-alias-label-secondary)}

/* 头部:标题 + 默认终端 + 1 个状态 badge + 重新探测,下面一行用途说明 */
.envd-headblock{display:flex;flex-direction:column;gap:4px;min-width:0}
.envd-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.envd-subtitle{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);min-width:0;overflow-wrap:anywhere}
.envd-h1{margin:0;font-size:18px;font-weight:650;display:flex;align-items:center;gap:8px;letter-spacing:.1px;flex:none}
.envd-headline{font-size:12.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;min-width:0;max-width:100%;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis}
.envd-headline b{color:var(--dsw-alias-label-primary);font-weight:600}

/* badge:整个面板只有「状态」用胶囊(二态:就绪 / 只展示) */
.envd-badge{display:inline-flex;align-items:center;gap:6px;height:20px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:650;white-space:nowrap;flex:none;max-width:100%;overflow:hidden;text-overflow:ellipsis;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.envd-badge .dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.envd-badge.ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}
.envd-badge.warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent)}
.envd-badge.muted{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}

/* 按钮 */
.envd-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500;font-family:inherit;cursor:pointer;white-space:nowrap;flex:none;transition:background .12s ease,border-color .12s ease,color .12s ease}
.envd-btn:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.envd-btn:disabled{opacity:.45;cursor:default}
.envd-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.envd-btn.primary{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 42%,transparent);font-weight:600}
.envd-btn.primary:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.envd-btn.ghost{height:24px;padding:0 7px;border-color:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:500;border-radius:7px}
.envd-btn.ghost:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:transparent}

/* 命令卡:整个面板唯一带边框的块(置顶主信息,值得一个框) */
.envd-card{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;min-width:0}
.envd-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.envd-tag{font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:500;flex:none;min-width:34px}
.envd-tool{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Mono",monospace;font-size:12px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.envd-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.envd-flag{font-size:11.5px;font-weight:600;min-width:0;overflow-wrap:anywhere}
.envd-flag.warn{color:var(--dsw-alias-state-warn-primary)}
.envd-flag.bad{color:var(--dsw-alias-state-error-primary)}
.envd-flag.ok{color:var(--dsw-alias-state-success-primary)}

/* chips */
.envd-chips{display:flex;gap:6px;flex-wrap:wrap;min-width:0}
.envd-chip{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);background:transparent;border-radius:7px;font-size:12px;font-family:inherit;cursor:pointer;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none;max-width:100%;overflow:hidden;text-overflow:ellipsis;transition:background .12s ease,border-color .12s ease,color .12s ease}
.envd-chip:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.envd-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.envd-chip.on{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);font-weight:600}

/* 一行备注:常显区最多一行,不套盒子 */
.envd-notes{display:flex;flex-direction:column;gap:2px;min-width:0}
.envd-note{display:flex;gap:6px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);min-width:0;overflow-wrap:anywhere}
.envd-note .ic{flex:none;font-weight:700}
.envd-note.warn{color:var(--dsw-alias-state-warn-primary)}
.envd-note.bad{color:var(--dsw-alias-state-error-primary)}

/* 命令行:自己的工具名 + 其它命令工具(长名字靠省略,不截数据) */
.envd-cmdrow{flex-wrap:wrap}
.envd-host{font-size:11.5px;color:var(--dsw-alias-label-secondary);min-width:0;flex:0 1 auto;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}

/* 语法标签:bash 语法 / PowerShell 语法(手动选择时带后缀);认不出语法(cmd / 自定义终端)时不显示 */
.envd-fam{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:650;white-space:nowrap;flex:none;max-width:100%;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 11%,transparent)}
.envd-fam .envd-famsrc{padding-left:4px;font-weight:500;color:var(--dsw-alias-label-secondary)}

/* 命令工具 chips:只在「详情」里出现 */
.envd-diag-shelltools{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.envd-shellchip{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.envd-shellchip .envd-mono{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
/* 被遮挡的名字:留在详情里给用户看,名字划掉(不会假装它还可用) */
.envd-shellchip.hidden{opacity:.72}
.envd-shellchip.hidden .envd-mono{text-decoration:line-through}
/* 只能拒绝 / 只展示:不遮挡,但要在 chip 上说清楚它的状态 */
.envd-shellchip.refused,.envd-shellchip.display{opacity:.85}

/* 详情:默认折叠,展开只有「扫描计数 + 命令工具 chips + 最近错误」 */
.envd-diag-detail{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--dsw-alias-label-secondary);align-items:center;min-width:0;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}
.envd-diag-stat{font-variant-numeric:tabular-nums;min-width:0;word-break:break-word}
.envd-diag-detail .e{color:var(--dsw-alias-state-error-primary);min-width:0;word-break:break-word}

/* 分节:没有卡片框,只有标题 + 一条细线 */
.envd-sec{display:flex;flex-direction:column;gap:10px}
.envd-sec-h{display:flex;align-items:baseline;gap:8px;min-width:0}
.envd-sec-h h2{margin:0;font-size:12.5px;font-weight:650;flex:none}
.envd-sec-h .n{font-size:11.5px;color:var(--dsw-alias-label-secondary);font-weight:400}
.envd-sec-h .tail{margin-left:auto;display:flex;gap:6px;align-items:center;min-width:0}
.envd-sec-b{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;min-width:0}

/* 工具链:一行一个工具,路径右对齐、点一下复制
   宽屏 5 列(分组 / 名称 / 版本 / 路径 / 动作),窄屏自动换行到两行。 */
.envd-tools{display:flex;flex-direction:column;min-width:0}
.envd-trow{display:grid;grid-template-columns:62px minmax(64px,84px) 96px minmax(0,1fr) auto;align-items:center;gap:10px;font-size:12px;min-width:0;padding:3px 0}
.envd-tgroup{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.envd-tname{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.envd-tver{color:var(--dsw-alias-brand-primary);font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis}
.envd-tver.idle{color:var(--dsw-alias-label-secondary);font-weight:500}
.envd-tpath{display:block;max-width:100%;text-align:left;background:transparent;border:none;padding:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Mono",monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;min-width:0}
.envd-tpath:hover{color:var(--dsw-alias-brand-primary);text-decoration:underline}
.envd-tpath:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}
.envd-tact{justify-self:end;display:flex;align-items:center;gap:4px;min-width:0}
.envd-vlist{display:flex;flex-direction:column;gap:2px;padding:2px 0 6px 72px;min-width:0}
.envd-vrow{display:grid;grid-template-columns:82px minmax(0,1fr) 84px;align-items:center;gap:10px;font-size:11.5px;min-width:0;padding:1px 0}
.envd-vrow .vv{font-weight:600;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.envd-vrow.on .vv{color:var(--dsw-alias-brand-primary)}
.envd-vrow .vp{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.envd-vrow .act{justify-self:end;display:flex;justify-content:flex-end;align-items:center;min-width:0}
.envd-cur{font-size:11px;color:var(--dsw-alias-brand-primary);white-space:nowrap}
.envd-mgr-ver{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.envd-mgr-ver b{color:var(--dsw-alias-brand-primary);font-weight:600}

/* 表单:折叠后才出现 */
.envd-fields{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;padding:2px 0}
.envd-f{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}
.envd-f.grow{flex:2.4;min-width:210px}
.envd-f.mid{flex:1.4;min-width:160px}
.envd-f.narrow{flex:0 0 110px;min-width:110px}
.envd-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.envd-input{width:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:0 9px;height:29px;font-size:12px;font-family:inherit;outline:none;box-sizing:border-box}
.envd-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.65}
.envd-input:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}

/* 开关 */
.envd-switch{position:relative;width:34px;height:19px;border-radius:999px;background:var(--dsw-alias-border-l2);cursor:pointer;transition:background .15s ease;flex:none;border:none;padding:0}
.envd-switch::after{content:"";position:absolute;top:3px;left:3px;width:13px;height:13px;border-radius:50%;background:var(--dsw-alias-label-primary);transition:transform .15s ease}
.envd-switch.on{background:var(--dsw-alias-brand-primary)}
.envd-switch.on::after{transform:translateX(15px);background:var(--dsw-alias-bg-base)}
.envd-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}

/* 环境检查:健康时一行「通过」,有问题一行摘要可展开 */
.envd-foldrow{display:flex;align-items:center;gap:8px;width:100%;background:transparent;border:none;padding:0;font-size:12px;font-family:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;min-width:0;text-align:left}
.envd-foldrow:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:6px}
.envd-issues{display:flex;flex-direction:column;gap:7px;padding-top:2px}
.envd-issue{display:flex;gap:9px;font-size:12px;line-height:1.5;min-width:0}
.envd-issue .dot{width:6px;height:6px;border-radius:50%;margin-top:6px;flex:none;background:currentColor}
.envd-issue.error{color:var(--dsw-alias-state-error-primary)}
.envd-issue.warn{color:var(--dsw-alias-state-warn-primary)}
.envd-issue.info{color:var(--dsw-alias-label-secondary)}
.envd-issue .tx{display:flex;flex-direction:column;gap:1px;min-width:0}
.envd-issue .tx b{color:var(--dsw-alias-label-primary);font-weight:600}
.envd-issue .tx span{color:var(--dsw-alias-label-secondary);word-break:break-word}

/* 简报 */
.envd-pre{margin:0;font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:11px 12px;max-height:280px;overflow:auto}

/* 空态 / 错误 / 骨架 */
.envd-empty{font-size:12px;color:var(--dsw-alias-label-secondary);padding:2px 0}
.envd-err{display:flex;flex-direction:column;gap:6px;font-size:12.5px;line-height:1.55;padding:10px 12px;border-radius:9px;min-width:0;overflow-wrap:anywhere;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 38%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.envd-err .h{font-weight:600;color:var(--dsw-alias-state-error-primary);min-width:0;overflow-wrap:anywhere}
.envd-loading{display:flex;flex-direction:column;gap:10px}
.envd-skel{height:13px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);animation:envd-pulse 1.4s ease-in-out infinite}
@keyframes envd-pulse{0%,100%{opacity:.55}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.envd-skel{animation:none}}

/* 底部:只需要复制反馈 + 安静的一行环境脚注 */
.envd-foot{display:flex;align-items:center;gap:18px;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l1);padding-top:11px;font-size:12px}
.envd-foot-item{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);min-width:0;max-width:100%}
.envd-foot-hint{font-size:11px;color:var(--dsw-alias-label-secondary);min-width:0;max-width:320px;overflow-wrap:anywhere}
.envd-copy-note{font-size:11.5px;color:var(--dsw-alias-label-secondary);min-width:0;overflow-wrap:anywhere}
.envd-footmeta{font-size:11px;color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* 高级设置:默认收起,把两个不常动的开关收进来(首屏只留四块) */
.envd-advanced{display:flex;flex-direction:column;gap:8px;min-width:0}
.envd-advanced-title{font-size:12.5px;font-weight:650;color:var(--dsw-alias-label-primary);flex:none}
/* 展开后的内容:仿 .envd-sec-b 的细线 + 缩进,别让开关直接贴住折叠行 */
.envd-adv{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px;min-width:0}
.envd-adv .envd-foot-item{align-items:flex-start;flex-wrap:wrap;gap:8px}
.envd-adv .envd-foot-item>span:first-child{padding-top:3px}

@media (max-width:560px){
  .envd-scroll{padding:16px 16px 40px;gap:18px}
  .envd-tgroup{display:none}
  .envd-trow{grid-template-columns:72px 84px minmax(0,1fr) auto}
  .envd-vlist{padding-left:0}
  .envd-tact .envd-btn{padding:0 4px}
}
@media (prefers-reduced-motion:reduce){.envd-btn,.envd-chip,.envd-switch{transition:none}}
`

    // ───────────────────────────────────── 数据 ──
    let localeService = null

    // 宿主探测本机环境偶尔会卡住:没有上限的话面板会一直转圈,请求永远不回来。
    const API_TIMEOUT_MS = 15000
    // 面板静默轮询间隔:宿主会在会话/工具表变化后自己重算,面板跟着拉一份就够。
    const POLL_MS = 15000
    // 轮询去重时忽略的易变键:宿主每个 tick 都会推进它们,拿它们参与比较等于「永远有新变化」,
    // 去重就白做了(生产里每 15s 都会 setData 重渲染一次)。
    const VOLATILE_STATS_KEYS = ['ticks', 'lastAt', 'lastErrorAt', 'now', 'updatedAt']
    const signatureOf = (value) => {
      if (!value || typeof value !== 'object') return JSON.stringify(value)
      const copy = Object.assign({}, value)
      if (copy.syncStats && typeof copy.syncStats === 'object') {
        const trimmed = Object.assign({}, copy.syncStats)
        for (const key of VOLATILE_STATS_KEYS) delete trimmed[key]
        copy.syncStats = trimmed
      }
      return JSON.stringify(copy)
    }

    // 优先 AbortSignal.timeout(原生、不用自己清定时器);老环境退到 AbortController + setTimeout。
    function abortPlan() {
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return { signal: AbortSignal.timeout(API_TIMEOUT_MS), stop: () => {} }
      }
      if (typeof AbortController === 'function') {
        const ctrl = new AbortController()
        const timer = setTimeout(() => {
          try {
            ctrl.abort()
          } catch {}
        }, API_TIMEOUT_MS)
        return {
          signal: ctrl.signal,
          stop: () => {
            try {
              clearTimeout(timer)
            } catch {}
          },
        }
      }
      return { signal: undefined, stop: () => {} }
    }

    // 失败一律以 { ok:false, error } 返回,不往调用方抛:调用点直接读 res.ok / res.error。
    async function callApi(body) {
      const plan = abortPlan()
      try {
        const res = await fetch('/envdock-api', {
          method: body ? 'POST' : 'GET',
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
          signal: plan.signal,
        })
        const data = await res.json().catch(() => null)
        if (!data || typeof data !== 'object') return { ok: false, error: 'HTTP ' + res.status }
        return data
      } catch (e) {
        const err = e || {}
        const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError'
        return { ok: false, error: timedOut ? 'timeout after ' + API_TIMEOUT_MS + 'ms' : String(err.message || err) }
      } finally {
        plan.stop()
      }
    }

    function fmtTime(ts) {
      if (!ts) return ''
      try {
        return new Date(ts).toLocaleTimeString()
      } catch {
        return ''
      }
    }

    // ───────────────────────────────────── 侧边栏图标 ──
    function EnvDockIcon(props) {
      const size = (props && props.size) || 18
      const active = Boolean(props && props.active)
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { x: 2.2, y: 2.2, width: 19.6, height: 19.6, rx: 5.4, fill: active ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 1.5, opacity: active ? 0.16 : 0.9 }),
        h('path', { d: 'M6.4 8.4h11.2M8.9 8.4V6.7h6.2v1.7M6.4 8.4l-.7 7.6a2 2 0 0 0 2 2.2h8.6a2 2 0 0 0 2-2.2l-.7-7.6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M10 12.2l1.5 1.5-1.5 1.5M12.8 15.2h2.6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    /** 极简模板:只替换 {key}。 */
    function fmtText(tpl, vars) {
      return String(tpl || '').replace(/\{(\w+)\}/g, (whole, key) => (vars && vars[key] !== undefined ? String(vars[key]) : whole))
    }

    // ───────────────────────────────────── 主面板 ──
    function EnvDockPanel() {
      const [t, setT] = useState(DICT.zh)
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [opError, setOpError] = useState('')
      const [busyCount, setBusyCount] = useState(0)
      const [copied, setCopied] = useState('')
      const [copyNote, setCopyNote] = useState('')
      const [shellPath, setShellPath] = useState('')
      const [shellLabel, setShellLabel] = useState('')
      const [shellArgs, setShellArgs] = useState('')
      const [shellFormOpen, setShellFormOpen] = useState(false)
      const [briefOpen, setBriefOpen] = useState(false)
      const [advancedOpen, setAdvancedOpen] = useState(false)
      const [healthOpen, setHealthOpen] = useState(false)
      const [diagOpen, setDiagOpen] = useState(false)
      const [openVersions, setOpenVersions] = useState({})
      const [toolPath, setToolPath] = useState('')
      const [toolName, setToolName] = useState('')
      const [toolFormOpen, setToolFormOpen] = useState(false)
      const [draftError, setDraftError] = useState('')
      const mounted = useRef(true)
      const seqRef = useRef(0)
      // 上一次成功写入的 payload:轮询拿回同一份事实时跳过 setData,避免无意义重渲染。
      const lastJson = useRef('')
      const busy = busyCount > 0

      // busy 用计数不用布尔:并发请求各持一份,谁先结束都不会把别人的状态放掉,也不会掉成负数。
      const begin = useCallback(() => setBusyCount((n) => n + 1), [])
      const end = useCallback(() => setBusyCount((n) => (n > 0 ? n - 1 : 0)), [])
      // 请求序号:每次请求领一张新票,只有最新那张票的响应可以写 state(后发起的赢)。
      const nextSeq = useCallback(() => {
        seqRef.current += 1
        return seqRef.current
      }, [])
      const isCurrent = useCallback((seq) => seqRef.current === seq, [])

      useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
        }
      }, [])

      useEffect(() => {
        let alive = true
        const apply = () => {
          if (!alive) return
          let id = ''
          try {
            const snap = localeService && localeService.getLocale ? localeService.getLocale() : null
            // 生效语言以 locale 服务当前激活的那个(active)为准
            id = snap && typeof snap.active === 'string' ? snap.active : ''
          } catch {}
          if (!id) {
            try {
              id = (navigator.language || '').slice(0, 2)
            } catch {}
          }
          setT(/^zh/i.test(id) ? DICT.zh : DICT.en)
        }
        apply()
        let off = null
        try {
          if (localeService && localeService.subscribe) off = localeService.subscribe(apply)
        } catch {}
        return () => {
          alive = false
          try {
            if (typeof off === 'function') off()
          } catch {}
        }
      }, [])

      const fetchState = useCallback(
        async (silent) => {
          const seq = nextSeq()
          if (!silent) begin()
          try {
            const next = await callApi(null)
            // 过期响应(期间又发起了别的请求)不许写 state,否则慢的那份会把新的盖回去
            if (!mounted.current || !isCurrent(seq)) return
            if (!next || next.ok !== true) {
              // 静默轮询失败不改面板(网络抖一下就让整块变红没有意义),只有手动刷新才报。
              if (!silent) setError((next && next.error) || t.loadFailed)
              return
            }
            setError('')
            // payload 没变就不 setData:15s 一次轮询,事实没变时重渲染纯属浪费。
            const encoded = signatureOf(next)
            if (encoded === lastJson.current) return
            lastJson.current = encoded
            setData(next)
          } catch (e) {
            if (mounted.current && isCurrent(seq) && !silent) setError(String((e && e.message) || e))
          } finally {
            if (!silent && mounted.current) end()
          }
        },
        [t, begin, end, nextSeq, isCurrent],
      )

      const load = useCallback(() => fetchState(false), [fetchState])

      useEffect(() => {
        load()
      }, [load])

      // 15s 静默轮询:只在页面可见时拉(后台标签页白跑宿主探测没有意义)。
      // 测试桩没有 document → 视为可见;可见性每 tick 现读,切回来不用重建定时器。
      useEffect(() => {
        const tick = () => {
          let visible = true
          try {
            if (typeof document !== 'undefined' && document && typeof document.visibilityState === 'string') {
              visible = document.visibilityState === 'visible'
            }
          } catch {}
          if (visible) fetchState(true)
        }
        const id = setInterval(tick, POLL_MS)
        return () => clearInterval(id)
      }, [fetchState])

      const post = useCallback(
        async (body) => {
          const seq = nextSeq()
          begin()
          try {
            const res = await callApi(body)
            if (!mounted.current || !isCurrent(seq)) return res
            if (res && res.ok === false) setOpError((res && res.error) || t.actionFailed)
            else setOpError('')
            await load()
            return res
          } catch (e) {
            // 任何异常都在这里收掉:rejection 不许逃进 React
            const message = String((e && e.message) || e)
            if (mounted.current && isCurrent(seq)) setOpError(message)
            return { ok: false, error: message }
          } finally {
            if (mounted.current) end()
          }
        },
        [load, begin, end, nextSeq, isCurrent, t],
      )

      // 复制:安全上下文(https/localhost)走 navigator.clipboard;
      // 局域网 http 没有剪贴板 API(或被策略拒),退到 textarea + execCommand('copy');
      // 两条都失败就给可见提示,不能静默失败(用户以为复制了,粘贴却是旧内容)。
      const copy = useCallback(async (value, tag) => {
        const done = () => {
          setCopyNote('')
          setCopied(tag)
          setTimeout(() => mounted.current && setCopied(''), 1400)
        }
        try {
          if (typeof navigator !== 'undefined' && navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(value)
            done()
            return
          }
        } catch {}
        try {
          if (typeof document === 'undefined' || !document || typeof document.execCommand !== 'function') throw new Error('clipboard unavailable')
          const area = document.createElement('textarea')
          area.value = value
          area.setAttribute('readonly', '')
          area.style.position = 'fixed'
          area.style.top = '0'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          const ok = document.execCommand('copy')
          document.body.removeChild(area)
          if (!ok) throw new Error('copy rejected')
          done()
        } catch {
          setCopied('')
          setCopyNote(t.copyFailed)
        }
      }, [t])

      // ── 载荷 → 视图模型 ──
      const tools = (data && data.tools) || []
      const issues = (data && data.issues) || []
      const terminals = (data && data.terminals) || []
      const managers = (data && (data.versionManagers || data.managers)) || []
      const state = (data && data.state) || { options: {}, customTools: [] }
      const options = state.options || {}
      const shell = (data && data.shell) || {}
      const platform = (data && data.platform) || null
      const pathInfo = (data && data.pathInfo) || null
      const missingPaths = pathInfo ? Number(pathInfo.missingCount) || (Array.isArray(pathInfo.missing) ? pathInfo.missing.length : 0) || 0 : 0
      const fmt = fmtText

      // ── 命令工具事实:面板只回答四件事 ──
      // 1) envd_shell 注册且可见吗;2) 本会话用哪个语法族、自动还是手动;
      // 3) 宿主有哪些命令工具(另一族此刻被遮挡了哪些);4) 有没有会话被围栏。
      // 不推导「终局」:注册失败就是没注册,面板只摆其它命令工具与隐藏事实。
      const ct = data && data.commandTool && typeof data.commandTool === 'object' ? data.commandTool : null
      const stats = data && data.syncStats && typeof data.syncStats === 'object' ? data.syncStats : null
      const hasOwn = (obj, key) => Boolean(obj) && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key)
      // 过渡期:client.js 是热更新的,而宿主进程里的 index.js 要重启 dsh 才换。
      // 旧形状没有 registered / hostTools,直接读会显示成「— / 未识别到」——那是假话。
      // 旧形状的 visible 正好等于「注册了且全局可见」,hostName 补宿主工具。
      const legacyApi = Boolean(ct) && typeof ct.registered !== 'boolean'
      const registered = legacyApi ? Boolean(ct && ct.visible === true) : Boolean(ct && ct.registered === true)
      const visible = Boolean(ct && ct.visible === true)
      const ready = registered && visible
      const skipReason = ct && typeof ct.skipReason === 'string' ? ct.skipReason : ''
      const ownText = registered ? String((ct && ct.name) || 'envd_shell') : '—'

      // ── 语法族(0.6):'bash' | 'powershell' | '' ──
      // 载荷顶层优先(逐会话事实),其次 commandTool;旧载荷没有这两个字段时退回终端自己的族,
      // 至少能标出「这是 bash 族」。cmd / 自定义终端不属于两族 → 空,面板不显示族徽标。
      const familyOf = (value) => {
        const key = String(value || '').toLowerCase()
        return key === 'bash' || key === 'powershell' ? key : ''
      }
      const declaredFamily = hasOwn(data, 'family') ? familyOf(data.family) : hasOwn(ct, 'family') ? familyOf(ct.family) : null
      const family = declaredFamily === null ? familyOf(shell.family) : declaredFamily
      const sourceRaw = hasOwn(data, 'familySource') ? String(data.familySource || '') : hasOwn(ct, 'familySource') ? String(ct.familySource || '') : ''
      const familySource = sourceRaw === 'manual' || sourceRaw === 'auto' ? sourceRaw : ''
      // 手动选的族「既没有终端、也没有按该族发布的宿主工具」→ 宿主已回退 auto。
      // 此刻 payload.family / familySource 报的已经是生效结果(auto),面板只负责把「你选的手动族被回退了」说出来。
      const familyFallback = hasOwn(data, 'familyFallback') ? data.familyFallback === true : hasOwn(ct, 'familyFallback') ? ct.familyFallback === true : false
      const famLabel = family === 'bash' ? t.famBash : family === 'powershell' ? t.famPwsh : ''
      // 自动选时不再加后缀(「· 自动」属于噪音);只有手动选的语法才标一下,提醒这是你自己定的。
      const famSourceTag = familySource === 'manual' ? t.famManual : ''
      // 终端 chip 上的短标:bash / pwsh / cmd / wsl。认不出就不加(不硬编一个假族)。
      const famShort = (value) => {
        const key = String(value || '').toLowerCase()
        if (key === 'bash') return 'bash'
        if (key === 'powershell' || key === 'pwsh') return 'pwsh'
        if (key === 'cmd' || key === 'wsl') return key
        return ''
      }
      const famNameOf = (value) => {
        const short = famShort(value)
        return short === 'bash' ? t.famBash : short === 'pwsh' ? t.famPwsh : short
      }
      // 遮挡开关:以宿主事实为准(此刻生效的值);旧载荷没有就用设置项,默认开。
      const blockOtherFamily = hasOwn(ct, 'blockOtherFamily') ? ct.blockOtherFamily !== false : options.blockOtherFamily !== false
      // 开关只认设置项;极端载荷里设置项缺了才退回宿主的有效值(免得开关与备注说的不一样)。
      const blockOptionOn = hasOwn(options, 'blockOtherFamily') ? options.blockOtherFamily !== false : blockOtherFamily
      // 开关本身只在宿主真的认这个设置项时才渲染:旧宿主上按一下只会换来 400,那是假开关。
      const blockSwitchSupported = hasOwn(options, 'blockOtherFamily') || hasOwn(ct, 'blockOtherFamily')
      const nameList = (value) => (Array.isArray(value) ? value.map((item) => String(item || '')).filter(Boolean) : [])
      const hiddenNames = nameList(ct && ct.hidden)
      const refuseOnlyNames = nameList(ct && ct.refuseOnly)
      const displayOnlyNames = nameList(ct && ct.displayOnly)
      const mixed = Boolean(ct && ct.mixed === true)

      // 命令工具:排序由调用方负责(内置顺序优先,其余按名字),面板只做去重与兜底。
      // 旧形状只给一个 hostName(没有宿主工具列表),过渡期就展示它。
      const legacyHostTools = legacyApi && ct && ct.hostName ? [{ name: String(ct.hostName), family: '', learned: false, group: '' }] : []
      const hostTools = (legacyApi ? legacyHostTools : ct && Array.isArray(ct.hostTools) ? ct.hostTools : [])
        .map((item) =>
          typeof item === 'string'
            ? { name: item, family: '', learned: false, group: '' }
            : {
                name: item && item.name ? String(item.name) : '',
                family: item && item.family ? String(item.family) : '',
                learned: Boolean(item && item.learned),
                group: item && item.group ? String(item.group) : '',
              },
        )
        .filter((item) => item.name)
      const hostNames = []
      for (const item of hostTools) if (!hostNames.includes(item.name)) hostNames.push(item.name)
      const hostText = hostNames.length ? t.hostPrefix + hostNames.join(' · ') : t.hostToolsNone
      // 按语法族分的宿主工具(备注要说「另一族此刻还在不在」)。
      const hostNamesInFamily = (short) => hostTools.filter((item) => famShort(item.family) === short).map((item) => item.name)
      const bashHostNames = hostNamesInFamily('bash')
      const pwshHostNames = hostNamesInFamily('pwsh')

      // 沙箱聚合:只用来回答「有没有会话被围栏」。
      const sandboxInfo = (ct && ct.sandbox && typeof ct.sandbox === 'object' ? ct.sandbox : null) || (data && data.sandbox && typeof data.sandbox === 'object' ? data.sandbox : null) || {}
      const confinedCount = Math.max(0, Number(sandboxInfo.confinedCount) || 0)
      const confined = confinedCount > 0

      // badge 二态(整个面板唯一的状态结论):有命令工具 → 就绪,没有 → 只展示。
      // 「有会话被沙箱限制」不是面板级结论(面板是全局的):它只进备注,免得上 badge 变成没主语的「受限」。
      const badgeTone = ready ? 'ok' : 'muted'
      const badgeText = ready ? t.statusAdditive : t.statusDisplayOnly

      // 备注最多两行,按优先级取:未提供原因 → 沙箱限制 → 语法回退 → 混用警告 → 隐藏/未隐藏。
      // 「用 envd_shell」「已隐藏 pwsh」这类话只在 envd_shell 真的可用/事实真的成立时才说:
      // 没提供工具就无工具可拒,也没挡任何东西 —— 那时只剩一句原因。
      // 环境差异那句已挪进「其它」段的 title(悬停可见),普通状态备注最多一行。
      const notes = []
      if (legacyApi) notes.push({ tone: 'warn', text: t.noteLegacyApi })
      if (!ready && !legacyApi) {
        if (skipReason === 'no-family-terminal') {
          // 选中的语法没有可用终端:说清两套语法各自需要什么,别让用户猜。
          notes.push({ tone: 'muted', text: t.skipNoFamilyTerminal })
        } else if (skipReason === 'no-unconfined-session') {
          notes.push({ tone: 'muted', text: t.skipNoUnconfined })
        } else if (skipReason === 'taken') {
          notes.push({ tone: 'muted', text: t.skipTaken })
        } else if (skipReason) {
          notes.push({ tone: 'warn', text: t.skipError })
        }
      }
      if (ready && confined) notes.push({ tone: 'warn', text: fmt(t.noteConfined, { n: confinedCount }) })
      // 手动选的语法不可用、已改回按会话选择:这是「用户的选择没生效」,必须让人看见。
      if (familyFallback) notes.push({ tone: 'warn', text: t.noteFamilyFallback })
      // 两套语法同时可见 = 模型手里有两套写法,最容易出的错就是混写。警告优先于其它 muted 事实。
      if (mixed) notes.push({ tone: 'warn', text: t.noteMixed })
      // bash 会话隐藏了 PowerShell 内置命令工具:这是此刻的事实,如实说被藏了谁(名字不加引号,人话)。
      if (family === 'bash' && hiddenNames.length) {
        notes.push({ tone: 'muted', text: fmt(t.noteHiddenPwsh, { names: hiddenNames.join(', ') }) })
      }
      if (family === 'bash' && !mixed && !blockOtherFamily && pwshHostNames.length) notes.push({ tone: 'muted', text: t.noteNotBlocked })
      // 手动选了 bash 语法、会话里却看不到 bash 命令工具:隐藏条件不成立,说清「没有隐藏」。
      if (family === 'bash' && familySource === 'manual' && bashHostNames.length === 0) notes.push({ tone: 'muted', text: t.noteNoBashHost })
      const shownNotes = notes.slice(0, 2)
      const badgeTitle = shownNotes.length ? shownNotes.map((note) => note.text).join(' · ') : undefined

      // 详情:扫描计数 + 宿主工具 chips + 最近错误。计数只读 syncStats 的白名单字段。
      const statNum = (value) => {
        const n = Number(value)
        return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
      }
      // 详情计数只留「扫描 / 最近 / 注册尝试」这三项稳定事实:
      // restrictApplied / guardRefusals 是历史累计(API 仍提供),贴着「此刻」的详情摆只会误导用户。
      const countText = stats
        ? [fmt(t.dScan, { n: statNum(stats.detections) }), fmt(t.dLastScan, { n: statNum(stats.lastDetectMs) }), fmt(t.dRegisterTries, { n: statNum(stats.registerTries) })].filter(Boolean).join(' · ')
        : ''
      const lastError = stats && typeof stats.lastError === 'string' ? stats.lastError.trim() : ''
      // 宿主工具 chips:被遮挡的名字不在 hostTools 里(宿主报的是「此刻看得见」),
      // 于是补一条划掉的名字 —— 用户要能看见「它被藏了」,而不是它凭空消失。
      // 「只能拒绝 / 只展示」的名字通常仍在 hostTools 里:就地打标签,不另起一行。
      const hiddenSet = new Set(hiddenNames)
      const refuseOnlySet = new Set(refuseOnlyNames)
      const displayOnlySet = new Set(displayOnlyNames)
      const chipTagOf = (name) => (hiddenSet.has(name) ? 'hidden' : refuseOnlySet.has(name) ? 'refused' : displayOnlySet.has(name) ? 'display' : '')
      const hostChipItems = hostTools.map((item) => Object.assign({}, item, { chipTag: chipTagOf(item.name) }))
      const addChip = (name, family, tag) => {
        if (hostChipItems.some((item) => item.name === name)) return
        hostChipItems.push({ name, family, learned: false, group: family, chipTag: tag })
      }
      for (const name of hiddenNames) addChip(name, 'powershell', 'hidden')
      for (const name of refuseOnlyNames) addChip(name, 'powershell', 'refused')
      for (const name of displayOnlyNames) addChip(name, 'powershell', 'display')

      // ── 小零件 ──
      const badge = (tone, text, extra) => h('span', Object.assign({ className: 'envd-badge ' + tone }, extra || {}), h('span', { className: 'dot' }), text)
      const sec = (title, body, tail, key) =>
        h(
          'section',
          { className: 'envd-sec', key: key || title },
          h('div', { className: 'envd-sec-h' }, h('h2', {}, title), tail || null),
          h('div', { className: 'envd-sec-b' }, body),
        )
      const field = (label, klass, input) => h('label', { className: 'envd-f ' + (klass || '') }, h('span', { className: 'envd-label' }, label), input)
      const ghostAdd = (text, onClick) => h('button', { className: 'envd-btn ghost', onClick, style: { alignSelf: 'flex-start' } }, '+ ' + text)

      // ── 详情:扫描计数 + 宿主工具 chips(带族/遮挡/只展示标签)+ 最近错误(默认折叠) ──
      const chipTagText = (tag) => (tag === 'hidden' ? t.hostToolHidden : tag === 'refused' ? t.hostToolRefused : tag === 'display' ? t.displayOnlyTag : '')
      const diagBlock = diagOpen
        ? h(
            'div',
            { className: 'envd-diag-detail' },
            h('span', { className: 'envd-diag-stat', key: 'dstat' }, countText || t.never),
            h(
              'span',
              { className: 'envd-diag-shelltools', key: 'dtools' },
              t.hostTools + ': ',
              hostChipItems.length
                ? hostChipItems.map((item) => {
                    const famText = famNameOf(item.family) || famNameOf(item.group)
                    const tagText = chipTagText(item.chipTag)
                    return h(
                      'span',
                      {
                        key: 'ht-' + item.name,
                        className: 'envd-shellchip' + (item.chipTag === 'hidden' ? ' hidden' : item.chipTag ? ' ' + item.chipTag : ''),
                        title: [item.name, famText, item.learned ? t.learnedTag : '', tagText].filter(Boolean).join(' · '),
                      },
                      h('span', { className: 'envd-mono' }, item.name),
                      famText ? ' · ' + famText : '',
                      item.learned ? ' ✦' : '',
                      tagText ? ' · ' + tagText : '',
                    )
                  })
                : h('span', { key: 'ht-none', className: 'envd-sub' }, t.hostToolsNone),
            ),
            lastError
              ? h('span', { className: 'e', key: 'derr' }, t.noteLastError + ': ' + (lastError.length > 140 ? lastError.slice(0, 140) + '…' : lastError))
              : null,
          )
        : null

      // ── 终端选择:面板的主操作,常显 ──
      // 每个 chip 带语法族短标(bash / pwsh / cmd):两族规则先在这里露出一点,再在命令行讲清。
      const shellChips = h(
        'div',
        { className: 'envd-chips', role: 'group', 'aria-label': t.terminal },
        h(
          'button',
          {
            className: 'envd-chip' + (state.defaultShell === 'auto' ? ' on' : ''),
            'aria-pressed': state.defaultShell === 'auto',
            title: t.autoShellHint,
            onClick: () => post({ op: 'setShell', key: 'auto' }),
          },
          t.autoShell,
        ),
        terminals
          .filter((x) => x.family !== 'wsl')
          .map((term) =>
            h(
              'button',
              {
                key: term.key,
                className: 'envd-chip' + (state.defaultShell === term.key ? ' on' : ''),
                'aria-pressed': state.defaultShell === term.key,
                title: term.path + (term.version ? ' · v' + term.version : ''),
                onClick: () => post({ op: 'setShell', key: term.key }),
              },
              term.label,
            ),
          ),
        h('button', { className: 'envd-btn ghost', title: t.customShell, 'aria-label': t.customShell, onClick: () => setShellFormOpen((v) => !v) }, '+'),
      )

      const shellForm = shellFormOpen
        ? h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            h(
              'div',
              { className: 'envd-fields' },
              field(t.labelPath, 'grow', h('input', { className: 'envd-input', placeholder: t.customHint, value: shellPath, onChange: (e) => setShellPath(e.target.value) })),
              field(t.name, 'narrow', h('input', { className: 'envd-input', placeholder: t.name, value: shellLabel, onChange: (e) => setShellLabel(e.target.value) })),
              field(t.labelArgs, 'mid', h('input', { className: 'envd-input', placeholder: t.customShellArgsHint, value: shellArgs, onChange: (e) => setShellArgs(e.target.value) })),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: 6 } },
              h(
                'button',
                {
                  className: 'envd-btn',
                  disabled: !shellPath.trim(),
                  onClick: async () => {
                    const res = await post({ op: 'setCustomShell', path: shellPath.trim(), label: shellLabel.trim() || undefined, args: shellArgs.trim() || undefined })
                    if (res && res.ok) {
                      setShellPath('')
                      setShellLabel('')
                      setShellArgs('')
                      setShellFormOpen(false)
                    }
                  },
                },
                t.add,
              ),
              h('button', { className: 'envd-btn ghost', onClick: () => setShellFormOpen(false) }, t.collapse),
            ),
          )
        : null

      // ── 工具链:一行一个工具 ──
      const groupOrder = ['runtime', 'package', 'vcs', 'env', 'custom']
      const groupName = {
        runtime: t.groupRuntime,
        package: t.groupPackage,
        vcs: t.groupVcs,
        env: t.groupEnv,
        custom: t.groupCustom,
        managers: t.groupManagers,
      }
      const buckets = new Map()
      for (const tool of tools) {
        const g = groupOrder.includes(tool.group) ? tool.group : 'custom'
        if (!buckets.has(g)) buckets.set(g, [])
        buckets.get(g).push(tool)
      }
      const toolRows = []
      for (const g of groupOrder) {
        const items = buckets.get(g) || []
        items.forEach((tool, index) => {
          const versions = Array.isArray(tool.versions) ? tool.versions : []
          const copiedNow = copied === tool.key + ':path'
          const expanded = openVersions[tool.key] === true
          const path = tool.defaultPath || ''
          toolRows.push(
            h(
              'div',
              { className: 'envd-trow', key: 'tool-' + tool.key },
              h('span', { className: 'envd-tgroup' }, index === 0 ? groupName[g] : ''),
              h('span', { className: 'envd-tname' }, tool.label),
              h('span', { className: 'envd-tver' + (tool.defaultVersion ? '' : ' idle') }, tool.defaultVersion ? 'v' + tool.defaultVersion : t.versionUnknown),
              path
                ? h('button', { className: 'envd-tpath', title: t.copyPathHint + ': ' + path, 'aria-label': t.copyPathHint + ': ' + path, onClick: () => copy(path, tool.key + ':path') }, copiedNow ? '✓ ' + t.copied : path)
                : h('span', { className: 'envd-sub' }, t.versionUnknown),
              h(
                'span',
                { className: 'envd-tact' },
                versions.length > 1
                  ? h(
                      'button',
                      { key: 'v', className: 'envd-btn ghost', 'aria-expanded': expanded, title: fmt(t.versionChip, { n: versions.length }), onClick: () => setOpenVersions((prev) => Object.assign({}, prev, { [tool.key]: !expanded })) },
                      fmt(t.versionChip, { n: versions.length }),
                      ' ',
                      expanded ? '▴' : '▾',
                    )
                  : null,
                tool.custom ? h('button', { key: 'rm', className: 'envd-btn ghost', onClick: () => post({ op: 'removeCustomTool', key: tool.key }) }, t.remove) : null,
              ),
            ),
          )
          if (expanded && versions.length) {
            toolRows.push(
              h(
                'div',
                { className: 'envd-vlist', key: 'vers-' + tool.key },
                versions.map((v) => {
                  const isDefault = String(v.path).toLowerCase() === String(tool.defaultPath).toLowerCase()
                  return h(
                    'div',
                    { className: 'envd-vrow' + (isDefault ? ' on' : ''), key: v.path },
                    h('span', { className: 'vv envd-mono' }, v.version ? 'v' + v.version : t.versionUnknown),
                    h('span', { className: 'vp envd-mono', title: v.path }, v.path),
                    h(
                      'span',
                      { className: 'act' },
                      isDefault ? h('span', { className: 'envd-cur' }, t.default) : h('button', { className: 'envd-btn ghost', onClick: () => post({ op: 'setTool', key: tool.key, path: v.path }) }, t.setDefault),
                    ),
                  )
                }),
              ),
            )
          }
        })
      }
      // 版本管理器:一行一个,版本列表合并到同一行(激活的那个加粗)
      managers.forEach((mgr, index) => {
        const versions = Array.isArray(mgr.versions) ? mgr.versions : []
        const versionText = versions.length
          ? versions.map((v) => (v.active ? v.name + ' ←' : v.name)).join(' · ')
          : mgr.listed
            ? ''
            : t.managersNoList
        toolRows.push(
          h(
            'div',
            { className: 'envd-trow envd-manager', key: 'mgr-' + mgr.key },
            h('span', { className: 'envd-tgroup' }, index === 0 ? t.groupManagers : ''),
            h('span', { className: 'envd-tname' }, mgr.label),
            h('span', { className: 'envd-mgr-ver', title: versionText }, versionText || (mgr.active ? t.managersActive + ' ' + mgr.active : '')),
            h('span', { className: 'envd-mgr-ver envd-mono', title: mgr.command || (mgr.roots && mgr.roots[0]) || '' }, mgr.command || (mgr.roots && mgr.roots[0]) || ''),
            h('span', { className: 'envd-tact' }),
          ),
        )
      })

      const toolForm = toolFormOpen
        ? h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            h(
              'div',
              { className: 'envd-fields' },
              field(t.labelPath, 'grow', h('input', { className: 'envd-input', placeholder: t.customHint, value: toolPath, onChange: (e) => setToolPath(e.target.value) })),
              field(t.name, 'narrow', h('input', { className: 'envd-input', placeholder: t.name, value: toolName, onChange: (e) => setToolName(e.target.value) })),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: 6 } },
              h(
                'button',
                {
                  className: 'envd-btn',
                  disabled: !toolPath.trim(),
                  onClick: async () => {
                    setDraftError('')
                    const res = await post({ op: 'addCustomTool', path: toolPath.trim(), label: toolName.trim() || undefined })
                    if (res && res.ok) {
                      setToolPath('')
                      setToolName('')
                      setToolFormOpen(false)
                    } else {
                      setDraftError((res && res.error) || t.addFailed)
                    }
                  },
                },
                t.add,
              ),
              h('button', { className: 'envd-btn ghost', onClick: () => setToolFormOpen(false) }, t.collapse),
            ),
            draftError ? h('div', { className: 'envd-err' }, h('span', { className: 'h' }, draftError)) : null,
          )
        : ghostAdd(t.customTool, () => setToolFormOpen(true))

      // ── 环境检查:健康时一行「通过」,有问题一行摘要 ──
      const hasError = issues.some((issue) => issue.level === 'error')
      const healthRow = issues.length
        ? h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h(
              'button',
              { className: 'envd-foldrow envd-fold-health', 'aria-expanded': healthOpen, onClick: () => setHealthOpen((v) => !v) },
              h('span', { className: 'envd-flag ' + (hasError ? 'bad' : 'warn') }, '⚠ ' + fmt(t.countItems, { n: issues.length })),
              h('span', { className: 'envd-sub', style: { flex: '1 1 auto' } }, issues[0] ? String(issues[0].title || '') : ''),
              h('span', { className: 'envd-sub', style: { flex: 'none' } }, healthOpen ? t.collapse : t.expand),
            ),
            healthOpen
              ? h(
                  'div',
                  { className: 'envd-issues' },
                  issues.map((issue, index) =>
                    h(
                      'div',
                      { className: 'envd-issue ' + (issue.level || 'info'), key: issue.title + index },
                      h('span', { className: 'dot' }),
                      h('div', { className: 'tx' }, h('b', {}, issue.title), h('span', {}, issue.detail || '')),
                    ),
                  ),
                )
              : null,
          )
        : h('div', { className: 'envd-row' }, h('span', { className: 'envd-tag' }, t.health), h('span', { className: 'envd-flag ok' }, '✓ ' + t.healthy))

      // ── 头部:插件名 / 默认终端 / 一个状态 badge / 重新探测,下一行一句用途说明 ──
      const head = h(
        'div',
        { className: 'envd-head' },
        h('h1', { className: 'envd-h1' }, h('span', { style: { color: 'var(--dsw-alias-brand-primary)', display: 'flex', flex: 'none' } }, h(EnvDockIcon, { size: 19 })), t.title),
        data
          ? h(
              'span',
              { className: 'envd-headline', title: t.updatedAt + ' ' + fmtTime(data.detectedAt) },
              h('b', {}, shell.label || '—'),
              shell.version ? ' v' + shell.version : '',
            )
          : h('span', { className: 'envd-headline' }, t.loading),
        data ? badge(badgeTone, badgeText, { title: badgeTitle }) : null,
        h('span', { className: 'envd-grow' }),
        h('button', { className: 'envd-btn primary', disabled: busy, onClick: () => post({ op: 'refresh' }) }, busy ? t.detecting : t.refresh),
      )
      // 陌生人第一眼要能回答「这插件是干嘛的」:一句用途说明常显,不折叠。
      const headBlock = h('div', { className: 'envd-headblock' }, head, h('div', { className: 'envd-subtitle' }, t.subtitle))

      const body = [headBlock]

      if (error) {
        body.push(
          h(
            'div',
            { className: 'envd-err', key: 'err', role: 'alert' },
            h('span', { className: 'h' }, t.loadFailed + ': ' + error),
            h('span', {}, t.loadFailedHint),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, h('button', { className: 'envd-btn ghost', onClick: load }, t.retry)),
          ),
        )
      }

      if (!data && !error) {
        body.push(
          h(
            'div',
            { className: 'envd-loading', key: 'loading' },
            h('div', { className: 'envd-skel', style: { width: '42%' } }),
            h('div', { className: 'envd-skel', style: { width: '72%' } }),
            h('div', { className: 'envd-skel', style: { width: '58%' } }),
          ),
        )
      }

      // 操作失败(切版本 / 加工具 / 改选项):独立通道,可关闭。
      // 不跟 data 绑定:!data(例如被 403 挡在门外)时切 allowLan 失败也必须看得见原因。
      if (opError) {
        body.push(
          h(
            'div',
            { className: 'envd-err', key: 'err-op', role: 'alert' },
            h('span', { className: 'h' }, t.actionFailed + ': ' + opError),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, h('button', { className: 'envd-btn ghost', onClick: () => setOpError('') }, t.dismiss)),
          ),
        )
      }

      if (data) {
        if (data.hasSubprocess === false) {
          body.push(h('div', { className: 'envd-err', key: 'nosub' }, h('span', { className: 'h' }, t.subprocessOff)))
        }

        // ── 命令卡:终端选择 + 命令工具一行 + 最多两行备注 + 详情 ──
        body.push(
          h(
            'section',
            { className: 'envd-card', key: 'command' },
            h('div', { className: 'envd-row' }, h('span', { className: 'envd-tag' }, t.terminal), shellChips),
            shellForm,
            h(
              'div',
              { className: 'envd-row envd-cmdrow' },
              h('span', { className: 'envd-tag' }, t.command),
              // 语法标签:「这个会话该写哪套语法」是这一行最重要的上下文;自动选时不加后缀。
              famLabel
                ? h(
                    'span',
                    { className: 'envd-fam', title: famLabel + (famSourceTag ? ' · ' + famSourceTag : '') },
                    famLabel,
                    famSourceTag ? h('span', { className: 'envd-famsrc' }, ' · ' + famSourceTag) : null,
                  )
                : null,
              h('span', { className: 'envd-tool', title: t.cmdHintEnvDock }, ownText),
              h('span', { className: 'envd-host', title: t.cmdHintHost }, hostText),
              h('span', { className: 'envd-grow' }),
              h('button', { className: 'envd-btn ghost', 'aria-expanded': diagOpen, title: countText || t.never, onClick: () => setDiagOpen((v) => !v) }, t.diag),
            ),
            shownNotes.length
              ? h(
                  'div',
                  { className: 'envd-notes' },
                  shownNotes.map((note, index) =>
                    h(
                      'div',
                      { className: 'envd-note' + (note.tone && note.tone !== 'muted' ? ' ' + note.tone : ''), key: 'note' + index },
                      h('span', { className: 'ic' }, note.tone === 'warn' ? '⚠' : '·'),
                      h('span', {}, note.text),
                    ),
                  ),
                )
              : null,
            diagBlock,
          ),
        )

        // ── 工具链:一行一个工具 + 环境检查 ──
        body.push(
          sec(
            t.tools,
            [
              tools.length || managers.length
                ? h('div', { className: 'envd-tools' }, toolRows)
                : h('div', { className: 'envd-empty' }, t.noTools),
              toolForm,
              healthRow,
            ],
            h(
              'span',
              { className: 'n' },
              [fmt(t.toolCount, { n: tools.length }), managers.length ? t.managers + ' ' + managers.length : '', missingPaths ? fmt(t.pathMissing, { n: missingPaths }) : ''].filter(Boolean).join(' · '),
            ),
            'tools',
          ),
        )

        // ── 环境简报:默认一行;注入开关就放在这一行(同一件事只说一遍) ──
        body.push(
          sec(
            t.brief,
            [
              h(
                'div',
                { className: 'envd-row' },
                h('span', { className: 'envd-sub' }, options.injectBrief === true ? t.briefHint : t.briefOff),
                h('span', { className: 'envd-grow' }),
                h('button', {
                  className: 'envd-switch' + (options.injectBrief === true ? ' on' : ''),
                  'aria-pressed': options.injectBrief === true,
                  'aria-label': t.injectBrief,
                  title: t.injectBrief,
                  onClick: () => post({ op: 'setOption', injectBrief: options.injectBrief !== true }),
                }),
                h('button', { className: 'envd-btn ghost', onClick: () => copy(data.brief || '', 'brief') }, copied === 'brief' ? '✓ ' + t.copied : t.copyBrief),
                h('button', { className: 'envd-btn ghost', 'aria-expanded': briefOpen, onClick: () => setBriefOpen((v) => !v) }, briefOpen ? t.collapse : t.expand),
              ),
              briefOpen ? h('pre', { className: 'envd-pre envd-mono' }, options.injectBrief === true ? data.brief || t.never : t.briefOffDetail) : null,
            ],
            null,
            'brief',
          ),
        )

        // ── 高级设置:默认收起,把两个不常动的开关收进来(首屏只留四块) ──
        body.push(
          h(
            'div',
            { className: 'envd-advanced', key: 'advanced' },
            h(
              'button',
              { className: 'envd-foldrow envd-fold-advanced', 'aria-expanded': advancedOpen, onClick: () => setAdvancedOpen((v) => !v) },
              h('span', { className: 'envd-advanced-title' }, t.advanced),
              h('span', { className: 'envd-sub', style: { flex: '1 1 auto' } }),
              h('span', { className: 'envd-sub', style: { flex: 'none' } }, advancedOpen ? t.collapse : t.expand),
            ),
            advancedOpen
              ? h(
                  'div',
                  { className: 'envd-adv' },
                  blockSwitchSupported
                    ? h(
                        'div',
                        { className: 'envd-foot-item' },
                        h('span', {}, t.blockOtherFamily),
                        h('button', {
                          className: 'envd-switch' + (blockOptionOn ? ' on' : ''),
                          'aria-pressed': blockOptionOn,
                          'aria-label': t.blockOtherFamily,
                          title: t.blockOtherFamilyHintTitle,
                          onClick: () => post({ op: 'setOption', blockOtherFamily: !blockOptionOn }),
                        }),
                        h('span', { className: 'envd-foot-hint', title: t.blockOtherFamilyHintTitle }, t.blockOtherFamilyHint),
                      )
                    : null,
                  h(
                    'div',
                    { className: 'envd-foot-item' },
                    h('span', { title: t.allowLanHint }, t.allowLan),
                    h('button', {
                      className: 'envd-switch' + (options.allowLan === true ? ' on' : ''),
                      'aria-pressed': options.allowLan === true,
                      'aria-label': t.allowLan,
                      title: t.allowLanHint,
                      onClick: () => post({ op: 'setOption', allowLan: options.allowLan !== true }),
                    }),
                  ),
                )
              : null,
          ),
        )
      }

      // 底部:复制反馈 + 安静的一行环境脚注。
      // 有数据时 footer 不再放任何开关(简报注入在简报区、其余两个在高级设置里),避免同一件事说两遍;
      // 拿不到数据(403 / 接口没响应)时简报区不存在,allowLan 是唯一的解法入口,必须留在 footer。
      const footMeta = [platform ? [platform.version, platform.arch, platform.host].filter(Boolean).join(' · ') : '', data && data.detectedAt ? t.updatedAt + ' ' + fmtTime(data.detectedAt) : '']
        .filter(Boolean)
        .join(' · ')
      body.push(
        h(
          'div',
          { className: 'envd-foot', key: 'foot' },
          data
            ? null
            : h(
                'div',
                { className: 'envd-foot-item' },
                h('span', { title: t.allowLanHint }, t.allowLan),
                h('button', {
                  className: 'envd-switch' + (options.allowLan === true ? ' on' : ''),
                  'aria-pressed': options.allowLan === true,
                  'aria-label': t.allowLan,
                  title: t.allowLanHint,
                  onClick: () => post({ op: 'setOption', allowLan: options.allowLan !== true }),
                }),
              ),
          h('span', { className: 'envd-grow' }),
          h('span', { className: 'envd-copy-note', role: 'status', 'aria-live': 'polite' }, copyNote || (copied ? t.copied : '')),
          footMeta ? h('span', { className: 'envd-footmeta', title: footMeta }, footMeta) : null,
        ),
      )

      return h('div', { className: 'envd-root' }, h('style', {}, CSS), h('div', { className: 'envd-scroll' }, body))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        try {
          localeService = ctx.get('locale') || null
        } catch {
          localeService = null
        }
        if (!slots) return
        try {
          slots.inject('sidebar.panellist', () =>
            slots.register({ name: 'sidebar.panellist', id: 'envdock', order: 60, label: () => 'EnvDock' }, EnvDockIcon),
          )
        } catch (error) {
          console.error('[envdock] 侧边栏图标注册失败', error)
        }
        try {
          slots.inject('main', () => slots.register({ name: 'main', key: 'envdock' }, EnvDockPanel))
        } catch (error) {
          console.error('[envdock] 主面板注册失败', error)
        }
      },
    }
  },
})
