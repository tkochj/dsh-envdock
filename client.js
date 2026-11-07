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
 * 设计取向:**少即是多**。
 *   · 一屏只回答 4 件事:是哪台机器、默认终端是什么、命令工具能不能用、有没有问题;
 *   · 不要嵌套盒子:分节之间只用一条细线,行与行之间只用间距;
 *   · 少用胶囊:只有「模型可见 / 不可见」这种**状态**才配一个标记,计数和版本用纯文本;
 *   · 低频操作(自定义终端 / 自定义工具 / 简报正文)默认收起,点开才占地方;
 *   · 健康时健康检查整节不出现,诊断计数收进状态标记的 title。
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
        subtitle: '工具链与终端',
        refresh: '重新探测',
        detecting: '探测中…',
        loading: '正在读取本机环境…',
        updatedAt: '更新于',
        system: '系统',
        defaultShell: '默认终端',
        customShell: '自定义终端',
        tools: '工具链',
        noTools: 'PATH 上没扫到 node / python / git。装好后点「重新探测」。',
        versions: '个版本',
        default: '当前',
        setDefault: '设为默认',
        copy: '复制路径',
        copied: '已复制',
        health: '健康检查',
        healthy: '没发现问题。',
        noIssue: '正常',
        brief: '环境简报',
        briefHint: '已注入给 AI',
        briefOff: '简报注入已关闭',
        options: '选项',
        injectBrief: '把环境简报注入给 AI',
        takeover: '终端接管',
        takeoverAuto: '自动',
        takeoverOn: '总是接管',
        takeoverOff: '只给简报',
        commandTool: '命令工具',
        byHost: '宿主自带',
        takenOver: 'EnvDock 已接管',
        takenOverHides: 'EnvDock 已接管（{shell} 已隐藏）',
        reuseByOther: '由其它插件提供',
        noCommandTool: '没探测到宿主命令工具',
        sandboxNoTakeover: '本会话被沙箱围栏，EnvDock 不接管（接管会绕过沙箱）',
        sandboxHint: 'dsh 的执行器会围栏，但「部署默认档」不等于「本会话策略」：只有本会话 resolve 出 danger-full-access 时才接管。有围栏的会话保留宿主自带的命令工具；想保住终端的价值，把「沙箱下接管」切到「委托执行」。',
        sandboxCapable: '宿主执行器会围栏',
        sandboxDefault: '部署默认',
        sandboxPolicyUnknown: '本会话策略未知',
        sandboxFree: '本会话无围栏，接管生效',
        sandboxScopeCount: '有围栏的会话 {n} 个',
        sandboxTakeover: '沙箱下接管',
        sandboxDelegate: '委托执行',
        sandboxRefuse: '直接拒绝',
        sandboxDelegateHint: '委托执行：命令经带围栏的宿主执行器跑，终端选择仍生效；直接拒绝：保留宿主命令工具，EnvDock 不接管。',
        cmdVisible: '模型可见',
        cmdInvisible: '不可见：会 UNKNOWN_TOOL',
        deniesLabel: '已遮挡',
        reconcile: '对账',
        diag: '接管诊断',
        syncRegisters: '注册',
        syncDisposes: '拆除',
        syncDenyApplies: '遮挡',
        syncLastError: '最近错误',
        steady: '稳态',
        syncUnrestrictable: '有宿主 shell 挡不掉',
        syncUnrestrictableHint: '这些名字在当前作用域里挡不掉（通常是作用域私有的 shell），会一直和 envd_shell 并列可见；插件重载后会再试一次',
        syncBlockedScopes: '有作用域没遮挡',
        syncBlockedScopesHint: '这些 agent 作用域里看不到 envd_shell，所以没有遮挡宿主 shell（宁可多一个工具，也不要零个）；一旦恢复可见会自动补上',
        syncHostOnly: '有会话的宿主 shell 挡不掉',
        syncHostOnlyHint: '这些会话的宿主命令工具注册在作用域私有层，restrict 过滤不到它；EnvDock 让自己的 envd_shell 让路，保证该会话仍然只有一个命令工具',
        allowLan: '允许局域网访问面板 API',
        allowLanHint: '只放行读取面板数据',
        customTool: '自定义工具',
        customHint: '可执行文件绝对路径，如 C:\\\\tools\\\\rg.exe',
        customShellArgs: '终端参数模板',
        customShellArgsHint: '用 {command} 占位，留空默认 -c {command}',
        name: '名称',
        labelPath: '路径',
        labelArgs: '参数',
        add: '添加',
        addFailed: '添加失败',
        remove: '移除',
        managers: '版本管理器',
        managersActive: '激活',
        managersVersions: '个版本',
        managersNone: '没探测到版本管理器',
        managersNoList: '在场，但没能列出已装版本',
        pathEntries: 'PATH 项',
        pathMissing: '个 PATH 目录不存在',
        stale: '路径已失效',
        error: '错误',
        warn: '警告',
        info: '提示',
        versionUnknown: '未知版本',
        subprocessOff: '宿主没有 subprocess 服务，版本探测会缺失',
        loadFailed: '读取失败',
        loadFailedHint: '/envdock-api 没响应，试试重启 dsh 或重装 EnvDock。',
        never: '尚未探测',
        groupRuntime: '运行时',
        groupPackage: '包管理',
        groupVcs: '版本控制',
        groupEnv: '环境管理',
        groupCustom: '自定义',
        toolCount: '{n} 个',
        countItems: '{n} 条',
        autoShell: '自动',
        copyBrief: '复制',
        expand: '展开',
        collapse: '收起',
        dismiss: '知道了',
        actionFailed: '操作失败',
        // 头部按会话汇总:全局 visible 只说明「EnvDock 的 envd_shell 注册成功」,
        // 不说明每个会话里模型真拿到的是谁 —— 混合状态必须按会话说。
        scopesSummary: '{n} 个会话用宿主工具',
        scopesHint: '头部按会话汇总:前缀是会话 id 前 8 位,后面是该会话里实际生效的命令工具。这些会话里模型用的是宿主自带的命令工具(宿主工具挡不掉 / 被沙箱围栏 / EnvDock 没接管成功)。',
        scopeKindTakeover: '直连接管',
        scopeKindHost: '未接管',
        scopeKindYield: '让路',
        scopeKindSandbox: '沙箱让路',
        scopeLine: '{id} · {kind} · {tool}',
        scopeHidden: '挡掉 {hidden}',
        // 三个计数的中文名:和 registers / disposes / denyApplies 并列,收进诊断 title。
        syncDelegateCalls: '委托',
        syncGuardDenials: '守卫拒绝',
        syncYieldTicks: '让路轮次',
        // 逐会话异常与旧版兜底:面板必须能说「有一个会话零命令工具」,不能只报汇总数字。
        scopesAnomaly: '{n} 个会话命令工具异常',
        scopesAnomalyHint: '这些会话里模型可能拿不到任何命令工具,或者接管后宿主工具仍然可见(两个命令工具)。逐会话原因见上面的清单。',
        scopesLegacyNote: '当前 /envdock-api 是旧版构建(没有逐会话 scopes):这里只能给汇总计数,无法逐个会话核对;重启 dsh 加载新版本后会列出每个会话。',
        scopeKindUnknown: '未知终局',
        scopeAnomalyInvisible: '⚠ 看不到命令工具',
        scopeAnomalyLeak: '⚠ 宿主 {tools} 仍可见',
        scopeConfined: '沙箱围栏',
        syncRegisterTries: '注册尝试',
        syncDelegateTries: '委托尝试',
        syncDelegateFailures: '委托失败',
        syncTicks: 'tick',
        syncDenyDrops: '释放遮挡',
        syncExecutorFamily: '执行器',
        syncScopeAnomalies: '命令工具异常会话',
        syncGuardMissing: '拒绝守卫未注册',
        // 简洁版:头部只有一行 + 1 个 badge;卡片负责「命令工具 / 接管」的可视化。
        statusTakeover: '接管中',
        statusYield: '让路',
        statusSandbox: '沙箱',
        statusHost: '未接管',
        statusAnomaly: '异常',
        cmdNotTakenOver: '未接管',
        takeoverCard: '命令工具 / 接管',
        perSession: '逐会话',
        sessionsMore: '还有 {n} 个',
        runtimeShellTools: '已识别宿主命令工具',
        runtimeShellToolsNone: '未识别到',
        learnedTag: '自动识别',
        executorPlatform: '平台默认',
        modeLabel: '接管模式',
        diagHealthy: '接管正常',
        diagAutoHint: '有问题时自动展开',
        versionChip: '{n} 个版本',
        copyPathHint: '点击复制路径',
        scopeAnomalyFlagged: '⚠ 对账判定异常',
      },
      en: {
        title: 'EnvDock',
        subtitle: 'Toolchains and terminals',
        refresh: 'Rescan',
        detecting: 'Scanning…',
        loading: 'Reading the local environment…',
        updatedAt: 'updated',
        system: 'System',
        defaultShell: 'Default terminal',
        customShell: 'Custom terminal',
        tools: 'Toolchains',
        noTools: 'No node / python / git on PATH. Install one, then rescan.',
        versions: 'versions',
        default: 'current',
        setDefault: 'Set as default',
        copy: 'Copy path',
        copied: 'Copied',
        health: 'Health',
        healthy: 'No issues found.',
        noIssue: 'OK',
        brief: 'Environment brief',
        briefHint: 'injected to the agent',
        briefOff: 'Brief injection is off',
        options: 'Options',
        injectBrief: 'Inject the environment brief',
        takeover: 'Shell takeover',
        takeoverAuto: 'Auto',
        takeoverOn: 'Always',
        takeoverOff: 'Brief only',
        commandTool: 'Command tool',
        byHost: 'host built-in',
        takenOver: 'taken over by EnvDock',
        takenOverHides: 'taken over by EnvDock ({shell} hidden)',
        reuseByOther: 'provided by another plugin',
        noCommandTool: 'No host command tool detected',
        sandboxNoTakeover: 'this session is sandbox-confined; EnvDock does not take over',
        sandboxHint: 'The executor CAN confine, but the deployment default is not this session’s policy: takeover happens only when this session resolves to danger-full-access. Confined sessions keep the host command tool; switch "sandbox takeover" to delegate to keep the terminal choice.',
        sandboxCapable: 'host executor can confine',
        sandboxDefault: 'deployment default',
        sandboxPolicyUnknown: 'this session’s policy is unknown',
        sandboxFree: 'this session is unconfined; takeover applies',
        sandboxScopeCount: '{n} confined session(s)',
        sandboxTakeover: 'Sandbox takeover',
        sandboxDelegate: 'Delegate',
        sandboxRefuse: 'Refuse',
        sandboxDelegateHint: 'Delegate: commands run through the confining host executor, so the terminal choice still works. Refuse: keep the host command tool and do not take over.',
        cmdVisible: 'model can see it',
        cmdInvisible: 'not visible: UNKNOWN_TOOL',
        deniesLabel: 'denied',
        reconcile: 'reconcile',
        diag: 'Takeover diagnostics',
        syncRegisters: 'registers',
        syncDisposes: 'disposes',
        syncDenyApplies: 'deny applies',
        syncLastError: 'last error',
        steady: 'steady',
        syncUnrestrictable: 'host shell that cannot be hidden',
        syncUnrestrictableHint: 'These names cannot be restricted in the current scope (usually a scope-local shell), so they stay visible next to envd_shell. Retried after a plugin reload.',
        syncBlockedScopes: 'scope(s) left undended',
        syncBlockedScopesHint: 'These agent scopes cannot see envd_shell, so the host shell was left visible there (two tools rather than none). It is hidden automatically once envd_shell becomes visible again.',
        syncHostOnly: 'host shell cannot be masked in some sessions',
        syncHostOnlyHint: 'These sessions register the host command tool in their own layer; restrict cannot filter it, so EnvDock lets its envd_shell step aside and keeps exactly one command tool.',
        allowLan: 'Allow LAN access to the panel API',
        allowLanHint: 'Panel data only',
        customTool: 'Custom tool',
        customHint: 'Absolute path, e.g. C:\\\\tools\\\\rg.exe',
        customShellArgs: 'Argument template',
        customShellArgsHint: 'Use {command} as the placeholder (default: -c {command})',
        name: 'Name',
        labelPath: 'Path',
        labelArgs: 'Args',
        add: 'Add',
        addFailed: 'Failed to add',
        remove: 'Remove',
        managers: 'Version managers',
        managersActive: 'active',
        managersVersions: 'versions',
        managersNone: 'No version manager detected',
        managersNoList: 'present, but could not list versions',
        pathEntries: 'PATH entries',
        pathMissing: 'PATH directories missing',
        stale: 'path is gone',
        error: 'error',
        warn: 'warn',
        info: 'info',
        versionUnknown: 'unknown',
        subprocessOff: 'The host has no subprocess service; version detection is incomplete',
        loadFailed: 'Failed to load',
        loadFailedHint: '/envdock-api did not answer. Try restarting dsh.',
        never: 'not detected yet',
        groupRuntime: 'Runtime',
        groupPackage: 'Package managers',
        groupVcs: 'Version control',
        groupEnv: 'Environment',
        groupCustom: 'Custom',
        toolCount: '{n}',
        countItems: '{n}',
        autoShell: 'Auto',
        copyBrief: 'Copy',
        expand: 'Expand',
        collapse: 'Collapse',
        dismiss: 'Got it',
        actionFailed: 'Action failed',
        // Header aggregates per session: the global visible flag only says EnvDock’s envd_shell registered.
        scopesSummary: '{n} session(s) use the host tool',
        scopesHint: 'Aggregated per session: the prefix is the first 8 characters of the session id, followed by the command tool actually in effect there. In these sessions the model runs the host’s own command tool (host tool cannot be masked / sandbox-confined / takeover failed).',
        scopeKindTakeover: 'direct takeover',
        scopeKindHost: 'not taken over',
        scopeKindYield: 'stepped aside',
        scopeKindSandbox: 'sandboxed',
        scopeLine: '{id} · {kind} · {tool}',
        scopeHidden: 'hides {hidden}',
        syncDelegateCalls: 'delegated',
        syncGuardDenials: 'guard denials',
        syncYieldTicks: 'yield rounds',
        scopesAnomaly: '{n} session(s) with a broken command tool',
        scopesAnomalyHint: 'In these sessions the model may have no command tool at all, or a host tool is still visible after takeover (two tools). See the per-session list above for the reason.',
        scopesLegacyNote: 'This /envdock-api is an older build (no per-session scopes): only aggregate counts are available, so sessions cannot be verified one by one. Restart dsh with the new version to list each session here.',
        scopeKindUnknown: 'unknown outcome',
        scopeAnomalyInvisible: '⚠ no command tool visible',
        scopeAnomalyLeak: '⚠ host {tools} still visible',
        scopeConfined: 'sandbox-confined',
        syncRegisterTries: 'register tries',
        syncDelegateTries: 'delegate tries',
        syncDelegateFailures: 'delegate failures',
        syncTicks: 'ticks',
        syncDenyDrops: 'mask releases',
        syncExecutorFamily: 'executor',
        syncScopeAnomalies: 'broken command-tool sessions',
        syncGuardMissing: 'refusal guard missing',
        statusTakeover: 'takeover',
        statusYield: 'stepped aside',
        statusSandbox: 'sandboxed',
        statusHost: 'not taken over',
        statusAnomaly: 'broken',
        cmdNotTakenOver: 'not taken over',
        takeoverCard: 'Command tool / takeover',
        perSession: 'per session',
        sessionsMore: '{n} more',
        runtimeShellTools: 'recognized host command tools',
        runtimeShellToolsNone: 'none detected',
        learnedTag: 'auto-detected',
        executorPlatform: 'platform default',
        modeLabel: 'takeover mode',
        diagHealthy: 'takeover healthy',
        diagAutoHint: 'expands automatically on problems',
        versionChip: '{n} versions',
        copyPathHint: 'click to copy path',
        scopeAnomalyFlagged: '⚠ flagged by reconcile',
      },
    }

    // 只用 --dsw-* theme token;分节靠一条细线,不靠盒子。
    const CSS = `
.envd-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:13px;line-height:1.5}
.envd-scroll{overflow:auto;display:flex;flex-direction:column;gap:26px;padding:22px 28px 64px;max-width:860px;width:100%;margin:0 auto;box-sizing:border-box;min-height:0}
.envd-scroll>*{flex:none}

/* 头部:压缩成一行(标题 + 终端/状态短语 + 1 个 badge + 问题数 + 刷新) */
.envd-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.envd-h1{margin:0;font-size:19px;font-weight:650;display:flex;align-items:center;gap:8px;letter-spacing:.1px;flex:none}
.envd-headline{font-size:12.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;min-width:0}
.envd-headline b{color:var(--dsw-alias-label-primary);font-weight:600}
.envd-attn{color:var(--dsw-alias-state-warn-primary);font-weight:600}

/* 分节:没有卡片框,只有标题 + 一条细线 */
.envd-sec{display:flex;flex-direction:column;gap:12px}
.envd-sec-h{display:flex;align-items:baseline;gap:8px}
.envd-sec-h h2{margin:0;font-size:13px;font-weight:650}
.envd-sec-h .n{font-size:11.5px;color:var(--dsw-alias-label-secondary);font-weight:400}
.envd-sec-h .tail{margin-left:auto;display:flex;gap:6px;align-items:center}
.envd-sec-b{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px}

/* 状态标记:整个面板只有这一类用胶囊 */
.envd-badge{display:inline-flex;align-items:center;gap:6px;height:20px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:650;white-space:nowrap;flex:none}
.envd-badge .dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.envd-badge.ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}
.envd-badge.bad{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent)}
/* warn:有会话没走 EnvDock 的命令工具 —— 不是错误(设计如此),但也不是「全绿」 */
.envd-badge.warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent)}
/* muted:EnvDock 没接管,模型用的是宿主自带的工具(事实,不是故障) */
.envd-badge.muted{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}

/* 按钮:只有「有边框」和「无边框」两种,行内动作用 ghost */
.envd-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500;font-family:inherit;cursor:pointer;white-space:nowrap;flex:none;transition:background .12s ease,border-color .12s ease,color .12s ease}
.envd-btn:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.envd-btn:disabled{opacity:.45;cursor:default}
.envd-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.envd-btn.primary{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 42%,transparent);font-weight:600}
.envd-btn.primary:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.envd-btn.ghost{height:24px;padding:0 7px;border-color:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:500;border-radius:7px}
.envd-btn.ghost:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:transparent}

/* 终端 chips */
.envd-chips{display:flex;gap:6px;flex-wrap:wrap}
.envd-chip{display:inline-flex;align-items:center;gap:5px;height:27px;padding:0 11px;border:1px solid var(--dsw-alias-border-l1);background:transparent;border-radius:7px;font-size:12px;font-family:inherit;cursor:pointer;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none;transition:background .12s ease,border-color .12s ease,color .12s ease}
.envd-chip:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.envd-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.envd-chip.on{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);font-weight:600}
.envd-chip .v{opacity:.6;font-size:11px}

/* 行 */
.envd-item{display:flex;flex-direction:column;gap:3px;min-width:0}
.envd-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.envd-name{font-weight:600;font-size:13px}
.envd-ver{font-size:11.5px;color:var(--dsw-alias-brand-primary);font-weight:600;flex:none}
.envd-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary)}
.envd-dot.idle{background:var(--dsw-alias-state-idle-primary)}
.envd-grow{flex:1;min-width:8px}
.envd-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Mono",monospace}
.envd-path{font-size:11.5px;color:var(--dsw-alias-label-secondary);word-break:break-all;line-height:1.45}
.envd-meta{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--dsw-alias-label-secondary);align-items:center;min-width:0}

/* 多版本:不套盒子;三列网格(版本 / 路径 / 动作)同行对齐。
   宽度上限是故意的:不加的话动作列会被推到整行最右端,和它那行路径隔着一大段空白。 */
.envd-vlist{display:flex;flex-direction:column;gap:2px;padding-left:12px;min-width:0;max-width:620px}
.envd-vrow{display:grid;grid-template-columns:82px minmax(0,1fr) 84px;align-items:center;gap:10px;font-size:11.5px;min-width:0;padding:1px 0}
.envd-vrow .vv{font-weight:600;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.envd-vrow.on .vv{color:var(--dsw-alias-brand-primary)}
.envd-vrow .vp{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.envd-vrow .act{justify-self:end;display:flex;justify-content:flex-end;align-items:center;min-width:0}
.envd-cur{font-size:11px;color:var(--dsw-alias-brand-primary);white-space:nowrap}

/* 分组标题:小、淡、不大写 */
.envd-group{display:flex;flex-direction:column;gap:2px;min-width:0}
.envd-group-h{font-size:11px;color:var(--dsw-alias-label-secondary);padding:8px 0 3px}
.envd-group:first-child .envd-group-h{padding-top:0}

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

.envd-switch{position:relative;width:34px;height:19px;border-radius:999px;background:var(--dsw-alias-border-l2);cursor:pointer;transition:background .15s ease;flex:none;border:none;padding:0}
.envd-switch::after{content:"";position:absolute;top:3px;left:3px;width:13px;height:13px;border-radius:50%;background:var(--dsw-alias-label-primary);transition:transform .15s ease}
.envd-switch.on{background:var(--dsw-alias-brand-primary)}
.envd-switch.on::after{transform:translateX(15px);background:var(--dsw-alias-bg-base)}
.envd-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}

/* 诊断:只在有问题时出现 */
.envd-diag{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11.5px;color:var(--dsw-alias-label-secondary);align-items:center}
.envd-diag .w{color:var(--dsw-alias-state-warn-primary);min-width:0;word-break:break-word}
.envd-diag .e{color:var(--dsw-alias-state-error-primary);min-width:0;word-break:break-word}

/* 健康问题:一行一条,左边一个点,不套盒子 */
.envd-issues{display:flex;flex-direction:column;gap:7px}
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
.envd-err{display:flex;flex-direction:column;gap:6px;font-size:12.5px;line-height:1.55;padding:10px 12px;border-radius:9px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 38%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.envd-err .h{font-weight:600;color:var(--dsw-alias-state-error-primary)}
.envd-loading{display:flex;flex-direction:column;gap:10px}
.envd-skel{height:13px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);animation:envd-pulse 1.4s ease-in-out infinite}
@keyframes envd-pulse{0%,100%{opacity:.55}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.envd-skel{animation:none}}

/* ── 接管卡片:整个面板唯一带边框的块(置顶主信息,值得一个框) ── */
.envd-card{display:flex;flex-direction:column;gap:11px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:13px 15px}
.envd-card-h{display:flex;align-items:center;gap:8px;min-width:0}
.envd-card-h h2{margin:0;font-size:12.5px;font-weight:650}
.envd-card-b{display:flex;flex-direction:column;gap:10px;min-width:0}
.envd-statusline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.envd-statuschip{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:650;white-space:nowrap;flex:none;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.envd-statuschip .dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.envd-statuschip.ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}
.envd-statuschip.warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent)}
.envd-statuschip.bad{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent)}
.envd-muted{color:var(--dsw-alias-label-secondary)}
.envd-tool{font-size:12px;font-weight:600}
.envd-mini-label{font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:500;flex:none}
.envd-chips-sm .envd-chip{height:22px;padding:0 8px;font-size:11px;border-radius:6px}

/* 逐会话:一行一个会话,异常行整体红 */
.envd-sessions{display:flex;flex-direction:column;gap:2px;min-width:0}
.envd-srow{display:flex;align-items:center;gap:8px;font-size:11.5px;min-width:0;padding:1px 0}
.envd-srow.bad{color:var(--dsw-alias-state-error-primary)}
.envd-sdot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-label-secondary)}
.envd-sdot.ok{background:var(--dsw-alias-state-success-primary)}
.envd-sdot.warn{background:var(--dsw-alias-state-warn-primary)}
.envd-sdot.idle{background:var(--dsw-alias-state-idle-primary)}
.envd-sdot.bad{background:var(--dsw-alias-state-error-primary)}
.envd-sid{font-weight:600}
.envd-skind{color:var(--dsw-alias-label-secondary)}
.envd-stool{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.envd-srow.bad .envd-skind,.envd-srow.bad .envd-stool{color:inherit}
.envd-sreason{margin-left:auto;font-size:11px;font-weight:600;white-space:nowrap;flex:none}

/* 已识别宿主命令工具 chips */
.envd-shelltools{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.envd-shellchip{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.envd-shellchip .envd-mono{color:var(--dsw-alias-label-primary)}
.envd-learned{color:var(--dsw-alias-brand-primary);font-weight:700}

/* 诊断:默认折叠,有问题自动展开一行红摘要 */
.envd-diagbox{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;min-width:0}
.envd-diagrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.envd-diag-sum{font-size:11.5px;color:var(--dsw-alias-label-secondary);min-width:0;word-break:break-word}
.envd-diag-sum.danger{color:var(--dsw-alias-state-error-primary);font-weight:600}
.envd-diag-detail{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--dsw-alias-label-secondary);align-items:center;min-width:0}
.envd-diag-detail .w{color:var(--dsw-alias-state-warn-primary);min-width:0;word-break:break-word}
.envd-diag-detail .e{color:var(--dsw-alias-state-error-primary);min-width:0;word-break:break-word}
.envd-legacy{font-size:11.5px;color:var(--dsw-alias-state-warn-primary);line-height:1.5}

/* 工具链:路径本身可点(复制),不再单占一个按钮 */
.envd-pathbtn{display:block;max-width:100%;text-align:left;background:transparent;border:none;padding:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Mono",monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;min-width:0}
.envd-pathbtn:hover{color:var(--dsw-alias-brand-primary);text-decoration:underline}
.envd-pathbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}

/* 折叠行(健康检查 / 简报):一行就够 */
.envd-foldrow{display:flex;align-items:center;gap:8px;width:100%;background:transparent;border:none;padding:0;font-size:12px;font-family:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;min-width:0;text-align:left}
.envd-foldrow:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:6px}

/* 底部一行紧凑开关 */
.envd-foot{display:flex;align-items:center;gap:18px;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px;font-size:12px}
.envd-foot-item{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary)}
`

    // ───────────────────────────────────── 数据 ──
    let localeService = null

    // 宿主探测本机环境偶尔会卡住:没有上限的话面板会一直转圈,请求永远不回来。
    const API_TIMEOUT_MS = 15000
    // 面板静默轮询间隔:宿主会在会话/工具表变化后自己重算,面板跟着拉一份就够。
    const POLL_MS = 15000

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

    // ───────────────────────────────────── 主面板 ──
    function EnvDockPanel() {
      const [t, setT] = useState(DICT.zh)
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [opError, setOpError] = useState('')
      const [busyCount, setBusyCount] = useState(0)
      const [copied, setCopied] = useState('')
      const [shellPath, setShellPath] = useState('')
      const [shellLabel, setShellLabel] = useState('')
      const [shellArgs, setShellArgs] = useState('')
      const [shellFormOpen, setShellFormOpen] = useState(false)
      const [briefOpen, setBriefOpen] = useState(false)
      const [healthOpen, setHealthOpen] = useState(false)
      const [sessionsOpen, setSessionsOpen] = useState(false)
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
            const encoded = JSON.stringify(next)
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

      const copy = useCallback(async (value, tag) => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(tag)
          setTimeout(() => mounted.current && setCopied(''), 1400)
        } catch {}
      }, [])

      const tools = (data && data.tools) || []
      const issues = (data && data.issues) || []
      const terminals = (data && data.terminals) || []
      const managers = (data && (data.versionManagers || data.managers)) || []
      const state = (data && data.state) || { options: {}, customTools: [] }
      const options = state.options || {}
      // shellTakeover 只认这三个值;别的(旧值 / 脏值)一律归一成 auto,免得三个 chip 全都点不亮
      const takeoverMode = options.shellTakeover === 'takeover' || options.shellTakeover === 'off' ? options.shellTakeover : 'auto'
      // 沙箱下接管:只有 delegate / refuse 两个值,脏值按默认 delegate
      const sandboxTakeoverMode = options.sandboxTakeover === 'refuse' ? 'refuse' : 'delegate'
      const shell = (data && data.shell) || {}
      const platform = (data && data.platform) || null
      const missingPaths = data && data.pathInfo ? data.pathInfo.missingCount || (data.pathInfo.missing || []).length || 0 : 0
      const fmt = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (whole, key) => (vars && vars[key] !== undefined ? String(vars[key]) : whole))

      const groupLabel = (g) =>
        ({
          runtime: t.groupRuntime,
          package: t.groupPackage,
          vcs: t.groupVcs,
          env: t.groupEnv,
          custom: t.groupCustom,
          managers: t.managers,
        })[g] || g

      const groups = useMemo(() => {
        const order = ['runtime', 'package', 'vcs', 'env', 'custom']
        const buckets = new Map()
        for (const tool of tools) {
          const g = order.includes(tool.group) ? tool.group : 'custom'
          if (!buckets.has(g)) buckets.set(g, [])
          buckets.get(g).push(tool)
        }
        const out = order.filter((g) => buckets.has(g)).map((g) => ({ group: g, items: buckets.get(g), kind: 'tool' }))
        if (managers.length) out.push({ group: 'managers', items: managers, kind: 'manager' })
        return out
      }, [tools, managers])

      const ct = data && data.commandTool
      const ctVisible = ct && typeof ct.visible === 'boolean' ? ct.visible : null
      const denies = ct && Array.isArray(ct.denies) ? ct.denies.filter(Boolean).map((x) => String(x)) : []
      // 沙箱两层说:能力位(执行器会不会围栏)+ 部署默认档 + 本会话有效策略。
      // 只报能力位就是这次修的谎:部署默认 workspace-write 不等于本会话被围栏。
      const ctSandbox = Boolean(ct && ct.sandbox === true)
      const sandboxInfo = (data && data.sandbox) || null
      const sandboxParts = []
      if (ctSandbox) {
        sandboxParts.push(t.sandboxCapable)
        if (sandboxInfo && sandboxInfo.defaultMode) sandboxParts.push(t.sandboxDefault + ' ' + sandboxInfo.defaultMode)
        if (ct.sandboxConfined === true) sandboxParts.push(t.sandboxNoTakeover)
        else if (ct.sandboxConfined === false) sandboxParts.push(t.sandboxFree)
        else sandboxParts.push(t.sandboxPolicyUnknown)
      }
      const ctSub = ctSandbox
        ? sandboxParts.join(' · ')
        : ctVisible === false && denies.length
          ? t.deniesLabel + ' ' + denies.join(', ')
          : !ct
            ? t.noCommandTool
            : ct.reuse
              ? t.reuseByOther
              : ct.takeover
                ? data.shippedShell
                  ? fmt(t.takenOverHides, { shell: data.shippedShell })
                  : t.takenOver
                : ct.name
                  ? t.byHost
                  : t.noCommandTool

      // ── 小零件 ──
      const badge = (kind, text, extra) => h('span', Object.assign({ className: 'envd-badge ' + kind }, extra || {}), h('span', { className: 'dot' }), text)
      const section = (title, body, tail, key) =>
        h(
          'section',
          { className: 'envd-sec', key: key || title },
          h('div', { className: 'envd-sec-h' }, h('h2', {}, title), tail || null),
          h('div', { className: 'envd-sec-b' }, body),
        )
      const field = (label, klass, input) => h('label', { className: 'envd-f ' + (klass || '') }, h('span', { className: 'envd-label' }, label), input)
      const ghostAdd = (text, onClick) => h('button', { className: 'envd-btn ghost', onClick, style: { alignSelf: 'flex-start' } }, '+ ' + text)

      // ── 行 ──
      // 工具行:名称 + 默认版本 + 一行省略路径(点路径即复制);多版本才展开候选,平时不占地方。
      const toolRow = (tool) => {
        const versions = tool.versions || []
        const copiedNow = copied === tool.key + ':path'
        const expanded = openVersions[tool.key] === true
        const path = tool.defaultPath || ''
        return h(
          'div',
          { className: 'envd-item', key: tool.key },
          h(
            'div',
            { className: 'envd-line' },
            h('span', { className: 'envd-dot' + (tool.defaultVersion ? '' : ' idle'), title: tool.defaultVersion ? t.default : t.versionUnknown }),
            h('span', { className: 'envd-name' }, tool.label),
            h('span', { className: 'envd-ver' }, tool.defaultVersion ? 'v' + tool.defaultVersion : t.versionUnknown),
            versions.length > 1
              ? h(
                  'button',
                  { className: 'envd-btn ghost envd-versionchip', 'aria-expanded': expanded, onClick: () => setOpenVersions((prev) => Object.assign({}, prev, { [tool.key]: !expanded })) },
                  fmt(t.versionChip, { n: versions.length }),
                )
              : null,
            tool.custom ? h('button', { className: 'envd-btn ghost', onClick: () => post({ op: 'removeCustomTool', key: tool.key }) }, t.remove) : null,
          ),
          path
            ? h(
                'button',
                { className: 'envd-pathbtn', title: t.copyPathHint + ': ' + path, 'aria-label': t.copyPathHint + ': ' + path, onClick: () => copy(path, tool.key + ':path') },
                copiedNow ? '✓ ' + t.copied : path,
              )
            : null,
          expanded && versions.length
            ? h(
                'div',
                { className: 'envd-vlist' },
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
              )
            : null,
        )
      }

      const managerRow = (mgr) =>
        h(
          'div',
          { className: 'envd-item', key: mgr.key },
          h(
            'div',
            { className: 'envd-line' },
            h('span', { className: 'envd-name' }, mgr.label),
            mgr.active ? h('span', { className: 'envd-ver' }, t.managersActive + ' ' + mgr.active) : null,
            (mgr.versions || []).length ? h('span', { className: 'envd-cur' }, (mgr.versions || []).length + ' ' + t.managersVersions) : null,
            h('span', { className: 'envd-grow' }),
            h('span', { className: 'envd-path envd-mono', title: mgr.command || (mgr.roots && mgr.roots[0]) || '' }, mgr.command || (mgr.roots && mgr.roots[0]) || ''),
          ),
          (mgr.versions || []).length
            ? h(
                'div',
                { className: 'envd-meta' },
                mgr.versions.map((v) => h('span', { key: v.name, className: 'envd-mono', style: v.active ? { color: 'var(--dsw-alias-brand-primary)' } : undefined }, v.name + (v.active ? ' ←' : ''))),
              )
            : mgr.listed
              ? null
              : h('div', { className: 'envd-path' }, t.managersNoList),
        )

      const issueRow = (issue, index) =>
        h(
          'div',
          { className: 'envd-issue ' + (issue.level || 'info'), key: issue.title + index },
          h('span', { className: 'dot' }),
          h('div', { className: 'tx' }, h('b', {}, issue.title), h('span', {}, issue.detail || '')),
        )

      // ── 终端选择 ──
      const shellChips = h(
        'div',
        { className: 'envd-chips', role: 'group', 'aria-label': t.defaultShell },
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
                onClick: () => post({ op: 'setShell', key: term.key }),
                title: term.path,
              },
              term.label,
              term.version ? h('span', { className: 'v' }, 'v' + term.version) : null,
            ),
          ),
      )

      // ── 选项:allowLan 必须脱离 if (data) ──
      // 非 loopback 打开面板时 GET 直接 403,数据永远读不到;而「允许局域网访问」正是唯一的解法,
      // 所以这一行在没数据时也要能点到(下面两份互斥,不会重复渲染)。
      const allowLanSwitch = h(
        'div',
        { className: 'envd-foot-item' },
        h('span', { title: t.allowLanHint }, t.allowLan),
        h('button', {
          className: 'envd-switch' + (options.allowLan === true ? ' on' : ''),
          'aria-pressed': options.allowLan === true,
          'aria-label': t.allowLan,
          onClick: () => post({ op: 'setOption', allowLan: options.allowLan !== true }),
        }),
      )

      // ── 接管诊断:默认折叠;只在真有问题时自动展开一行红摘要 ──
      // 事实来自 scopes(逐会话)+ syncStats(计数)。沙箱只在「有围栏会话 / 本会话被围栏 /
      // 策略未知」时才说 —— 光有围栏能力是常态,不该让健康机器挂一行 ⚠。
      const diagFacts = () => {
        const sb = sandboxInfo && typeof sandboxInfo === 'object' ? sandboxInfo : null
        const items = []
        const confinedCount = ctScopes.filter((x) => x.confined === true).length
        const policyUnknown = Boolean(sb && sb.policyKnown === false)
        if (ctSandbox && (confinedCount > 0 || ct.sandboxConfined === true || policyUnknown)) {
          const parts = [sb && sb.capable ? t.sandboxCapable : t.sandboxNoTakeover]
          if (sb && sb.defaultMode) parts.push(t.sandboxDefault + ' ' + sb.defaultMode)
          if (ctScopes.length) parts.push(fmt(t.sandboxScopeCount, { n: confinedCount }))
          else parts.push(t.sandboxPolicyUnknown)
          items.push({ level: 'warn', text: parts.join(' · '), title: t.sandboxHint })
        }
        if (anomalySessions.length) {
          items.push({ level: 'error', text: t.syncScopeAnomalies + ': ' + anomalySessions.map((x) => String(x.id || '').slice(0, 8)).join(', '), title: t.scopesAnomalyHint })
        }
        if (stats && Array.isArray(stats.unrestrictable) && stats.unrestrictable.length) {
          items.push({ level: 'warn', text: t.syncUnrestrictable + ': ' + stats.unrestrictable.map(String).join(', '), title: t.syncUnrestrictableHint })
        }
        if (stats && Array.isArray(stats.blockedScopes) && stats.blockedScopes.length) {
          items.push({ level: 'warn', text: t.syncBlockedScopes + ': ' + stats.blockedScopes.map((x) => String(x).slice(0, 8)).join(', '), title: t.syncBlockedScopesHint })
        }
        const lastError = stats && typeof stats.lastError === 'string' ? stats.lastError.trim() : ''
        const errorAge = stats && Number(stats.lastErrorAt) > 0 ? Math.max(0, Math.round((Date.now() - Number(stats.lastErrorAt)) / 1000)) : 0
        // 自动展开的只有「真问题」:异常会话 / 挡不掉的宿主 shell / 没遮挡的作用域 / 最近错误。
        // 沙箱那一行是事实说明(有围栏会话),不该把诊断区自动顶开、也不染红。
        const auto =
          anomalySessions.length > 0 ||
          Boolean(lastError) ||
          Boolean(stats && Array.isArray(stats.unrestrictable) && stats.unrestrictable.length) ||
          Boolean(stats && Array.isArray(stats.blockedScopes) && stats.blockedScopes.length)
        const redBits = []
        if (anomalySessions.length) redBits.push(fmt(t.scopesAnomaly, { n: anomalySessions.length }))
        if (lastError) redBits.push(t.syncLastError + (errorAge > 0 ? '(' + errorAge + 's)' : ''))
        const summary = auto ? redBits.join(' · ') : items.length ? items.map((x) => x.text).join(' · ') : t.diagHealthy
        return { auto, danger: auto, summary, items, lastError, errorAge }
      }
      const diagTitle = (s) => {
        if (!s || typeof s !== 'object') return undefined
        const n = (v) => {
          const x = Number(v)
          return Number.isFinite(x) ? x : 0
        }
        // steadyNow 是「本 tick 是否稳态」;steadyTicks 只是累计量,拿累计量当状态会让 title 永远写「稳态」。
        const steady = s.steadyNow === true && !s.lastError && !(s.unrestrictable || []).length && !(s.blockedScopes || []).length
        const base = [
          t.reconcile + ': ' + t.syncRegisters + ' ' + n(s.registers) + '/' + t.syncRegisterTries + ' ' + n(s.registerTries),
          t.syncDisposes + ' ' + n(s.disposes),
          t.syncDenyApplies + ' ' + n(s.denyApplies),
          t.syncTicks + ' ' + n(s.ticks),
        ]
        const extra = [
          t.syncDelegateCalls + ' ' + n(s.delegateCalls) + '/' + t.syncDelegateTries + ' ' + n(s.delegateTries),
          t.syncDelegateFailures + ' ' + n(s.delegateFailures),
          t.syncGuardDenials + ' ' + n(s.guardDenials),
          t.syncYieldTicks + ' ' + n(s.yieldTicks),
          t.syncDenyDrops + ' ' + n(s.denyDrops),
        ]
        if (s.executorFamily) {
          extra.push(t.syncExecutorFamily + ' ' + String(s.executorFamily) + (s.executorFamilySource === 'platform' ? '(平台默认)' : ''))
        }
        if (s.guardReady === false) base.push(t.syncGuardMissing)
        return base.concat(extra, steady ? [t.steady] : []).filter(Boolean).join(' · ')
      }

      // ── 头部 badge:按会话汇总,不再只报全局「模型可见」 ──
      // 全局 ct.visible 只说明「EnvDock 的 envd_shell 此刻在不在工具表」;模型实际拿到哪个
      // 命令工具由每个会话自己的作用域决定。只要有一个会话不是「直连接管且真能调」,
      // 单挂「模型可见」就是在替那个会话说谎 —— 改挂汇总 badge,逐会话细节进 title。
      const ctScopes = ct && Array.isArray(ct.scopes) ? ct.scopes.filter((s) => s && typeof s === 'object') : []
      const hasScopeFacts = ctScopes.length > 0
      const stats = data && data.syncStats && typeof data.syncStats === 'object' ? data.syncStats : null
      const scopeKindText = (kind) =>
        ({
          takeover: t.scopeKindTakeover,
          host: t.scopeKindHost,
          yield: t.scopeKindYield,
          'sandbox-host': t.scopeKindSandbox,
        })[kind] || t.scopeKindUnknown
      const scopeLine = (sc) => {
        const hidden = Array.isArray(sc.hidden) ? sc.hidden.filter(Boolean).map(String) : []
        const tool = sc.tool ? String(sc.tool) : t.noCommandTool
        const line = fmt(t.scopeLine, { id: String(sc.id || '?').slice(0, 8), kind: scopeKindText(sc.kind), tool })
        const extras = []
        if (hidden.length) extras.push(fmt(t.scopeHidden, { hidden: hidden.join(', ') }))
        if (sc.confined === true) extras.push(t.scopeConfined)
        if (sc.visible === false) extras.push(t.scopeAnomalyInvisible)
        if (sc.kind === 'takeover' && Array.isArray(sc.hostTools) && sc.hostTools.length) extras.push(fmt(t.scopeAnomalyLeak, { tools: sc.hostTools.join(', ') }))
        if (Array.isArray(sc.leaked) && sc.leaked.length) extras.push(fmt(t.scopeAnomalyLeak, { tools: sc.leaked.join(', ') }))
        return extras.length ? line + ' · ' + extras.join(' · ') : line
      }
      // 模型用宿主工具的会话:非 takeover 就是。takeover 但看不到 envd_shell 的情况必然同时
      // 命中下面的 anomalySessions(交给 bad badge),这里不再重复判断 —— 否则是永不参与渲染的死条件。
      const hostToolSessions = hasScopeFacts ? ctScopes.filter((sc) => sc.kind !== 'takeover') : []
      // 异常会话:看不到任何命令工具(tool 为空)/ takeover 下宿主工具仍可见 / 挡了却仍可见。
      // tool 为空是客户端自己就能判定的事实,不依赖服务端 anomaly 标志(旧版可能没算)。
      const anomalySessions = hasScopeFacts
        ? ctScopes.filter(
            (sc) =>
              sc.anomaly === true ||
              !sc.tool ||
              sc.visible === false ||
              (sc.kind === 'takeover' && Array.isArray(sc.hostTools) && sc.hostTools.length > 0) ||
              (Array.isArray(sc.leaked) && sc.leaked.length > 0),
          )
        : []
      // 旧版 API(没有 scopes)才用 stats 兜底:此时不能按会话核对,title 里必须明说。
      const statsHostOnly = stats && Array.isArray(stats.hostOnlyScopes) ? stats.hostOnlyScopes.filter(Boolean).map(String) : []
      const statsHidden = stats ? Math.max(0, Math.trunc(Number(stats.sandboxHiddenScopes) || 0)) : 0
      const fallbackIds = hasScopeFacts ? [] : statsHostOnly
      const fallbackSessions = fallbackIds.map((id) => ({ id, kind: 'yield', tool: ct && ct.hostName ? String(ct.hostName) : '' }))
      const fallbackCount = hasScopeFacts ? 0 : Math.max(fallbackIds.length, statsHidden)
      const mixedCount = hasScopeFacts ? hostToolSessions.length : fallbackCount
      const anomalyCount = anomalySessions.length
      const ctMixed = ctVisible === true && mixedCount > 0
      const ctAnomaly = anomalyCount > 0
      const titleLines = []
      if (!hasScopeFacts) titleLines.push(t.scopesLegacyNote)
      titleLines.push(t.scopesHint)
      const listedScopes = hasScopeFacts ? ctScopes : fallbackSessions
      for (const sc of listedScopes) titleLines.push(scopeLine(sc))
      if (ctAnomaly) titleLines.push(t.scopesAnomalyHint)
      titleLines.push(diagTitle(stats) || '')
      const ctTitle = titleLines.filter(Boolean).join('\n')

      // ── 头部只留 1 个状态 badge:异常红 / 混合黄 / 接管绿 / 未接管灰 ──
      // 全局 ct.visible 只说明 envd_shell 在不在工具表;真正的结论由 scopes 汇总出来。
      const headerBadge = !ct
        ? badge('muted', t.noCommandTool, { title: ctTitle })
        : ctAnomaly
          ? badge('bad', fmt(t.scopesAnomaly, { n: anomalyCount }), { title: ctTitle })
          : ctMixed
            ? badge('warn', fmt(t.scopesSummary, { n: mixedCount }), { title: ctTitle })
            : ctVisible === true
              ? ct.takeover === true
                ? badge('ok', t.cmdVisible, { title: ctTitle })
                : badge('muted', t.cmdNotTakenOver, { title: ctTitle })
              : ctVisible === false
                ? ctSandbox
                  ? badge('muted', t.statusSandbox, { title: ctSub })
                  : badge('bad', t.cmdInvisible, { title: ctSub })
                : badge('muted', t.noCommandTool, { title: ctTitle })

      // 状态短语:一句短词说清「模型手里的命令工具」是什么状态。优先级:
      // 异常(会丢工具)> 有会话未接管(host)> 沙箱让路 > 让路 > 接管中。
      const statusKind = !ct
        ? 'host'
        : ctAnomaly
          ? 'anomaly'
          : hasScopeFacts
            ? hostToolSessions.some((sc) => sc.kind === 'host')
              ? 'host'
              : hostToolSessions.some((sc) => sc.kind === 'sandbox-host')
                ? 'sandbox'
                : hostToolSessions.length
                  ? 'yield'
                  : 'takeover'
            : ct.takeover === true && ctVisible === true
              ? 'takeover'
              : 'host'
      const statusText = { takeover: t.statusTakeover, yield: t.statusYield, sandbox: t.statusSandbox, host: t.statusHost, anomaly: t.statusAnomaly }[statusKind]
      const statusTone = statusKind === 'anomaly' ? 'bad' : statusKind === 'takeover' ? 'ok' : statusKind === 'host' ? 'muted' : 'warn'

      // 执行器族:委托执行时命令由谁包装(win32 默认 powershell);source=platform 说明只是平台默认。
      const executorFamily = stats && stats.executorFamily ? String(stats.executorFamily) : ''
      const executorText = executorFamily
        ? t.syncExecutorFamily + ' ' + executorFamily + (stats && stats.executorFamilySource === 'platform' ? '(' + t.executorPlatform + ')' : '')
        : ''

      // 已识别的宿主命令工具(运行时扫到的名字 + 家族);learned = 名字/描述启发式认出来的。
      const runtimeShellTools = (stats && Array.isArray(stats.runtimeShellTools) ? stats.runtimeShellTools : [])
        .map((item) =>
          typeof item === 'string'
            ? { name: item, family: '', learned: false }
            : { name: item && item.name ? String(item.name) : '', family: item && item.family ? String(item.family) : '', learned: Boolean(item && item.learned) },
        )
        .filter((item) => item.name)

      // 逐会话行:一行一个会话,异常行整体红 + 行尾给原因。
      const scopeIsBad = (sc) =>
        sc.anomaly === true ||
        !sc.tool ||
        sc.visible === false ||
        (sc.kind === 'takeover' && Array.isArray(sc.hostTools) && sc.hostTools.length > 0) ||
        (Array.isArray(sc.leaked) && sc.leaked.length > 0)
      const scopeReasons = (sc) => {
        const reasons = []
        if (!sc.tool || sc.visible === false) reasons.push(t.scopeAnomalyInvisible)
        if (sc.kind === 'takeover' && Array.isArray(sc.hostTools) && sc.hostTools.length) reasons.push(fmt(t.scopeAnomalyLeak, { tools: sc.hostTools.join(', ') }))
        if (Array.isArray(sc.leaked) && sc.leaked.length) reasons.push(fmt(t.scopeAnomalyLeak, { tools: sc.leaked.join(', ') }))
        // 只有服务端 anomaly 标志、客户端看不出具体原因时,也要给一句话,不能红了却不说为什么。
        if (!reasons.length && sc.anomaly === true) reasons.push(t.scopeAnomalyFlagged)
        return reasons
      }
      const dotTone = (sc) => (scopeIsBad(sc) ? 'bad' : sc.kind === 'takeover' ? 'ok' : sc.kind === 'host' ? 'idle' : 'warn')

      // ── 头部:一行说清「哪台机器 / 默认终端 / 状态 / 有没有问题」 ──
      const head = h(
        'div',
        { className: 'envd-head' },
        h('h1', { className: 'envd-h1' }, h('span', { style: { color: 'var(--dsw-alias-brand-primary)', display: 'flex', flex: 'none' } }, h(EnvDockIcon, { size: 19 })), t.title),
        data
          ? h(
              'span',
              { className: 'envd-headline', title: data.detectedAt ? t.updatedAt + ' ' + fmtTime(data.detectedAt) : undefined },
              h('b', {}, shell.label || '—'),
              shell.version ? ' v' + shell.version : '',
              ' · ',
              statusText,
            )
          : h('span', { className: 'envd-headline' }, t.loading),
        data ? headerBadge : null,
        issues.length ? h('span', { className: 'envd-attn' }, '⚠ ' + fmt(t.countItems, { n: issues.length })) : null,
        h('span', { className: 'envd-grow' }),
        h('button', { className: 'envd-btn primary', disabled: busy, onClick: () => post({ op: 'refresh' }) }, busy ? t.detecting : t.refresh),
      )

      const body = [head]

      if (!data) {
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

      if (data && data.hasSubprocess === false) {
        body.push(h('div', { className: 'envd-err', key: 'nosub' }, h('span', { className: 'h' }, t.subprocessOff)))
      }

      if (error && !data) {
        body.push(
          h(
            'div',
            { className: 'envd-err', key: 'err', role: 'alert' },
            h('span', { className: 'h' }, t.loadFailed + ': ' + error),
            h('span', {}, t.loadFailedHint),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, h('button', { className: 'envd-btn ghost', onClick: load }, t.refresh)),
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
        // ── 置顶卡片:命令工具 / 接管(终端 + 状态 + 逐会话 + 宿主工具 + 诊断折叠) ──
        // 逐会话最多 5 行,超出的收进「还有 N 个」;数字与行数都从 scopes 事实来。
        const SCOPE_ROW_LIMIT = 5
        const scopeRows = hasScopeFacts ? ctScopes : fallbackSessions
        const shownScopes = sessionsOpen ? scopeRows : scopeRows.slice(0, SCOPE_ROW_LIMIT)
        const moreScopes = Math.max(0, scopeRows.length - shownScopes.length)
        const scopeRow = (sc, index) => {
          const reasons = scopeReasons(sc)
          const bad = scopeIsBad(sc)
          return h(
            'div',
            { className: 'envd-srow' + (bad ? ' bad' : ''), key: 'sc-' + String(sc.id || index), 'data-kind': String(sc.kind || 'unknown') },
            h('span', { className: 'envd-sdot ' + dotTone(sc) }),
            h('span', { className: 'envd-sid envd-mono' }, String(sc.id || '?').slice(0, 8)),
            h('span', { className: 'envd-skind' }, scopeKindText(sc.kind)),
            h('span', { className: 'envd-stool envd-mono' }, sc.tool ? String(sc.tool) : t.noCommandTool),
            reasons.length ? h('span', { className: 'envd-sreason' }, reasons.join(' · ')) : null,
          )
        }
        const diag = diagFacts()
        const diagShown = diagOpen || diag.auto
        // 接管模式 chips(自动 / 总是 / 只给简报)
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
        // 沙箱下接管 chips:只有「真有围栏会话」或「执行器具备围栏能力」时才值得占地方。
        const confinedSessions = ctScopes.filter((sc) => sc.confined === true).length
        const sandboxModeChips =
          confinedSessions > 0 || (sandboxInfo && sandboxInfo.capable)
            ? h(
                'div',
                { className: 'envd-chips envd-chips-sm', role: 'group', 'aria-label': t.sandboxTakeover, title: t.sandboxDelegateHint },
                [
                  ['delegate', t.sandboxDelegate],
                  ['refuse', t.sandboxRefuse],
                ].map((pair) =>
                  h('button', { key: pair[0], className: 'envd-chip' + (sandboxTakeoverMode === pair[0] ? ' on' : ''), 'aria-pressed': sandboxTakeoverMode === pair[0], onClick: () => post({ op: 'setOption', sandboxTakeover: pair[0] }) }, pair[1]),
                ),
              )
            : null
        const statusLine = h(
          'div',
          { className: 'envd-statusline' },
          h('span', { className: 'envd-statuschip ' + statusTone }, h('span', { className: 'dot' }), statusText),
          h('span', { className: 'envd-tool envd-mono' }, ct && ct.name ? String(ct.name) : t.noCommandTool),
          executorText ? h('span', { className: 'envd-exec envd-muted', style: { fontSize: '11.5px' } }, executorText) : null,
          h('span', { className: 'envd-grow' }),
          modeChips,
          sandboxModeChips,
        )
        const sessionBlock = h(
          'div',
          { className: 'envd-sessions' },
          h(
            'div',
            { className: 'envd-statusline' },
            h('span', { className: 'envd-mini-label' }, t.perSession),
            moreScopes > 0 || sessionsOpen
              ? h('button', { className: 'envd-btn ghost envd-morebtn', 'aria-expanded': sessionsOpen, onClick: () => setSessionsOpen((v) => !v) }, sessionsOpen ? t.collapse : fmt(t.sessionsMore, { n: moreScopes }))
              : null,
            h('span', { className: 'envd-grow' }),
            hasScopeFacts ? null : h('span', { className: 'envd-legacy' }, t.scopesLegacyNote),
          ),
          shownScopes.length ? shownScopes.map(scopeRow) : null,
        )
        const shellToolBlock = h(
          'div',
          { className: 'envd-shelltools' },
          h('span', { className: 'envd-mini-label' }, t.runtimeShellTools),
          runtimeShellTools.length
            ? runtimeShellTools.map((item) =>
                h(
                  'span',
                  { className: 'envd-shellchip', key: item.name, title: item.learned ? t.learnedTag : undefined },
                  h('span', { className: 'envd-mono' }, item.name),
                  item.family ? h('span', { className: 'envd-muted' }, ' · ' + item.family) : null,
                  item.learned ? h('span', { className: 'envd-learned', title: t.learnedTag }, ' ✦') : null,
                ),
              )
            : h('span', { className: 'envd-muted', style: { fontSize: '11.5px' } }, t.runtimeShellToolsNone),
        )
        const diagBlock = h(
          'div',
          { className: 'envd-diagbox' },
          h(
            'div',
            { className: 'envd-diagrow' },
            h('span', { className: 'envd-mini-label' }, t.diag),
            h('span', { className: 'envd-diag-sum' + (diag.danger ? ' danger' : ''), title: diag.auto ? t.diagAutoHint : undefined }, diag.summary),
            h('span', { className: 'envd-grow' }),
            h('button', { className: 'envd-btn ghost', 'aria-expanded': diagShown, title: diag.auto ? undefined : t.diagAutoHint, onClick: () => setDiagOpen((v) => !v) }, diagShown ? t.collapse : t.expand),
          ),
          diagShown
            ? h(
                'div',
                { className: 'envd-diag-detail' },
                ...diag.items.map((item, i) => h('span', { key: 'dg' + i, className: item.level === 'error' ? 'e' : 'w', title: item.title }, '⚠ ' + item.text)),
                diag.lastError
                  ? h('span', { key: 'dge', className: 'e', title: diag.lastError }, t.syncLastError + (diag.errorAge > 0 ? '(' + diag.errorAge + 's)' : '') + ': ' + (diag.lastError.length > 160 ? diag.lastError.slice(0, 160) + '…' : diag.lastError))
                  : null,
                diagTitle(stats) ? h('span', { key: 'dgc' }, diagTitle(stats)) : null,
              )
            : null,
        )
        body.push(
          h(
            'section',
            { className: 'envd-card', key: 'takeover' },
            h('div', { className: 'envd-card-h' }, h('h2', {}, t.takeoverCard)),
            h(
              'div',
              { className: 'envd-card-b' },
              shellChips,
              shellFormOpen
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
                : ghostAdd(t.customShell, () => setShellFormOpen(true)),
              statusLine,
              sessionBlock,
              shellToolBlock,
              diagBlock,
            ),
          ),
        )

        // 工具链 + 版本管理器(合成一节:都属「这台机器上有什么」)
        body.push(
          section(
            t.tools,
            [
              tools.length
                ? groups.map((bucket) =>
                    h('div', { className: 'envd-group', key: bucket.group }, h('div', { className: 'envd-group-h' }, groupLabel(bucket.group)), bucket.items.map(bucket.kind === 'manager' ? managerRow : toolRow)),
                  )
                : h('div', { className: 'envd-empty' }, t.noTools),
              toolFormOpen
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
                : ghostAdd(t.customTool, () => setToolFormOpen(true)),
            ],
            h(
              'span',
              { className: 'n' },
              [fmt(t.toolCount, { n: tools.length }), managers.length ? t.managers + ' ' + managers.length : '', missingPaths ? (missingPaths + ' ' + t.pathMissing) : ''].filter(Boolean).join(' · '),
            ),
            'tools',
          ),
        )

        // 健康检查:没问题整节不出现;有问题也只一行计数,点开才看列表。
        if (issues.length) {
          const hasError = issues.some((i) => i.level === 'error')
          body.push(
            section(
              t.health,
              [
                h(
                  'button',
                  { className: 'envd-foldrow envd-fold-health', 'aria-expanded': healthOpen, onClick: () => setHealthOpen((v) => !v) },
                  h('span', { style: { color: hasError ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-warn-primary)', fontWeight: 600 } }, fmt(t.countItems, { n: issues.length })),
                  h('span', { className: 'envd-muted' }, healthOpen ? t.collapse : t.expand),
                ),
                healthOpen ? h('div', { className: 'envd-issues' }, issues.map(issueRow)) : null,
              ],
              null,
              'health',
            ),
          )
        }

        // 环境简报:默认折叠成一行(展开 / 复制)
        body.push(
          section(
            t.brief,
            [
              h(
                'div',
                { className: 'envd-statusline' },
                h('span', { className: 'envd-muted' }, options.injectBrief === true ? t.briefHint : t.briefOff),
                h('span', { className: 'envd-grow' }),
                h('button', { className: 'envd-btn ghost', onClick: () => copy(data.brief || '', 'brief') }, copied === 'brief' ? '✓ ' + t.copied : t.copyBrief),
                h('button', { className: 'envd-btn ghost envd-fold-brief', 'aria-expanded': briefOpen, onClick: () => setBriefOpen((v) => !v) }, briefOpen ? t.collapse : t.expand),
              ),
              briefOpen ? h('pre', { className: 'envd-pre envd-mono' }, options.injectBrief === true ? data.brief || t.never : t.briefOff) : null,
            ],
            null,
            'brief',
          ),
        )
      }

      // 底部一行:两个开关(allowLan 必须在 if (data) 之外 —— 被 403 挡在门外时它是唯一的解法)
      body.push(
        h(
          'div',
          { className: 'envd-foot', key: 'foot' },
          h(
            'div',
            { className: 'envd-foot-item' },
            h('span', {}, t.injectBrief),
            h('button', {
              className: 'envd-switch' + (options.injectBrief === true ? ' on' : ''),
              'aria-pressed': options.injectBrief === true,
              'aria-label': t.injectBrief,
              onClick: () => post({ op: 'setOption', injectBrief: options.injectBrief !== true }),
            }),
          ),
          allowLanSwitch,
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
