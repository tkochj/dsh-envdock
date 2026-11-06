**English** | [中文](README.md)

# EnvDock · Environment Dock

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6)
![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B32C3)

> Tell the agent, before it asks: where Node / Python / Git live on this Windows machine, which version to use, and how commands must be written in this terminal.

![EnvDock panel: default terminal and toolchain](docs/panel.png)

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
- **Optional shell takeover** — when the default terminal and the host command tool belong to different families, EnvDock registers a stable `envd_shell`, hides the host shells, and switches terminals without an empty tool window.
- **Health checks** — Store stubs, dead PATH entries, EOL versions, npm/Node mismatch, active version manager vs. PATH drift.
- **The `envd` tool** — `summary` / `resolve` / `check` / `set_default` for the agent.

## Install

**Requirements:** Windows and an installed DeepSeek Harness (dsh). Plugins are installed per profile; the commands below use `web`.

### Option 1 — Web plugin page (recommended)

1. Open **Plugins** in the dsh sidebar.
2. Choose install and provide the source:
   - local directory: `link:D:\plugins\envdock` (use your own path)
   - or a Git URL
3. Make sure **EnvDock** is enabled, then restart dsh.

### Option 2 — Command line

```powershell
# Install into the web profile; link: takes the plugin directory
dsh plugin --profile web add link:D:\plugins\envdock

# Restart web
dsh web
```

Enable EnvDock in the plugin page if it was not enabled automatically. Replace `web` with `tui`, `headless`, etc. for other profiles.

> From source: `git clone https://github.com/tkochj/dsh-envdock.git envdock`, then install it with `link:` as above. Restart dsh after source changes.

### Verify

- EnvDock appears in the sidebar and the panel lists your toolchain.
- A new session contains the `## 本机环境 (EnvDock 实测,优先于猜测)` brief.
- Ask the agent "where is node?" — it answers with an absolute path instead of searching.

## Quick start

1. Open the EnvDock panel from the sidebar.
2. Review the detected toolchain and health checks.
3. Pick default versions and a default terminal where needed.
4. Return to the session — the agent already has the updated brief.

![Health checks, brief and options](docs/health.png)

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
- Host shell sandboxed (`sandboxMode` / `sandboxPolicy`): EnvDock **never** takes over, because its `subprocess` path cannot honor per-session sandbox policies.
- If registration fails or the name is taken, EnvDock keeps the host tool instead of leaving you without any command tool.

## Settings and reset

State lives in `~/.dsh/envdock.json` (atomic writes; a corrupt file is backed up as `envdock.json.corrupt` and defaults are restored).

| Option | Default | Meaning |
|---|---|---|
| Inject brief | on | Write the environment brief into the agent context |
| Shell takeover | auto | `auto`: only for different families; `always`; `brief only` |
| Allow LAN | off | Panel API is loopback-only unless enabled |
| Custom tools | empty | Add tools outside PATH |

```powershell
# Reset everything
Remove-Item ~/.dsh/envdock.json
```

Uninstall from the plugin page, then restart dsh.

## FAQ

**No EnvDock in the sidebar?** Check that it is enabled in the plugin page and restart dsh; confirm you installed it into the profile you boot.

**The agent now has only `envd_shell` and fewer capabilities?** The takeover tool is a minimal executor: one foreground command, truncated output, `cwd` / `timeoutMs` — no background jobs, tail files or `sandbox_permissions`. Switch takeover to **brief only** to get the host tool back.

**"Sandboxed host shell, EnvDock will not take over"?** By design: a sandboxed host shell publishes its policy, and the `subprocess` bypass cannot follow it.

**Health check says the active version manager differs from PATH?** e.g. fnm is on Node 20 while PATH resolves the system Node 24. Use absolute paths or run `fnm use` first.

**Changed the system PATH but the panel is stale?** Click re-scan; on Windows it re-reads the machine and user registry. On POSIX, or without the host `subprocess` service, restart dsh.

## Known limits

- Detection covers executables and versions; it does not parse `.nvmrc` / `pyproject.toml` / `package.json` requirements.
- Version detection needs the host `subprocess` service; without it only PATH scanning is done.
- Volta / asdf are presence-only.
- The takeover executor is deliberately minimal.
- Working directory is the current session's, not the dsh process cwd.
- Windows-first; cross-platform details are handled but non-Windows detection is weaker.

Deep implementation notes and design trade-offs: [docs/DESIGN.md](docs/DESIGN.md) (Chinese).

## Development

```
index.js          Host: detection, envd tool, brief injection, terminal takeover, /envdock-api
client.js         Client: sidebar icon + panel
cordis.patch.yml  bundle patch (insert id: envdock)
locale/           meta.title / meta.description
icon.svg          Plugin icon
test/             parsers, i18n check, host harness
docs/             Design notes and screenshots
```

```powershell
node test/parsers.mjs
node test/i18n-check.mjs
node test/host-harness.mjs
```

Issues and pull requests are welcome. Keep the three tests green.

## License

[MIT](LICENSE) © 2026 EnvDock contributors
