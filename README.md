# autocondition

Use your Codex usage more intentionally from local scripts.

`autocondition` tells your automations when it is a good time to spend Codex usage. It can answer questions like:

- Do I still have enough weekly usage left for a heavier automation run?
- Is my reset close enough that I should spend down remaining usage?
- Should this script skip now and try again later?

It runs locally, uses your existing Codex login, and does not require a background service.

## Install

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

## Automation Examples

Run a heavier backlog task only when you have meaningful weekly usage left and the reset is close:

```bash
if autocondition gate --lane weekly --remaining-at-least 40 --resets-within 3d; then
  codex exec "triage stale issues, open focused fixes, and summarize what changed"
fi
```

Spend remaining usage on low-priority cleanup during the last day before reset:

```bash
if autocondition gate --lane weekly --remaining-at-least 20 --resets-within 24h; then
  codex exec "find small documentation improvements and prepare a concise patch"
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
  codex exec "continue the next small item from my local task list"
fi
```

Pair it with cron or launchd by letting the exit code decide whether the job runs:

```bash
autocondition gate --lane weekly --remaining-at-least 35 --resets-within 2d \
  && codex exec "review my open local branches and suggest the best next action"
```

## Snapshot Output

Use `snapshot` when you want to make your own decision in a script:

```bash
autocondition snapshot --json | jq '.windows.weekly.remaining_percent'
autocondition snapshot --json | jq -r '.windows.weekly.reset_in'
autocondition snapshot --json | jq '.credits.balance'
```

The fields most useful for automations are `used_percent`, `remaining_percent`, `resets_at`, `seconds_until_reset`, `reset_in`, and `credits.balance`.

## Security

- This tool is local-only.
- It uses your existing Codex login.
- It does not start a web server or background daemon.
- Use `--include-account` only when you explicitly want the account email in JSON output.

## Development

```bash
npm test
npm run check
node bin/autocondition.js doctor --json
```
