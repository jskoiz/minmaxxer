import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

describe("minmaxxer CLI", () => {
  let dir: string;
  let mockCodex: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "minmaxxer-test-"));
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
      const rateLimits = process.env.MINMAXXER_ONLY_SESSION === "1"
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
      if (process.env.MINMAXXER_FAIL_ACCOUNT_READ === "1") {
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
      "dist/bin/minmaxxer.js",
      "snapshot",
      "--json",
      "--codex-bin",
      mockCodex,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, MINMAXXER_FAIL_ACCOUNT_READ: "1" },
    });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.windows.weekly.remaining_percent, 50);
    assert.equal(parsed.account.email, null);
  });

  it("includes account email only when requested", () => {
    const result = spawnSync("node", [
      "dist/bin/minmaxxer.js",
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
      "dist/bin/minmaxxer.js",
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
      "dist/bin/minmaxxer.js",
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
      "dist/bin/minmaxxer.js",
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
      env: { ...process.env, MINMAXXER_ONLY_SESSION: "1" },
    });

    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stdout, /indeterminate/);
  });

  it("rejects unknown options and invalid percentages", () => {
    const unknown = spawnSync("node", [
      "dist/bin/minmaxxer.js",
      "gate",
      "--remaining-atleast",
      "40",
      "--codex-bin",
      mockCodex,
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(unknown.status, 64);
    assert.match(unknown.stderr, /unknown option/);

    const invalidPercent = spawnSync("node", [
      "dist/bin/minmaxxer.js",
      "gate",
      "--remaining-at-least",
      "garbage",
      "--codex-bin",
      mockCodex,
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(invalidPercent.status, 64);
    assert.match(invalidPercent.stderr, /number from 0 to 100/);
  });

  it("prints human-readable text by default for snapshot", () => {
    const result = spawnSync("node", [
      "dist/bin/minmaxxer.js",
      "snapshot",
      "--codex-bin",
      mockCodex,
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Codex usage \(codex-cli-rpc\)/);
    assert.match(result.stdout, /- weekly: 50% used, 50% remaining/);
  });

  it("rejects the removed --pretty flag", () => {
    const result = spawnSync("node", [
      "dist/bin/minmaxxer.js",
      "snapshot",
      "--pretty",
      "--codex-bin",
      mockCodex,
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(result.status, 64);
    assert.match(result.stderr, /unknown option/);
  });

  it("suppresses gate output with --quiet", () => {
    const pass = spawnSync("node", [
      "dist/bin/minmaxxer.js",
      "gate",
      "--quiet",
      "--remaining-at-least",
      "40",
      "--codex-bin",
      mockCodex,
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(pass.status, 0, pass.stderr);
    assert.equal(pass.stdout, "");

    const skip = spawnSync("node", [
      "dist/bin/minmaxxer.js",
      "gate",
      "--quiet",
      "--remaining-at-least",
      "80",
      "--codex-bin",
      mockCodex,
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(skip.status, 10, skip.stderr);
    assert.equal(skip.stdout, "");
  });

  it("prints command-specific help", () => {
    const gateHelp = spawnSync("node", [
      "dist/bin/minmaxxer.js",
      "gate",
      "--help",
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(gateHelp.status, 0);
    assert.match(gateHelp.stdout, /minmaxxer gate —/);
    assert.match(gateHelp.stdout, /--quiet/);
    assert.doesNotMatch(gateHelp.stdout, /--include-account/);

    const snapshotHelp = spawnSync("node", [
      "dist/bin/minmaxxer.js",
      "snapshot",
      "--help",
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(snapshotHelp.status, 0);
    assert.match(snapshotHelp.stdout, /minmaxxer snapshot —/);
    assert.match(snapshotHelp.stdout, /--include-account/);
    assert.doesNotMatch(snapshotHelp.stdout, /--lane/);
  });

  it("warns when the codex version is untested", () => {
    const result = spawnSync("node", [
      "dist/bin/minmaxxer.js",
      "doctor",
      "--codex-bin",
      mockCodex,
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /warning: codex-cli 9\.9\.9 has not been verified/);

    const json = spawnSync("node", [
      "dist/bin/minmaxxer.js",
      "doctor",
      "--json",
      "--codex-bin",
      mockCodex,
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).codex_version_tested, false);
  });

  it("reports doctor status", () => {
    const result = spawnSync("node", [
      "dist/bin/minmaxxer.js",
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
