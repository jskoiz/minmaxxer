import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseDurationSeconds } from "./duration.js";
import { evaluateGate, normalizeRateLimitsPayload, type UsageSnapshot } from "./normalize.js";
import { CodexRpcError, fetchCodexRpcSnapshot } from "./rpc.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8")) as PackageJson;

type PackageJson = {
  version: string;
};

type WritableLike = {
  write(chunk: string): unknown;
};

type CliIo = {
  stdout: WritableLike;
  stderr: WritableLike;
  env: NodeJS.ProcessEnv;
};

type Command = "snapshot" | "gate" | "doctor";

type ParsedOptions = {
  help?: boolean;
  json?: boolean;
  quiet?: boolean;
  "include-account"?: boolean;
  "codex-bin"?: string;
  timeout?: string;
  "request-timeout"?: string;
  lane?: string;
  "remaining-at-least"?: string;
  "used-at-most"?: string;
  "resets-within"?: string;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  remainingAtLeast?: number;
  usedAtMost?: number;
  resetsWithinSeconds?: number;
};

type OptionSpec = {
  booleans: Set<string>;
  values: Set<string>;
  allowed: Set<string>;
};

const EXIT = {
  ok: 0,
  gateFalse: 10,
  sourceUnavailable: 2,
  sourceError: 3,
  args: 64,
};

const MAX_TIMEOUT_MS = 120_000;

// Codex CLI versions the RPC integration has been verified against.
const TESTED_CODEX_VERSIONS = /^codex-cli 0\.139\./;

class UsageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageInputError";
  }
}

export async function main(argv: string[], io: CliIo): Promise<number> {
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
    if (error instanceof UsageInputError) {
      io.stderr.write(`${error.message}\n`);
      return EXIT.args;
    }
    io.stderr.write(`${errorMessage(error)}\n`);
    return EXIT.args;
  }

  io.stderr.write(`unknown command: ${command}\n\n${helpText()}`);
  return EXIT.args;
}

async function snapshotCommand(argv: string[], io: CliIo): Promise<number> {
  const args = parseOptions("snapshot", argv);
  if (args.help === true) {
    io.stdout.write(helpText("snapshot"));
    return EXIT.ok;
  }
  const snapshot = await loadSnapshot(args, io.env);
  writeSnapshot(snapshot, args, io.stdout);
  return EXIT.ok;
}

async function gateCommand(argv: string[], io: CliIo): Promise<number> {
  const args = parseOptions("gate", argv);
  if (args.help === true) {
    io.stdout.write(helpText("gate"));
    return EXIT.ok;
  }
  const snapshot = await loadSnapshot(args, io.env);
  const gate = evaluateGate(snapshot, {
    lane: args.lane,
    remainingAtLeast: args.remainingAtLeast,
    usedAtMost: args.usedAtMost,
    resetsWithinSeconds: args.resetsWithinSeconds,
  });

  if (args.json === true) {
    io.stdout.write(`${JSON.stringify(gate, null, 2)}\n`);
  } else if (args.quiet !== true) {
    io.stdout.write(`${gate.status}: ${gate.reason}\n`);
  }
  if (gate.status === "indeterminate") {
    if (args.quiet === true && args.json !== true) io.stderr.write(`${gate.reason}\n`);
    return EXIT.sourceError;
  }
  return gate.pass ? EXIT.ok : EXIT.gateFalse;
}

