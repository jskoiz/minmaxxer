# autocondition

Make your Codex automations budget-aware with one line of shell.

`autocondition gate` reads your live Codex usage window and exits `0` or `10` — so a cron job, git hook, or script can decide for itself whether now is a good time to spend usage:

```bash
if autocondition gate --lane weekly --remaining-at-least 30 --resets-within 3d; then
  codex exec "Review the current branch against main and report risks."
fi
```

That is the whole idea: exit `0` means "go," exit `10` means "skip this time." No daemon, no config file, no second account — it just reads the usage your installed Codex CLI already knows about over local stdio.

Want the numbers instead of a yes/no? `snapshot` gives you a point-in-time view:

```text
$ autocondition snapshot --pretty
Codex usage (codex-cli-rpc)
- session: 12% used, 88% remaining, resets in 3h
- weekly: 64% used, 36% remaining, resets in 2d
```

**Why you'd want this:** you don't want a nightly automation burning your weekly Codex budget on low-value work — or leaving it unspent right before it resets. `autocondition` lets the exit code make that call for you.

> Experimental: `autocondition` depends on the Codex app-server interface used by the installed Codex CLI. Known local check: `codex-cli 0.139.0`.

## Requirements

- Node.js 20 or later
- An installed Codex CLI
- A signed-in Codex account that reports ChatGPT-backed rate-limit windows

## Install

From source:

```bash
npm install
npm link
```

## Commands

```bash
autocondition snapshot --json
autocondition gate --lane weekly --remaining-at-least 30 --resets-within 3d
autocondition doctor
```

Exit codes:

```text
0  success or gate passed
10 gate condition false
2  local Codex usage is unavailable
3  local Codex usage returned an error
64 invalid arguments
```

`10` means the usage data was readable and the policy was false. `2`, `3`, and `64` should be treated as real errors by automation.

## Automation Examples

All gate conditions use AND semantics.

The most important pattern is telling a real skip apart from a broken source. Exit `10` means usage was readable and your policy said no; `2` and `3` mean the usage data could not be read at all:

```bash
if autocondition gate --lane weekly --remaining-at-least 35 --resets-within 2d; then
  codex exec "Review this repo in read-only mode and write a concise risk report."
else
  status=$?
  case "$status" in
    10) echo "Skipped: usage policy not met." ;;
    *) echo "autocondition could not evaluate usage policy." >&2; exit "$status" ;;
  esac
fi
```

The human-readable output tells you exactly why a gate skipped:

```text
$ autocondition gate --lane weekly --remaining-at-least 30
skip: weekly.remaining_percent=20 is below required 30
```

Spend remaining usage on small cleanup during the last day before a reset:

```bash
if autocondition gate --lane weekly --remaining-at-least 20 --resets-within 24h; then
  codex exec "Find one small documentation improvement, make the smallest patch, and run the relevant check."
fi
```

Cap optional work by how much you have already used (`--used-at-most`), and use `--lane session` for short local loops:

```bash
if autocondition gate --lane weekly --used-at-most 70; then
  codex exec "run the optional repo health sweep"
fi
```

Pair it with cron or launchd by letting the exit code decide whether the job runs:

```bash
autocondition gate --lane weekly --remaining-at-least 35 --resets-within 2d \
  && codex exec "Inspect stale local branches and recommend keep, rebase, extract, or delete."
```

## Snapshot Output

Use `snapshot` when you want to make your own decision in a script:

```bash
autocondition snapshot --json | jq '.windows.weekly.remaining_percent'
autocondition snapshot --json | jq -r '.windows.weekly.reset_in'
autocondition snapshot --json | jq '.credits.balance'
```

The fields most useful for automations are `used_percent`, `remaining_percent`, `resets_at`, `seconds_until_reset`, `reset_in`, and `credits.balance`. Treat `reset_in` as display text; use `seconds_until_reset` and `resets_at` for scripts.

## What it doesn't do

`autocondition` does not schedule jobs, reserve usage, predict task cost, or run Codex on your behalf. It does not run a service or add telemetry. It invokes the installed Codex CLI over local stdio; the Codex CLI still performs its normal account, network, config, and logging operations.

A passed gate is only a point-in-time observation; it does not reserve capacity, so multiple jobs can pass at once.

## Security

- This tool does not run its own server or daemon.
- It uses your existing Codex login.
- Use `--include-account` only when you explicitly want the account email in JSON output.
- Without `--include-account`, `autocondition` does not request account details from the Codex app-server.

## Development

```bash
npm test
npm run check
node bin/autocondition.js doctor --json
```
