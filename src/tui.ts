/**
 * machine_code — minimal TUI (M3).
 *
 * Polling-based dashboard: lists runs, tails events, interrupts via control
 * files. No native deps. Use tmux to keep it alive.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { layout } from "./paths.js";
import { listAllRuns, readRun, listProjects, type RunSummary } from "./state/runs.js";
import { listInstances } from "./state/instances.js";

const ANSI = {
  clear: "\x1b[2J\x1b[H",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

function statusColor(status: string): string {
  if (status === "done") return ANSI.green;
  if (status === "running") return ANSI.cyan;
  if (status === "interrupted") return ANSI.yellow;
  if (status === "blocked" || status === "failed") return ANSI.red;
  return ANSI.gray;
}

export async function runTui(): Promise<void> {
  const l = layout();
  mkdirSync(l.localDir, { recursive: true });

  let selected = 0;
  let mode: "runs" | "detail" = "runs";
  let detailId: string | null = null;
  let lastRuns: RunSummary[] = [];

  const stdin = process.stdin;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  const render = () => {
    const runs = listAllRuns(l.home);
    lastRuns = runs;
    if (selected >= runs.length) selected = Math.max(0, runs.length - 1);

    let out = ANSI.clear;
    out += `${ANSI.bold}machine_code TUI${ANSI.reset}  ${ANSI.dim}(j/k navigate, enter detail, i interrupt, r refresh, q quit)${ANSI.reset}\n`;
    out += `${ANSI.dim}instances: ${listInstances(l.home).length}  runs: ${runs.length}${ANSI.reset}\n\n`;

    if (mode === "runs") {
      out += `${ANSI.bold}RUNS${ANSI.reset}\n`;
      if (runs.length === 0) out += `${ANSI.dim}  no runs${ANSI.reset}\n`;
      for (let i = 0; i < runs.length; i++) {
        const r = runs[i]!;
        const mark = i === selected ? "> " : "  ";
        const color = statusColor(r.status);
        out += `${mark}${color}${r.status.padEnd(12)}${ANSI.reset} ${r.id}  ${r.agent}  ${r.usage.totalTokens}tok  $${r.cost.actual.toFixed(4)}  ${r.request.slice(0, 40)}\n`;
      }
    } else if (detailId) {
      const run = readRun(l, detailId) ?? (findRunInProjects(l.home, detailId) as ReturnType<typeof readRun>);
      out += `${ANSI.bold}RUN ${detailId}${ANSI.reset}  ${ANSI.dim}(esc back)${ANSI.reset}\n`;
      if (run) {
        const s = run.summary;
        out += `  status ${statusColor(s.status)}${s.status}${ANSI.reset}  agent ${s.agent}  mode ${s.mode}\n`;
        out += `  tokens ${s.usage.totalTokens}  cost $${s.cost.actual.toFixed(6)}  calls ${s.modelCalls}\n`;
        out += `  request: ${s.request}\n\n`;
        out += `${ANSI.bold}EVENTS${ANSI.reset}\n`;
        for (const e of run.events.slice(-30)) {
          const t = String(e.t).slice(11, 19);
          out += `  ${ANSI.gray}${t}${ANSI.reset}  ${String(e.type).padEnd(18)} ${formatEvent(e)}\n`;
        }
      } else {
        out += `${ANSI.red}run not found${ANSI.reset}\n`;
      }
    }

    process.stdout.write(out);
  };

  const interruptSelected = () => {
    const r = lastRuns[selected];
    if (!r) return;
    if (r.status !== "running") {
      process.stderr.write(`\nrun ${r.id} is not running\n`);
      return;
    }
    const dir = join(r.repoRoot, ".machine_code", "local", "runs", r.id);
    const controlFile = join(dir, "control");
    let seq = 1;
    try {
      const ack = readFileSync(join(dir, "control.ack"), "utf8");
      const m = ack.match(/"seq":\s*(\d+)/);
      if (m) seq = Number(m[1]) + 1;
    } catch {
      // no ack yet
    }
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(controlFile, JSON.stringify({ seq, action: "interrupt", from: process.pid }) + "\n", "utf8");
    } catch (e) {
      process.stderr.write(`\nfailed to write control: ${(e as Error).message}\n`);
    }
  };

  stdin.on("data", (data: string) => {
    for (const ch of data) {
      if (ch === "q" || ch === "\x03") {
        cleanup();
        process.exit(0);
      }
      if (mode === "runs") {
        if (ch === "j" || ch === "\x1b[B") selected = Math.min(lastRuns.length - 1, selected + 1);
        else if (ch === "k" || ch === "\x1b[A") selected = Math.max(0, selected - 1);
        else if (ch === "\r" || ch === "\n") {
          const r = lastRuns[selected];
          if (r) { mode = "detail"; detailId = r.id; }
        } else if (ch === "i") interruptSelected();
        else if (ch === "r") render();
      } else {
        if (ch === "\x1b" || ch === "q") { mode = "runs"; detailId = null; }
      }
    }
    render();
  });

  const cleanup = () => {
    stdin.setRawMode?.(false);
    process.stdout.write(ANSI.clear);
  };

  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  render();
  const poll = setInterval(render, 1000);
  await new Promise(() => {
    // keep alive until exit
  });
}

function formatEvent(e: Record<string, unknown>): string {
  if (e.type === "model_select") {
    return e.error ? `error: ${e.error}` : `-> ${e.key}`;
  }
  if (e.type === "model_call_end") {
    const u = e.usage as { totalTokens: number };
    return `${e.provider}/${e.model}  ${e.stopReason}  ${u?.totalTokens ?? 0} tok`;
  }
  if (e.type === "tool_call") return `${e.tool}  ${e.isError ? "ERR" : "ok"}`;
  if (e.type === "gates") return `gates: ${(e as { passed: boolean }).passed ? "PASS" : "FAIL"}`;
  if (e.type === "run_end") return String(e.status);
  return "";
}

function findRunInProjects(home: string, id: string): ReturnType<typeof readRun> {
  for (const project of listProjects(home)) {
    const r = readRun(layout(project), id);
    if (r) return r;
  }
  return null;
}
