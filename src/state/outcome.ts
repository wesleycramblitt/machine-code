/**
 * machine_code — deterministic run outcome summaries.
 *
 * Every run gets one. The summary is derived from the event stream and the
 * final run state, so it is available even when the model never produced a
 * final message (turn cap, provider failure, interruption). It is intentionally
 * short and factual: what stopped the run, what it produced, what it read or
 * changed, and what the model said.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunEvent, RunSummary, RunStatus } from "./runs.js";

export type StopReason =
  | "completed"
  | "turn-cap"
  | "budget"
  | "loop"
  | "error"
  | "blocked"
  | "interrupted"
  | "paused"
  | "awaiting-input"
  | "cancelled"
  | "running";

export interface StateFactView {
  kind: string;
  text: string;
  turn: number;
  status: string;
}

export interface StateView {
  phase?: string;
  nextAction?: string;
  facts?: StateFactView[];
  open?: Array<{ text: string; status: string }>;
}

export interface RunOutcome {
  /** One-line explanation of how the run ended. */
  headline: string;
  /** Multi-line, model-independent summary. */
  text: string;
  stopReason: StopReason;
}

export interface SummarizeInput {
  summary: Pick<
    RunSummary,
    "agent" | "status" | "request" | "turns" | "modelCalls" | "usage" | "cost"
  > & { error?: string };
  events: readonly RunEvent[];
  state?: StateView | null;
  finalText?: string;
  /** Override the inferred stop reason (used by the recorder when it knows). */
  stopReason?: StopReason;
}

const SUMMARY_CAP = 4_000;
const RESPONSE_CAP = 1_500;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function countLine(label: string, values: ReadonlyMap<string, number>, max = 5): string | null {
  if (values.size === 0) return null;
  const items = [...values.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([key, count]) => (count > 1 ? `${key} (x${count})` : key));
  return `${label}: ${items.join(", ")}${values.size > max ? `, +${values.size - max} more` : ""}`;
}

function inc(map: Map<string, number>, key: string): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function clip(value: string, cap: number): string {
  const clean = value.trim();
  return clean.length <= cap ? clean : `${clean.slice(0, cap).replace(/\s+$/, "")}…`;
}

function inferStopReason(status: RunStatus, events: readonly RunEvent[]): StopReason {
  if (events.some((event) => event.type === "turn_cap")) return "turn-cap";
  if (events.some((event) => event.type === "budget_exhausted")) return "budget";
  if (events.some((event) => event.type === "loop_blocked")) return "loop";
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "error";
    case "blocked":
      return "blocked";
    case "interrupted":
      return "interrupted";
    case "paused":
      return "paused";
    case "awaiting_input":
      return "awaiting-input";
    case "cancelled":
      return "cancelled";
    default:
      return "running";
  }
}

