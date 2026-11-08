**English** | [中文](README.md)

# EnvDock · Environment Dock

[![npm](https://img.shields.io/npm/v/dsh-envdock?logo=npm)](https://www.npmjs.com/package/dsh-envdock)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6)
![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B32C3)

> Tell the agent, before it asks: where Node / Python / Git live on this Windows machine, which version to use, and how commands must be written in this terminal.

![EnvDock panel: one-sentence purpose, terminal choice, command row, toolchain](https://raw.githubusercontent.com/tkochj/dsh-envdock/main/docs/panel.png)

> The screenshot is the 0.6.1 first screen (this example machine uses the PowerShell family): a one-line header (icon · plugin name · default terminal and version · one two-state badge · Rescan) with a one-sentence purpose underneath; the pinned **Terminal / Command** card (`Terminal` set to `Auto`, the `Command` row reads "`PowerShell syntax` · `envd_shell` · `Other: pwsh` · Details", with one plain-language note only when needed, at most two); a toolchain with one row per tool; one Environment brief row (state + an inline switch + Copy + Expand); **Advanced** collapsed by default and holding the "Hide the other family command tools" and "Allow LAN access" switches; and a footer with only copy feedback and the platform / updated footnote.

On Windows it is common to have several Node / Python / Git installations side by side, while cmd, PowerShell and Git Bash all disagree on syntax. Without EnvDock the agent has to probe with `where node`, guess paths, write the wrong command and retry. **EnvDock is a DeepSeek Harness (dsh) plugin** that detects your toolchain at startup, injects a ready-made environment brief into the agent's context, and exposes **one syntax family per session** (bash or PowerShell); it optionally adds one command tool that runs your terminal (`envd_shell`). No configuration required.

**Who it is for:** people writing code with dsh on Windows; machines with several Node / Python / Git installations; anyone switching between PowerShell, cmd and Git Bash; anyone tired of the agent asking which node you use.

**What it does not do:** it does not install tools, change the system PATH, or decide versions for you. It is additive and masks nothing by default; 0.6's single exception is masking the **built-in** PowerShell tools (`pwsh` / `powershell`) in bash-family sessions, and the "Hide the other family command tools" switch turns that off.

## Why EnvDock

| Without EnvDock | With EnvDock |
|---|---|
| The agent probes with `where` / `Get-Command` every time | Absolute paths and versions are already in context |
| Multiple versions, the agent cannot tell which one you want | Pick a default version in the panel |
| Default shell is PowerShell, the agent writes bash syntax | The brief gives the syntax of this session's single family |
| `nvm use` / `fnm use` disagrees with PATH | A health check points it out |
| Newly installed tools stay invisible until dsh restarts | **Re-scan** re-reads the system PATH |

## Features

- **Toolchain detection** — node, npm, pnpm, yarn, bun, deno, python, pip, uv, git, conda, with **every** candidate path and version.
- **Version managers** — nvm-windows, pyenv-win, conda, fnm, mise are parsed (including the active version where available); Volta and asdf are reported only as present. A manager counts as present only if its command is on PATH or its root really exists.
- **One-click default version** — choose any absolute path in the panel; the agent sees it on the next turn.
- **Environment brief injection** — system, default terminal, absolute tool paths and versions, and **this session's syntax family**, written into the run context.
- **One syntax family per session (0.6)** — the bash family (`ops_bash` / `bash` …) and the PowerShell family (`pwsh` / `powershell`) are kept apart: in a bash-family session the host's built-in `pwsh` / `powershell` are masked (hidden through `tools.restrict` where possible, otherwise refused before dispatch). The "Hide the other family command tools" switch turns masking off and keeps both families visible.
- **Optional additive command tool** — when the primary family has a usable terminal, EnvDock registers a stable `envd_shell` on top (running your terminal and PATH) and picks the terminal of the **calling session's** family. In a confined session `envd_shell` refuses outright and you keep using the host tool.
- **Health checks** — Store stubs, dead PATH entries, EOL versions, npm/Node mismatch, active version manager vs. PATH drift.
- **The `envd` tool** — `summary` / `resolve` / `check` / `set_default` for the agent.

## Install

**Requirements:** Windows and an installed DeepSeek Harness (dsh). Plugins are installed per profile; the commands below use `web`.

> **The npm build may lag behind this repository.** For the newest features (the one-screen panel, the additive command tool, brief injection), install from a local directory / Git as described below; the npm package follows releases, and the repository's `package.json` is the source of truth for the current version.

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
3. Use the pinned **Command tools** card to switch the default terminal; click a tool path to copy it, or "N versions" to pick a default version.
4. Return to the session — the agent already has the updated brief.

## Panel guide

The panel answers four questions on the first screen: **which terminal this machine uses**, **which syntax to write this round**, **which tools are installed**, and **whether anything is wrong**. The first screen uses no inside jargon — families show up as "`bash syntax` / `PowerShell syntax`", host command tools as "other command tools", and confinement as "sandbox-limited"; technical detail lives behind **Details** and **Advanced**. In a 720px-high window (about 600px usable) the always-visible part needs no scrolling.

| Area | What it always shows |
|---|---|
| **Header (one line + one-sentence purpose)** | Icon · plugin name · default terminal and version (e.g. `Git Bash v5.3.15`) · **exactly one two-state** status badge · Rescan on the right (re-reads the system's **current** PATH; on Windows it re-reads the registry and clears the version cache; it also re-judges the syntax choice, dropping the previous session decisions and hidden names). Underneath, always visible: "Tells the agent where your tools live, which version to use, and which shell syntax to write." |
| **Status badge** | The panel's single conclusion, in plain words: green **Ready** (the command tool works) or muted **Display only** (no command tool provided — the panel only lists the other command tools). "Some sessions are sandbox-limited" never lands on the panel-level badge (the panel is global; a bare "Limited" reads like the plugin is broken) — it is a note instead. No family suffix; hover for up to two notes. |
| **Command card · Terminal** | `Terminal` chips: `Auto` + every detected terminal + `+` (custom terminal: path / name / argument template). Chips show the terminal name only, no family tag; the `Auto` tooltip reads "Picks the shell syntax per session (recommended)". Switching applies immediately. |
| **Command card · Command** | The `Command` row: the syntax tag (`bash syntax` / `PowerShell syntax`, **with "· manual" only when picked by hand**) · `envd_shell` (**`—` when none is provided**) · `Other: ops_bash · pwsh` ("No other command tools" when there is none) · Details on the right. Hover explains where each one's environment / PATH comes from. |
| **Notes (at most two lines, plain words)** | Only when needed: why no command tool is provided (`No usable terminal found (bash syntax needs Git Bash, PowerShell syntax needs pwsh)` / `No session outside the sandbox yet; envd_shell is not provided for now` / `Name is taken by another plugin; envd_shell is not provided` / `Could not provide the command tool (registration failed)`), `N other sessions are sandbox-limited: envd_shell will not run there; use another command tool`, `The manually picked syntax is unavailable (no matching terminal or command tool); switched back to per-session selection`, `PowerShell syntax was picked manually: both PowerShell and bash tools are available; write each command in its own syntax, do not mix them`, `Hid pwsh (to avoid mixing the two syntaxes)`. In the quiet case (nothing to report) there is no note at all; the "other command tools may use a different environment and PATH" explanation lives in the hover of `Other: …`. |
| **Details (collapsed by default)** | `scans: N · last: Xms · register tries: N` + command-tool chips (`name · syntax`; heuristically recognised ones carry a ✦ "auto-detected" mark, hidden / refusal-only / display-only ones are tagged) + the last error. |
| **Toolchain** | One row per tool: group name (only on the group's first row) · name · version · path (**click the path to copy**) · "N versions ▾" at the end of the row (candidates and "set as default" appear only after expanding). Version managers are one row each (the active version carries ←), followed by the "+ Custom tool" entry. |
| **Health check (one line, end of the toolchain)** | `✓ Pass` when healthy; otherwise `⚠ N issue(s)` plus the first title, expanding into the full list (red / yellow / grey). |
| **Environment brief (one line)** | "Injected into the agent / Not injected" + an **inline injection switch** + Copy + Expand; the text appears only after expanding. |
| **Advanced (collapsed by default)** | Expanding shows the two rarely-touched switches: "Hide the other family command tools" (on by default; one visible hint line "Hides PowerShell's pwsh / powershell in bash sessions", with the consequence of turning it off in the tooltip) and "Allow LAN access to the panel API". |
| **Footer (one line)** | With data there are **no switches**: copy feedback (`aria-live`) + the platform / updated footnote on the right. When the panel has no data (403 / no answer from the API) the brief row does not exist, so the "Allow LAN access" switch stays here as the only way in. |

The takeover-mode / sandbox-takeover settings chips, the per-session table and the status pills are gone. 0.6.1 also removed the most technical-looking decoration: the family tags on terminal chips, the family suffix on the badge, and the duplicated switch in the footer and the brief row. Every line on the first screen now answers either "which syntax should I write?" or "what is this tool?". The panel polls `/envdock-api` every 15 seconds (only while the page is visible; an unchanged payload does not re-render, so a counter change alone may not repaint). Failures surface as a dismissible error row, copy failures included.

## What the agent sees

A brief like this is injected (content varies per machine):

```text
## 本机环境 (EnvDock 实测,优先于猜测)
- 系统: Windows_NT 10.0.26300 (x64),用户 LAPTOP-XXXX
- 默认终端: Git Bash → E:\Git\bin\bash.exe (v5.3.15)
  · 命令工具(bash 族): 宿主 `ops_bash` + `envd_shell`(EnvDock 增补,Git Bash,同语法);PowerShell 族宿主工具已隐藏(`pwsh`),不要调用 pwsh;使用分工:需要你机器上的版本(node/pnpm/python/git)时用 envd_shell,需要后台作业或沙箱提权参数时用 ops_bash
- 工具(绝对路径,直接用,不必再 where/which):
  · Node.js v24.18.0 → C:\Program Files\nodejs\node.exe [另有 v20.19.0 ...]
  · Python v3.12.10 → D:\python\python.exe [...]
  · Git v2.55.0 → E:\Git\cmd\git.exe
- 版本管理器: pyenv-win(...) [2 个版本], fnm(...) [1 个版本,激活 v20.19.0]
- `envd` 工具只能解析上面已探测到的工具;没列出的不在探测范围内(需要时用 `command -v` / `Get-Command` 自行确认,别用 `envd` 试探)。
```

The `envd` tool:

| action | Purpose |
|---|---|
| `summary` (default) | Full environment brief |
| `resolve` | Default path, version, all candidates, terminal |
| `check` | Health issue list |
| `set_default` | Switch the default version |

### Command tools: one syntax family per session

The core change in 0.6. EnvDock sorts command tools into two families:

- **bash family**: host `bash` / `sh` / `zsh` / `fish` / `ops_bash`, plus third-party bash tools recognised from name / description heuristics.
- **PowerShell family**: host `pwsh` / `powershell`.
- `cmd` and custom terminals **take no part in automatic family selection** and are never masked; manually selecting WSL counts as bash syntax.

**How the family is chosen:** in auto mode it is decided **per session** — when a session first appears and can see a bash-family host tool it is a bash-family session, otherwise PowerShell family; then it is locked. There is one fallback: within 10 seconds of first being judged PowerShell family, if a bash-family tool such as `ops_bash` shows up late (dsh-ops mounts after startup), the session may upgrade to bash family once. When the default terminal is set manually to `pwsh` / `powershell` or `bash` / `wsl`, every session uses that manual family. If the manually picked family has **neither a usable terminal nor any host tool published in that family**, EnvDock falls back to automatic selection (`familyFallback=true`, stated in the brief and the panel note) and returns to the manual family once that family becomes usable again; while detection is not ready it does not misjudge.

**Masking (on by default):** in a bash-family session, if that session can see a bash-family host tool, the host's built-in `pwsh` / `powershell` are masked — hidden from the tool table through `tools.restrict` where possible; tools published on the agent's own layer, which `restrict` cannot reach, are refused at call time (no spawn). bash-family names are never masked; heuristically recognised PowerShell-family names are display-only. Masking is undone when the "Hide the other family command tools" switch is turned off, the session family changes, the agent is disposed, or the plugin unloads. When you manually pick the PowerShell family while the session also has `ops_bash`, nothing is masked and the brief warns "both families are visible; write each command with its own syntax, do not mix them".

**When `envd_shell` is registered** (all three must hold): ① the primary family has a usable terminal (primary = the global default family: the manual family when one is selected, otherwise decided from the host tools; without a terminal the reason is `skipReason='no-family-terminal'`); ② the sandbox allows it — with no sandbox executor (or an executor that does not confine) it registers right away, while a confining executor requires **at least one session** resolving to `danger-full-access` (otherwise it would only ever refuse — a dead tool); ③ the name `envd_shell` is not taken by another plugin and registration does not throw (failed attempts retry with a 30-second backoff, immediately on `tools/change`). The 0.5 "no duplicate of the same family" rule is gone: in a bash-family session `envd_shell` (Git Bash) and the host's `ops_bash` coexisting is **expected**, and the brief states the division of labour.

- **Execution prefers the calling session's family terminal**: a bash-family session runs bash-family commands (Git Bash here), a PowerShell-family session runs PowerShell — different sessions on one machine may use different terminals. If that family has no usable terminal, EnvDock says so instead of silently running the other family's shell.
- **It refuses outright in a confined session**: `envd_shell` runs through `ctx.subprocess.spawn`, which has no `sandboxPolicy` entry — spawning on its own would bypass the sandbox. So every call re-checks **this session's** effective policy: when confined it returns `[sandbox] this session is sandbox-confined by the host (<mode>); EnvDock's envd_shell does not run commands` and tells the model to use the host tool; it neither spawns nor delegates. Unconfined sessions run normally (cwd is the current session's, output is truncated, `cwd` / `timeoutMs` are supported).
- **Sandbox is judged per session, not by the deployment default**: the executor's `sandboxMode` is only the **deployment default**; the real policy comes from `sandboxPolicy.resolve({ session })`. The legal set is closed — `read-only` / `workspace-write` / `danger-full-access`; a result of `{}`, an empty mode, or anything outside that set counts as **unknown policy** and is refused conservatively as confined (it never falls back to the deployment default). `/envdock-api` exposes only aggregates under `sandbox` (`sessionCount` / `confinedCount` / `anyUnconfined`), never per-session rows.
- **The brief is written per session**: it names the family, lists the command tools the session really sees, explains hidden / refuse-only / display-only separately, warns when both families are visible, and points at a **same-syntax** fallback when confined. The division of labour stays: use `envd_shell` for your machine's versions (node / pnpm / python / git) and the host tool for background jobs or sandbox-permission arguments.
- **Host command tools are recognised once per agent** from `tools.definitions`, using the built-in family table plus "description mentions bash / PowerShell / cmd / WSL and there is a command-like parameter". `run_cmd` (task parameter) or `ops_read_files` are never mis-claimed. That list now decides **family selection and masking targets**, but the masking list only contains the built-in `pwsh` / `powershell`.
- **bash-family names and third-party names are never masked**: that is the hard boundary of 0.6 (the tests assert that the `restrict` deny set can only be a subset of `{ pwsh, powershell }`). The point is the other family's built-in command tools, not somebody else's tools.
- **Coexisting with dsh-ops needs no settings at all**: `ops_bash` is claimed as bash family (it is published on the agent's own layer, so `restrict` can never hide it); dsh-ops' `deny-host-shell` is a guard while EnvDock is restrict + guard, and the two layers stack monotonically without conflicting. With both on, the same built-in PowerShell names get masked twice — **redundant but harmless**; nothing needs to change in this plugin or in dsh-ops.
- **Not registering never leaves the model without a tool**: the host tools are still there; EnvDock simply has no extra entry to offer.

## Settings and reset

State lives in `~/.dsh/envdock.json` (atomic writes; a corrupt file is backed up as `envdock.json.corrupt` and defaults are restored).

| Option | Default | Meaning |
|---|---|---|
| Inject brief | on | Write the environment brief into the agent context |
| Hide the other family command tools | on | In bash-family sessions, mask the host's built-in `pwsh` / `powershell`; turning it off keeps both families visible (the brief and panel only warn). In the panel it is tucked into **Advanced**, collapsed by default |
| Allow LAN | off | Once enabled, LAN clients can only **read** panel data. Every write (terminal, default version, custom tool / terminal argv, options) stays local-only; the single exception is a same-origin page turning this switch **off** (turning it on must happen locally, otherwise the terminal argv becomes a LAN-wide command-injection surface) |
| Custom tools | empty | Add tools outside PATH |

> **No takeover option since 0.5 — and a "hide the other family" switch since 0.6**: the older `shellTakeover` (auto / always / brief only) and `sandboxTakeover` (delegate / refuse) settings are gone; if an old state file still contains them, they are **ignored** (no error, no migration). 0.6 adds `blockOtherFamily` (the panel's "Hide the other family command tools"), on by default — the only switch that lets EnvDock touch somebody else's tool table, and it only affects the host's **built-in** `pwsh` / `powershell`.

```powershell
# Reset everything
Remove-Item ~/.dsh/envdock.json
```

Uninstall from the plugin page, then restart dsh.

## FAQ

**Why did my `pwsh` (or `powershell`) tool disappear?**

Because this session was judged a **bash-family** session and the "Hide the other family command tools" switch is on (the default). The 0.6 rule: in a bash-family session, when that session can see a bash-family host tool (dsh-ops' `ops_bash`, for example), the host's built-in `pwsh` / `powershell` are masked — hidden from the table where possible, refused at call time where not. The point is to give the model command tools from one syntax family only, instead of mixing two syntaxes. `cmd` and custom terminals are unaffected; bash-family names and third-party tools are never masked.

**How do I get `pwsh` back?**

Two ways, neither needs a dsh restart: ① switch the default terminal in the panel to **PowerShell 7 / Windows PowerShell** — that is a manual family choice, every session follows the PowerShell family and nothing is masked; ② turn off the "Hide the other family command tools" switch under **Advanced**, which restores the 0.5 "both families visible" behaviour (the brief then only warns "write each command with its own syntax, do not mix them"). Note that automatic family selection **locks once judged**: it will not flip back and forth when you switch terminals; only a manual choice overrides it.

**Why does the model have two command tools?**

Two cases: ① **same family** — in a bash-family session `envd_shell` (Git Bash) and the host's `ops_bash` are both bash syntax; that is **expected**, and the brief states the division of labour: use `envd_shell` for your machine's versions (node / pnpm / python / git), the host tool for background jobs or sandbox-permission arguments. ② **different families** — you manually selected the PowerShell family while the session has `ops_bash` (or the masking switch is off); then the brief and panel warn "both families are visible; write each command with its own syntax, do not mix them".

**Why does `envd_shell` refuse outright in a confined session?**

Because this session's effective policy is not `danger-full-access` (e.g. `workspace-write`). EnvDock runs through `ctx.subprocess`, which has no `sandboxPolicy` entry — spawning on its own would bypass the sandbox. So every `envd_shell` call re-checks **this session's** policy: when confined (or when the policy is unknown) it returns `[sandbox] this session is sandbox-confined by the host (<mode>); EnvDock's envd_shell does not run commands` and tells the model to use the host tool; it neither runs nor delegates. Execution uses the terminal of the **calling session's family** (bash family → Git Bash), so different sessions on the same machine may run in different terminals. The host command tool itself is confined and keeps working. To use EnvDock's terminal in that session, switch the session policy to `danger-full-access` (it applies on the next check); when **every** session is confined, EnvDock does not register at all (the note reads "No unconfined session; not registered").

**No EnvDock in the sidebar?** Check that it is enabled in the plugin page and restart dsh; confirm you installed it into the profile you boot.

**Health check says the active version manager differs from PATH?** e.g. fnm is on Node 20 while PATH resolves the system Node 24. Use absolute paths or run `fnm use` first.

**Changed the system PATH but the panel is stale?** Click re-scan; on Windows it re-reads the machine and user registry. On POSIX, or without the host `subprocess` service, restart dsh.

**What can LAN clients do?** Nothing by default. After enabling **Allow LAN** in the panel, LAN clients can only **read** panel data; every write (terminal, default version, custom tool / terminal argv, options) stays local-only. The single exception is a same-origin page turning Allow LAN **off** (turning it on must happen locally) — otherwise a LAN page could rewrite the default terminal argv, which is a command-injection surface. The switch itself stays clickable when the API answers 403.

**What do the red / yellow / grey health tiers mean?** Red = error (Store Python stub, dead default-version path, unusable default terminal, …); yellow = warning (multiple versions side by side, EOL runtime, dead PATH entries, active version manager vs. PATH drift, …); grey = info (e.g. the dsh process PATH is stale).

## Known limits

- Detection covers executables and versions; it does not parse `.nvmrc` / `pyproject.toml` / `package.json` requirements.
- Version detection needs the host `subprocess` service; without it only PATH scanning is done.
- Volta / asdf are presence-only.
- **Masking is the only exception, and it has a cost**: a bash-family session loses the host's Windows-native abilities — registry, COM and `Get-*` commands exist only in PowerShell. Switch the default terminal to the PowerShell family, or turn off "Hide the other family command tools". `cmd`, custom terminals, bash-family names and heuristically recognised third-party names are unaffected.
- **Family selection is a one-way lock**: once a session is judged it does not flip back and forth; only within 10 seconds of first being judged PowerShell family may it upgrade to bash family once (to catch dsh-ops mounting `ops_bash` late). Change it by selecting a family manually.
- **No test coverage outside Windows**: family detection works from host command-tool names common on Windows (`pwsh` / `powershell` / `ops_bash` …); the logic is isomorphic on POSIX but untested there.
- The additive `envd_shell` is a **minimal executor**: one foreground command, truncated output, `cwd` / `timeoutMs` — no background jobs, tail files or `sandbox_permissions`. Use the host command tool (always there) for those.
- In a confined session `envd_shell` refuses outright (no spawn, no delegation): `ctx.subprocess` has no `sandboxPolicy` entry, so running it would bypass the sandbox; an unknown policy is treated as confined.
- Registration requires all three conditions (primary-family terminal usable / sandbox allows / name free). When one fails there is no registration and only the host tools are listed; the reason is in the note and `commandTool.skipReason`. All sessions confined counts as "sandbox does not allow", so no dead tool is created.
- Host command tools are recognised by name token / description heuristics: failing to recognise one affects the family evidence and the detail chips, but **never how the model calls that tool**; the masking list only contains the built-in `pwsh` / `powershell`.
- Detection results are cached in memory for 45 seconds; only default-terminal / custom-terminal / default-version / custom-tool changes invalidate them (toggling allow-LAN no longer triggers a full re-scan). Rescan forces a fresh scan and clears the version cache (versions themselves are cached for 10 minutes, keyed by mtime+size).
- Working directory is the current session's, not the dsh process cwd.
- Windows-first; cross-platform details are handled but non-Windows detection is weaker.

Deep implementation notes and design trade-offs: [docs/DESIGN.md](https://github.com/tkochj/dsh-envdock/blob/main/docs/DESIGN.md) (Chinese). What changed in each version: [CHANGELOG.md](https://github.com/tkochj/dsh-envdock/blob/main/CHANGELOG.md).

## Development

```
index.js          Host: detection, envd tool, brief injection, additive command tool, /envdock-api
client.js         Client: sidebar icon + panel
cordis.patch.yml  bundle patch (insert id: envdock)
locale/           meta.title / meta.description
icon.svg          Plugin icon
CHANGELOG.md      Release notes
test/             parsers, i18n check, shared host fixture, host harness, simulator, panel render, family logic
docs/             Design notes and screenshots
```

```powershell
npm test                    # all five tests in one go (source checkout only)

node test/parsers.mjs
node test/i18n-check.mjs
node test/host-harness.mjs
node test/panel-render.mjs
node test/family.mjs        # family logic: selection, lock, 10s upgrade window, manual family, mask list, brief line

node test/simulate.mjs --help   # manual check: run the real index.js on a fake host and print the panel payload (flags vary; see --help)
```

`npm test` only works in a **source checkout**: the npm package does not ship `test/`, so an installed plugin has no tests to run. Issues and pull requests are welcome. Keep the five tests green.

## License

[MIT](LICENSE) © 2026 EnvDock contributors
