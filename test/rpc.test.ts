import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

function writeMock(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env node\n${body}`);
  chmodSync(path, 0o755);
}

function runCli(args: string[]): SpawnSyncReturns<string> {
  return spawnSync("node", ["dist/bin/minmaxxer.js", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 15_000,
  });
}

describe("codex RPC transport", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "minmaxxer-rpc-test-"));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 2 when the codex binary does not exist", () => {
    const result = runCli(["snapshot", "--codex-bin", join(dir, "no-such-codex")]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /ENOENT|no-such-codex/);
  });

  it("exits 3 with sanitized stderr detail when the app-server dies immediately", () => {
    const mock = join(dir, "codex-dies.js");
    writeMock(mock, `
console.error("auth failed for person@example.com with Bearer abc123token");
process.exit(7);
`);
    const result = runCli(["snapshot", "--codex-bin", mock]);
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /exited \(7\)/);
    assert.match(result.stderr, /\[redacted-email\]/);
    assert.match(result.stderr, /Bearer \[redacted\]/);
    assert.doesNotMatch(result.stderr, /person@example\.com/);
    assert.doesNotMatch(result.stderr, /abc123token/);
  });

  it("exits 3 on request timeout and does not hang when the child ignores SIGTERM", () => {
    const mock = join(dir, "codex-hangs.js");
    writeMock(mock, `
process.on("SIGTERM", () => {});
process.stdin.resume();
`);
    const start = Date.now();
    const result = runCli(["snapshot", "--codex-bin", mock, "--timeout", "1000"]);
    const elapsed = Date.now() - start;
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /timed out/);
    // SIGKILL escalation plus unref must let the CLI exit promptly.
    assert.ok(elapsed < 10_000, `CLI took ${elapsed}ms to exit`);
  });

  it("tolerates non-JSON and unsolicited lines on stdout", () => {
    const mock = join(dir, "codex-noisy.js");
    writeMock(mock, `
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (!msg.id) continue;
    console.log("this is not json");
    console.log(JSON.stringify({ method: "someNotification", params: {} }));
    console.log(JSON.stringify({ id: 9999, result: { unrelated: true } }));
    if (msg.method === "initialize") {
      console.log(JSON.stringify({ id: msg.id, result: {} }));
    } else if (msg.method === "account/rateLimits/read") {
      console.log(JSON.stringify({ id: msg.id, result: { rateLimits: {
        secondary: { usedPercent: 25, windowDurationMins: 10080, resetsAt: 1781830800 }
      } } }));
    }
  }
});
`);
    const result = runCli(["snapshot", "--json", "--codex-bin", mock]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.windows.weekly.used_percent, 25);
  });

  it("surfaces RPC error responses as exit 3", () => {
    const mock = join(dir, "codex-errors.js");
    writeMock(mock, `
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (!msg.id) continue;
    if (msg.method === "initialize") {
      console.log(JSON.stringify({ id: msg.id, result: {} }));
    } else {
      console.log(JSON.stringify({ id: msg.id, error: { message: "rate limits unavailable" } }));
    }
  }
});
`);
    const result = runCli(["snapshot", "--codex-bin", mock]);
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /rate limits unavailable/);
  });
});
