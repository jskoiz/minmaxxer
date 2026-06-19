import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class CodexRpcError extends Error {
  constructor(message, code = "RPC_ERROR") {
    super(message);
    this.name = "CodexRpcError";
    this.code = code;
  }
}

export async function fetchCodexRpcSnapshot(options = {}) {
  const client = new CodexRpcClient(options);
  try {
    await client.start();
    await client.initialize();
    const rateLimits = await client.request("account/rateLimits/read");
    let account = null;
    try {
      account = await client.request("account/read");
    } catch {
      account = null;
    }
    return { rateLimits, account };
  } finally {
    client.close();
  }
}

class CodexRpcClient {
  constructor(options = {}) {
    this.codexBin = options.codexBin ?? "codex";
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 3000;
    this.env = options.env ?? process.env;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.process = null;
  }

  async start() {
    const args = ["-s", "read-only", "-a", "untrusted", "app-server"];
    this.process = spawn(this.codexBin, args, {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stderr.on("data", (data) => {
      this.stderr += data.toString("utf8");
    });

    this.process.on("error", (error) => {
      this.rejectAll(new CodexRpcError(error.message, "START_FAILED"));
    });

    this.process.on("exit", (code, signal) => {
      if (this.pending.size > 0) {
        const detail = this.stderr.trim();
        const suffix = detail ? `: ${detail}` : "";
        this.rejectAll(new CodexRpcError(`codex app-server exited (${code ?? signal})${suffix}`, "EXITED"));
      }
    });

    const rl = createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => this.handleLine(line));

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        cleanup();
        reject(new CodexRpcError(error.message, "START_FAILED"));
      };
      const cleanup = () => {
        this.process.off("error", onError);
      };
      this.process.once("error", onError);
      setImmediate(() => {
        cleanup();
        resolve();
      });
    });
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: {
        name: "autocondition",
        version: "0.1.0",
      },
    }, this.timeoutMs);
    this.notify("initialized");
  }

  async request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
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

  notify(method, params = {}) {
    this.write({ method, params });
  }

  write(payload) {
    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined || message.id === null) return;
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

  rejectAll(error) {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  close() {
    if (!this.process) return;
    if (!this.process.killed) {
      this.process.kill("SIGTERM");
    }
  }
}
