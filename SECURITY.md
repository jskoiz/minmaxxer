# Security

`autocondition` is a local CLI. It does not run a daemon, expose an HTTP listener, or add telemetry.

## Secrets

`autocondition` does not request, store, or print OAuth tokens. It delegates account access to the installed Codex CLI and reads usage over local stdio. The Codex CLI can still perform its normal account, network, configuration, and logging operations.

Do not paste access tokens into issues, logs, or shell transcripts.

## Network Exposure

No daemon or HTTP listener runs. Usage is printed only to the process that invoked the CLI.

## Reporting

Open a private security advisory or contact the maintainer if the tool leaks tokens, exposes usage data remotely, or allows untrusted callers to trigger Codex actions.
