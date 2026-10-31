/**
 * machine_code — one way to run a subprocess: argument vector (never a
 * shell), /dev/null stdin (a piped stdin makes rg and friends wait forever),
 * minimal environment without provider secrets, own process group so a
 * timeout kills the whole group, captured and capped output.
 */
import { spawn } from "node:child_process";

export interface ProcResult {
  /** Process exit code; null when killed by signal or failed to spawn. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** "exit" | "timeout" | "spawn-error" */
  outcome: "exit" | "timeout" | "spawn-error";
  spawnError?: string;
}

export interface ProcOptions {
  cwd: string;
  timeoutMs: number;
  /** Extra environment over the minimal base. */
  env?: Record<string, string>;
  /** Capture cap per stream (bytes); excess is discarded. Default 4 MiB. */
  maxBufferBytes?: number;
}

/** Minimal environment: enough for binaries, never provider secrets. */
export function minimalEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
  };
}

export function runProc(binary: string, args: string[], options: ProcOptions): Promise<ProcResult> {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(binary, args, {
        cwd: options.cwd,
        env: { ...minimalEnv(), ...(options.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      resolvePromise({
        code: null,
        stdout: "",
        stderr: "",
        outcome: "spawn-error",
        spawnError: (error as Error).message,
      });
      return;
    }
    const cap = options.maxBufferBytes ?? 4 * 1024 * 1024;
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let settled = false;
    const settle = (result: ProcResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
      settle({
        code: null,
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        outcome: "timeout",
      });
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (outLen < cap) {
        chunks.push(chunk);
        outLen += chunk.length;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errLen < cap) {
        errChunks.push(chunk);
        errLen += chunk.length;
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      settle({
        code: null,
        stdout: "",
        stderr: "",
        outcome: "spawn-error",
        spawnError: error.code === "ENOENT" ? `${binary}: not installed or not on PATH` : error.message,
      });
    });
    child.on("close", (code) => {
      settle({
        code,
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        outcome: "exit",
      });
    });
  });
}
