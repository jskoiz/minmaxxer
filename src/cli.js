import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseDurationSeconds } from "./duration.js";
import { evaluateGate, normalizeRateLimitsPayload } from "./normalize.js";
import { CodexRpcError, fetchCodexRpcSnapshot } from "./rpc.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));

const EXIT = {
  ok: 0,
  gateFalse: 10,
  sourceUnavailable: 2,
  sourceError: 3,
  args: 64,
};

export async function main(argv, io) {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    io.stdout.write(helpText());
    return EXIT.ok;
  }
  if (command === "--version" || command === "-v") {
    io.stdout.write(`${packageJson.version}\n`);
    return EXIT.ok;
  }

  try {
    if (command === "snapshot") return await snapshotCommand(argv.slice(1), io);
    if (command === "gate") return await gateCommand(argv.slice(1), io);
    if (command === "doctor") return await doctorCommand(argv.slice(1), io);
  } catch (error) {
    if (error instanceof CodexRpcError && (error.code === "START_FAILED" || error.code === "NOT_RUNNING")) {
      io.stderr.write(`${error.message}\n`);
      return EXIT.sourceUnavailable;
    }
    if (error instanceof CodexRpcError) {
      io.stderr.write(`${error.message}\n`);
      return EXIT.sourceError;
    }
    io.stderr.write(`${error.message}\n`);
    return EXIT.args;
  }

  io.stderr.write(`unknown command: ${command}\n\n${helpText()}`);
  return EXIT.args;
}

async function snapshotCommand(argv, io) {
  const args = parseOptions(argv);
  const snapshot = await loadSnapshot(args, io.env);
  writeSnapshot(snapshot, args, io.stdout);
  return EXIT.ok;
}

async function gateCommand(argv, io) {
  const args = parseOptions(argv);
  const snapshot = await loadSnapshot(args, io.env);
  const gate = evaluateGate(snapshot, {
    lane: args.lane ?? "weekly",
    remainingAtLeast: args["remaining-at-least"],
    usedAtMost: args["used-at-most"],
    resetsWithinSeconds: args["resets-within"] ? parseDurationSeconds(args["resets-within"]) : undefined,
  });

  if (args.json) {
    io.stdout.write(`${JSON.stringify(gate, null, 2)}\n`);
  } else {
    io.stdout.write(`${gate.pass ? "pass" : "skip"}: ${gate.reason}\n`);
  }
  return gate.pass ? EXIT.ok : EXIT.gateFalse;
}

async function doctorCommand(argv, io) {
  const args = parseOptions(argv);
  const codexBin = resolveCodexBin(args, io.env);
  const version = spawnSync(codexBin, ["--version"], { encoding: "utf8" });
  const report = {
    codex_bin: codexBin,
    codex_version_ok: version.status === 0,
    codex_version: version.status === 0 ? version.stdout.trim() : null,
    rpc_ok: false,
    error: null,
  };

  try {
    await loadSnapshot(args, io.env);
    report.rpc_ok = true;
  } catch (error) {
    report.error = error.message;
  }

  if (args.json) {
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    io.stdout.write(`codex binary: ${report.codex_bin}\n`);
    io.stdout.write(`codex --version: ${report.codex_version_ok ? report.codex_version : "failed"}\n`);
    io.stdout.write(`rpc snapshot: ${report.rpc_ok ? "ok" : "failed"}\n`);
    if (report.error) io.stdout.write(`error: ${report.error}\n`);
  }

  if (!report.codex_version_ok) return EXIT.sourceUnavailable;
  return report.rpc_ok ? EXIT.ok : EXIT.sourceError;
}

async function loadSnapshot(args, env) {
  const rpc = await fetchCodexRpcSnapshot({
    codexBin: resolveCodexBin(args, env),
    timeoutMs: Number(args.timeout ?? 8000),
    requestTimeoutMs: Number(args["request-timeout"] ?? 3000),
    env,
  });
  return normalizeRateLimitsPayload(rpc.rateLimits, rpc.account, {
    includeAccount: Boolean(args["include-account"]),
    version: packageJson.version,
  });
}

function writeSnapshot(snapshot, args, stdout) {
  if (args.json || !args.pretty) {
    stdout.write(`${JSON.stringify(snapshot, null, args.pretty ? 2 : 0)}\n`);
    return;
  }
  stdout.write(`Codex usage (${snapshot.source})\n`);
  for (const [lane, window] of Object.entries(snapshot.windows)) {
    stdout.write(`- ${lane}: ${window.used_percent}% used, ${window.remaining_percent}% remaining`);
    if (window.reset_in) stdout.write(`, resets in ${window.reset_in}`);
    stdout.write("\n");
  }
  if (snapshot.credits?.balance !== null && snapshot.credits?.balance !== undefined) {
    stdout.write(`- credits: ${snapshot.credits.balance}\n`);
  }
}

function resolveCodexBin(args, env) {
  return args["codex-bin"] ?? env.CODEX_USAGE_CODEX_BIN ?? "codex";
}

function parseOptions(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    if (["json", "pretty", "include-account"].includes(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

function helpText() {
  return `autocondition ${packageJson.version}

Local-only Codex usage snapshot and automation gate.

Usage:
  autocondition snapshot [--json] [--pretty] [--include-account]
  autocondition gate --lane weekly --remaining-at-least 30 --resets-within 3d [--json]
  autocondition doctor [--json]

Options:
  --codex-bin <path>        Codex executable. Default: codex
  --timeout <ms>            RPC initialize timeout. Default: 8000
  --request-timeout <ms>    RPC request timeout. Default: 3000
  --lane <session|weekly>   Gate lane. Default: weekly
  --remaining-at-least <n>  Pass when remaining percent is at least n
  --used-at-most <n>        Pass when used percent is at most n
  --resets-within <dur>     Pass when reset is within duration, e.g. 12h or 3d

Exit codes:
  0  success or gate passed
  10 gate condition false
  2  Codex source unavailable
  3  Codex source error
`;
}
