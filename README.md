# autocondition

A local CLI that turns your installed Codex usage windows into JSON or a script-friendly exit code.

Use it to admit, defer, or prioritize optional Codex jobs from a point-in-time usage snapshot. It can answer questions like:

- Do I still have enough weekly usage left for a heavier automation run?
- Is my reset close enough that I should spend down remaining usage?
- Should this script skip now and try again later?

`autocondition` does not schedule jobs, reserve usage, predict task cost, or run Codex on your behalf. It does not run a service or add telemetry. It invokes the installed Codex CLI over local stdio; the Codex CLI still performs its normal account, network, config, and logging operations.

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

All gate conditions use AND semantics. A passed gate is only a point-in-time observation; it does not reserve capacity, so multiple jobs can pass at once.

Run a read-only review only when there is meaningful weekly usage left and the reset is close:

```bash
if autocondition gate --lane weekly --remaining-at-least 35 --resets-within 2d; then
  codex exec "Review the current branch against main. Do not modify files. Report concrete correctness risks and missing tests."
fi
```

Handle skip separately from source errors:

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

Spend remaining usage on small cleanup during the last day before reset:

```bash
if autocondition gate --lane weekly --remaining-at-least 20 --resets-within 24h; then
  codex exec "Find one small documentation improvement, make the smallest patch, and run the relevant check."
fi
```

Protect your weekly budget by skipping optional work after usage gets too high:

```bash
if autocondition gate --lane weekly --used-at-most 70; then
  codex exec "run the optional repo health sweep"
else
  echo "Skipping optional Codex automation until usage resets."
fi
```

Use session resets for short, local loops:

```bash
if autocondition gate --lane session --remaining-at-least 50; then
  codex exec "Continue the next small item from my local task list and stop after one verified change."
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
