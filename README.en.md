**English** | [中文](README.md)

# EnvDock · Environment Dock

[![npm](https://img.shields.io/npm/v/dsh-envdock?logo=npm)](https://www.npmjs.com/package/dsh-envdock)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6)
![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B32C3)

> Tell the agent, before it asks: where Node / Python / Git live on this Windows machine, which version to use, and how commands must be written in this terminal.

![EnvDock panel: one-line header, pinned takeover card, one row per tool](https://raw.githubusercontent.com/tkochj/dsh-envdock/main/docs/panel.png)

> The screenshot shows the **always-visible part of the one screen**: a one-line header (plugin name · default terminal and version · one status badge), the pinned **Terminal / Command** card (this machine runs an older API build with an unrestrictable host tool, hence the yellow "Tool clash" badge listing both tool names), a toolchain with one row per tool, one health-check row at its end, and a one-line brief; settings / sessions / details are collapsed.

On Windows it is common to have several Node / Python / Git installations side by side, while cmd, PowerShell and Git Bash all disagree on syntax. Without EnvDock the agent has to probe with `where node`, guess paths, write the wrong command and retry. **EnvDock is a DeepSeek Harness (dsh) plugin** that detects your toolchain at startup, injects a ready-made environment brief into the agent's context, and optionally takes over the command tool so the agent always speaks the right shell dialect. No configuration required.

**Who it is for:** people writing code with dsh on Windows; machines with several Node / Python / Git installations; anyone switching between PowerShell, cmd and Git Bash; anyone tired of the agent asking which node you use.

**What it does not do:** it does not install tools, change the system PATH, or decide versions for you — it reports the facts to the agent.

## Why EnvDock

| Without EnvDock | With EnvDock |
|---|---|
| The agent probes with `where` / `Get-Command` every time | Absolute paths and versions are already in context |
| Multiple versions, the agent cannot tell which one you want | Pick a default version in the panel |
| Default shell is PowerShell, the agent writes bash syntax | The brief states the current terminal's syntax rules |
| `nvm use` / `fnm use` disagrees with PATH | A health check points it out |
| Newly installed tools stay invisible until dsh restarts | **Re-scan** re-reads the system PATH |

## Features

- **Toolchain detection** — node, npm, pnpm, yarn, bun, deno, python, pip, uv, git, conda, with **every** candidate path and version.
- **Version managers** — nvm-windows, pyenv-win, conda, fnm, mise are parsed (including the active version where available); Volta and asdf are reported only as present. A manager counts as present only if its command is on PATH or its root really exists.
- **One-click default version** — choose any absolute path in the panel; the agent sees it on the next turn.
- **Environment brief injection** — system, default terminal, absolute tool paths and versions, and syntax notes, written into the run context.
- **Optional shell takeover** — when the default terminal and the host command tool belong to different families, EnvDock registers a stable `envd_shell`, hides the host shells, and switches terminals without an empty tool window. Host command tools are recognised at runtime (`ops_bash`, third-party publication names, …); one that cannot be masked or whose family cannot be recognised gets EnvDock's tool hidden instead (yield), so the session still has exactly one command tool.
- **Health checks** — Store stubs, dead PATH entries, EOL versions, npm/Node mismatch, active version manager vs. PATH drift.
- **The `envd` tool** — `summary` / `resolve` / `check` / `set_default` for the agent.

## Install

**Requirements:** Windows and an installed DeepSeek Harness (dsh). Plugins are installed per profile; the commands below use `web`.

> **The npm build may lag behind this repository.** For the newest features (the one-screen panel, per-session takeover facts, runtime host-tool discovery), install from a local directory / Git as described below; the npm package follows releases, and the repository's `package.json` is the source of truth for the current version.

### Option 1 — npm (may lag behind)

```powershell
dsh plugin --profile web add dsh-envdock
```

Enable EnvDock in the plugin page if needed, then restart dsh. Replace `web` with `tui`, `headless`, etc. for other profiles.

### Option 2 — Web plugin page (local directory / Git, recommended)

1. Open **Plugins** in the dsh sidebar.
2. Choose install and provide the source:
   - local directory: `link:D:\plugins\envdock` (use your own path)
   - or a Git URL
3. Make sure **EnvDock** is enabled, then restart dsh.

### Option 3 — Command line (local directory, recommended)

```powershell
# Install into the web profile; link: takes the plugin directory
dsh plugin --profile web add link:D:\plugins\envdock

# Restart web
dsh web
```

Enable EnvDock in the plugin page if it was not enabled automatically. Replace `web` with `tui`, `headless`, etc. for other profiles.

> **The panel only exists in the Web UI** (`web` profile): the plugin's `dsh.client.platform` is `web`. `tui` / `headless` can install EnvDock — the brief and the `envd` tool still work — but there is no visual panel to open.

> From source: `git clone https://github.com/tkochj/dsh-envdock.git envdock`, then install it with `link:` as above. Restart dsh after source changes.

### Verify

- EnvDock appears in the sidebar and the panel lists your toolchain.
- A new session contains the `## 本机环境 (EnvDock 实测,优先于猜测)` brief.
- Ask the agent "where is node?" — it answers with an absolute path instead of searching.

## Quick start

1. Open the EnvDock panel from the sidebar.
2. Review the detected toolchain and health checks.
3. Use the pinned takeover card to switch the terminal; open Settings for the takeover mode; click a tool path to copy it, or "N versions" to pick a default version.
4. Return to the session — the agent already has the updated brief.

## Panel guide

The panel answers four questions on one screen: **which terminal this machine uses**, **which command tool the model has right now**, **which tools are installed**, and **whether anything is wrong**. Only the header line, the pinned takeover card, the toolchain section and the footer line are always visible; settings, per-session rows, details, the health-issue list and the brief body live behind their triggers. In a 720px-high window (about 600px usable) the always-visible part needs no scrolling.

| Area | What it always shows |
|---|---|
| **Header (one line)** | Plugin name · default terminal and version (e.g. `Git Bash v5.3.15`) · **exactly one** status badge · Rescan on the right (re-reads the system's **current** PATH; on Windows it re-reads the registry and clears the version cache). |
| **Status badge** | The panel's single conclusion, picked by severity: red "N broken" (or "No tool" when a tool should be visible but none is reachable) > yellow "Host tool in N" / "Yielding" / "Tool clash" > green "Takeover" > muted grey "Host tool" / "Sandboxed" / "Provided by another plugin" (also grey "No tool" when no command tool was detected at all). Hover for the command tool name, the session count and the note texts. |
| **Takeover card · Terminal** | `Terminal` chips: `Auto` + every detected terminal + `+` (custom terminal: path / name / argument template). Switching applies immediately. |
| **Takeover card · Command** | The `Command` row: a status chip (the same conclusion as the header badge) + the command tool name actually in effect (`envd_shell` on takeover, `ops_bash` when yielding, both when they clash, e.g. `envd_shell · ops_bash`) + one sentence of session counts (`3 sessions · 2 direct · 1 sandboxed`) + three ghost buttons on the right: Sessions / Settings / Details (no Sessions button without per-session facts). |
| **Always-visible notes** | One sentence per line, facts only: old API build (no per-session data), an unrestrictable host tool that EnvDock yielded to or that coexists with `envd_shell`, N sessions that cannot see `envd_shell`, unknown sandbox policy, N confined sessions, the last error. |
| **Settings (collapsed by default)** | Opens two chip groups: takeover mode (Auto / Always / Brief only) and under-sandbox takeover (Delegate / Refuse). |
| **Per session (collapsed by default; auto-expands on anomalies)** | One row per session: first 8 id characters · outcome (direct / host / yielded / sandboxed) · tool actually in effect · mask or confinement info · reason. Broken rows are marked red with the reason at the end; one anomalous session is enough to auto-expand this section, with broken rows sorted first. |
| **Recognised host tools (one line)** | Chips for host command tools actually seen at runtime (`name · family`); heuristically recognised ones carry a ✦ "auto-detected" mark; "no host tool recognized" when there is none. |
| **Details (collapsed by default)** | Reconcile counters: register / dispose / deny / lift / ticks, delegation (tries · calls · failures · refusals · runner failures · aborts), guard denials, yield ticks, executor family, detection count and duration; the summary starts with "N broken" when something is wrong. The full field set lives in `/envdock-api` → `syncStats`. |
| **Toolchain** | One row per tool: group name (only on the group's first row) · name · version · path (**click the path to copy**) · "N versions ▾" at the end of the row (candidates and "set as default" appear only after expanding). Version managers are one row each (the active version carries ←), followed by the "+ Custom tool" entry. |
| **Health check (one line, end of the toolchain)** | `✓ Pass` when healthy; otherwise `⚠ N issue(s)` plus the first title, expanding into the full list (red / yellow / grey). |
| **Environment brief (one line)** | State (injected for the agent / brief injection off) + Copy + Expand; the text appears only after expanding. |
| **Footer (one line)** | Two switches (brief injection; Allow LAN — still clickable when the API answers 403) + copy feedback (`aria-live`) + a footnote (system · arch · hostname · updated). |

The panel polls `/envdock-api` every 15 seconds (only while the page is visible; an unchanged payload does not re-render, so a counter change alone may not repaint). Failures surface as a dismissible error row, copy failures included.

## What the agent sees

A brief like this is injected (content varies per machine):

```text
## 本机环境 (EnvDock 实测,优先于猜测)
- 系统: Windows_NT 10.0.26300 (x64),用户 LAPTOP-XXXX
- 默认终端: Windows PowerShell → C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe (v5.1.26100)
  · 串联用 `;`,条件串联 `&&`/`||` 只有 PowerShell 7 支持
  · 环境变量 `$env:NAME`,调用外部程序要 `& $exe` 或用完整路径
- 工具(绝对路径,直接用,不必再 where/which):
  · Node.js v24.18.0 → C:\Program Files\nodejs\node.exe [另有 v20.19.0 ...]
  · Python v3.12.10 → D:\python\python.exe [...]
  · Git v2.55.0 → E:\Git\cmd\git.exe
- 版本管理器: pyenv-win(...) [2 个版本], fnm(...) [1 个版本,激活 v20.19.0]
```

The `envd` tool:

| action | Purpose |
|---|---|
| `summary` (default) | Full environment brief |
| `resolve` | Default path, version, all candidates, terminal |
| `check` | Health issue list |
| `set_default` | Switch the default version |

### Shell takeover

- The host command tool is `pwsh` / `bash` etc. When your default terminal is a different family, EnvDock registers a stable `envd_shell` and hides the host shells.
- Same family: EnvDock does nothing and adds no duplicate tool.
- Sandbox is judged **per session**, not by the deployment default: the executor's `sandboxMode` is only the deployment default; the effective policy comes from `sandboxPolicy.resolve({ session })` and has **three states** (confirmed unconfined / confirmed confined / unknown). The legal policy set is a closed one — `read-only` / `workspace-write` / `danger-full-access`; a resolve result of `{}`, an empty mode, or anything outside that set counts as **unknown policy** conservatively and is **never** replaced by the deployment default. `envd_shell` is only registered when **at least one session proves it is unconfined**; a confined session does not disable takeover for other sessions (confined sessions keep the host command tool). An unknown policy is treated conservatively as confined — it is never reported as unconfined. The reverse also holds: if the executor claims it does not confine but the policy service says this session is confined, EnvDock still refuses to spawn or delegate on its own. If **every** session is confined, EnvDock registers no tool at all — each session is "not taken over" and the model simply uses the host tool.
- **Host command tools are recognised at runtime, not from a hard-coded list**: where the host provides `tools.definitions`, EnvDock enumerates them and recognises bash / PowerShell / cmd / WSL by family tokens in the name (`ops_bash`, `tenant_pwsh`, …) and by "description mentions a shell + a command-like parameter (`command` / `cmd` / `script` / `commandline`)". `ops_bash` is on the **built-in bash family list**, so it short-circuits there and does **not** need a command parameter; that name-token-plus-parameter gate only applies to third-party publication names. Conversely a name containing `cmd` is **not** enough: `run_cmd` (task parameter) or `wc_cmd_palette` (UI palette) are not claimed as host shells. A tool it can name but whose family it cannot recognise is left alone and the session yields — no syntax guessing.
- **A scope-private host shell cannot be masked, so EnvDock yields** — when the host tool is mounted in a scope-private layer (dsh-ops mounts `ops_bash` per session), `restrict` cannot hide it, so EnvDock hides its own `envd_shell` instead and the session keeps exactly one host command tool. The decision is **per scope**: with the global `pwsh` plus a per-session `ops_bash`, each session only masks the host shells it actually saw; an unmaskable name is remembered only in that scope (other sessions that can mask it still do), and the plan targets exactly one command tool per session.
- **Two kinds of "cannot mask", handled differently**: **structural** — the host tool is registered in the agent's own layer, while `restrict`'s `restrictableNames` only covers the inherited surface (contract: restrictions "do not affect scoped registrations"), so retrying is pointless: these names get a 10-minute TTL, **never write `lastError`** and do not paint the panel red every 30 seconds. **Transient** — publication reentry or a hot-reload gap: retried after 30 seconds and recorded honestly as an error; a name that is merely missing for now goes into a 30-second retry window instead of being written off.
- **New outcome "Tool clash"**: when the panel has no per-session facts (`/envdock-api` is an older build) and an unrestrictable host tool is still visible next to `envd_shell`, it can only show a yellow "Tool clash" badge and list both tool names on the command row (e.g. `envd_shell · ops_bash`) — it neither claims "Takeover" nor pretends to be "Yielding" (EnvDock's own tool is still visible). With the new API the outcome is decided per session and "clash" does not exist as an outcome; a clash is a signal that one session has two command tools, and the note says it is the old API that prevents per-session verification.
- **Coexisting with dsh-ops**: dsh-ops publishes `ops_bash` at the session layer, so EnvDock **cannot mask it** and yields (it hides `envd_shell`, the model uses `ops_bash`, each session still has exactly one command tool, and the brief states that EnvDock yielded). To use EnvDock's terminal takeover in that session, the only supported entry point is turning off **Publish Bash in the dsh-ops settings** (there is no unregister API; EnvDock cannot do it for you).
- **Delegation only supports bash / PowerShell targets**: the wrapper follows the **host executor's** family (`executorFamily`: clues from the `ctx.shell` object/class name first, then the platform default — PowerShell on win32, bash elsewhere), and the command data **never travels on the command line**: a bash target gets the user command as base64 in the `ENVD_CMD` environment variable and runs `printf %s $ENVD_CMD | base64 -d | bash -s` (the outer `-lc` is already a login shell, so the inner one is `-s` only and the profile never runs twice); a PowerShell target uses `-NoProfile -NonInteractive -Command`, decodes UTF-8 base64 from `$env:ENVD_CMD` and runs it through `Invoke-Expression`, and pins `[Console]::OutputEncoding` to UTF-8 so non-65001 code pages cannot mangle the output. That means the host command line never contains user text, so the PowerShell 5.1 quote-swallowing bug cannot trigger, and an MSYS/Git Bash host cannot rewrite a cmd target's `/d /s /c` into paths. **cmd / WSL / custom-terminal targets are always refused** (the command would silently not run). A cmd executor, an absent executor, a missing session, or a missing/illegal session policy is refused too — never guessed, never replaced by the deployment default; the refusal text carries the facts ("session policy X", "this session is sandbox-confined", "this session's sandbox policy is unknown") so the model does not think the tool is broken or the command wrong.
- **A hidden command tool gives an actionable refusal** (`tools.guard`): a hidden host shell says "EnvDock took over, use `envd_shell`"; conversely, a hidden `envd_shell` in a yield / sandbox session points at the host tool actually visible there (the reason comes from the per-session facts: sandbox-confined, a scope-private host shell, or an unknown policy). The guard judges the replacement by "can it be used right now": through `tools.executable` where the host provides it, otherwise by visibility only; when it cannot tell, it says so or simply lets the call through — it never invents a tool name. It is not a security boundary — under PTC the agent's direct call may be folded into `run_code`, and dsh-ops 0.5.0 may deny/guard first through its own `tools/pre-execute`, so EnvDock's direction-2 message may never appear and `guardDenials` may stay 0. That is normal, not a broken guard.
- **Takeover diagnostics carry the common counters**: the panel shows register tries/registers, disposes, deny applies, ticks, delegate tries/calls/failures/**refusals**/**runner failures**/**aborts**, guard refusals, yield ticks, mask releases, the executor family, detection count/duration, whether the guard is registered, whether this tick is steady, and the last error with its age. The full field set (`ownHides`, `hostDenyApplies`, `denyNoops`, `transientMisses`, `steadySinceAt`, `scopeAnomalies`, `runtimeShellTools`, `hasExecutableApi`, …) is in `/envdock-api` → `syncStats`. Delegation counters are kept apart: entering the delegation path is a try; an unsupported target / executor is a refusal; only a legal execution that really ran counts as a call; the confined runner being broken (command never ran) is a **runner failure**; a cancelled command is an **abort** — all three outcomes leave a trace, so "never delegated" and "the runner broke" cannot collapse into the same 0.
- **`commandTool.hostName` reports the real host tool**: it prefers the per-session facts (the union of every session's `hostTools` when it has exactly one name), so a dsh-ops deployment reports `ops_bash` instead of pretending it is `pwsh`; only without per-session facts does it fall back to the runtime's shippedName.
- If registration fails or the name is taken, EnvDock keeps the host tool instead of leaving you without any command tool.

## Settings and reset

State lives in `~/.dsh/envdock.json` (atomic writes; a corrupt file is backed up as `envdock.json.corrupt` and defaults are restored).

| Option | Default | Meaning |
|---|---|---|
| Inject brief | on | Write the environment brief into the agent context |
| Shell takeover | auto | `auto`: only for different families; `always`; `brief only` |
| Sandbox takeover | delegate | While EnvDock's own tool is still in a confined session's tool table: `delegate` forwards the command through the confining host executor (no sandbox bypass; only **bash / PowerShell targets** are supported, the wrapper follows the executor family and the command travels on a base64 data channel; the terminal choice still applies to that call); cmd / WSL / custom-terminal targets are refused. `refuse` always errors. In steady state a confined session uses the host command tool |
| Allow LAN | off | Once enabled, LAN clients can only **read** panel data. Every write (terminal, default version, custom tool / terminal argv, options) stays local-only; the single exception is a same-origin page turning this switch **off** (turning it on must happen locally, otherwise the terminal argv becomes a LAN-wide command-injection surface) |
| Custom tools | empty | Add tools outside PATH |

```powershell
# Reset everything
Remove-Item ~/.dsh/envdock.json
```

Uninstall from the plugin page, then restart dsh.

## FAQ

**Why does the model see `ops_bash` instead of `envd_shell`?**

The command tool is decided **per session**: in one dsh process, different sessions can hand the model different tools. Seeing `ops_bash` usually means EnvDock **yielded** or **did not take over** in that session — takeover is not broken. Host command tools are recognised at runtime (`ops_bash`, third-party publication names, …); when the family cannot be recognised EnvDock yields instead of guessing syntax. The four per-session outcomes (plus one aggregate state that only exists with an old API):

| Outcome | When | What the model has | Panel |
|---|---|---|---|
| Takeover | at least one session is unconfined (that is when `envd_shell` gets registered) and this session's host shell was masked successfully | `envd_shell` (default terminal syntax only) | green "Takeover" when every session is on takeover; otherwise yellow "Host tool in N" |
| Not taken over (`host`) | EnvDock does not take over this session: brief only, registration failed / name taken, same family as the host, or **every session is confined (no tool is registered at all)** | the host tool | "Host tool in N" in mixed setups; when everything is not taken over (or every session is confined) the header shows a single grey badge ("Host tool" / "Sandboxed") instead of a yellow warning |
| Yield | the host shell lives in a scope-private layer and `restrict` cannot hide it (dsh-ops mounts `ops_bash` per session), or its family cannot be recognised | that host tool (`ops_bash`) | "Host tool in N"; when every session yields, the badge says "Yielding" |
| Sandbox-host | **mixed deployment**: a tool was registered for the unconfined sessions while this session is confined, so `envd_shell` is hidden here | the host's confined command tool | "Host tool in N" |
| Tool clash (aggregate state, old API only) | `/envdock-api` is an older build, so per-session facts are unavailable, while an unrestrictable host tool is still visible next to `envd_shell` | two (e.g. `envd_shell` and `ops_bash`) | yellow "Tool clash" with both tool names on the command row — it never claims a takeover |

Note that `sandbox-host` only exists in a mixed deployment (at least one unconfined session plus this confined one). With a single session, or when **all** sessions are confined, the outcome is `host`: EnvDock does not register `envd_shell` at all.

When yielding, EnvDock hides its own `envd_shell` instead, so the session still has exactly one command tool; the brief says so directly:

```text
· 命令工具: `ops_bash`(宿主自带,用 bash / sh 语法);宿主 shell 在这个会话里挡不掉或无法替代,EnvDock 已让路,直接用这个
```

The plans never hide both tools; if both ever end up visible (or neither is reachable), the per-session `anomaly` flag surfaces it as "N broken".

**What do the "Host tool in N" and "N broken" badges mean?**

EnvDock reconciles per session rather than declaring one global takeover state:

- **Host tool in N** (warn): N counts the sessions that are **not** on direct takeover (not taken over / yield / sandbox-host). The number comes straight from `commandTool.scopes`, not from aggregate counters such as `sandboxHiddenScopes`. Yellow only appears when takeover and non-takeover sessions are mixed; **when no session is taken over the header is a grey "Host tool"** rather than a mixed warning.
- **N broken** (error): in that session neither `envd_shell` nor a host command tool is reachable (zero tools), or a takeover leaves the host tool visible (two tools), or a mask did not take effect (`leaked` non-empty). Treat it as a bug signal, not a normal outcome; yielding itself is not an anomaly and no longer gets a ⚠ in the details block.
- Hovering the badge shows the command tool name, the session count and the always-visible note texts; per-session rows open under Sessions, the reconcile counters under Details, and the full field set lives in `/envdock-api`.
- `/envdock-api` exposes the same facts as `commandTool.scopes`: `id`, `kind`, `tool`, `hostTool` / `hostTools`, `ownVisible`, `hideOwnPlanned`, `visible`, `hidden`, `leaked`, `hidesOwn`, `confined` (**three states**: true / false / null = unknown policy), `policyKnown`, `mode`, `anomaly`. A new build with no sessions returns `scopes: []` and the panel says "No sessions yet" instead of pretending to be an older build.
- If `/envdock-api` is an older build (no `scopes` field), the panel shows a note ("Old API build; per-session facts need a dsh restart") and can only state one aggregate outcome (it becomes "Tool clash" when an unrestrictable host tool is still visible next to `envd_shell`); restart dsh with the new version to get per-session rows — until then there is no Sessions button either.
- The plain "Takeover" badge appears only when the tool is registered and no session falls back to "not taken over" (with no sessions yet it also shows: the tool is there).

**Why is there no `envd_shell` in a sandbox-confined session?**

Because this session's effective policy is not `danger-full-access` (e.g. `workspace-write`). EnvDock executes through `ctx.subprocess`, which has no `sandboxPolicy` entry — spawning directly would bypass the sandbox. Three cases:

- **All sessions confined**: EnvDock registers no `envd_shell`; every session's `kind` is `host` (not taken over) and the model uses the host's own confined tool. The header shows a single grey badge ("Sandboxed" when the executor can confine, otherwise "Host tool") — never "Takeover", and never a yellow mixed warning.
- **Mixed deployment (at least one unconfined session)**: the tool is registered for the others, and the confined session's `kind` is `sandbox-host` — `envd_shell` is hidden there.
- **Unknown policy** (`sandboxPolicy.resolve` throws, no policy service, or a result of `{}` / empty mode / a value outside the closed set): treated conservatively as confined — `envd_shell` hidden, host tool kept; `commandTool.scopes[].confined` is `null` and `policyKnown` is `false`, and the panel marks it "policy unknown". Illegal values never fall back to the deployment default.

Either way the brief talks about the sandbox (the tool name varies per machine):

```text
· 命令工具: `pwsh`(宿主自带,用 PowerShell 语法);本会话被沙箱围栏(workspace-write):EnvDock 不接管(接管会绕过沙箱),以工具表里那个工具为准
```

`sandboxMode` is only the **deployment default**: capability (whether the executor confines at all) / deployment default / this session's effective policy are three separate facts, and the last one is resolved per session via `sandboxPolicy.resolve({ session })` and is **three-state** (confirmed unconfined / confirmed confined / unknown). To use EnvDock's terminal here, switch the session policy to `danger-full-access`; takeover applies on the next reconcile. But if the host shell is scope-private and cannot be masked, the session still yields even without confinement.

"Sandbox takeover → Delegate" is not a switch that keeps EnvDock's terminal in a confined session: delegate forwards the command through the confining host executor (`resolve` + `execute`; the command data travels on the `ENVD_CMD` base64 channel, the confinement rides the host process and is inherited), and it only matters during the short window before `envd_shell` is removed from that session's tool table. The wrapper follows the **host executor's** family (`executorFamily`), not the model-facing tool name; and **only bash / PowerShell targets** are supported: a bash target receives the command as base64 in `ENVD_CMD` and runs `printf %s $ENVD_CMD | base64 -d | bash -s` (the outer `-lc` is already a login shell, so the inner `bash` is `-s` only and the profile does not run twice), while a PowerShell target uses `-Command`, decodes UTF-8 base64 from `$env:ENVD_CMD`, runs it through `Invoke-Expression` and pins `[Console]::OutputEncoding`; that sidesteps both "silently does nothing" traps (PowerShell 5.1 swallowing quotes, MSYS rewriting cmd arguments) and avoids mojibake on non-65001 code pages. cmd / WSL / custom-terminal targets are refused outright; a cmd executor, a missing executor, a missing session, or a missing/illegal session policy (empty or out-of-set mode included) is refused instead of falling back to the deployment default.

**No EnvDock in the sidebar?** Check that it is enabled in the plugin page and restart dsh; confirm you installed it into the profile you boot.

**The agent now has only `envd_shell` and fewer capabilities?** The takeover tool is a minimal executor: one foreground command, truncated output, `cwd` / `timeoutMs` — no background jobs, tail files or `sandbox_permissions`. Switch takeover to **brief only** to get the host tool back.

**"This session is sandbox-confined, EnvDock will not take over"?** Because this session's effective policy is not `danger-full-access` (see "Why is there no `envd_shell` in a sandbox-confined session?" above for what happens instead). The executor's `sandboxMode` is only the deployment default — the panel keeps three facts apart: capability, deployment default, and this session's effective policy, and `/envdock-api` lists the per-session policies under `sandbox.scopes`. To use EnvDock's terminal here, switch the session policy to `danger-full-access`; takeover applies on the next reconcile (sooner when the tool table changes).

**Health check says the active version manager differs from PATH?** e.g. fnm is on Node 20 while PATH resolves the system Node 24. Use absolute paths or run `fnm use` first.

**Changed the system PATH but the panel is stale?** Click re-scan; on Windows it re-reads the machine and user registry. On POSIX, or without the host `subprocess` service, restart dsh.

**What can LAN clients do?** Nothing by default. After enabling **Allow LAN** in the panel, LAN clients can only **read** panel data; every write (terminal, default version, custom tool / terminal argv, options) stays local-only. The single exception is a same-origin page turning Allow LAN **off** (turning it on must happen locally) — otherwise a LAN page could rewrite the default terminal argv, which is a command-injection surface. The switch itself stays clickable when the API answers 403.

**What do the red / yellow / grey health tiers mean?** Red = error (Store Python stub, dead default-version path, unusable default terminal, …); yellow = warning (multiple versions side by side, EOL runtime, dead PATH entries, active version manager vs. PATH drift, …); grey = info (e.g. the dsh process PATH is stale).

## Known limits

- Detection covers executables and versions; it does not parse `.nvmrc` / `pyproject.toml` / `package.json` requirements.
- Version detection needs the host `subprocess` service; without it only PATH scanning is done.
- Volta / asdf are presence-only.
- The takeover executor is deliberately minimal.
- A scope-private host command tool cannot be masked (contract: restrictions "do not affect scoped registrations"); EnvDock yields and that session keeps the host tool. Structurally unmaskable names are retried every 10 minutes and never write `lastError`; transient ones are retried after 30 seconds and recorded honestly. dsh-ops' `ops_bash` is the former — to let EnvDock take over, turn off Publish Bash in the dsh-ops settings.
- Host command tools are recognised by name / description heuristics: a tool whose family cannot be recognised is neither masked nor taught syntax — EnvDock yields and the model keeps using it as before. A name containing `cmd` alone is not enough: the tool must expose a command-like parameter.
- The refusal guard is an actionable hint, not a security boundary: without `tools.executable` it can only judge by visibility, under PTC a direct call may be folded into `run_code`, and dsh-ops 0.5.0 may deny/guard first through its own `tools/pre-execute`, so EnvDock's direction-2 message may never appear (`guardDenials` may stay 0).
- Delegation only supports **bash / PowerShell targets**: cmd / WSL / custom-terminal targets are refused (the command would silently not run). Confined policies (`read-only` / `workspace-write`) never spawn by themselves — only delegate or refuse. A PowerShell 5.1 host is still safe because commands travel through the `ENVD_CMD` base64 data channel (`-Command` + `Invoke-Expression`) instead of the command line, but a cmd target simply has no safe delegation path.
- When every session is confined EnvDock registers no `envd_shell` (each session is "not taken over") and the header shows a grey badge, never "Takeover"; `sandbox-host` only appears in a mixed deployment.
- Detection results are cached in memory for 45 seconds; only default-terminal / custom-terminal / default-version / custom-tool changes invalidate them (toggling allow-LAN no longer triggers a full re-scan). Rescan forces a fresh scan and clears the version cache.
- A host command tool only counts while it is **actually visible** (or still inside our mask): once it disappears after having been seen, EnvDock takes over as a fallback instead of assuming "same family as the host" forever. Before the first sighting there is a ~60 second grace window so a late-registering host plugin is not raced.
- Working directory is the current session's, not the dsh process cwd.
- Windows-first; cross-platform details are handled but non-Windows detection is weaker.

Deep implementation notes and design trade-offs: [docs/DESIGN.md](https://github.com/tkochj/dsh-envdock/blob/main/docs/DESIGN.md) (Chinese). What changed in each version: [CHANGELOG.md](https://github.com/tkochj/dsh-envdock/blob/main/CHANGELOG.md).

## Development

```
index.js          Host: detection, envd tool, brief injection, terminal takeover, /envdock-api
client.js         Client: sidebar icon + panel
cordis.patch.yml  bundle patch (insert id: envdock)
locale/           meta.title / meta.description
icon.svg          Plugin icon
CHANGELOG.md      Release notes
test/             parsers, i18n check, shared host fixture, host harness, simulator, panel render
docs/             Design notes and screenshots
```

```powershell
npm test                    # all four tests in one go (source checkout only)

node test/parsers.mjs
node test/i18n-check.mjs
node test/host-harness.mjs
node test/panel-render.mjs

node test/simulate.mjs --help   # manual check: run the real index.js on a fake host and print the panel payload (--mode / --host-tools / --unrestrictable …)
```

`npm test` only works in a **source checkout**: the npm package does not ship `test/`, so an installed plugin has no tests to run. Issues and pull requests are welcome. Keep the four tests green.

## License

[MIT](LICENSE) © 2026 EnvDock contributors