function headlineFor(reason: StopReason, error: string | undefined, capTurns: number): string {
  switch (reason) {
    case "turn-cap":
      return `Stopped at the turn cap (${capTurns || "?"}) before finishing.`;
    case "budget":
      return "Stopped: token budget exhausted.";
    case "loop":
      return "Stopped: repeated identical tool calls detected.";
    case "completed":
      return "Completed.";
    case "error":
      return `Failed${error ? `: ${error}` : "."}`;
    case "blocked":
      return `Blocked${error ? `: ${error}` : "."}`;
    case "interrupted":
      return "Interrupted before finishing.";
    case "paused":
      return "Paused.";
    case "awaiting-input":
      return "Waiting for input.";
    case "cancelled":
      return "Cancelled.";
    default:
      return "In progress.";
  }
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** Build a deterministic outcome summary from a run record and its events. */
export function summarizeRun(input: SummarizeInput): RunOutcome {
  const { summary, events } = input;
  const status = summary.status;
  const stopReason = input.stopReason ?? inferStopReason(status, events);
  const capEvent = events.find((event) => event.type === "turn_cap");
  const capTurns = num(capEvent?.turns);
  // The cap event is authoritative for a capped run. Otherwise use the
  // recorder's turn count (old records counted model calls here).
  const turns = capTurns || summary.turns;

  const tools = new Map<string, number>();
  const reads = new Map<string, number>();
  const searches = new Map<string, number>();
  const commands = new Map<string, number>();
  const changed = new Set<string>();
  const issues: Array<{ number: number; kind: string; title: string }> = [];
  const linked: string[] = [];
  const plans = new Set<number>();
  const errors = new Map<string, number>();
  let retries = 0;
  let children = 0;
  let thinkingBuffer = "";

  // A tool_call_start carries the arguments; tool_call carries the outcome.
  const failedCalls = new Set<string>();
  for (const event of events) {
    if (event.type !== "tool_call") continue;
    if (event.isError === true && typeof event.toolCallId === "string") failedCalls.add(event.toolCallId);
  }

  for (const event of events) {
    switch (event.type) {
      case "tool_call_start": {
        const tool = text(event.tool);
        if (!tool) break;
        inc(tools, tool);
        const args = (event.args ?? {}) as Record<string, unknown>;
        if (tool === "read" && typeof args.path === "string") inc(reads, args.path);
        else if (tool === "search") {
          const mode = text(args.mode) || "text";
          const scope = typeof args.path === "string" ? args.path : "";
          const pattern = text(args.pattern);
          inc(searches, `${mode} ${pattern || scope || "."}`.trim());
        } else if (tool === "command") {
          const action = text(args.action);
          const name = text(args.name);
          if (name) inc(commands, action && action !== "run" ? `${action} ${name}` : name);
          else if (action) inc(commands, action);
        } else if ((tool === "edit" || tool === "write") && typeof args.path === "string") {
          const id = text(event.toolCallId);
          if (!id || !failedCalls.has(id)) changed.add(args.path);
        }
        break;
      }
      case "issue_created":
        issues.push({
          number: num(event.number),
          kind: text(event.kind),
          title: text(event.title),
        });
        break;
      case "issue_linked":
        linked.push(`#${num(event.issue)} under #${num(event.parent)}`);
        break;
      case "plan_updated":
        plans.add(num(event.issue));
        break;
      case "error_classified":
        inc(errors, text(event.kind) || "error");
        break;
      case "retry":
        retries += 1;
        break;
      case "child_spawned":
        children += 1;
        break;
      case "model_request":
        thinkingBuffer = "";
        break;
      case "model_delta":
        if (event.kind === "thinking" && typeof event.text === "string") thinkingBuffer += event.text;
        break;
      default:
        break;
    }
  }

  const lines: string[] = [`Outcome: ${headlineFor(stopReason, summary.error, capTurns)}`];
  if (summary.status === "completed" && stopReason !== "completed") {
    lines.push(`Recorded status: ${summary.status} (the run did not finish cleanly)`);
  } else if (summary.status !== "completed") {
    lines.push(`Recorded status: ${summary.status}`);
  }
  if (input.state?.phase) lines.push(`Phase: ${input.state.phase}`);
  lines.push(
    `Work: ${turns} turn(s) · ${summary.modelCalls} model call(s) · ` +
      `${formatTokens(summary.usage.totalTokens)} tokens · $${summary.cost.actual.toFixed(6)}`,
  );

  if (issues.length === 0) {
    lines.push(
      summary.agent === "planner"
        ? "Issues: none created — the planner did not create any issues."
        : "Issues: none created",
    );
  } else {
    lines.push(
      "Issues: " +
        issues
          .map((issue) => `#${issue.number} ${issue.kind}${issue.title ? ` "${clip(issue.title, 80)}"` : ""}`)
          .join("; "),
    );
  }
  if (linked.length > 0) lines.push(`Linked: ${linked.join(", ")}`);
  if (plans.size > 0) lines.push(`Plans: ${[...plans].map((n) => `#${n}`).join(", ")}`);

  lines.push(changed.size === 0 ? "Changes: none" : `Changes: ${[...changed].sort().join(", ")}`);

  const readLine = countLine("Read", reads);
  if (readLine) lines.push(readLine);
  const searchLine = countLine("Searched", searches);
  if (searchLine) lines.push(searchLine);
  const commandLine = countLine("Commands", commands);
  if (commandLine) lines.push(commandLine);
  if (children > 0) lines.push(`Children: ${children} spawned`);
  if (errors.size > 0) {
    lines.push(
      "Errors: " +
        [...errors.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([kind, count]) => (count > 1 ? `${kind} (x${count})` : kind))
          .join(", "),
    );
  }
  if (retries > 0) lines.push(`Retries: ${retries}`);

  const decisionSeen = new Set<string>();
  const decisions = (input.state?.facts ?? [])
    .filter((fact) => fact.status === "active" && fact.kind === "decision")
    .filter((fact) => {
      if (decisionSeen.has(fact.text)) return false;
      decisionSeen.add(fact.text);
      return true;
    })
    .slice(-3);
  if (decisions.length > 0) {
    lines.push("Decisions:");
    for (const decision of decisions) lines.push(`- ${clip(decision.text, 200)}`);
  }
  const openSeen = new Set<string>();
  const open = (input.state?.open ?? [])
    .filter((question) => question.status === "open")
    .filter((question) => {
      if (openSeen.has(question.text)) return false;
      openSeen.add(question.text);
      return true;
    })
    .slice(0, 3);
  if (open.length > 0) {
    lines.push("Open:");
    for (const question of open) lines.push(`- ${clip(question.text, 200)}`);
  }

  const response = clip(text(input.finalText), RESPONSE_CAP);
  const active = summary.status === "running" || summary.status === "created";
  const waiting = summary.status === "paused" || summary.status === "awaiting_input";
  if (response) {
    lines.push(`Response:\n${response}`);
  } else if (active) {
    lines.push("Response: (in progress)");
  } else if (waiting) {
    lines.push("Response: none — the run is paused or waiting for input.");
  } else {
    lines.push("Response: none — the run produced no final assistant text.");
    const lastModelText = [...events]
      .reverse()
      .find((event) => event.type === "model_call_end" && typeof event.text === "string" && event.text.trim().length > 0);
    if (lastModelText && typeof lastModelText.text === "string") {
      lines.push(`Last model text: ${clip(lastModelText.text, 600)}`);
    } else if (thinkingBuffer.trim().length > 0) {
      lines.push(`Last thinking: ${clip(thinkingBuffer.trim().slice(-600), 600)}`);
    }
  }
  if (input.state?.nextAction) lines.push(`Next: ${clip(input.state.nextAction, 240)}`);

  const textOut = lines.join("\n");
  return {
    headline: headlineFor(stopReason, summary.error, capTurns),
    text: textOut.length <= SUMMARY_CAP ? textOut : `${textOut.slice(0, SUMMARY_CAP).replace(/\s+$/, "")}\n…[summary truncated]`,
    stopReason,
  };
}

/** Read the compact state view from a run directory without replaying git/map side effects. */
export function readStateView(runDir: string): StateView | null {
  const file = join(runDir, "state.jsonl");
  if (!existsSync(file)) return null;
  const view: StateView = { facts: [], open: [] };
  const facts = new Map<string, StateFactView>();
  const factOrder: string[] = [];
  const open = new Map<string, { text: string; status: string }>();
  const openOrder: string[] = [];
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = text(entry.type);
      if (type === "next") view.nextAction = text(entry.text).trim() || undefined;
      else if (type === "phase") view.phase = text(entry.phase);
      else if (type === "fact" && entry.fact && typeof entry.fact === "object") {
        const fact = entry.fact as Record<string, unknown>;
        const id = text(fact.id) || `fact_${factOrder.length}`;
        const item: StateFactView = {
          kind: text(fact.kind),
          text: text(fact.text),
          turn: num(fact.turn),
          status: text(fact.status) || "active",
        };
        if (!facts.has(id)) factOrder.push(id);
        facts.set(id, item);
      } else if ((type === "stale" || type === "resolve") && typeof entry.id === "string") {
        const fact = facts.get(entry.id);
        if (fact) fact.status = "stale";
        const question = open.get(entry.id);
        if (question) question.status = "answered";
      } else if (type === "open" && entry.question && typeof entry.question === "object") {
        const question = entry.question as Record<string, unknown>;
        const id = text(question.id) || `q_${openOrder.length}`;
        if (!open.has(id)) openOrder.push(id);
        open.set(id, { text: text(question.text), status: text(question.status) || "open" });
      }
    }
  } catch {
    return null;
  }
  view.facts = factOrder.map((id) => facts.get(id)!).filter(Boolean);
  view.open = openOrder.map((id) => open.get(id)!).filter(Boolean);
  return view;
}
