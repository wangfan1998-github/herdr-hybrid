<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.png">
    <img src="docs/assets/banner-light.png" alt="herdr-hybrid" width="100%">
  </picture>
</p>

<p align="center">
  <strong>Let your smartest model lead. Let the cheap ones build.</strong><br>
  Hybrid orchestration for Claude Code: one config for every gateway, key and model; a Leader that plans, verifies and reviews; workers that build in parallel; one herdr tab per worker.
</p>

<p align="center">
  <a href="#why-hybrid">Why hybrid</a> ·
  <a href="#why-herdr">Why herdr</a> ·
  <a href="#three-minutes">Get started</a> ·
  <a href="#showcase">Showcase</a> ·
  <a href="#config">Config</a> ·
  <a href="README.md">中文</a>
</p>

<br>

## Why hybrid

One Claude Code writing a feature end to end burns your most expensive tokens on planning *and* on typing, and it can only do one thing at a time. Meanwhile the other models you pay for sit in shell aliases nobody can script.

herdr-hybrid turns those models into a team:

<table>
  <tr>
    <td width="25%" valign="top"><strong>Expensive tokens only for judgement</strong><br>The Leader decomposes, verifies, organises review and reports. Implementation, scripts and batch work go to cheap profiles, each a headless <code>claude -p</code> process.</td>
    <td width="25%" valign="top"><strong>Parallel, not queued</strong><br>Every subtask is its own process, session and working directory. Frontend and backend start together; review overlaps with implementation.</td>
    <td width="25%" valign="top"><strong>The writer is never the reviewer</strong><br>Review runs on a different profile, read-only. The Leader still runs the build, the tests and <code>git log</code> itself. Nobody's self-report is trusted.</td>
    <td width="25%" valign="top"><strong>Same toolchain</strong><br>It is still Claude Code. <code>hh init</code> imports your existing aliases and gateway config; <code>hh claude fast</code> is your old <code>fastcc</code>.</td>
  </tr>
</table>

<p align="center"><picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture-dark.png">
    <img src="docs/assets/architecture-light.png" alt="architecture" width="100%">
  </picture></p>

The Leader works from principles, not keywords. At launch it receives the live role roster (who is good at what) and the profile list, then decides for every request what changes, what capability it needs and how completion will be proven. Workers end with a JSON report (files changed, verification commands run, assumptions); the Leader checks data, and follow-ups resume the same session.

## Why herdr

Headless processes are invisible. [herdr](https://herdr.dev) adds the window and nothing else:

- **One tab per worker** with the transcript scrolling live: which files it reads, which tools it calls, where it is stuck. Created with `--no-focus`, so your cursor stays put.
- **The workspace is the dashboard.** Tab 1 is the Leader; the rest are opened and closed by the Leader (`hh close`).
- **State never goes through the window.** Completion is decided by `result.json` and the process. Close a tab and nothing is lost; without herdr everything still runs, just unwatched.

<p align="center"><picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/herdr-dark.png">
    <img src="docs/assets/herdr-light.png" alt="herdr workspace" width="100%">
  </picture></p>

## Three minutes

Requires Node ≥ 18 and Claude Code. herdr is optional.

```bash
git clone https://github.com/wangfan1998-github/herdr-hybrid.git && cd herdr-hybrid
./install.sh                                # hh → ~/.local/bin, Leader skill → ~/.claude/skills, runs hh init
hh roles set coder --profile fast           # cheap and fast does the work
hh roles set reviewer --profile official    # smart one reviews
hh profiles test fast                       # real round trip
hh leader smart                         # your smartest profile leads
hh claude                                   # start the Leader in a herdr tab, then just describe the task
```

<p align="center"><picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/loop-dark.png">
    <img src="docs/assets/loop-light.png" alt="Leader loop" width="100%">
  </picture></p>

## Showcase

One full loop as seen from the Leader tab (decompose → two coders in parallel → wait → re-run verification → review by a different model → follow-up in the same session → report):

<p align="center"><img src="docs/assets/showcase.gif" alt="Leader loop demo" width="100%"></p>

Real output; gateway and model names replaced with placeholders.

```text
$ hh dispatch -r coder -l e2e -d ~/work -t "Create ok.txt containing: hybrid works. Then reply: done"
run      20260902-172446-e2e-9e5c
role     coder → fast@relay(vendor/coding-fast) · full
launch   herdr tab w1:tT
status   ● running

$ hh wait 20260902-172446-e2e-9e5c
[17:24:48] 20260902-172446-e2e-9e5c=running
[17:25:18] 20260902-172446-e2e-9e5c=done
ALL_SETTLED (30s)
```

The worker's structured report:

```json
{ "status": "done", "summary": "created note.txt, verified",
  "changed": ["note.txt"], "commits": [],
  "verified": [{ "cmd": "cat note.txt", "ok": true }],
  "assumptions": ["not a git repo, nothing committed"], "blockers": [] }
```

Inside an agent's shell every command above returns JSON.

## Config

`~/.config/hh/config.json` (mode 600):

```json
{
  "leader": "smart",
  "gateways": { "relay": { "url": "https://relay.example.com", "auth": "token", "secret": "env:RELAY_KEY" } },
  "profiles": {
    "official": { "gateway": null },
    "fast":     { "gateway": "relay", "model": "vendor/coding-fast" },
    "smart":    { "gateway": "relay", "model": "vendor/reasoning-max" }
  },
  "roles": {
    "coder":    { "profile": "fast",     "autonomy": "full",     "desc": "implement within a clear boundary, run verification, commit per file" },
    "reviewer": { "profile": "official", "autonomy": "readonly", "desc": "read-only diff review with severity-ranked findings" }
  }
}
```

A profile is gateway + key + model. Roles are data: any name, `desc` tells the Leader what it is for, `autonomy` maps to `--permission-mode`. Secrets live only in this file (or `env:VAR`) and are masked in every output.

Docs: [config](docs/config.md) · [profiles & report contract](docs/profiles.md) · [observability](docs/observability.md) · [troubleshooting](docs/troubleshooting.md) · [Leader protocol](skill/herdr-leader/SKILL.md)

<p align="center"><sub>Optional viewer built on <a href="https://herdr.dev">herdr</a> · README structure after <a href="https://github.com/0x0funky/agent-sprite-forge">agent-sprite-forge</a>, design guidance from <a href="https://github.com/pbakaus/impeccable">impeccable</a> · MIT</sub></p>
