# Security

`autocondition` is intended to be local-only.

## Secrets

The prototype does not request, store, or print OAuth tokens. It delegates account access to the installed Codex CLI by launching `codex -s read-only -a untrusted app-server` and reading the rate-limit response over local stdio.

Do not paste access tokens into issues, logs, or shell transcripts. If future versions add direct OAuth, credentials should live in the OS keychain or another local secret store and never be printed by default.

## Network Exposure

No daemon or HTTP listener runs by default. If a future `serve` mode is added, it should bind only to `127.0.0.1` or a Unix socket, avoid account PII by default, and never return raw tokens.

## Reporting

Open a private security advisory or contact the maintainer if the tool leaks tokens, exposes usage data remotely, or allows untrusted callers to trigger Codex actions.
