# minmaxxer

[![CI](https://github.com/jskoiz/minmaxxer/actions/workflows/ci.yml/badge.svg)](https://github.com/jskoiz/minmaxxer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`minmaxxer gate` exits `0` when your Codex usage says "go" and `10` when it says "skip" — so a cron job or git hook can stop burning your weekly budget on low-value work, or spend it before it resets. One line of shell, no daemon, no config; it reads what your installed Codex CLI already knows over local stdio.

```bash
if minmaxxer gate --lane weekly --remaining-at-least 30 --resets-within 3d; then
  codex exec "Review the current branch against main and report risks."
fi
```

Want the numbers instead of a yes/no? `snapshot` gives you a point-in-time view:

```text
$ minmaxxer snapshot
Codex usage (codex-cli-rpc)
- session: 12% used, 88% remaining, resets in 3h
- weekly: 64% used, 36% remaining, resets in 2d
```

> Experimental: depends on the Codex app-server interface. Verified against `codex-cli 0.139.0`; `minmaxxer doctor` warns on unverified versions.

## Install

Not on npm yet — install from source:

```bash
git clone https://github.com/jskoiz/minmaxxer.git
cd minmaxxer
npm install && npm link
```

Requires Node.js 20+ and a signed-in Codex CLI that reports ChatGPT-backed rate-limit windows.

## Usage

```bash
minmaxxer snapshot            # human-readable text; --json for machine output
minmaxxer gate --lane weekly --remaining-at-least 30 --resets-within 3d
minmaxxer doctor              # checks the Codex binary and RPC connectivity
```

Gate conditions — all given conditions must pass (AND semantics), and at least one is required:

- `--lane <session|weekly>` — which usage window to check (default: weekly)
- `--remaining-at-least <n>` — remaining percent is at least `n`
- `--used-at-most <n>` — used percent is at most `n`
- `--resets-within <dur>` — window resets within a duration like `12h` or `3d`

Every command supports `--help`. `gate --quiet` suppresses output when only the exit code matters.

Exit codes:

```text
0  success or gate passed
10 gate condition false — usage was readable, your policy said no
2  local Codex usage is unavailable
3  local Codex usage returned an error
64 invalid arguments
```

Treat `2`, `3`, and `64` as real errors in automation; only `10` is a clean "skip this time."

## Recipes

Tell a real skip apart from a broken source:

```bash
if minmaxxer gate --lane weekly --remaining-at-least 35 --resets-within 2d; then
  codex exec "Review this repo in read-only mode and write a concise risk report."
else
  status=$?
  case "$status" in
    10) echo "Skipped: usage policy not met." ;;
    *) echo "minmaxxer could not evaluate usage policy." >&2; exit "$status" ;;
  esac
fi
```

Spend remaining usage on small cleanup during the last day before a reset:

```bash
if minmaxxer gate --lane weekly --remaining-at-least 20 --resets-within 24h; then
  codex exec "Find one small documentation improvement, make the smallest patch, and run the relevant check."
fi
```

The human-readable output says exactly why a gate skipped (`skip: weekly.remaining_percent=20 is below required 30`), and the same pattern works anywhere an exit code decides: cron, launchd, git hooks, CI. Use `--used-at-most` to cap optional work and `--lane session` for short local loops.

## JSON output

Use `snapshot --json` when you want to make the decision yourself:

```bash
minmaxxer snapshot --json | jq '.windows.weekly.remaining_percent'
```

The useful fields per window are `used_percent`, `remaining_percent`, `resets_at`, `seconds_until_reset`, and `reset_in`, plus `credits.balance`. `reset_in` is display text; script against `seconds_until_reset` or `resets_at`.

## Scope

`minmaxxer` does not schedule jobs, reserve usage, predict task cost, or run Codex for you — a passed gate is a point-in-time observation, so concurrent jobs can all pass at once. It runs no server and adds no telemetry; it invokes your installed Codex CLI over local stdio using your existing login, and never requests account details unless you pass `--include-account`.

## Development

```bash
npm test
npm run check
```