async function doctorCommand(argv: string[], io: CliIo): Promise<number> {
  const args = parseOptions("doctor", argv);
  if (args.help === true) {
    io.stdout.write(helpText("doctor"));
    return EXIT.ok;
  }
  const codexBin = resolveCodexBin(args, io.env);
  const version = spawnSync(codexBin, ["--version"], {
    encoding: "utf8",
    timeout: 3000,
  });
  const codexVersion = version.status === 0 ? version.stdout.trim() : null;
  const report = {
    codex_bin: codexBin,
    codex_version_ok: version.status === 0,
    codex_version: codexVersion,
    codex_version_tested: codexVersion !== null && TESTED_CODEX_VERSIONS.test(codexVersion),
    rpc_ok: false,
    error: null as string | null,
  };

  try {
    await loadSnapshot(args, io.env);
    report.rpc_ok = true;
  } catch (error) {
    report.error = errorMessage(error);
  }

  if (args.json === true) {
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    io.stdout.write(`codex binary: ${report.codex_bin}\n`);
    io.stdout.write(`codex --version: ${report.codex_version_ok ? report.codex_version : "failed"}\n`);
    io.stdout.write(`rpc snapshot: ${report.rpc_ok ? "ok" : "failed"}\n`);
    if (report.codex_version_ok && !report.codex_version_tested) {
      io.stdout.write(`warning: ${report.codex_version} has not been verified with minmaxxer; the app-server interface may differ\n`);
    }
    if (report.error) io.stdout.write(`error: ${report.error}\n`);
  }

  if (!report.codex_version_ok) return EXIT.sourceUnavailable;
  return report.rpc_ok ? EXIT.ok : EXIT.sourceError;
}

async function loadSnapshot(args: ParsedOptions, env: NodeJS.ProcessEnv): Promise<UsageSnapshot> {
  const rpc = await fetchCodexRpcSnapshot({
    codexBin: resolveCodexBin(args, env),
    timeoutMs: args.timeoutMs ?? 8000,
    requestTimeoutMs: args.requestTimeoutMs ?? 3000,
    includeAccount: args["include-account"] === true,
    clientVersion: packageJson.version,
    env,
  });
  return normalizeRateLimitsPayload(rpc.rateLimits, rpc.account, {
    includeAccount: args["include-account"] === true,
    version: packageJson.version,
  });
}

