import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

describe("autocondition CLI", () => {
  let dir;
  let mockCodex;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "autocondition-test-"));
    mockCodex = join(dir, "codex-mock.js");
    writeFileSync(mockCodex, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("codex-cli 9.9.9");
  process.exit(0);
}
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk;
  let lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (!msg.id) continue;
    if (msg.method === "initialize") {
      console.log(JSON.stringify({ id: msg.id, result: {} }));
    } else if (msg.method === "account/rateLimits/read") {
      const rateLimits = process.env.AUTOCONDITION_ONLY_SESSION === "1"
        ? {
            primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1781830800 },
            credits: { hasCredits: true, unlimited: false, balance: "4.5" },
            planType: "pro"
          }
        : {
            primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1781830800 },
            secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 1782432000 },
            credits: { hasCredits: true, unlimited: false, balance: "4.5" },
            planType: "pro"
          };
      console.log(JSON.stringify({ id: msg.id, result: { rateLimits } }));
    } else if (msg.method === "account/read") {
      if (process.env.AUTOCONDITION_FAIL_ACCOUNT_READ === "1") {
        console.error("account/read should not be called");
        process.exit(51);
      }
      console.log(JSON.stringify({ id: msg.id, result: { account: {
        type: "chatgpt",
        email: "person@example.com",
        planType: "pro"
      } } }));
    }
  }
});
`);
    chmodSync(mockCodex, 0o755);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints snapshot JSON", () => {
    const result = spawnSync("node", [
      "bin/autocondition.js",
      "snapshot",
      "--json",
      "--codex-bin",
      mockCodex,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, AUTOCONDITION_FAIL_ACCOUNT_READ: "1" },
    });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.windows.weekly.remaining_percent, 50);
    assert.equal(parsed.account.email, null);
  });

  it("includes account email only when requested", () => {
    const result = spawnSync("node", [
      "bin/autocondition.js",
      "snapshot",
      "--json",
      "--include-account",
      "--codex-bin",
      mockCodex,
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.account.email, "person@example.com");
  });

  it("uses exit code 0 for a passing gate", () => {
    const result = spawnSync("node", [
      "bin/autocondition.js",
      "gate",
      "--lane",
      "weekly",
      "--remaining-at-least",
      "40",
      "--codex-bin",
      mockCodex,
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /pass/);
  });

  it("uses exit code 10 for a false gate", () => {
    const result = spawnSync("node", [
      "bin/autocondition.js",
      "gate",
      "--lane",
      "weekly",
      "--remaining-at-least",
      "80",
      "--codex-bin",
      mockCodex,
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(result.status, 10, result.stderr);
    assert.match(result.stdout, /skip/);
  });

  it("uses source error when a gate cannot evaluate its lane", () => {
    const result = spawnSync("node", [
      "bin/autocondition.js",
      "gate",
      "--lane",
      "weekly",
      "--remaining-at-least",
      "1",
      "--codex-bin",
      mockCodex,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, AUTOCONDITION_ONLY_SESSION: "1" },
    });

    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stdout, /indeterminate/);
  });

  it("rejects unknown options and invalid percentages", () => {
    const unknown = spawnSync("node", [
      "bin/autocondition.js",
      "gate",
      "--remaining-atleast",
      "40",
      "--codex-bin",
      mockCodex,
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(unknown.status, 64);
    assert.match(unknown.stderr, /unknown option/);

    const invalidPercent = spawnSync("node", [
      "bin/autocondition.js",
      "gate",
      "--remaining-at-least",
      "garbage",
      "--codex-bin",
      mockCodex,
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(invalidPercent.status, 64);
    assert.match(invalidPercent.stderr, /number from 0 to 100/);
  });

  it("reports doctor status", () => {
    const result = spawnSync("node", [
      "bin/autocondition.js",
      "doctor",
      "--json",
      "--codex-bin",
      mockCodex,
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.codex_version_ok, true);
    assert.equal(parsed.rpc_ok, true);
  });
});
