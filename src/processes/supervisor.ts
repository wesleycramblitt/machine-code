/**
 * machine_code — per-run process supervisor.
 *
 * Routes observed spawns through runProc, appends process records, and writes
 * full stdout/stderr to log files while returning the capped tool result.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { runProc, type ProcOptions, type ProcResult } from "../proc.js";
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
