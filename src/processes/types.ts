/**
 * machine_code — run-owned OS process records.
 *
 * The supervisor writes one JSONL record per process. Output lives in separate
 * log files so the run event stream stays small.
 */
export type ProcessOrigin = "tool" | "command" | "script" | "lsp" | "mcp" | "orchestrator";
export type ProcessStatus = "running" | "exited" | "killed" | "failed" | "spawn-error";

export interface ProcessRecord {
  id: string;
  runId: string;
  origin: ProcessOrigin;
  name: string;
  toolCallId?: string;
  argv: string[];
  pid?: number;
  pgid?: number;
  status: ProcessStatus;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  stdoutLog: string;
  stderrLog: string;
  lastOutputAt?: string;
  error?: string;
}

export function isProcessRunning(record: ProcessRecord): boolean {
  return record.status === "running";
}