function writeSnapshot(snapshot: UsageSnapshot, args: ParsedOptions, stdout: WritableLike): void {
  if (args.json === true) {
    stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
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

function resolveCodexBin(args: ParsedOptions, env: NodeJS.ProcessEnv): string {
  return args["codex-bin"] ?? env.MINMAXXER_CODEX_BIN ?? "codex";
}

function parseOptions(command: Command, argv: string[]): ParsedOptions {
  const optionSpec = commandOptions(command);
  const args: ParsedOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      assertNoDuplicate(args, "help");
      args.help = true;
      continue;
    }
    if (!token.startsWith("--") || token === "--") {
      throw new UsageInputError(`unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    if (!optionSpec.allowed.has(key)) {
      throw new UsageInputError(`unknown option for ${command}: --${key}`);
    }
    assertNoDuplicate(args, key);
    if (optionSpec.booleans.has(key)) {
      setParsedOption(args, key, true);
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new UsageInputError(`missing value for --${key}`);
    }
    setParsedOption(args, key, value);
    i += 1;
  }
  validateOptions(command, args);
  return args;
}

function commandOptions(command: Command): OptionSpec {
  const commonValues = new Set(["codex-bin", "timeout", "request-timeout"]);
  const byCommand = {
    snapshot: {
      booleans: new Set(["json", "include-account"]),
      values: commonValues,
    },
    gate: {
      booleans: new Set(["json", "quiet"]),
      values: new Set([...commonValues, "lane", "remaining-at-least", "used-at-most", "resets-within"]),
    },
    doctor: {
      booleans: new Set(["json"]),
      values: commonValues,
    },
  };
  const spec = byCommand[command];
  return {
    booleans: spec.booleans,
    values: spec.values,
    allowed: new Set(["help", ...spec.booleans, ...spec.values]),
  };
}

function setParsedOption(args: ParsedOptions, key: string, value: string | boolean): void {
  (args as Record<string, string | number | boolean | undefined>)[key] = value;
}

function assertNoDuplicate(args: ParsedOptions, key: string): void {
  if (Object.prototype.hasOwnProperty.call(args, key)) {
    throw new UsageInputError(`duplicate option: --${key}`);
  }
}

function validateOptions(command: Command, args: ParsedOptions): void {
  if (args.help === true) return;
  if (args.timeout !== undefined) args.timeoutMs = parseTimeout(args.timeout, "--timeout");
  if (args["request-timeout"] !== undefined) {
    args.requestTimeoutMs = parseTimeout(args["request-timeout"], "--request-timeout");
  }

  if (command !== "gate") return;

  args.lane = args.lane ?? "weekly";
  if (!["session", "weekly"].includes(args.lane)) {
    throw new UsageInputError("--lane must be session or weekly");
  }

  if (args["remaining-at-least"] !== undefined) {
    args.remainingAtLeast = parsePercent(args["remaining-at-least"], "--remaining-at-least");
  }
  if (args["used-at-most"] !== undefined) {
    args.usedAtMost = parsePercent(args["used-at-most"], "--used-at-most");
  }
  if (args["resets-within"] !== undefined) {
    args.resetsWithinSeconds = parseDurationSeconds(args["resets-within"]);
    if (!Number.isFinite(args.resetsWithinSeconds) || args.resetsWithinSeconds <= 0) {
      throw new UsageInputError("--resets-within must be greater than 0");
    }
  }
  if (
    args.remainingAtLeast === undefined &&
    args.usedAtMost === undefined &&
    args.resetsWithinSeconds === undefined
  ) {
    throw new UsageInputError("gate requires at least one condition");
  }
}

function parsePercent(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new UsageInputError(`${flag} must be a number from 0 to 100`);
  }
  return parsed;
}

function parseTimeout(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_TIMEOUT_MS) {
    throw new UsageInputError(`${flag} must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  }
  return parsed;
}

const COMMON_OPTIONS_HELP = `  --codex-bin <path>        Codex executable. Default: codex
  --timeout <ms>            RPC initialize timeout. Default: 8000
  --request-timeout <ms>    RPC request timeout. Default: 3000`;

const EXIT_CODES_HELP = `Exit codes:
  0  success or gate passed
  10 gate condition false
  2  Codex source unavailable
  3  Codex source error
  64 invalid arguments`;

function helpText(command?: Command): string {
  if (command === "snapshot") {
    return `minmaxxer snapshot — print the current Codex usage windows

Usage:
  minmaxxer snapshot [--json] [--include-account]

Options:
  --json                    Machine-readable JSON instead of human text
  --include-account         Include the signed-in account email in output
${COMMON_OPTIONS_HELP}
`;
  }
  if (command === "gate") {
    return `minmaxxer gate — exit 0 when usage conditions pass, 10 when they do not

Usage:
  minmaxxer gate --lane weekly --remaining-at-least 30 --resets-within 3d [--json] [--quiet]

Options:
  --lane <session|weekly>   Gate lane. Default: weekly
  --remaining-at-least <n>  Pass when remaining percent is at least n
  --used-at-most <n>        Pass when used percent is at most n
  --resets-within <dur>     Pass when reset is within duration, e.g. 12h or 3d
  --json                    Print the full gate evaluation as JSON
  --quiet                   No output; the exit code is the answer
${COMMON_OPTIONS_HELP}

All conditions must pass (AND semantics). At least one condition is required.

${EXIT_CODES_HELP}
`;
  }
  if (command === "doctor") {
    return `minmaxxer doctor — check the Codex binary and RPC connectivity

Usage:
  minmaxxer doctor [--json]

Options:
  --json                    Machine-readable JSON instead of human text
${COMMON_OPTIONS_HELP}
`;
  }
  return `minmaxxer ${packageJson.version}

Local-only Codex usage snapshot and automation gate.

Usage:
  minmaxxer snapshot [--json] [--include-account]
  minmaxxer gate --lane weekly --remaining-at-least 30 --resets-within 3d [--json] [--quiet]
  minmaxxer doctor [--json]

Run "minmaxxer <command> --help" for command-specific options.

Options:
${COMMON_OPTIONS_HELP}
  --lane <session|weekly>   Gate lane. Default: weekly
  --remaining-at-least <n>  Pass when remaining percent is at least n
  --used-at-most <n>        Pass when used percent is at most n
  --resets-within <dur>     Pass when reset is within duration, e.g. 12h or 3d

${EXIT_CODES_HELP}
`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
