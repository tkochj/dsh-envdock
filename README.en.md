**English** | [中文](README.md)

# EnvDock · Environment Dock

[![npm](https://img.shields.io/npm/v/dsh-envdock?logo=npm)](https://www.npmjs.com/package/dsh-envdock)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6)
![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B32C3)

> Tell the agent, before it asks: where Node / Python / Git live on this Windows machine, which version to use, and how commands must be written in this terminal.

![EnvDock panel: one-line header, command-tools card, one row per tool](https://raw.githubusercontent.com/tkochj/dsh-envdock/main/docs/panel.png)

> The screenshot shows the **always-visible part of the one screen**: a one-line header (plugin name · default terminal and version · one three-state badge — here a grey "Display only" because the host already provides a same-family `pwsh`), the pinned **Terminal / Command** card (the `Command` row reads `— · host pwsh · ops_bash`, with the skip reason "Same family as pwsh; EnvDock does not duplicate it" underneath), a toolchain with one row per tool, one health-check row at its end, and a one-line brief; details are collapsed.

On Windows it is common to have several Node / Python / Git installations side by side, while cmd, PowerShell and Git Bash all disagree on syntax. Without EnvDock the agent has to probe with `where node`, guess paths, write the wrong command and retry. **EnvDock is a DeepSeek Harness (dsh) plugin** that detects your toolchain at startup, injects a ready-made environment brief into the agent's context, and optionally adds one command tool that runs your terminal (`envd_shell`) — it never hides or disables an existing tool. No configuration required.

**Who it is for:** people writing code with dsh on Windows; machines with several Node / Python / Git installations; anyone switching between PowerShell, cmd and Git Bash; anyone tired of the agent asking which node you use.

**What it does not do:** it does not install tools, change the system PATH, decide versions for you, or **hide/disable any existing tool** — it reports the facts to the agent and at most adds one extra command entry.

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
- **Optional additive command tool** — when the default terminal belongs to a different family than the host command tool, EnvDock registers a stable `envd_shell` on top (running your terminal and PATH) and **hides nothing**: the host tool stays usable and the brief states that `envd_shell` is preferred. In a confined session `envd_shell` refuses outright and you keep using the host tool.
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

The panel answers four questions on one screen: **which terminal this machine uses**, **which command tools the model has right now**, **which tools are installed**, and **whether anything is wrong**. Only the header line, the pinned **Command tools** card, the toolchain section and the footer line are always visible; details, the health-issue list and the brief body live behind their triggers. In a 720px-high window (about 600px usable) the always-visible part needs no scrolling.

| Area | What it always shows |
|---|---|
| **Header (one line)** | Plugin name · default terminal and version (e.g. `PowerShell 7 v7.4.6`) · **exactly one three-state** status badge · Rescan on the right (re-reads the system's **current** PATH; on Windows it re-reads the registry and clears the version cache). |
| **Status badge** | The panel's single conclusion, one of three states: green "Additive" (`envd_shell` is registered and visible right now), muted "Display only" (not registered — the panel only lists the host command tools), yellow "Confined" (some sessions are confined, so `envd_shell` refuses there). Hover for the text of up to two notes. |
| **Command-tools card · Terminal** | `Terminal` chips: `Auto` + every detected terminal + `+` (custom terminal: path / name / argument template). Switching applies immediately. |
| **Command-tools card · Command** | The `Command` row: `envd_shell` (**`—` when not registered**) · host tool names (e.g. `host ops_bash · pwsh`; "No host command tool recognized" when there is none) + Details on the right. Hover explains where each one's environment / PATH comes from. |
| **Notes (at most two lines)** | Only when needed: why it is not registered (`Same family as ops_bash; EnvDock does not duplicate it` / `No unconfined session; not registered` / `Name taken by another plugin; not registered` / `Registration failed; not registered`), `N sessions are confined: envd_shell will refuse; use the host tool`, and one static hint (`The host tool environment/PATH may differ from yours; use envd_shell for your terminal`). |
| **Details (collapsed by default)** | `scans: N · last: Xms · register tries: N` + host-tool chips (`name · family`; heuristically recognised ones carry a ✦ "auto-detected" mark) + the last error. |
| **Toolchain** | One row per tool: group name (only on the group's first row) · name · version · path (**click the path to copy**) · "N versions ▾" at the end of the row (candidates and "set as default" appear only after expanding). Version managers are one row each (the active version carries ←), followed by the "+ Custom tool" entry. |
| **Health check (one line, end of the toolchain)** | `✓ Pass` when healthy; otherwise `⚠ N issue(s)` plus the first title, expanding into the full list (red / yellow / grey). |
| **Environment brief (one line)** | State (injected for the agent / brief injection off) + Copy + Expand; the text appears only after expanding. |
| **Footer (one line)** | Two switches (brief injection; Allow LAN — still clickable when the API answers 403) + copy feedback (`aria-live`) + a footnote (system · arch · hostname · updated). |

The takeover-mode / sandbox-takeover settings chips, the per-session table and the status pills are gone: EnvDock masks nothing, so there is no "per-session outcome" left to report. The panel polls `/envdock-api` every 15 seconds (only while the page is visible; an unchanged payload does not re-render, so a counter change alone may not repaint). Failures surface as a dismissible error row, copy failures included.

## What the agent sees

A brief like this is injected (content varies per machine):

```text
## 本机环境 (EnvDock 实测,优先于猜测)
- 系统: Windows_NT 10.0.26300 (x64),用户 LAPTOP-XXXX
- 默认终端: Windows PowerShell → C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe (v5.1.26100)
  · 串联用 `;`,条件串联 `&&`/`||` 只有 PowerShell 7 支持
  · 环境变量 `$env:NAME`,调用外部程序要 `& $exe` 或用完整路径
  · 命令工具: `envd_shell`(EnvDock 增补,用 Windows PowerShell 语法) + 宿主 `ops_bash`(bash / sh);二者都可用,优先 `envd_shell`(它用你的 PATH/终端),需要宿主语义时再用宿主工具
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

### Command tools: additive, not takeover

EnvDock **hides and disables nothing**: the host's own command tools (`ops_bash` / `pwsh` / `bash` …) stay exactly as they are. EnvDock only decides whether to **add** an `envd_shell` on top — one that runs commands with your configured default terminal and PATH.

- **When it is registered** (all four must hold): ① the default terminal resolves to a usable executable; ② none of the recognised host command tools belongs to the **same family** (one shell is never provided twice); ③ the sandbox allows it — with no sandbox executor (or an executor that does not confine) it registers right away, while a confining executor requires **at least one session** resolving to `danger-full-access` (otherwise the tool could only ever refuse in confined sessions — a dead tool); ④ the name `envd_shell` is not taken by another plugin and registration does not throw. If any condition fails there is no registration, and the panel note plus `commandTool.skipReason` in `/envdock-api` give the reason (`same-family` / `no-unconfined-session` / `taken` / `error`); a failed registration is retried with a 30-second backoff, immediately on `tools/change`.
- **It refuses outright in a confined session**: `envd_shell` runs through `ctx.subprocess.spawn`, which has no `sandboxPolicy` entry — spawning on its own would bypass the sandbox. So every call re-checks **this session's** effective policy: when confined it returns `[sandbox] this session is sandbox-confined by the host (<mode>); EnvDock's envd_shell does not run commands` and tells the model to use the host tool; it neither spawns nor delegates. Unconfined sessions run normally (cwd is the current session's, output is truncated, `cwd` / `timeoutMs` are supported).
- **Sandbox is judged per session, not by the deployment default**: the executor's `sandboxMode` is only the **deployment default**; the real policy comes from `sandboxPolicy.resolve({ session })`. The legal set is closed — `read-only` / `workspace-write` / `danger-full-access`; a result of `{}`, an empty mode, or anything outside that set counts as **unknown policy** and is refused conservatively as confined (it never falls back to the deployment default). `/envdock-api` exposes only aggregates under `sandbox` (`sessionCount` / `confinedCount` / `anyUnconfined`), never per-session rows.
- **The brief speaks for what the model can actually use**: when registered it lists `envd_shell` (EnvDock additive, your terminal) + the host tools and says **prefer `envd_shell`** (it uses your PATH / terminal), falling back to the host tool when host semantics are needed; same family reads "`<host tool>` (same family as the default terminal, EnvDock does not duplicate it)"; any other skip reason reads "use the host `<tools>`" plus one sentence. In a confined session it appends "`envd_shell` is confined in this session, it will be refused, use the host tool".
- **Host command tools are display-only**: they are recognised from `tools.definitions` (once per agent) with the built-in family table plus "description mentions bash / PowerShell / cmd / WSL and a command-like parameter", then sorted into `commandTool.hostTools` and the panel's details. `ops_bash` is on the built-in bash family list and needs no command parameter once matched there; `run_cmd` (task parameter) or `ops_read_files` are never mis-claimed. That list answers "what command tools exist" and **takes no part in any masking or disabling**.
- **No `restrict`, no `guard`, no `tools/pre-execute`**: this is the hardest invariant of the model (the tests assert that `restrict` is called zero times). EnvDock's only registry actions are registering `envd_shell` and disposing its own definition.
- **Coexisting with dsh-ops needs no settings at all**: dsh-ops' cordis mode replaces the official `pwsh` with `ops_bash`; EnvDock recognises it as bash-family, lists it as a host command tool, and adds `envd_shell` when the default terminal is a different family. Both being available is **expected** (the brief states the priority); nothing needs to change in this plugin or in dsh-ops.
- **Not registering never leaves the model without a tool**: the host tools are still there; EnvDock simply has no extra entry to offer.

## Settings and reset

State lives in `~/.dsh/envdock.json` (atomic writes; a corrupt file is backed up as `envdock.json.corrupt` and defaults are restored).

| Option | Default | Meaning |
|---|---|---|
| Inject brief | on | Write the environment brief into the agent context |
| Allow LAN | off | Once enabled, LAN clients can only **read** panel data. Every write (terminal, default version, custom tool / terminal argv, options) stays local-only; the single exception is a same-origin page turning this switch **off** (turning it on must happen locally, otherwise the terminal argv becomes a LAN-wide command-injection surface) |
| Custom tools | empty | Add tools outside PATH |

> **0.5 has no takeover option**: the older `shellTakeover` (auto / always / brief only) and `sandboxTakeover` (delegate / refuse) settings are gone. If an old state file still contains them, they are **ignored** (no error, no migration): EnvDock only ever adds `envd_shell`, and whether it is registered is decided by the terminal / host tools / sandbox conditions, not by a switch.

```powershell
# Reset everything
Remove-Item ~/.dsh/envdock.json
```

Uninstall from the plugin page, then restart dsh.

## FAQ

**Why does the model have two command tools (`envd_shell` and `ops_bash`)?**

That is the 0.5 design: EnvDock is **additive, never masking**. The host command tools (`ops_bash` / `pwsh` …) stay exactly as they are, and EnvDock additionally registers an `envd_shell` (running your configured terminal and PATH) when its registration conditions hold. Both are usable; the brief states the priority: **prefer `envd_shell`** (it uses your PATH / terminal) and use the host tool when you need host semantics (for example when you deliberately want the host's environment). To have one entry fewer, switch the default terminal to the host's family — EnvDock then treats it as "one shell is never provided twice" and does not register `envd_shell` (the note reads "Same family as `ops_bash`; EnvDock does not duplicate it").

**Why does `envd_shell` refuse outright in a confined session?**

Because this session's effective policy is not `danger-full-access` (e.g. `workspace-write`). EnvDock runs through `ctx.subprocess`, which has no `sandboxPolicy` entry — spawning on its own would bypass the sandbox. So every `envd_shell` call re-checks **this session's** policy: when confined (or when the policy is unknown) it returns `[sandbox] this session is sandbox-confined by the host (<mode>); EnvDock's envd_shell does not run commands` and tells the model to use the host tool; it neither runs nor delegates. The host command tool itself is confined and keeps working. To use EnvDock's terminal in that session, switch the session policy to `danger-full-access` (it applies on the next check); when **every** session is confined, EnvDock does not register at all (the note reads "No unconfined session; not registered").

**No EnvDock in the sidebar?** Check that it is enabled in the plugin page and restart dsh; confirm you installed it into the profile you boot.

**Health check says the active version manager differs from PATH?** e.g. fnm is on Node 20 while PATH resolves the system Node 24. Use absolute paths or run `fnm use` first.

**Changed the system PATH but the panel is stale?** Click re-scan; on Windows it re-reads the machine and user registry. On POSIX, or without the host `subprocess` service, restart dsh.

**What can LAN clients do?** Nothing by default. After enabling **Allow LAN** in the panel, LAN clients can only **read** panel data; every write (terminal, default version, custom tool / terminal argv, options) stays local-only. The single exception is a same-origin page turning Allow LAN **off** (turning it on must happen locally) — otherwise a LAN page could rewrite the default terminal argv, which is a command-injection surface. The switch itself stays clickable when the API answers 403.

**What do the red / yellow / grey health tiers mean?** Red = error (Store Python stub, dead default-version path, unusable default terminal, …); yellow = warning (multiple versions side by side, EOL runtime, dead PATH entries, active version manager vs. PATH drift, …); grey = info (e.g. the dsh process PATH is stale).

## Known limits

- Detection covers executables and versions; it does not parse `.nvmrc` / `pyproject.toml` / `package.json` requirements.
- Version detection needs the host `subprocess` service; without it only PATH scanning is done.
- Volta / asdf are presence-only.
- **EnvDock masks and disables nothing**: host command tools stay as they are, `envd_shell` is only an additive entry. "The model has two command tools at once" is therefore expected behaviour, and the priority is written in the brief; there is no switch that makes EnvDock hide somebody else's tool.
- The additive `envd_shell` is a **minimal executor**: one foreground command, truncated output, `cwd` / `timeoutMs` — no background jobs, tail files or `sandbox_permissions`. Use the host command tool (always there) for those.
- In a confined session `envd_shell` refuses outright (no spawn, no delegation): `ctx.subprocess` has no `sandboxPolicy` entry, so running it would bypass the sandbox; an unknown policy is treated as confined.
- Registration requires all four conditions (usable terminal / no same-family host tool / sandbox allows / name free). When one fails there is no registration and only the host tools are listed; the reason is in the note and `commandTool.skipReason`. All sessions confined counts as "sandbox does not allow", so no dead tool is created.
- Host command tools are recognised by name token / description heuristics and are **display-only**: failing to recognise one only means one chip missing in the details — it does not change how the model calls that tool, nor whether EnvDock adds its own.
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
test/             parsers, i18n check, shared host fixture, host harness, simulator, panel render (266 assertions)
docs/             Design notes and screenshots
```

```powershell
npm test                    # all four tests in one go (source checkout only)

node test/parsers.mjs
node test/i18n-check.mjs
node test/host-harness.mjs
node test/panel-render.mjs

node test/simulate.mjs --help   # manual check: run the real index.js on a fake host and print the panel payload (--mode / --host-tools / --executor / --policy …)
```

`npm test` only works in a **source checkout**: the npm package does not ship `test/`, so an installed plugin has no tests to run. Issues and pull requests are welcome. Keep the four tests green.

## License

[MIT](LICENSE) © 2026 EnvDock contributors
