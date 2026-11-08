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
 *   2. 模型现在手里的命令工具是什么、接管成没成(一行状态 + 一行备注);
 *   3. 装了哪些工具链(每个工具一行,点路径即复制);
 *   4. 有没有问题(没问题只说一句「通过」,有问题一行摘要可展开)。
 *
 * 三条硬规则:
 *   · 常显区不放计数:计数只在展开后出现,或作为一句人话(「3 个会话」);
 *   · 只有「状态」配胶囊:终端选择、模式选择用 chip,状态用 statuschip/badge;
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
        // ── 头部 / 接管卡 ──
        terminal: '终端',
        autoShell: '自动',
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
        statusTakeover: '接管中',
        statusMixed: '{n} 个会话用宿主工具',
        statusConflict: '工具并存',
        statusHost: '未接管',
        statusSandbox: '沙箱',
        statusYield: '让路',
        statusAnomaly: '{n} 个会话异常',
        statusNoTool: '无命令工具',
        noCommandTool: '没探测到命令工具',
        noneLabel: '（无）',
        reuseByOther: '由其它插件提供',
        sessions: '会话',
        nSessions: '{n} 个会话',
        nDirect: '{n} 直连',
        nHost: '{n} 未接管',
        nYield: '{n} 让路',
        nSandbox: '{n} 沙箱',
        sessionsEmpty: '当前无会话',
        sessionKindTakeover: '直连',
        sessionKindHost: '未接管',
        sessionKindYield: '让路',
        sessionKindSandbox: '沙箱',
        sessionKindUnknown: '未知',
        sessionNoTool: '无命令工具',
        scopeAnomalyInvisible: '看不到命令工具',
        scopeAnomalyLeak: '宿主 {tools} 仍可见',
        scopeAnomalyFlagged: '对账异常',
        scopeConfined: '围栏',
        scopeHidden: '已挡 {names}',
        scopePolicyUnknown: '策略未知',
        noteLegacy: '接口是旧版构建，逐会话信息不可用；重启 dsh 后可显示',
        noteBroken: 'envd_shell 不可见，已遮挡 {names}',
        noteBrokenNoDeny: 'envd_shell 不可见，而且没有任何遮挡生效；重启 dsh 或重装 EnvDock 试试',
        noteUnrestrictable: '宿主工具 {names} 挡不掉，已让路',
        noteConflict: '宿主工具 {names} 挡不掉，与 envd_shell 并存',
        noteUnrestrictableHint: '这些工具注册在会话自己的层里，restrict 只过滤继承面；EnvDock 收起 envd_shell，保证一个会话只有一个命令工具。想改用 EnvDock 的终端接管，请在 dsh-ops 的设置里关掉它的 Publish Bash',
        noteBlocked: '{n} 个会话看不到 envd_shell，未遮挡宿主工具',
        noteLostDenies: '无主遮挡：{names} 已被挡住但撤销句柄丢失，重启 dsh 才能恢复',
        notePolicyUnknown: '沙箱策略未知，按有围栏保守处理',
        noteSandbox: '{n} 个会话被围栏，保留宿主工具',
        noteLastError: '最近错误',
        recognized: '已识别宿主工具',
        recognizedNone: '未识别到宿主工具',
        learnedTag: '自动识别',
        settings: '设置',
        modeLabel: '接管模式',
        takeoverAuto: '自动',
        takeoverOn: '总是接管',
        takeoverOff: '只给简报',
        sandboxTakeover: '沙箱下接管',
        sandboxDelegate: '委托执行',
        sandboxRefuse: '直接拒绝',
        sandboxDelegateHint: '围栏会话默认不接管（EnvDock 藏起 envd_shell，模型用宿主工具）。委托执行：万一执行层放行了 envd_shell，命令也只经带围栏的宿主执行器跑，绝不自己 spawn；直接拒绝：连这条兜底也关掉。',
        diag: '详情',
        diagHealthy: '对账正常',
        steady: '稳态',
        executor: '执行器',
        executorPlatform: '平台默认',
        syncRegister: '注册',
        syncDispose: '拆除',
        syncDeny: '遮挡',
        syncDrops: '释放',
        syncLostDenies: '无主遮挡',
        syncTicks: 'tick',
        syncDelegate: '委托',
        syncDelegateTries: '委托尝试',
        syncDelegateFailures: '委托失败',
        syncDelegateRefusals: '委托拒绝',
        syncDelegateRunnerFailures: 'runner 失败',
        syncDelegateAborts: '委托取消',
        syncGuardDenials: '守卫拒绝',
        syncYieldTicks: '让路轮次',
        syncDetections: '探测',
        syncGuardMissing: '拒绝守卫未注册',
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
        briefOff: '简报注入已关闭',
        never: '尚未探测',
        copyBrief: '复制',
        injectBrief: '把环境简报注入给 AI',
        allowLan: '允许局域网访问面板 API',
        allowLanHint: '只放行读取面板数据',
        subprocessOff: '宿主没有 subprocess 服务，版本探测会缺失',
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
        autoShell: 'Auto',
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
        statusTakeover: 'Takeover',
        statusMixed: '{n} sessions use the host tool',
        statusConflict: 'Tool clash',
        statusHost: 'Host tool',
        statusSandbox: 'Sandboxed',
        statusYield: 'Yielding',
        statusAnomaly: '{n} broken',
        statusNoTool: 'No tool',
        noCommandTool: 'No command tool detected',
        noneLabel: '(none)',
        reuseByOther: 'Provided by another plugin',
        sessions: 'Sessions',
        nSessions: '{n} sessions',
        nDirect: '{n} direct',
        nHost: '{n} host',
        nYield: '{n} yielded',
        nSandbox: '{n} sandboxed',
        sessionsEmpty: 'No sessions yet',
        sessionKindTakeover: 'direct',
        sessionKindHost: 'host',
        sessionKindYield: 'yielded',
        sessionKindSandbox: 'sandboxed',
        sessionKindUnknown: 'unknown',
        sessionNoTool: 'no tool',
        scopeAnomalyInvisible: 'no command tool',
        scopeAnomalyLeak: 'host {tools} still visible',
        scopeAnomalyFlagged: 'reconcile anomaly',
        scopeConfined: 'confined',
        scopeHidden: 'hid {names}',
        scopePolicyUnknown: 'policy unknown',
        noteLegacy: 'Old API build; per-session facts need a dsh restart',
        noteBroken: 'envd_shell is invisible; hid {names}',
        noteBrokenNoDeny: 'envd_shell is invisible and no restriction took effect; restart dsh or reinstall EnvDock',
        noteUnrestrictable: 'Cannot hide host {names}; yielding',
        noteConflict: 'Cannot hide host {names}; coexists with envd_shell',
        noteUnrestrictableHint: 'These tools live in the session own layer, which restrict cannot filter; EnvDock hides envd_shell so each session keeps exactly one command tool. To use the EnvDock terminal instead, turn off Publish Bash in the dsh-ops settings',
        noteBlocked: '{n} sessions cannot see envd_shell; host tools left visible',
        noteLostDenies: 'Orphan restriction: {names} is hidden but the disposer was lost; restart dsh to restore',
        notePolicyUnknown: 'Sandbox policy unknown; treated as confined',
        noteSandbox: '{n} sessions confined; host tools kept',
        noteLastError: 'Last error',
        recognized: 'Recognized host tools',
        recognizedNone: 'No host tool recognized',
        learnedTag: 'auto-detected',
        settings: 'Settings',
        modeLabel: 'Takeover mode',
        takeoverAuto: 'Auto',
        takeoverOn: 'Always',
        takeoverOff: 'Brief only',
        sandboxTakeover: 'Under sandbox',
        sandboxDelegate: 'Delegate',
        sandboxRefuse: 'Refuse',
        sandboxDelegateHint: 'Confined sessions keep the host tool by default (EnvDock hides envd_shell). Delegate: if the executor ever admits envd_shell, commands still run only through the confined host executor, never a direct spawn. Refuse: turn that fallback off as well.',
        diag: 'Details',
        diagHealthy: 'reconcile healthy',
        steady: 'steady',
        executor: 'executor',
        executorPlatform: 'platform default',
        syncRegister: 'registered',
        syncDispose: 'disposed',
        syncDeny: 'denied',
        syncDrops: 'lifted',
        syncLostDenies: 'orphan denies',
        syncTicks: 'ticks',
        syncDelegate: 'delegated',
        syncDelegateTries: 'delegate tries',
        syncDelegateFailures: 'delegate failures',
        syncDelegateRefusals: 'delegate refusals',
        syncDelegateRunnerFailures: 'runner failures',
        syncDelegateAborts: 'delegate aborts',
        syncGuardDenials: 'guard denials',
        syncYieldTicks: 'yield ticks',
        syncDetections: 'scans',
        syncGuardMissing: 'deny guard not registered',
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
        briefOff: 'Brief injection is off',
        never: 'Not scanned yet',
        copyBrief: 'Copy',
        injectBrief: 'Inject the environment brief into the agent',
        allowLan: 'Allow LAN access to the panel API',
        allowLanHint: 'Read-only access to panel data',
        subprocessOff: 'No subprocess service on the host; version detection is incomplete',
      },
    }

    // ───────────────────────────────────── 样式 ──
    // 只用 --dsw-* theme token;分节靠一条细线,只有接管卡带边框。
    const CSS = `
.envd-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:13px;line-height:1.5}
.envd-scroll{overflow:auto;display:flex;flex-direction:column;gap:18px;padding:18px 24px 34px;max-width:820px;width:100%;margin:0 auto;box-sizing:border-box;min-height:0}
.envd-scroll>*{flex:none}
.envd-grow{flex:1;min-width:8px}
.envd-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Mono",monospace}
.envd-muted{color:var(--dsw-alias-label-secondary)}

/* 头部:标题 + 默认终端 + 1 个状态 badge + 重新探测 */
.envd-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.envd-h1{margin:0;font-size:18px;font-weight:650;display:flex;align-items:center;gap:8px;letter-spacing:.1px;flex:none}
.envd-headline{font-size:12.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;min-width:0;max-width:100%;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis}
.envd-headline b{color:var(--dsw-alias-label-primary);font-weight:600}

/* badge / statuschip:整个面板只有「状态」用胶囊 */
.envd-badge,.envd-statuschip{display:inline-flex;align-items:center;gap:6px;height:20px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:650;white-space:nowrap;flex:none;max-width:100%;overflow:hidden;text-overflow:ellipsis;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.envd-badge .dot,.envd-statuschip .dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.envd-badge.ok,.envd-statuschip.ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}
.envd-badge.warn,.envd-statuschip.warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent)}
.envd-badge.bad,.envd-statuschip.bad{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent)}
.envd-badge.muted,.envd-statuschip.muted{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}

/* 按钮 */
.envd-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500;font-family:inherit;cursor:pointer;white-space:nowrap;flex:none;transition:background .12s ease,border-color .12s ease,color .12s ease}
.envd-btn:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.envd-btn:disabled{opacity:.45;cursor:default}
.envd-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.envd-btn.primary{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 42%,transparent);font-weight:600}
.envd-btn.primary:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.envd-btn.ghost{height:24px;padding:0 7px;border-color:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:500;border-radius:7px}
.envd-btn.ghost:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:transparent}

/* 接管卡:整个面板唯一带边框的块(置顶主信息,值得一个框) */
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
.envd-chips-sm .envd-chip{height:22px;padding:0 8px;font-size:11px;border-radius:6px}

/* 一行备注:常显区最多一行,不套盒子 */
.envd-notes{display:flex;flex-direction:column;gap:2px;min-width:0}
.envd-note{display:flex;gap:6px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);min-width:0;overflow-wrap:anywhere}
.envd-note .ic{flex:none;font-weight:700}
.envd-note.warn{color:var(--dsw-alias-state-warn-primary)}
.envd-note.bad{color:var(--dsw-alias-state-error-primary)}

/* 逐会话:一行一个,异常行染色 */
.envd-sessions{display:flex;flex-direction:column;gap:2px;min-width:0;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}
.envd-srow{display:flex;align-items:center;gap:8px;font-size:11.5px;min-width:0;flex-wrap:wrap;padding:1px 0}
.envd-srow.bad{color:var(--dsw-alias-state-error-primary)}
.envd-sdot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-label-secondary)}
.envd-sdot.ok{background:var(--dsw-alias-state-success-primary)}
.envd-sdot.warn{background:var(--dsw-alias-state-warn-primary)}
.envd-sdot.idle{background:var(--dsw-alias-state-idle-primary)}
.envd-sdot.bad{background:var(--dsw-alias-state-error-primary)}
.envd-sid{font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Mono",monospace}
.envd-skind{color:var(--dsw-alias-label-secondary)}
.envd-stool{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Mono",monospace;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;max-width:100%}
.envd-srow.bad .envd-skind,.envd-srow.bad .envd-stool{color:inherit}
.envd-sreason{margin-left:auto;font-size:11px;font-weight:600;white-space:nowrap;flex:0 1 auto;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis}

/* 已识别宿主工具 */
.envd-shelltools{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.envd-shellchip{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.envd-shellchip .envd-mono{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.envd-learned{color:var(--dsw-alias-brand-primary);font-weight:700}

/* 详情:默认折叠 */
.envd-diag-sum{font-size:11.5px;color:var(--dsw-alias-label-secondary);min-width:0;word-break:break-word}
.envd-diag-sum.danger{color:var(--dsw-alias-state-error-primary);font-weight:600}
.envd-diag-detail{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--dsw-alias-label-secondary);align-items:center;min-width:0;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}
.envd-diag-detail .w{color:var(--dsw-alias-state-warn-primary);min-width:0;word-break:break-word}
.envd-diag-detail .e{color:var(--dsw-alias-state-error-primary);min-width:0;word-break:break-word}
.envd-legacy{font-size:11.5px;color:var(--dsw-alias-state-warn-primary);line-height:1.5}

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

/* 底部:开关 + 安静的一行环境脚注 */
.envd-foot{display:flex;align-items:center;gap:18px;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l1);padding-top:11px;font-size:12px}
.envd-foot-item{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);min-width:0;max-width:100%}
.envd-copy-note{font-size:11.5px;color:var(--dsw-alias-label-secondary);min-width:0;overflow-wrap:anywhere}
.envd-footmeta{font-size:11px;color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

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
    const VOLATILE_STATS_KEYS = ['ticks', 'steadyTicks', 'steadySinceAt', 'lastAt', 'lastErrorAt', 'now', 'updatedAt']
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

    // ───────────────────────────────────── 纯函数:接管事实 ──
    /**
     * 把一个会话的终局翻成一句话的原因。返回 [] = 这个会话没问题。
     *
     * 「有问题」只有三种:模型拿不到任何命令工具、接管了但宿主工具仍可见、
     * 对账自己标了 anomaly。别的(宿主接管 / 让路 / 沙箱)都是设计内的终局。
     */
    function scopeReasons(sc, t) {
      const out = []
      if (!sc || typeof sc !== 'object') return out
      if (!sc.tool || sc.visible === false) out.push(t.scopeAnomalyInvisible)
      if (sc.kind === 'takeover' && Array.isArray(sc.hostTools) && sc.hostTools.length) out.push(fmtText(t.scopeAnomalyLeak, { tools: sc.hostTools.join(', ') }))
      if (Array.isArray(sc.leaked) && sc.leaked.length) out.push(fmtText(t.scopeAnomalyLeak, { tools: sc.leaked.join(', ') }))
      if (!out.length && sc.anomaly === true) out.push(t.scopeAnomalyFlagged)
      return out
    }
    const isBadScope = (sc, t) => scopeReasons(sc, t).length > 0 || (sc && sc.anomaly === true)

    /**
     * 会话 id 的短显示。
     *
     * dsh 的会话 id 是 `session-<uuid>`:直接 slice(0,8) 每一行都是 "session-",
     * 逐会话表就分不清谁是谁了。先去掉这个固定前缀,再截 8 位;完整 id 放 title。
     */
    function shortId(id) {
      const raw = String(id || '?')
      return (raw.startsWith('session-') ? raw.slice('session-'.length) : raw).slice(0, 8) || '?'
    }

    /** 极简模板:只替换 {key}。 */
    function fmtText(tpl, vars) {
      return String(tpl || '').replace(/\{(\w+)\}/g, (whole, key) => (vars && vars[key] !== undefined ? String(vars[key]) : whole))
    }

    /**
     * 会话终局 → 短词。
     *
     * `kind==='host'` 只说明「模型用宿主工具」,不说明原因;确定被围栏(或策略不可知)
     * 时它就是沙箱让路。聚合怎么算,逐会话行就怎么算 —— 同屏不许出现「沙箱 + 未接管」。
     */
    function scopeKindText(sc, t) {
      const kind = sc && sc.kind
      if (kind === 'host' || kind === 'sandbox-host') {
        return sc.confined === false ? t.sessionKindHost : t.sessionKindSandbox
      }
      return (
        {
          takeover: t.sessionKindTakeover,
          host: t.sessionKindHost,
          yield: t.sessionKindYield,
          'sandbox-host': t.sessionKindSandbox,
        }[kind] || t.sessionKindUnknown
      )
    }

    /** 终局 → 会话点颜色。 */
    function scopeTone(sc, t) {
      if (isBadScope(sc, t)) return 'bad'
      return sc.kind === 'takeover' ? 'ok' : sc.kind === 'host' ? 'idle' : 'warn'
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
      const [healthOpen, setHealthOpen] = useState(false)
      // 逐会话表的开关是三态:undefined = 跟随「有异常就自动展开」,true/false = 用户显式选择。
      // 只用一个布尔会在「异常自动展开」时让「收起」变成死按钮(点了没反应)。
      const [sessionsUser, setSessionsUser] = useState(undefined)
      const [settingsOpen, setSettingsOpen] = useState(false)
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
      // shellTakeover 只认这三个值;别的(旧值 / 脏值)一律归一成 auto,免得 chip 全都点不亮
      const takeoverMode = options.shellTakeover === 'takeover' || options.shellTakeover === 'off' ? options.shellTakeover : 'auto'
      // 沙箱下接管:只有 delegate / refuse 两个值,脏值按默认 delegate
      const sandboxTakeoverMode = options.sandboxTakeover === 'refuse' ? 'refuse' : 'delegate'
      const shell = (data && data.shell) || {}
      const platform = (data && data.platform) || null
      const pathInfo = (data && data.pathInfo) || null
      const missingPaths = pathInfo ? Number(pathInfo.missingCount) || (Array.isArray(pathInfo.missing) ? pathInfo.missing.length : 0) || 0 : 0
      const fmt = fmtText

      const ct = data && data.commandTool && typeof data.commandTool === 'object' ? data.commandTool : null
      const stats = data && data.syncStats && typeof data.syncStats === 'object' ? data.syncStats : null
      // 新旧判据必须是「字段在不在」:新服务端零会话给 scopes: [],当旧版会误判。
      const hasScopeField = Boolean(ct && Array.isArray(ct.scopes))
      const scopes = hasScopeField ? ct.scopes.filter((sc) => sc && typeof sc === 'object') : []
      const hasScopes = scopes.length > 0
      const badScopes = scopes.filter((sc) => isBadScope(sc, t))
      const nonTakeover = scopes.filter((sc) => sc.kind !== 'takeover')
      const kindCount = { takeover: 0, host: 0, yield: 0, 'sandbox-host': 0 }
      for (const sc of scopes) if (kindCount[sc.kind] !== undefined) kindCount[sc.kind] += 1

      const unrestrictable = stats && Array.isArray(stats.unrestrictable) ? stats.unrestrictable.filter(Boolean).map(String) : []
      const blockedScopes = stats && Array.isArray(stats.blockedScopes) ? stats.blockedScopes.filter(Boolean).map(String) : []
      const confinedCount = scopes.filter((sc) => sc.confined === true).length
      const denies = ct && Array.isArray(ct.denies) ? ct.denies.filter(Boolean).map(String) : []
      const sandboxInfo = data && data.sandbox && typeof data.sandbox === 'object' ? data.sandbox : null
      const policyUnknown = Boolean(sandboxInfo && sandboxInfo.policyKnown === false) || Boolean(ct && ct.sandbox === true && !hasScopeField && ct.sandboxPolicyKnown === false)
      const runtimeShellTools = (stats && Array.isArray(stats.runtimeShellTools) ? stats.runtimeShellTools : [])
        .map((item) =>
          typeof item === 'string'
            ? { name: item, family: '', learned: false }
            : { name: item && item.name ? String(item.name) : '', family: item && item.family ? String(item.family) : '', learned: Boolean(item && item.learned) },
        )
        .filter((item) => item.name)
      const lastError = stats && typeof stats.lastError === 'string' ? stats.lastError.trim() : ''

      // 一个终局词:异常 > 混合 > 全宿主管家 > 沙箱 > 让路 > 接管。这是整个面板唯一的状态结论。
      const kind = !ct
        ? 'none'
        : ct.reuse === true
          ? 'reuse'
          : badScopes.length
            ? 'anomaly'
            : hasScopes
              ? !nonTakeover.length
                ? 'takeover'
                : nonTakeover.length === scopes.length
                  ? nonTakeover.every((sc) => sc.kind === 'host')
                    ? // 全部用宿主工具 + 没有一个是「确定无围栏」= 沙箱部署(EnvDock 压根没注册),
                      // 说「沙箱」比说「未接管」更接近事实:模型用的是宿主那个带围栏的工具。
                      // 策略不可知(confined===null)也算沙箱:保守方向与执行层一致。
                      scopes.every((sc) => sc.confined !== false)
                      ? 'sandbox'
                      : 'host'
                    : nonTakeover.every((sc) => sc.kind === 'sandbox-host')
                      ? 'sandbox'
                      : 'yield'
                  : 'mixed'
              : ct.visible === false
                ? ct.sandbox === true
                  ? 'sandbox'
                  : // 既没围栏、工具又不可见:模型可能一个命令工具都没有,这是真故障
                    'broken'
                : // 旧版接口看不到逐会话终局:宿主工具挡不掉时,两个命令工具就是并存,
                  // 不能谎报「接管中」,也不能说成「让路」(EnvDock 的工具还看得见)。
                  unrestrictable.length && ct.takeover === true
                  ? ct.visible === true
                    ? 'conflict'
                    : 'yield'
                  : ct.takeover === true
                    ? 'takeover'
                    : 'host'
      const statusText =
        {
          takeover: t.statusTakeover,
          mixed: fmt(t.statusMixed, { n: nonTakeover.length }),
          conflict: t.statusConflict,
          host: t.statusHost,
          sandbox: t.statusSandbox,
          yield: t.statusYield,
          anomaly: fmt(t.statusAnomaly, { n: badScopes.length }),
          none: t.statusNoTool,
          broken: t.statusNoTool,
          reuse: t.reuseByOther,
        }[kind] || t.statusNoTool
      const statusTone = kind === 'anomaly' || kind === 'broken' ? 'bad' : kind === 'mixed' || kind === 'conflict' || kind === 'yield' ? 'warn' : kind === 'takeover' ? 'ok' : 'muted'

      // 模型手里的命令工具名字:接管时是 envd_shell,让路时是宿主的;并存时两个都列。
      const toolNames = hasScopes
        ? [...new Set(scopes.map((sc) => (sc.tool ? String(sc.tool) : '')).filter(Boolean))]
        : kind === 'conflict' && ct && ct.name
          ? [String(ct.name)].concat(unrestrictable)
          : kind === 'yield' && unrestrictable.length
            ? unrestrictable.slice()
            : ct && ct.name
              ? [String(ct.name)]
              : []
      const toolText = toolNames.length ? toolNames.join(' · ') : ''

      // 会话计数:一句人话,不是五个数字。
      const sessionBits = []
      if (hasScopes) {
        if (kindCount.takeover) sessionBits.push(fmt(t.nDirect, { n: kindCount.takeover }))
        if (kindCount.host) sessionBits.push(fmt(t.nHost, { n: kindCount.host }))
        if (kindCount.yield) sessionBits.push(fmt(t.nYield, { n: kindCount.yield }))
        if (kindCount['sandbox-host']) sessionBits.push(fmt(t.nSandbox, { n: kindCount['sandbox-host'] }))
      }
      const sessionsText = hasScopes
        ? [fmt(t.nSessions, { n: scopes.length })].concat(sessionBits).filter(Boolean).join(' · ')
        : hasScopeField
          ? t.sessionsEmpty
          : ''

      // 常显备注:只放「用户需要知道的事实」,每条一句话。
      const notes = []
      if (kind === 'broken') {
        notes.push(
          denies.length
            ? { tone: 'bad', text: fmt(t.noteBroken, { names: denies.join(', ') }) }
            : { tone: 'bad', text: t.noteBrokenNoDeny },
        )
      }
      if (ct && !hasScopeField) notes.push({ tone: 'warn', text: t.noteLegacy })
      if (unrestrictable.length) {
        // 新接口:只有真让路的会话才说「已让路」;旧接口:并存的才说「并存」。
        const yielded = hasScopes ? nonTakeover.some((sc) => sc.kind === 'yield') : ct && ct.visible === false
        if (yielded) notes.push({ tone: 'warn', text: fmt(t.noteUnrestrictable, { names: unrestrictable.join(', ') }), title: t.noteUnrestrictableHint })
        else notes.push({ tone: 'warn', text: fmt(t.noteConflict, { names: unrestrictable.join(', ') }), title: t.noteUnrestrictableHint })
      }
      if (blockedScopes.length) notes.push({ tone: 'warn', text: fmt(t.noteBlocked, { n: blockedScopes.length }) })
      const lostDenies = stats && Array.isArray(stats.lostDenies) ? stats.lostDenies.filter(Boolean).map(String) : []
      if (lostDenies.length) notes.push({ tone: 'warn', text: fmt(t.noteLostDenies, { names: lostDenies.join(', ') }) })
      if (ct && ct.sandbox === true && hasScopeField && confinedCount > 0) notes.push({ tone: 'muted', text: fmt(t.noteSandbox, { n: confinedCount }) })
      if (policyUnknown) notes.push({ tone: 'muted', text: t.notePolicyUnknown })
      if (lastError) notes.push({ tone: 'bad', text: t.noteLastError + ': ' + (lastError.length > 140 ? lastError.slice(0, 140) + '…' : lastError) })

      // 详情:一行摘要 + 展开后的计数。默认不占地方。
      // 摘要只说「硬故障」(异常会话 / 最近错误);常显备注已经说过的事实不再重复一遍。
      const diagSummary = (() => {
        const parts = []
        if (badScopes.length) parts.push(fmt(t.statusAnomaly, { n: badScopes.length }))
        if (lastError) parts.push(t.noteLastError)
        if (!parts.length) parts.push(t.diagHealthy)
        return parts.join(' · ')
      })()
      const diagTitleText = (() => {
        if (!stats) return ''
        const n = (v) => {
          const x = Number(v)
          return Number.isFinite(x) ? x : 0
        }
        const steady = stats.steadyNow === true && !stats.lastError && !unrestrictable.length && !blockedScopes.length
        const base = [
          t.syncRegister + ' ' + n(stats.registers) + '/' + n(stats.registerTries),
          t.syncDispose + ' ' + n(stats.disposes),
          t.syncDeny + ' ' + n(stats.denyApplies),
          t.syncDrops + ' ' + n(stats.denyDrops),
          t.syncTicks + ' ' + n(stats.ticks),
        ]
        const extra = [
          t.syncDelegate + ' ' + n(stats.delegateCalls) + '/' + n(stats.delegateTries),
          t.syncDelegateFailures + ' ' + n(stats.delegateFailures),
          t.syncDelegateRefusals + ' ' + n(stats.delegateRefusals),
          t.syncDelegateRunnerFailures + ' ' + n(stats.delegateRunnerFailures),
          t.syncDelegateAborts + ' ' + n(stats.delegateAborts),
          t.syncGuardDenials + ' ' + n(stats.guardDenials),
          t.syncYieldTicks + ' ' + n(stats.yieldTicks),
          t.syncLostDenies + ' ' + (Array.isArray(stats.lostDenies) ? stats.lostDenies.length : 0),
        ]
        if (stats.executorFamily) extra.push(t.executor + ' ' + String(stats.executorFamily) + (stats.executorFamilySource === 'platform' ? '(' + t.executorPlatform + ')' : ''))
        if (n(stats.detections) > 0) extra.push(t.syncDetections + ' ' + n(stats.detections) + '/' + n(stats.lastDetectMs) + 'ms')
        if (stats.guardReady === false) base.push(t.syncGuardMissing)
        return base.concat(extra, steady ? [t.steady] : []).filter(Boolean).join(' · ')
      })()

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

      // ── 终端选择:面板的主操作,常显 ──
      const shellChips = h(
        'div',
        { className: 'envd-chips', role: 'group', 'aria-label': t.terminal },
        h('button', { className: 'envd-chip' + (state.defaultShell === 'auto' ? ' on' : ''), 'aria-pressed': state.defaultShell === 'auto', onClick: () => post({ op: 'setShell', key: 'auto' }) }, t.autoShell),
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

      // ── 接管设置:默认收起,不跟状态抢地方 ──
      const modeChips = h(
        'div',
        { className: 'envd-chips envd-chips-sm', role: 'group', 'aria-label': t.modeLabel },
        [
          ['auto', t.takeoverAuto],
          ['takeover', t.takeoverOn],
          ['off', t.takeoverOff],
        ].map((pair) =>
          h('button', { key: pair[0], className: 'envd-chip' + (takeoverMode === pair[0] ? ' on' : ''), 'aria-pressed': takeoverMode === pair[0], onClick: () => post({ op: 'setOption', shellTakeover: pair[0] }) }, pair[1]),
        ),
      )
      const sandboxChips = h(
        'div',
        { className: 'envd-chips envd-chips-sm', role: 'group', 'aria-label': t.sandboxTakeover, title: t.sandboxDelegateHint },
        [
          ['delegate', t.sandboxDelegate],
          ['refuse', t.sandboxRefuse],
        ].map((pair) =>
          h('button', { key: pair[0], className: 'envd-chip' + (sandboxTakeoverMode === pair[0] ? ' on' : ''), 'aria-pressed': sandboxTakeoverMode === pair[0], onClick: () => post({ op: 'setOption', sandboxTakeover: pair[0] }) }, pair[1]),
        ),
      )
      const settingsBlock = settingsOpen
        ? h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h('div', { className: 'envd-row' }, h('span', { className: 'envd-tag' }, t.modeLabel), modeChips),
            h('div', { className: 'envd-row' }, h('span', { className: 'envd-tag' }, t.sandboxTakeover), sandboxChips),
          )
        : null

      // ── 逐会话:异常一定展开;正常默认收起 ──
      const scopeRows = scopes.length ? (badScopes.length ? badScopes.concat(scopes.filter((sc) => !isBadScope(sc, t))) : scopes) : []
      const showSessions = hasScopes && (sessionsUser === undefined ? badScopes.length > 0 : sessionsUser)
      const sessionList = showSessions
        ? h(
            'div',
            { className: 'envd-sessions' },
            scopeRows.map((sc, index) => {
              const reasons = scopeReasons(sc, t)
              const bad = reasons.length > 0 || sc.anomaly === true
              const extras = []
              if (Array.isArray(sc.hidden) && sc.hidden.length) extras.push(fmt(t.scopeHidden, { names: sc.hidden.filter(Boolean).map(String).join(', ') }))
              if (sc.confined === true) extras.push(t.scopeConfined)
              else if (sc.confined === null || sc.policyKnown === false) extras.push(t.scopePolicyUnknown)
              return h(
                'div',
                { className: 'envd-srow' + (bad ? ' bad' : ''), key: 'sc-' + String(sc.id || index), 'data-kind': String(sc.kind || 'unknown') },
                h('span', { className: 'envd-sdot ' + scopeTone(sc, t) }),
                h('span', { className: 'envd-sid', title: String(sc.id || '') }, shortId(sc.id)),
                h('span', { className: 'envd-skind', title: String(sc.id || '') }, scopeKindText(sc, t)),
                h('span', { className: 'envd-stool', title: sc.tool ? String(sc.tool) : t.sessionNoTool }, sc.tool ? String(sc.tool) : t.sessionNoTool),
                extras.length ? h('span', { className: 'envd-sub' }, extras.join(' · ')) : null,
                reasons.length ? h('span', { className: 'envd-sreason', title: reasons.join(' · ') }, reasons.join(' · ')) : null,
              )
            }),
          )
        : null

      // ── 已识别宿主工具:学习的结果,一行说完 ──
      const recognized = hasScopeField || runtimeShellTools.length
        ? h(
            'div',
            { className: 'envd-shelltools' },
            h('span', { className: 'envd-sub' }, t.recognized),
            runtimeShellTools.length
              ? runtimeShellTools.map((item) =>
                  h(
                    'span',
                    { className: 'envd-shellchip', key: item.name, title: item.name + (item.family ? ' · ' + item.family : '') + (item.learned ? ' · ' + t.learnedTag : '') },
                    h('span', { className: 'envd-mono' }, item.name),
                    item.family ? h('span', {}, ' · ' + item.family) : null,
                    item.learned ? h('span', { className: 'envd-learned', title: t.learnedTag }, ' ✦') : null,
                  ),
                )
              : h('span', { className: 'envd-sub' }, t.recognizedNone),
          )
        : null

      const diagBlock = diagOpen
        ? h(
            'div',
            { className: 'envd-diag-detail' },
            h('span', { key: 'dgc', title: diagTitleText }, diagTitleText || diagSummary),
            ...notes.map((note, i) => h('span', { key: 'dg' + i, className: note.tone === 'bad' ? 'e' : 'w' }, note.text)),
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

      // ── 头部 ──
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
        data ? badge(statusTone, statusText, { title: [toolText, hasScopes ? fmt(t.nSessions, { n: scopes.length }) : '', ...notes.map((n) => n.text)].filter(Boolean).join('\n') }) : null,
        h('span', { className: 'envd-grow' }),
        h('button', { className: 'envd-btn primary', disabled: busy, onClick: () => post({ op: 'refresh' }) }, busy ? t.detecting : t.refresh),
      )

      const body = [head]

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

        // ── 接管卡:终端选择 + 一句状态 + 备注 + (设置 | 会话 | 详情) ──
        body.push(
          h(
            'section',
            { className: 'envd-card', key: 'takeover' },
            h('div', { className: 'envd-row' }, h('span', { className: 'envd-tag' }, t.terminal), shellChips),
            shellForm,
            h(
              'div',
              { className: 'envd-row' },
              h('span', { className: 'envd-tag' }, t.command),
              h('span', { className: 'envd-statuschip ' + statusTone, title: diagTitleText || undefined }, h('span', { className: 'dot' }), statusText),
              toolText ? h('span', { className: 'envd-tool', title: toolText }, toolText) : null,
              sessionsText ? h('span', { className: 'envd-sub' }, sessionsText) : null,
              h('span', { className: 'envd-grow' }),
              hasScopes ? h('button', { className: 'envd-btn ghost', 'aria-expanded': showSessions, onClick: () => setSessionsUser(!showSessions) }, showSessions ? t.collapse : t.sessions) : null,
              h('button', { className: 'envd-btn ghost', 'aria-expanded': settingsOpen, onClick: () => setSettingsOpen((v) => !v) }, t.settings),
              h('button', { className: 'envd-btn ghost', 'aria-expanded': diagOpen, title: diagSummary, onClick: () => setDiagOpen((v) => !v) }, t.diag),
            ),
            notes.length
              ? h(
                  'div',
                  { className: 'envd-notes' },
                  notes.map((note, index) =>
                    h(
                      'div',
                      { className: 'envd-note' + (note.tone && note.tone !== 'muted' ? ' ' + note.tone : ''), key: 'note' + index, title: note.title },
                      h('span', { className: 'ic' }, note.tone === 'bad' ? '⛔' : note.tone === 'warn' ? '⚠' : '·'),
                      h('span', {}, note.text),
                    ),
                  ),
                )
              : null,
            settingsBlock,
            sessionList,
            recognized,
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

        // ── 环境简报:默认一行 ──
        body.push(
          sec(
            t.brief,
            [
              h(
                'div',
                { className: 'envd-row' },
                h('span', { className: 'envd-sub' }, options.injectBrief === true ? t.briefHint : t.briefOff),
                h('span', { className: 'envd-grow' }),
                h('button', { className: 'envd-btn ghost', onClick: () => copy(data.brief || '', 'brief') }, copied === 'brief' ? '✓ ' + t.copied : t.copyBrief),
                h('button', { className: 'envd-btn ghost', 'aria-expanded': briefOpen, onClick: () => setBriefOpen((v) => !v) }, briefOpen ? t.collapse : t.expand),
              ),
              briefOpen ? h('pre', { className: 'envd-pre envd-mono' }, options.injectBrief === true ? data.brief || t.never : t.briefOff) : null,
            ],
            null,
            'brief',
          ),
        )
      }

      // 底部:开关 + 复制反馈 + 安静的一行环境脚注
      // allowLan 必须在 if (data) 之外 —— 被 403 挡在门外时它是唯一的解法;
      // 简报注入开关只在拿到数据时显示:403 时 options 是空壳,显示一个假的「关闭」等于撒谎。
      const footMeta = [platform ? [platform.version, platform.arch, platform.host].filter(Boolean).join(' · ') : '', data && data.detectedAt ? t.updatedAt + ' ' + fmtTime(data.detectedAt) : '']
        .filter(Boolean)
        .join(' · ')
      body.push(
        h(
          'div',
          { className: 'envd-foot', key: 'foot' },
          data
            ? h(
                'div',
                { className: 'envd-foot-item' },
                h('span', {}, t.injectBrief),
                h('button', {
                  className: 'envd-switch' + (options.injectBrief === true ? ' on' : ''),
                  'aria-pressed': options.injectBrief === true,
                  'aria-label': t.injectBrief,
                  onClick: () => post({ op: 'setOption', injectBrief: options.injectBrief !== true }),
                }),
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
