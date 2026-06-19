# autocondition

Minimal local-only Codex usage snapshots for automation gates.

`autocondition` talks to the local Codex CLI app-server over JSON-RPC. It does not scrape the terminal UI, does not require a daemon, and does not print OAuth tokens. By default it also omits account email from output.

## Install

Prototype checkout:

```bash
npm install
npm link
```

Future packaging targets:

```bash
brew tap <owner>/autocondition
brew install autocondition
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
2  Codex source unavailable
3  Codex source error
64 invalid arguments
```

## Automation Example

```bash
if autocondition gate --lane weekly --remaining-at-least 40 --resets-within 3d; then
  codex exec "run the high-value backlog automation"
fi
```

## Snapshot Shape

```json
{
  "tool": "autocondition",
  "version": "0.1.0",
  "source": "codex-cli-rpc",
  "updated_at": "2026-06-19T00:00:00.000Z",
  "account": {
    "type": "chatgpt",
    "plan": "pro",
    "email": null
  },
  "windows": {
    "session": {
      "used_percent": 20,
      "remaining_percent": 80,
      "window_minutes": 300,
      "resets_at": "2026-06-19T05:00:00.000Z",
      "seconds_until_reset": 18000,
      "reset_in": "5h"
    },
    "weekly": {
      "used_percent": 50,
      "remaining_percent": 50,
      "window_minutes": 10080,
      "resets_at": "2026-06-26T00:00:00.000Z",
      "seconds_until_reset": 604800,
      "reset_in": "7d"
    }
  },
  "credits": {
    "has_credits": true,
    "unlimited": false,
    "balance": 4.5
  }
}
```

## Security

- This tool is local-only and shells out to `codex -s read-only -a untrusted app-server`.
- It does not own OAuth login in this prototype.
- It does not expose an HTTP listener by default.
- Use `--include-account` only when you explicitly want the account email in JSON output.

## Development

```bash
npm test
npm run check
node bin/autocondition.js doctor --json
```
