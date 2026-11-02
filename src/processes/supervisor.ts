/**
 * machine_code — per-run process supervisor.
 *
 * Routes observed spawns through runProc, appends process records, and writes
 * full stdout/stderr to log files while returning the capped tool result.
 */
import { appendFileSync, closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { minimalEnv, runProc, type ProcOptions, type ProcResult } from "../proc.js";
import {
  appendProcessRecord,
  latestProcessRecords,
  liveProcessRecords,
  nextProcessId,
  processLogPaths,
  processesDir,
  readProcessRecords,
} from "./registry.js";
import type { ProcessOrigin, ProcessRecord, ProcessStatus } from "./types.js";
import { pidAlive } from "./reconcile.js";

export interface SupervisorOptions {
  runId: string;
  runDir: string;
  onEvent?: (type: string, data: Record<string, unknown>) => void;
}

export interface SupervisedRunOptions extends Omit<ProcOptions, "hooks"> {
  origin: ProcessOrigin;
  name: string;
  toolCallId?: string;
}

export interface SupervisedRunResult {
  result: ProcResult;
  processId: string;
  record: ProcessRecord;
}

export interface SupervisedStartOptions {
  cwd: string;
  env?: Record<string, string>;
  origin: ProcessOrigin;
  name: string;
  toolCallId?: string;
}

export interface SupervisedAttachOptions {
  origin: ProcessOrigin;
  name: string;
  toolCallId?: string;
}

export interface SupervisedStartResult {
  processId: string;
  record: ProcessRecord;
}

function statusFor(result: ProcResult): ProcessStatus {
  if (result.outcome === "spawn-error") return "spawn-error";
  if (result.outcome === "timeout") return "killed";
  return result.code === 0 ? "exited" : "failed";
}

export class ProcessSupervisor {
  constructor(private readonly options: SupervisorOptions) {}

  list(): ProcessRecord[] {
    return latestProcessRecords(readProcessRecords(this.options.runDir));
  }

  live(): ProcessRecord[] {
    return liveProcessRecords(readProcessRecords(this.options.runDir));
  }

  async run(binary: string, args: string[], options: SupervisedRunOptions): Promise<SupervisedRunResult> {
    const { origin, name, toolCallId, ...procOptions } = options;
    const id = nextProcessId(readProcessRecords(this.options.runDir));
    const logs = processLogPaths(this.options.runDir, id);
    mkdirSync(processesDir(this.options.runDir), { recursive: true });
    writeFileSync(logs.stdout, "", "utf8");
    writeFileSync(logs.stderr, "", "utf8");
    const startedAt = new Date().toISOString();
    let record: ProcessRecord = {
      id,
      runId: this.options.runId,
      origin,
      name,
      ...(toolCallId ? { toolCallId } : {}),
      argv: [binary, ...args],
      status: "running",
      startedAt,
      stdoutLog: logs.stdout,
      stderrLog: logs.stderr,
    };
    appendProcessRecord(this.options.runDir, record);
    this.options.onEvent?.("process_started", { processId: id, origin, name });
    let finalized = false;
    const finalize = (result: ProcResult): void => {
      if (finalized) return;
      finalized = true;
      const endedAt = new Date().toISOString();
      record = {
        ...record,
        status: statusFor(result),
        endedAt,
        exitCode: result.code,
        signal: null,
        ...(result.spawnError ? { error: result.spawnError } : {}),
      };
      appendProcessRecord(this.options.runDir, record);
      this.options.onEvent?.("process_exited", {
        processId: id,
        status: record.status,
        exitCode: result.code,
        outcome: result.outcome,
      });
      if (result.outcome === "timeout") {
        this.options.onEvent?.("process_killed", { processId: id, reason: "timeout" });
      }
    };
    const result = await runProc(binary, args, {
      ...procOptions,
      hooks: {
        onSpawn: (process) => {
          record = { ...record, ...process };
          appendProcessRecord(this.options.runDir, record);
        },
        onStdout: (chunk) => {
          appendFileSync(logs.stdout, chunk);
          record = { ...record, lastOutputAt: new Date().toISOString() };
        },
        onStderr: (chunk) => {
          appendFileSync(logs.stderr, chunk);
          record = { ...record, lastOutputAt: new Date().toISOString() };
        },
        onExit: finalize,
      },
    });
    finalize(result);
    return { result, processId: id, record };
  }

  /**
   * Start a detached, long-lived process and return immediately. The parent
   * records the process and writes its output to logs; if the parent exits
   * first, reconcile marks the orphan later.
   */
  async start(binary: string, args: string[], options: SupervisedStartOptions): Promise<SupervisedStartResult> {
    const { origin, name, toolCallId, cwd, env } = options;
    const id = nextProcessId(readProcessRecords(this.options.runDir));
    const logs = processLogPaths(this.options.runDir, id);
    mkdirSync(processesDir(this.options.runDir), { recursive: true });
    const startedAt = new Date().toISOString();
    let record: ProcessRecord = {
      id,
      runId: this.options.runId,
      origin,
      name,
      ...(toolCallId ? { toolCallId } : {}),
      argv: [binary, ...args],
      status: "running",
      startedAt,
      stdoutLog: logs.stdout,
      stderrLog: logs.stderr,
    };
    appendProcessRecord(this.options.runDir, record);
    this.options.onEvent?.("process_started", { processId: id, origin, name });
    let outFd: number | undefined;
    let errFd: number | undefined;
    try {
      outFd = openSync(logs.stdout, "a");
      errFd = openSync(logs.stderr, "a");
      const child = spawn(binary, args, {
        cwd,
        env: { ...minimalEnv(), ...(env ?? {}) },
        detached: true,
        stdio: ["ignore", outFd, errFd],
      });
      if (child.pid !== undefined) {
        record = { ...record, pid: child.pid, pgid: child.pid };
        appendProcessRecord(this.options.runDir, record);
      }
      const finish = (status: ProcessStatus, code: number | null, signal: string | null, error?: string): void => {
        record = {
          ...record,
          status,
          endedAt: new Date().toISOString(),
          exitCode: code,
          signal,
          ...(error ? { error } : {}),
        };
        appendProcessRecord(this.options.runDir, record);
        this.options.onEvent?.("process_exited", { processId: id, status, exitCode: code, signal });
      };
      child.on("error", (error: Error) => finish("spawn-error", null, null, error.message));
      child.on("exit", (code, signal) => finish(code === 0 ? "exited" : signal ? "killed" : "failed", code, signal));
      child.unref();
      return { processId: id, record };
    } catch (error) {
      record = { ...record, status: "spawn-error", endedAt: new Date().toISOString(), error: (error as Error).message };
      appendProcessRecord(this.options.runDir, record);
      this.options.onEvent?.("process_exited", { processId: id, status: "spawn-error" });
      return { processId: id, record };
    } finally {
      if (outFd !== undefined) closeSync(outFd);
      if (errFd !== undefined) closeSync(errFd);
    }
  }

  /**
   * Register an already-spawned long-lived child (for example an LSP server).
   * Its stdio remains owned by the caller; only lifecycle metadata is recorded.
   */
  attach(child: ChildProcess, options: SupervisedAttachOptions): string {
    const id = nextProcessId(readProcessRecords(this.options.runDir));
    const logs = processLogPaths(this.options.runDir, id);
    mkdirSync(processesDir(this.options.runDir), { recursive: true });
    let record: ProcessRecord = {
      id,
      runId: this.options.runId,
      origin: options.origin,
      name: options.name,
      ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
      argv: [options.name],
      ...(child.pid !== undefined ? { pid: child.pid, pgid: child.pid } : {}),
      status: "running",
      startedAt: new Date().toISOString(),
      stdoutLog: logs.stdout,
      stderrLog: logs.stderr,
    };
    appendProcessRecord(this.options.runDir, record);
    this.options.onEvent?.("process_started", { processId: id, origin: options.origin, name: options.name });
    child.on("exit", (code, signal) => {
      record = {
        ...record,
        status: code === 0 ? "exited" : signal ? "killed" : "failed",
        endedAt: new Date().toISOString(),
        exitCode: code,
        signal,
      };
      appendProcessRecord(this.options.runDir, record);
      this.options.onEvent?.("process_exited", { processId: id, status: record.status, exitCode: code, signal });
    });
    return id;
  }
}

/** Kill a registered process group. The TUI/CLI never supplies a raw pid. */
export function killProcessRecord(record: ProcessRecord, signal: NodeJS.Signals = "SIGTERM"): void {
  if (record.status !== "running") throw new Error(`process ${record.id} is not running`);
  if (!record.pgid) throw new Error(`process ${record.id} has no process group`);
  process.kill(-record.pgid, signal);
}

export function killAllProcesses(records: readonly ProcessRecord[], signal: NodeJS.Signals = "SIGTERM"): number {
  let killed = 0;
  for (const record of liveProcessRecords(records)) {
    try {
      killProcessRecord(record, signal);
      killed += 1;
    } catch {
      // Already gone.
    }
  }
  return killed;
}

function groupAlive(pgid: number | undefined): boolean {
  if (!pgid) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM, bounded grace period, then SIGKILL for the process group. */
export async function terminateProcessRecord(record: ProcessRecord, graceMs = 2_000): Promise<"term" | "kill"> {
  if (record.status !== "running") throw new Error(`process ${record.id} is not running`);
  if (!record.pgid) throw new Error(`process ${record.id} has no process group`);
  process.kill(-record.pgid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!groupAlive(record.pgid) && !pidAlive(record.pid)) return "term";
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (groupAlive(record.pgid)) {
    try {
      process.kill(-record.pgid, "SIGKILL");
    } catch {
      // Already gone.
    }
    return "kill";
  }
  return "term";
}

export async function terminateAllProcesses(
  records: readonly ProcessRecord[],
  graceMs = 2_000,
): Promise<{ terminated: number; killed: number }> {
  let terminated = 0;
  let killed = 0;
  for (const record of liveProcessRecords(records)) {
    try {
      const outcome = await terminateProcessRecord(record, graceMs);
      if (outcome === "kill") killed += 1;
      else terminated += 1;
    } catch {
      // Already gone.
    }
  }
  return { terminated, killed };
}
