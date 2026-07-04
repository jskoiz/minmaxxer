import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { AccountPayload, RawRateLimitsInput } from "./normalize.js";

type RpcErrorCode = "RPC_ERROR" | "START_FAILED" | "NOT_RUNNING" | "EXITED" | "TIMEOUT" | "REQUEST_FAILED";

export class CodexRpcError extends Error {
  code: RpcErrorCode;

  constructor(message: string, code: RpcErrorCode = "RPC_ERROR") {
    super(message);
    this.name = "CodexRpcError";
    this.code = code;
  }
}

const MAX_STDERR_CHARS = 4096;
const KILL_GRACE_MS = 2000;

type RpcOptions = {
  codexBin?: string;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  includeAccount?: boolean;
  clientVersion?: string;
  env?: NodeJS.ProcessEnv;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: CodexRpcError) => void;
  timer: NodeJS.Timeout;
};

type RpcPayload = {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
};

type RpcResponse = {
  id?: number | null;
  result?: unknown;
  error?: {
    message?: string;
  };
};

export type CodexRpcSnapshot = {
  rateLimits: RawRateLimitsInput | null;
  account: AccountPayload | null;
};

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-api-key]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]");
}

export async function fetchCodexRpcSnapshot(options: RpcOptions = {}): Promise<CodexRpcSnapshot> {
  const client = new CodexRpcClient(options);
  try {
    await client.start();
    await client.initialize();
    const rateLimits = await client.request("account/rateLimits/read") as RawRateLimitsInput | null;
    let account: AccountPayload | null = null;
    if (options.includeAccount === true) {
      try {
        account = await client.request("account/read") as AccountPayload;
      } catch {
        account = null;
      }
    }
    return { rateLimits, account };
  } finally {
    client.close();
  }
}

class CodexRpcClient {
  private codexBin: string;
  private timeoutMs: number;
  private requestTimeoutMs: number;
  private clientVersion: string;
  private env: NodeJS.ProcessEnv;
  private nextId: number;
  private pending: Map<number, PendingRequest>;
  private stderr: string;
  private process: ChildProcessWithoutNullStreams | null;
  private readline: Interface | null;

  constructor(options: RpcOptions = {}) {
    this.codexBin = options.codexBin ?? "codex";
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 3000;
    this.clientVersion = options.clientVersion ?? "0.0.0";
    this.env = options.env ?? process.env;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.process = null;
    this.readline = null;
  }

  async start(): Promise<void> {
    const args = ["-s", "read-only", "-a", "untrusted", "app-server"];
    this.process = spawn(this.codexBin, args, {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const child = this.process;

    // A write can race the child's death; the exit handler reports the real
    // failure, so an EPIPE on stdin must not crash the process.
    child.stdin.on("error", () => {});

    child.stderr.on("data", (data: Buffer) => {
      this.stderr = (this.stderr + data.toString("utf8")).slice(-MAX_STDERR_CHARS);
    });

    child.on("error", (error: Error) => {
      this.rejectAll(new CodexRpcError(error.message, "START_FAILED"));
    });

    child.on("exit", (code, signal) => {
      if (this.pending.size > 0) {
        const detail = sanitizeDiagnostic(this.stderr.trim());
        const suffix = detail ? `: ${detail}` : "";
        this.rejectAll(new CodexRpcError(`codex app-server exited (${code ?? signal})${suffix}`, "EXITED"));
      }
    });

    this.readline = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    this.readline.on("line", (line: string) => this.handleLine(line));

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(new CodexRpcError(error.message, "START_FAILED"));
      };
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "minmaxxer",
        version: this.clientVersion,
      },
    }, this.timeoutMs);
    this.notify("initialized");
  }

  async request(method: string, params: Record<string, unknown> = {}, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (!this.process?.stdin?.writable) {
      throw new CodexRpcError("codex app-server is not running", "NOT_RUNNING");
    }

    const id = this.nextId++;
    const payload = { id, method, params };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRpcError(`${method} timed out after ${timeoutMs}ms`, "TIMEOUT"));
        this.close();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write(payload);
    return promise;
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.write({ method, params });
  }

  write(payload: RpcPayload): void {
    if (!this.process?.stdin?.writable) {
      throw new CodexRpcError("codex app-server is not running", "NOT_RUNNING");
    }
    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  handleLine(line: string): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const message = parsed as RpcResponse;
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new CodexRpcError(message.error.message ?? "RPC request failed", "REQUEST_FAILED"));
      return;
    }
    pending.resolve(message.result);
  }

  rejectAll(error: CodexRpcError): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  close(): void {
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }
    const child = this.process;
    if (!child) return;
    this.process = null;

    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();

    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      // Escalate if the app-server ignores SIGTERM; unref'd so a stubborn
      // child never keeps the CLI's event loop alive past its own work.
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, KILL_GRACE_MS);
      killTimer.unref();
    }
    child.unref();
  }
}
